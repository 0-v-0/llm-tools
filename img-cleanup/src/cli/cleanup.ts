import { AppError, createProvider } from '@llm-image/shared';
import { Command } from 'commander';
import { loadEnv } from '../config/env.js';
import { loadConfig } from '../config/config.js';
import { bootstrap } from '../config/paths.js';
import { getAllImages, countDistinctFiles } from '../storage/repository.valuation.js';
import { runCleanupPipeline, parseM } from '../selection/engine.js';
import { moveImages } from '../move/mover.js';
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

				// Query images from DB
				const images = getAllImages(pathGlobs, standardName);

				if (images.length === 0) {
					if (isJsonFormat(opts.format)) {
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
				const provider = createProvider(env);

				// Progress callback
				const onProgress = verbose
					? (msg: string) => console.error(`[progress] ${msg}`)
					: undefined;

				// Run the cleanup pipeline
				const result = await runCleanupPipeline(images, m, config, provider, onProgress);

				if (result.toRemove.length === 0) {
					if (isJsonFormat(opts.format)) {
						console.log(renderCleanupJson(result));
					} else {
						console.log(renderCleanupSummary(result));
						console.log('\n无需移走的图片');
					}
					return;
				}

				// Show results before moving
				if (isJsonFormat(opts.format)) {
					console.log(renderCleanupJson(result));
				} else {
					console.log(renderCleanupSummary(result));
					if (verbose || dryRun) {
						console.log(renderToRemoveList(result));
					}
				}

				// Move files
				const moveResults = await moveImages(result.toRemove, targetDir, {
					dryRun,
					onCollision: collisionMode,
				});

				if (isJsonFormat(opts.format)) {
					console.log(renderMoveResultsJson(moveResults));
				} else {
					console.log(renderMoveResults(moveResults));
					if (dryRun) {
						console.log('\n(干运行模式，未实际移动文件)');
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
