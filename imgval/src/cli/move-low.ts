import { AppError } from '@llm-image/shared';
import { Command } from 'commander';
import { existsSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { fileUrlToPath, toFileUrl } from '../util/url.js';
import {
	findLowValueFiles,
	findLowestNFiles,
	countDistinctFiles,
	getMaxValueByUrl,
	updateRecordUrl,
	type LowValueFile,
} from '../storage/repository.move.js';
import { renderMoveResults, type MoveResult } from './output/table.js';
import { FORMAT_FLAGS, FORMAT_DESCRIPTION, isJsonFormat } from './output/format.js';

type CollisionMode = 'skip' | 'rename' | 'abort' | 'keep-max';

const COLLISION_MODES: CollisionMode[] = ['skip', 'rename', 'abort', 'keep-max'];

interface MoveLowOptions {
	limit?: string;
	dryRun?: boolean;
	format?: string;
	onCollision?: string;
	path?: string[];
}

function toLocalPath(url: string): string | null {
	if (!url.startsWith('file://')) return null;
	try {
		return fileUrlToPath(url);
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

export const moveLowCommand = new Command('move-low')
	.description('将数据库记录中最高价值低于阈值的图片移动到指定目录')
	.argument('<threshold>', '最高价值阈值，图片最大价值低于该值则移动')
	.argument('<target-dir>', '目标目录路径')
	.option('--limit <n>', '最多移动的图片数量 (0 表示不限制)', '0')
	.option('--dry-run', '仅预览要移动的文件，不实际执行')
	.option('--on-collision <mode>', '目标已有同名文件时的处理方式: skip|rename|abort|keep-max', 'skip')
	.option(
		'--path <glob>',
		'仅处理路径匹配该 glob 的图片 (支持 * ** ?，可重复)',
		(val: string, prev: string[]) => [...prev, val],
		[] as string[],
	)
	.option(FORMAT_FLAGS, FORMAT_DESCRIPTION, 'text')
	.action(
		async (threshold: string, targetDir: string, opts: MoveLowOptions): Promise<void> => {
			try {
				loadEnv();
				bootstrap();

				const collisionMode = (opts.onCollision ?? 'skip') as CollisionMode;
				if (!COLLISION_MODES.includes(collisionMode)) {
					throw new AppError(
						'INVALID_COLLISION_MODE',
						`无效的同名处理方式: ${collisionMode} (可选: ${COLLISION_MODES.join('|')})`,
						1,
					);
				}

				const limit = parseInt(opts.limit ?? '0', 10);
				const dryRun = opts.dryRun ?? false;
				const pathGlobs = (opts.path ?? []).filter((g) => g.length > 0);

				const pctMatch = threshold.match(/^(\d+(?:\.\d+)?)%$/);
				let files: LowValueFile[];
				if (pctMatch) {
					const pctStr = pctMatch[1]!;
					const pct = parseFloat(pctStr);
					if (pct <= 0 || pct > 100) {
						throw new AppError(
							'INVALID_THRESHOLD',
							`百分比阈值须在 0~100 之间: ${threshold}`,
							1,
						);
					}
					const totalFiles = countDistinctFiles(pathGlobs);
					const n = Math.ceil(totalFiles * pct / 100);
					if (n === 0) {
						if (isJsonFormat(opts.format)) {
							console.log('[]');
						} else {
							console.log(renderMoveResults([]));
						}
						return;
					}
					files = findLowestNFiles(n, pathGlobs);
				} else {
					const maxThreshold = parseFloat(threshold);
					if (!Number.isFinite(maxThreshold) || maxThreshold <= 0) {
						throw new AppError('INVALID_THRESHOLD', `无效的阈值: ${threshold}`, 1);
					}
					files = findLowValueFiles(maxThreshold, pathGlobs);
				}
				if (limit > 0) files = files.slice(0, limit);

				if (files.length === 0) {
					if (isJsonFormat(opts.format)) {
						console.log('[]');
					} else {
						console.log(renderMoveResults([]));
					}
					return;
				}

				const targetPath = resolve(targetDir);
				if (!dryRun && !existsSync(targetPath)) {
					mkdirSync(targetPath, { recursive: true });
				}

				const results: MoveResult[] = [];
				for (const file of files) {
					const localPath = toLocalPath(file.url);
					if (!localPath) {
						results.push({
							path: file.url,
							maxValue: file.maxValue,
							status: 'skipped',
							error: '非本地文件 URL',
						});
						continue;
					}

					if (!existsSync(localPath)) {
						results.push({
							path: localPath,
							maxValue: file.maxValue,
							status: 'skipped',
							error: '源文件不存在',
						});
						continue;
					}

					const baseTarget = join(targetPath, basename(localPath));
					let target = baseTarget;

					if (existsSync(baseTarget)) {
						if (collisionMode === 'rename') {
							target = await resolveTargetPath(targetPath, localPath);
						} else if (collisionMode === 'skip') {
							results.push({
								path: localPath,
								targetPath: baseTarget,
								maxValue: file.maxValue,
								status: 'skipped',
								error: '目标目录已存在同名文件',
							});
							continue;
						} else if (collisionMode === 'abort') {
							if (isJsonFormat(opts.format)) {
								console.log(JSON.stringify(results, null, 2));
							} else {
								console.log(renderMoveResults(results));
							}
							throw new AppError(
								'COLLISION_ABORT',
								`目标目录已存在同名文件，操作中止: ${baseTarget}`,
								1,
							);
						} else {
							// keep-max: 高价值者进入目标，低价值者被覆盖/删除
							const existingMax = getMaxValueByUrl(toFileUrl(baseTarget));
							if (existingMax === null) {
								results.push({
									path: localPath,
									targetPath: baseTarget,
									maxValue: file.maxValue,
									status: 'skipped',
									error: '目标文件无估值记录，无法比较价值',
								});
								continue;
							}
							if (file.maxValue <= existingMax) {
								results.push({
									path: localPath,
									targetPath: baseTarget,
									maxValue: file.maxValue,
									status: 'skipped',
									error: `目标文件价值更高 (¥${existingMax.toFixed(2)})`,
								});
								continue;
							}
							// 源文件价值更高 → 覆盖目标中较低价值的文件
						}
					}

					if (dryRun) {
						results.push({
							path: localPath,
							targetPath: target,
							maxValue: file.maxValue,
							status: 'dry-run',
						});
						continue;
					}

					try {
						await rename(localPath, target);
						const changes = updateRecordUrl(file.url, toFileUrl(target));
						const result: MoveResult = {
							path: localPath,
							targetPath: target,
							maxValue: file.maxValue,
							status: 'moved',
						};
						if (changes === 0) result.error = '未找到对应的数据库记录';
						results.push(result);
					} catch (e) {
						results.push({
							path: localPath,
							maxValue: file.maxValue,
							status: 'failed',
							error: e instanceof Error ? e.message : String(e),
						});
					}
				}

				const moved = results.filter((r) => r.status === 'moved').length;
				if (isJsonFormat(opts.format)) {
					console.log(JSON.stringify(results, null, 2));
				} else {
					console.log(renderMoveResults(results));
					if (dryRun) {
						console.log(`\n(干运行模式，未实际移动文件)`);
					} else {
						console.log(`成功移动 ${moved} 个文件`);
					}
				}
			} catch (e) {
				if (e instanceof AppError) {
					console.error(e.message);
					process.exit(e.exitCode);
				}
				throw e;
			}
		},
	);
