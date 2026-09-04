import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CheckpointDataSchema, type CheckpointData, type Verdict } from './types.js';
import { hashStrings, verdictKey } from './fingerprint.js';

/** 备份后缀，如 `.bak.1720000000000`。 */
function backupSuffix(): string {
	return `.bak.${Date.now()}`;
}

/**
 * 加载 checkpoint。不存在 → null；JSON 损坏 / schema 不匹配 → null 并告警。
 */
export function loadCheckpoint(path: string): CheckpointData | null {
	if (!existsSync(path)) return null;

	let raw: string;
	try {
		raw = readFileSync(path, 'utf-8');
	} catch (e) {
		console.error(
			`[warn] 读取 checkpoint 失败 ${path}: ${e instanceof Error ? e.message : String(e)}`,
		);
		return null;
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		console.error(`[warn] checkpoint 文件 JSON 损坏 ${path}，将重新开始`);
		return null;
	}

	const parsed = CheckpointDataSchema.safeParse(data);
	if (!parsed.success) {
		console.error(
			`[warn] checkpoint 校验失败 ${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}，将重新开始`,
		);
		return null;
	}
	return parsed.data;
}

/**
 * 原子保存：先写 `*.tmp` 再 rename，保证文件不出现半写状态。
 * 失败仅告警，不阻断流水线（降级为无恢复模式）。
 */
export function saveCheckpoint(path: string, data: CheckpointData): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = join(dirname(path), `${basename(path)}.tmp`);
		const payload = JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2);
		writeFileSync(tmp, payload, 'utf-8');
		renameSync(tmp, path);
	} catch (e) {
		console.error(
			`[warn] checkpoint 保存失败 ${path}: ${e instanceof Error ? e.message : String(e)}（继续执行，但本次进度无法恢复）`,
		);
	}
}

/** 幂等清空。 */
export function clearCheckpoint(path: string): void {
	if (!existsSync(path)) return;
	try {
		unlinkSync(path);
	} catch (e) {
		console.error(
			`[warn] checkpoint 删除失败 ${path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** 备份并移走旧文件（作废时调用），失败只告警。 */
export function invalidateCheckpoint(path: string, reason: string): void {
	if (!existsSync(path)) return;
	try {
		const backup = path + backupSuffix();
		renameSync(path, backup);
		console.error(`[warn] checkpoint 作废（${reason}），旧文件已备份至 ${backup}`);
	} catch (e) {
		console.error(
			`[warn] checkpoint 作废失败 ${path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * 运行期 checkpoint 句柄：持有 `CheckpointData`，提供裁决缓存读写与保存。
 *
 * 设计要点——**缓存以「参与比较的 url 集合」为主键**，与分组/批次划分方式解耦：
 * 只要某组图片的 url 集合不变，其裁决结果就与 `m`、`targetDir`、`batchSize`、
 * `bucketBoundaries`、`pathGlobs`、`standard` 无关，可安全复用。
 */
export class Checkpoint {
	readonly data: CheckpointData;
	private readonly path: string;
	private readonly index: Map<string, Verdict>;
	private reused = 0;
	private recorded = 0;

	private constructor(data: CheckpointData, path: string) {
		this.data = data;
		this.path = path;
		this.index = new Map();
		for (const v of data.verdicts) {
			this.index.set(verdictKey(v.urls), v);
		}
	}

	/** 基于当前运行参数新建一个空 checkpoint。 */
	static create(
		path: string,
		init: Omit<CheckpointData, 'verdicts' | 'toRemoveUrls' | 'move' | 'completed'>,
	): Checkpoint {
		const data: CheckpointData = {
			...init,
			verdicts: [],
			toRemoveUrls: null,
			move: null,
			completed: false,
		};
		return new Checkpoint(data, path);
	}

	/** 从已加载的 checkpoint 恢复（调用方已完成有效性判断）。 */
	static resumed(data: CheckpointData, path: string): Checkpoint {
		return new Checkpoint(data, path);
	}

	/** 查询某组 url 是否已有裁决；命中则计入 reused。 */
	lookup(urls: readonly string[]): Verdict | null {
		const hit = this.index.get(verdictKey(urls));
		if (hit) this.reused++;
		return hit ?? null;
	}

	/** 记录一条新裁决并立即落盘（保证中断后不丢）。 */
	record(verdict: Verdict): void {
		const key = verdictKey(verdict.urls);
		if (this.index.has(key)) return;
		const v: Verdict = { ...verdict, urls: [...verdict.urls].sort() };
		this.index.set(key, v);
		this.data.verdicts.push(v);
		this.recorded++;
		this.save();
	}

	/** 已缓存的裁决总数。 */
	get size(): number {
		return this.index.size;
	}

	/** 本次运行命中缓存的次数。 */
	get reusedCount(): number {
		return this.reused;
	}

	/** 本次运行新增裁决的次数。 */
	get recordedCount(): number {
		return this.recorded;
	}

	get filePath(): string {
		return this.path;
	}

	/** 更新 params（用于把本次运行的实际参数写回，便于下次比对与展示）。 */
	updateParams(params: CheckpointData['params']): void {
		this.data.params = params;
	}

	/** 记录选择阶段结果。 */
	setToRemoveUrls(urls: readonly string[]): void {
		this.data.toRemoveUrls = [...urls];
		this.save();
	}

	/** 清除已记录的选择/移动结果（重跑选择阶段前调用）。 */
	clearSelection(): void {
		this.data.toRemoveUrls = null;
		this.data.move = null;
		this.save();
	}

	/** 重置移动进度（targetDir / dryRun 变化时）。 */
	resetMove(targetDir: string): void {
		this.data.move = { targetDir, results: [], nextIndex: 0 };
		this.save();
	}

	get move(): CheckpointData['move'] {
		return this.data.move;
	}

	appendMoveResult(
		targetDir: string,
		result: NonNullable<CheckpointData['move']>['results'][number],
	): void {
		if (!this.data.move || this.data.move.targetDir !== targetDir) {
			this.data.move = { targetDir, results: [], nextIndex: 0 };
		}
		this.data.move.results.push(result);
		this.data.move.nextIndex = this.data.move.results.length;
		this.save();
	}

	markCompleted(): void {
		this.data.completed = true;
		this.save();
	}

	/** 立即落盘当前状态（信号处理与异常路径使用）。 */
	save(): void {
		saveCheckpoint(this.path, this.data);
	}
}

/** 图片集合 hash（sorted urls）。 */
export function imageSetHash(urls: readonly string[]): string {
	return hashStrings(urls);
}
