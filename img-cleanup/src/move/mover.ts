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
	opts: {
		dryRun: boolean;
		onCollision: CollisionMode;
	},
): Promise<MoveResult[]> {
	const targetPath = resolve(targetDir);
	if (!opts.dryRun && !existsSync(targetPath)) {
		mkdirSync(targetPath, { recursive: true });
	}

	const results: MoveResult[] = [];
	for (const img of images) {
		const localPath = toLocalPath(img.url);
		if (!localPath) {
			results.push({
				path: img.url,
				status: 'skipped',
				error: '非本地文件 URL',
			});
			continue;
		}

		if (!existsSync(localPath)) {
			results.push({
				path: localPath,
				status: 'skipped',
				error: '源文件不存在',
			});
			continue;
		}

		const baseTarget = join(targetPath, basename(localPath));
		let target = baseTarget;

		if (existsSync(baseTarget)) {
			if (opts.onCollision === 'rename') {
				target = await resolveTargetPath(targetPath, localPath);
			} else if (opts.onCollision === 'skip') {
				results.push({
					path: localPath,
					targetPath: baseTarget,
					status: 'skipped',
					error: '目标目录已存在同名文件',
				});
				continue;
			} else {
				// abort
				results.push({
					path: localPath,
					targetPath: baseTarget,
					status: 'skipped',
					error: '目标目录已存在同名文件，操作中止',
				});
				return results;
			}
		}

		if (opts.dryRun) {
			results.push({
				path: localPath,
				targetPath: target,
				status: 'dry-run',
			});
			continue;
		}

		try {
			await rename(localPath, target);
			const newUrl = toFileUrl(target);
			const changes = updateRecordUrl(img.url, newUrl);
			await updateLinksForMove(img.url, newUrl);
			const result: MoveResult = {
				path: localPath,
				targetPath: target,
				status: 'moved',
			};
			if (changes === 0) result.error = '未找到对应的数据库记录';
			results.push(result);
		} catch (e) {
			results.push({
				path: localPath,
				status: 'failed',
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
	return results;
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
