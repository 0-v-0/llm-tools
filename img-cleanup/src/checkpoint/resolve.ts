import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { CheckpointData } from './types.js';
import { Checkpoint, imageSetHash, invalidateCheckpoint, loadCheckpoint } from './store.js';
import { computeCacheKey, BATCH_PROMPT_VERSION } from './fingerprint.js';
import { confirmForcedReuse, type ConfirmPrompt } from './confirm.js';

/** 本次运行的输入快照（决定分组、批次与移动行为的全部参数）。 */
export interface RunInputs {
	m: number;
	mArg: string;
	batchSize: number;
	bucketBoundaries: number[];
	pathGlobs: string[];
	standardName: string | null;
	targetDir: string;
	dryRun: boolean;
	imageUrls: string[];
	provider: string;
	model: string;
	maxImageDimension: number;
}

export interface ResolveResult {
	checkpoint: Checkpoint;
	/** 人类可读的复用/作废说明（供 CLI 打印）。 */
	notes: string[];
	/** 是否从已有 checkpoint 恢复。 */
	resumed: boolean;
	/** 恢复时携带的已缓存裁决数。 */
	cachedVerdicts: number;
}

/** 解析 checkpoint 路径：CLI 覆盖 > 配置 > 默认；相对路径以 IMGDATA_DIR 为基准。 */
export function resolveCheckpointPath(
	explicit: string | undefined,
	configured: string | undefined,
	defaultPath: string,
	imgDataDir: string | undefined,
): string {
	const candidate = explicit ?? configured;
	if (!candidate) return defaultPath;
	if (isAbsolute(candidate)) return candidate;
	return resolvePath(imgDataDir ?? process.cwd(), candidate);
}

/** 当前运行的 cacheKey（裁判 + 图像形态 + prompt 版本）。 */
export function cacheKeyFor(inputs: RunInputs): string {
	return computeCacheKey({
		provider: inputs.provider,
		model: inputs.model,
		temperature: 0,
		maxImageDimension: inputs.maxImageDimension,
		promptVersion: BATCH_PROMPT_VERSION,
	});
}

function freshCheckpoint(path: string, inputs: RunInputs, now: string): Checkpoint {
	return Checkpoint.create(path, {
		version: 1,
		createdAt: now,
		updatedAt: now,
		cacheKey: cacheKeyFor(inputs),
		params: {
			m: inputs.m,
			mArg: inputs.mArg,
			totalImages: inputs.imageUrls.length,
			batchSize: inputs.batchSize,
			bucketBoundaries: [...inputs.bucketBoundaries],
			pathGlobs: [...inputs.pathGlobs],
			standardName: inputs.standardName,
			targetDir: inputs.targetDir,
			dryRun: inputs.dryRun,
			imageSetHash: imageSetHash(inputs.imageUrls),
		},
	});
}

/**
 * 分层复用决策。
 *
 * 裁决缓存以「参与比较的 url 集合」为主键，因此以下参数变化**不影响**复用：
 * `m`、`targetDir`、`batchSize`、`bucketBoundaries`、`--path`、图片集合增删
 * ——它们只改变分组/批次划分或下游阶段，已完成的视觉比较结果依然成立。
 *
 * 只有「裁判换了」（`cacheKey`：provider/model/maxImageDimension/prompt 版本）
 * 才整体作废。`standard` 变化会改变分组与候选集合，但 LLM 从未看到估值信息，
 * 视觉裁决本身仍成立 —— 按用户要求：显示警告并要求确认，允许强制复用。
 */
export async function resolveCheckpoint(
	path: string,
	inputs: RunInputs,
	opts: { force?: boolean; prompt?: ConfirmPrompt; now?: string } = {},
): Promise<ResolveResult> {
	const now = opts.now ?? new Date().toISOString();
	const existing = loadCheckpoint(path);

	if (!existing) {
		return {
			checkpoint: freshCheckpoint(path, inputs, now),
			notes: [],
			resumed: false,
			cachedVerdicts: 0,
		};
	}

	// 裁判变更 → 旧裁决不可信，整体作废
	if (existing.cacheKey !== cacheKeyFor(inputs)) {
		invalidateCheckpoint(path, `裁判变更 ${existing.cacheKey} → ${cacheKeyFor(inputs)}`);
		return {
			checkpoint: freshCheckpoint(path, inputs, now),
			notes: ['裁判（provider/model/图像尺寸/prompt 版本）已变更，旧裁决作废，重新开始'],
			resumed: false,
			cachedVerdicts: 0,
		};
	}

	const notes: string[] = [];
	const oldStd = existing.params.standardName;
	const newStd = inputs.standardName;

	if (oldStd !== newStd) {
		const confirmOpts: { force?: boolean; prompt?: ConfirmPrompt } = {};
		if (opts.force !== undefined) confirmOpts.force = opts.force;
		if (opts.prompt !== undefined) confirmOpts.prompt = opts.prompt;
		const ok = await confirmForcedReuse(oldStd, newStd, confirmOpts);
		if (!ok) {
			invalidateCheckpoint(path, `standard 变更且未确认复用 ${oldStd ?? '(全部)'} → ${newStd ?? '(全部)'}`);
			return {
				checkpoint: freshCheckpoint(path, inputs, now),
				notes: [...notes, `standard 变更未确认，checkpoint 重新开始`],
				resumed: false,
				cachedVerdicts: 0,
			};
		}
		notes.push(
			`standard 变更 ${oldStd ?? '(全部)'} → ${newStd ?? '(全部)'}，已确认强制复用 ${existing.verdicts.length} 条裁决`,
		);
	}

	// 软参数变化：照常复用裁决，仅提示受影响的下游阶段
	if (existing.params.m !== inputs.m) {
		notes.push(`m ${existing.params.m} → ${inputs.m}：复用批次裁决，锦标赛按新阈值重算`);
	}
	if (existing.params.batchSize !== inputs.batchSize) {
		notes.push(`batchSize ${existing.params.batchSize} → ${inputs.batchSize}：重新分批，相同 url 组合仍命中缓存`);
	}
	if (existing.params.imageSetHash !== imageSetHash(inputs.imageUrls)) {
		notes.push(
			`图片集合变化（${existing.params.totalImages} → ${inputs.imageUrls.length} 张）：仅新增/重组的批次需要调用 LLM`,
		);
	}
	if (existing.params.targetDir !== inputs.targetDir) {
		notes.push(`目标目录 ${existing.params.targetDir} → ${inputs.targetDir}：移动进度重置`);
	}
	if (existing.params.dryRun !== inputs.dryRun) {
		notes.push(`dry-run 模式切换为 ${String(inputs.dryRun)}：移动进度重置`);
	}

	const checkpoint = Checkpoint.resumed(existing, path);
	// 先判定选择阶段结论是否仍适用（必须在 updateParams 覆盖 params 之前）
	const selectionStale = needsSelectionRerun(existing, inputs);

	checkpoint.updateParams({
		m: inputs.m,
		mArg: inputs.mArg,
		totalImages: inputs.imageUrls.length,
		batchSize: inputs.batchSize,
		bucketBoundaries: [...inputs.bucketBoundaries],
		pathGlobs: [...inputs.pathGlobs],
		standardName: inputs.standardName,
		targetDir: inputs.targetDir,
		dryRun: inputs.dryRun,
		imageSetHash: imageSetHash(inputs.imageUrls),
	});
	if (selectionStale) {
		checkpoint.clearSelection();
	}

	return {
		checkpoint,
		notes,
		resumed: true,
		cachedVerdicts: existing.verdicts.length,
	};
}

/**
 * 判断选择阶段结论是否仍适用于本次运行。
 *
 * `toRemoveUrls` 只有在 `m`、图片集合、standard 都未变时才可能一致；
 * 任一变化都意味着要重新走一遍选择（裁决仍会从缓存命中）。
 */
function needsSelectionRerun(existing: CheckpointData, inputs: RunInputs): boolean {
	if (existing.toRemoveUrls === null) return false;
	return (
		existing.params.m !== inputs.m ||
		existing.params.standardName !== inputs.standardName ||
		existing.params.imageSetHash !== imageSetHash(inputs.imageUrls) ||
		existing.params.batchSize !== inputs.batchSize ||
		!sameNumbers(existing.params.bucketBoundaries, inputs.bucketBoundaries) ||
		!sameStrings(existing.params.pathGlobs, inputs.pathGlobs)
	);
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	const sa = [...a].sort();
	const sb = [...b].sort();
	return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}
