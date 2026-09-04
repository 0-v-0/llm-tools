import { AppError, createProvider, resolveProviderConfig } from '@llm-image/shared';
import { Command } from 'commander';
import { resolve as resolvePath } from 'node:path';
import { loadEnv } from '../config/env.js';
import { loadConfig } from '../config/config.js';
import { bootstrap, getCheckpointPath } from '../config/paths.js';
import { getAllImages, countDistinctFiles } from '../storage/repository.valuation.js';
import { runCleanupPipeline, parseM } from '../selection/engine.js';
import { moveImages } from '../move/mover.js';
import {
	clearCheckpoint,
	resolveCheckpoint,
	resolveCheckpointPath,
} from '../checkpoint/index.js';
import {
	renderCleanupSummary,
	renderMoveResults,
	renderToRemoveList,
} from './output/table.js';
import { renderCleanupJson, renderMoveResultsJson } from './output/json.js';
import { FORMAT_FLAGS, FORMAT_DESCRIPTION, isJsonFormat } from './output/format.js';

interface CleanupOptions {
	batchSize?: string;
	path?: string[];
	dryRun?: boolean;
	format?: string;
	onCollision?: string;
	standard?: string;
	verbose?: boolean;
	resume?: boolean;
	noResume?: boolean;
	force?: boolean;
	checkpoint?: string;
}

const COLLISION_MODES = ['skip', 'rename', 'abort'] as const;
type CollisionMode = (typeof COLLISION_MODES)[number];

export const cleanupCommand = new Command('cleanup')
	.description('按数据库估值分组，LLM 批次比较后选出最不值得保留的图片移到指定目录')
	.argument('<m>', '要移走的图片数量（绝对数字如 50，或百分比如 10%）')
	.argument('<target-dir>', '目标目录路径')
	.option('--batch-size <n>', '每个批次中图片数量 n (默认 2)', '2')
	.option('--path <glob>', '仅处理路径匹配该 glob 的图片 (可重复)', (val: string, prev: string[]) => [...prev, val], [] as string[])
	.option('--dry-run', '仅预览，不实际移动文件')
	.option('--on-collision <mode>', '目标已有同名文件时的处理方式: skip|rename|abort', 'skip')
	.option('--standard <name>', '仅处理指定估值标准的图片')
	.option('--resume', '必须从已有 checkpoint 恢复（不存在则报错）')
	.option('--no-resume', '忽略已有 checkpoint，全新开始')
	.option('--force', 'standard 变更时跳过交互确认，强制复用已完成的比较结果')
	.option('--checkpoint <path>', '自定义 checkpoint 文件路径（默认 <IMGDATA_DIR>/imgcleanup-checkpoint.json）')
	.option(FORMAT_FLAGS, FORMAT_DESCRIPTION, 'text')
	.option('--verbose', '输出详细进度信息')
	.action(
		async (mArg: string, targetDir: string, opts: CleanupOptions): Promise<void> => {
			try {
				const env = loadEnv();
				bootstrap(process.env.IMGDATA_DIR);
				const config = loadConfig();
				// Override batch size if provided
				if (opts.batchSize) {
					const bs = parseInt(opts.batchSize, 10);
					if (!Number.isFinite(bs) || bs < 2) {
						throw new AppError('INVALID_BATCH_SIZE', `批次大小须 ≥ 2: ${opts.batchSize}`, 2);
					}
					config.batchSize = bs;
				}

				const collisionMode = (opts.onCollision ?? 'skip') as CollisionMode;
				if (!COLLISION_MODES.includes(collisionMode)) {
					throw new AppError(
						'INVALID_COLLISION_MODE',
						`无效的同名处理方式: ${collisionMode} (可选: ${COLLISION_MODES.join('|')})`,
						2,
					);
				}

				const pathGlobs = (opts.path ?? []).filter((g) => g.length > 0);
				const dryRun = opts.dryRun ?? false;
				const verbose = opts.verbose ?? false;
				const standardName = opts.standard;
				const jsonFormat = isJsonFormat(opts.format);

				const checkpointPath = resolveCheckpointPath(
					opts.checkpoint,
					config.checkpointEnabled ? config.checkpointPath : undefined,
					getCheckpointPath(process.env.IMGDATA_DIR),
					process.env.IMGDATA_DIR,
				);

				// Query images from DB
				const images = getAllImages(pathGlobs, standardName);

				if (images.length === 0) {
					if (jsonFormat) {
						console.log(JSON.stringify({ toRemove: [], totalImages: 0 }, null, 2));
					} else {
						console.log('数据库中没有匹配的图片记录');
					}
					return;
				}

				// Parse m
				const totalForM = pathGlobs.length > 0 || standardName
					? images.length
					: countDistinctFiles(pathGlobs);
				const m = parseM(mArg, totalForM);

				if (verbose) {
					console.error(`[debug] 数据库共 ${images.length} 张图片，目标移走 ${m} 张`);
				}

				// Create LLM provider
				const provider = createProvider(resolveProviderConfig(config.llm, env));

				// Progress callback
				const onProgress = verbose
					? (msg: string) => console.error(`[progress] ${msg}`)
					: undefined;

				// ---- Checkpoint (中断恢复) ----
				let checkpoint: import('../checkpoint/index.js').Checkpoint | undefined;
				if (config.checkpointEnabled) {
					if (opts.noResume) {
						clearCheckpoint(checkpointPath);
					}
					const resolved = await resolveCheckpoint(
						checkpointPath,
						{
							m,
							mArg,
							batchSize: config.batchSize,
							bucketBoundaries: [...config.bucketBoundaries],
							pathGlobs,
							standardName: standardName ?? null,
							targetDir: resolvePath(targetDir),
							dryRun,
							imageUrls: images.map((i) => i.url),
							provider: provider.provider,
							model: provider.model,
							maxImageDimension: config.maxImageDimension,
						},
						opts.force ? { force: true } : {},
					);
					checkpoint = resolved.checkpoint;
					for (const note of resolved.notes) {
						console.error(`[checkpoint] ${note}`);
					}
					if (resolved.resumed) {
						console.error(
							`[checkpoint] 恢复自 ${checkpointPath}（已缓存 ${resolved.cachedVerdicts} 条比较结果）`,
						);
					}
				}

				// Ctrl+C / kill：先落盘再退出（kill -9 无法捕获，依赖每步即时落盘）
				const onSignal = (signal: string) => {
					console.error(`\n[interrupt] 收到 ${signal}，已保存断点，可用相同命令续跑`);
					checkpoint?.save();
					process.exit(130);
				};
				process.once('SIGINT', () => onSignal('SIGINT'));
				process.once('SIGTERM', () => onSignal('SIGTERM'));

				// Run the cleanup pipeline
				const result = await runCleanupPipeline(images, m, config, provider, {
					...(checkpoint !== undefined ? { checkpoint } : {}),
					...(onProgress !== undefined ? { onProgress } : {}),
				});

				if (result.toRemove.length === 0) {
					if (jsonFormat) {
						console.log(renderCleanupJson(result));
					} else {
						console.log(renderCleanupSummary(result));
						console.log('\n无需移走的图片');
					}
					checkpoint?.markCompleted();
					clearCheckpoint(checkpointPath);
					return;
				}

				// Show results before moving
				if (jsonFormat) {
					console.log(renderCleanupJson(result));
				} else {
					console.log(renderCleanupSummary(result));
					if (verbose || dryRun) {
						console.log(renderToRemoveList(result));
					}
				}

				// Move files
				const { results: moveResults, resumedSkipped } = await moveImages(result.toRemove, targetDir, {
					dryRun,
					onCollision: collisionMode,
					...(checkpoint !== undefined ? { checkpoint } : {}),
				});
				if (resumedSkipped > 0) {
					console.error(`[checkpoint] 跳过上次已处理的 ${resumedSkipped} 个文件`);
				}

				if (jsonFormat) {
					console.log(renderMoveResultsJson(moveResults));
				} else {
					console.log(renderMoveResults(moveResults));
					if (dryRun) {
						console.log('\n(干运行模式，未实际移动文件)');
					}
				}

				if (checkpoint) {
					if (dryRun) {
						// 干运行不落 completed，真实执行时仍可复用全部裁决与移动进度
						checkpoint.save();
					} else {
						checkpoint.markCompleted();
						clearCheckpoint(checkpointPath);
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
