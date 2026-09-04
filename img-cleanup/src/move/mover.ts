import { existsSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
	openFileIndexDb,
	FileIndexRepo,
	getFileIndexDbPath,
	blake3HexFile,
	fileUrlToPath,
} from '@llm-image/file-index';
import { stat } from 'node:fs/promises';
import type { ImageEntry } from '../storage/types.js';
import { fileUrlToPath as localFileUrlToPath, toFileUrl } from '../util/url.js';
import { updateRecordUrl } from '../storage/repository.valuation.js';
import type { Checkpoint } from '../checkpoint/index.js';

export interface MoveResult {
	path: string;
	targetPath?: string;
	status: 'moved' | 'dry-run' | 'skipped' | 'failed';
	error?: string;
}

type CollisionMode = 'skip' | 'rename' | 'abort';

let repo: FileIndexRepo | null = null;

function getFileIndexRepo(): FileIndexRepo {
	if (!repo) {
		repo = new FileIndexRepo(openFileIndexDb(getFileIndexDbPath(process.env.IMGDATA_DIR)));
	}
	return repo;
}

/** For testing: inject an in-memory repo. */
export function setFileIndexRepo(r: FileIndexRepo | null): void {
	repo = r;
}

function toLocalPath(url: string): string | null {
	if (!url.startsWith('file://')) return null;
	try {
		return localFileUrlToPath(url);
	} catch {
		return null;
	}
}

/** Pick a non-colliding path inside targetDir for sourcePath (name_1.ext, name_2.ext, ...). */
async function resolveTargetPath(targetDir: string, sourcePath: string): Promise<string> {
	const ext = extname(sourcePath);
	const base = basename(sourcePath, ext);
	let candidate = join(targetDir, `${base}${ext}`);
	for (let i = 1; existsSync(candidate); i++) {
		candidate = join(targetDir, `${base}_${i}${ext}`);
	}
	return candidate;
}

export interface MoveOptions {
	dryRun: boolean;
	onCollision: CollisionMode;
	/**
	 * 中断恢复句柄。提供时每个文件移动完成后即时落盘；重跑时跳过已记录的文件。
	 *
	 * 匹配以「源路径」为准（而非下标），因此 `toRemove` 顺序变化也不会重复移动。
	 * `targetDir` 或 `dryRun` 与 checkpoint 中记录不同时，移动进度会被重置。
	 */
	checkpoint?: Checkpoint;
}

/**
 * Move the given images to targetDir. Updates imgval.db URLs and the
 * file-index after each successful move.
 *
 * Collision handling matches img-val's move-low:
 * - skip: skip if target file exists
 * - rename: auto-rename (name_1.ext, name_2.ext, ...)
 * - abort: stop on first collision
 */
export async function moveImages(
	images: ImageEntry[],
	targetDir: string,
	opts: MoveOptions,
): Promise<{ results: MoveResult[]; resumedSkipped: number }> {
	const { dryRun, onCollision, checkpoint } = opts;
	const targetPath = resolve(targetDir);
	if (!dryRun && !existsSync(targetPath)) {
		mkdirSync(targetPath, { recursive: true });
	}

	// Decide whether prior move progress is reusable for this run.
	const prior = checkpoint?.move ?? null;
	const reusable =
		prior !== null && prior.targetDir === targetPath && sameDryRunMode(checkpoint, dryRun);
	if (prior && !reusable) {
		checkpoint?.resetMove(targetPath);
	}
	const done = new Set<string>(
		reusable && prior ? prior.results.map((r) => r.path) : [],
	);
	const results: MoveResult[] = [];
	if (reusable && prior) {
		for (const r of prior.results) {
			results.push(
				r.targetPath === undefined
					? { path: r.path, status: r.status, ...(r.error !== undefined ? { error: r.error } : {}) }
					: { path: r.path, targetPath: r.targetPath, status: r.status, ...(r.error !== undefined ? { error: r.error } : {}) },
			);
		}
	}
	let resumedSkipped = 0;

	for (const img of images) {
		const localPath = toLocalPath(img.url);
		if (!localPath) {
			const r: MoveResult = { path: img.url, status: 'skipped', error: '非本地文件 URL' };
			results.push(r);
			checkpoint?.appendMoveResult(targetPath, r);
			continue;
		}

		// Already handled in a previous (interrupted) run — do not touch it again.
		if (done.has(localPath)) {
			resumedSkipped++;
			continue;
		}

		const baseTarget = join(targetPath, basename(localPath));

		if (!existsSync(localPath)) {
			// 上次中断可能发生在 rename 与数据库更新之间：源已不在、目标已在 → 补做 DB 更新。
			if (!dryRun && existsSync(baseTarget)) {
				const newUrl = toFileUrl(baseTarget);
				const changes = updateRecordUrl(img.url, newUrl);
				await updateLinksForMove(img.url, newUrl);
				const r: MoveResult = {
					path: localPath,
					targetPath: baseTarget,
					status: 'moved',
					error: changes > 0 ? '源文件已不在，按目标存在补做数据库更新' : '未找到对应的数据库记录',
				};
				results.push(r);
				checkpoint?.appendMoveResult(targetPath, r);
				continue;
			}
			const r: MoveResult = { path: localPath, status: 'skipped', error: '源文件不存在' };
			results.push(r);
			checkpoint?.appendMoveResult(targetPath, r);
			continue;
		}

		let target = baseTarget;

		if (existsSync(baseTarget)) {
			if (onCollision === 'rename') {
				target = await resolveTargetPath(targetPath, localPath);
			} else if (onCollision === 'skip') {
				const r: MoveResult = {
					path: localPath,
					targetPath: baseTarget,
					status: 'skipped',
					error: '目标目录已存在同名文件',
				};
				results.push(r);
				checkpoint?.appendMoveResult(targetPath, r);
				continue;
			} else {
				// abort
				const r: MoveResult = {
					path: localPath,
					targetPath: baseTarget,
					status: 'skipped',
					error: '目标目录已存在同名文件，操作中止',
				};
				results.push(r);
				checkpoint?.appendMoveResult(targetPath, r);
				return { results, resumedSkipped };
			}
		}

		if (dryRun) {
			const r: MoveResult = { path: localPath, targetPath: target, status: 'dry-run' };
			results.push(r);
			checkpoint?.appendMoveResult(targetPath, r);
			continue;
		}

		try {
			await rename(localPath, target);
			const newUrl = toFileUrl(target);
			const changes = updateRecordUrl(img.url, newUrl);
			await updateLinksForMove(img.url, newUrl);
			const r: MoveResult = { path: localPath, targetPath: target, status: 'moved' };
			if (changes === 0) r.error = '未找到对应的数据库记录';
			results.push(r);
			checkpoint?.appendMoveResult(targetPath, r);
		} catch (e) {
			const r: MoveResult = {
				path: localPath,
				status: 'failed',
				error: e instanceof Error ? e.message : String(e),
			};
			results.push(r);
			checkpoint?.appendMoveResult(targetPath, r);
		}
	}

	return { results, resumedSkipped };
}

/** dryRun 是否仍与 checkpoint 记录一致（不一致则移动进度不可复用）。 */
function sameDryRunMode(checkpoint: Checkpoint | undefined, dryRun: boolean): boolean {
	if (!checkpoint) return false;
	return checkpoint.data.params.dryRun === dryRun;
}

/** Update file-index links after a move: invalidate old URL, register new URL. */
async function updateLinksForMove(oldUrl: string, newUrl: string): Promise<void> {
	try {
		const r = getFileIndexRepo();
		if (r.findByUrl(newUrl)) {
			r.updateStatus(newUrl, 0);
		}
		r.updateStatus(oldUrl, 0);
		await registerLinkForFile(newUrl, fileUrlToPath(newUrl));
	} catch (e) {
		console.error(`[warn] file-index 移动更新失败: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Register a local file's link in the file-index (best-effort). */
async function registerLinkForFile(url: string, filePath: string): Promise<void> {
	try {
		const blake3 = await blake3HexFile(filePath);
		const { size } = await stat(filePath);
		getFileIndexRepo().register({ url, blake3, size: BigInt(size), status: 3 });
	} catch (e) {
		console.error(`[warn] file-index 注册失败: ${e instanceof Error ? e.message : String(e)}`);
	}
}
