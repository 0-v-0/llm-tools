import { processImage, createProvider, resolveProviderConfig, AppError } from '@llm-image/shared';
import { Command } from 'commander';
import { limitAsync } from 'es-toolkit';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../config/env.js';
import { loadConfig } from '../config/config.js';
import { bootstrap } from '../config/paths.js';
import { resolveStandard } from '../standards/loader.js';
import { toFileUrl } from '../util/url.js';
import { valuate, type ValuationResult } from '../valuation/engine.js';
import { existsByHashAndStandard, updateUrlByHashAndStandard } from '../storage/repository.valuation.js';
import { registerLinkForFile } from '../fileindex.js';
import { renderJson, renderJsonArray } from './output/json.js';
import { renderValuationCard, renderBatchTable } from './output/table.js';
import { createProgressBar } from './output/progress.js';
import { FORMAT_FLAGS, FORMAT_DESCRIPTION, isJsonFormat } from './output/format.js';

interface BatchEntry {
	result?: ValuationResult;
	error?: string;
	path: string;
	skipped?: boolean;
}

async function collectImages(dir: string, recursive: boolean, include: string): Promise<string[]> {
	const images: string[] = [];
	const extensions = include
		.replace(/[{}]/g, '')
		.split(',')
		.map((e) => e.trim().toLowerCase());

	async function walk(d: string) {
		const entries = await readdir(d);
		for (const entry of entries) {
			const fullPath = join(d, entry);
			const s = await stat(fullPath);
			if (s.isDirectory() && recursive) {
				await walk(fullPath);
			} else if (s.isFile()) {
				const ext = entry.split('.').pop()?.toLowerCase();
				if (ext && extensions.includes(ext)) {
					images.push(fullPath);
				}
			}
		}
	}

	await walk(dir);
	return images;
}

export const valueCommand = new Command('value')
	.description('对单张图片进行估值；若传入目录则自动批量处理')
	.argument('<path>', '图片文件路径或目录路径')
	.option('--standard <name|path>', '估值标准名称或文件路径', 'default-photo')
	.option('--concurrency <n>', '并发数（仅目录模式）', '1')
	.option('--include <glob>', '文件匹配模式（仅目录模式）', '*.{jpg,jpeg,png,webp}')
	.option('--recursive', '递归子目录（仅目录模式）')
	.option(FORMAT_FLAGS, FORMAT_DESCRIPTION, 'text')
	.option('--progress', '显示进度条（仅目录模式）')
	.option('--mode <full|skip|sync>', '估值模式：full=全量估值，skip=跳过已估值，sync=跳过已估值并同步数据库中的url', 'skip')
	.option('--no-tools', '禁用工具调用')
	.option('--verbose', '输出调试信息')
	.action(
		async (
			pathArg: string,
			opts: {
				standard?: string;
				concurrency?: string;
				include?: string;
				recursive?: boolean;
				format?: string;
				progress?: boolean;
				mode?: 'full' | 'skip' | 'sync';
				tools?: boolean;
				verbose?: boolean;
			},
		) => {
			try {
				const env = loadEnv();
				const config = loadConfig();
				bootstrap(env.IMGDATA_DIR);

				const enableTools = opts.tools !== false && config.enableTools;
				const standard = await resolveStandard(opts.standard, config.standardsDir);
				const provider = createProvider(resolveProviderConfig(config.llm, env));

				const absPath = isAbsolute(pathArg) ? pathArg : join(process.cwd(), pathArg);
				const s = await stat(absPath);

				if (s.isDirectory()) {
					const concurrency = Math.max(1, parseInt(opts.concurrency ?? '1', 10));
					const images = await collectImages(
						absPath,
						opts.recursive ?? false,
						opts.include ?? '*.{jpg,jpeg,png,webp}',
					);

					if (opts.verbose) {
						console.error(`[debug] found ${images.length} images, concurrency=${concurrency}`);
					}

					const limitedValuate = limitAsync(async (imagePath: string): Promise<BatchEntry> => {
						try {
							const encodedUrl = pathToFileURL(imagePath).href;
							const image = await processImage(encodedUrl, config.maxImageDimension);

							if (
							opts.mode !== 'full' &&
							existsByHashAndStandard(image.hash, standard.frontmatter.name)
						) {
							if (opts.mode === 'sync') {
								updateUrlByHashAndStandard(
									image.hash,
									standard.frontmatter.name,
									toFileUrl(imagePath),
								);
							}
							return { path: imagePath, skipped: true };
						}

							const result = await valuate({
								url: toFileUrl(imagePath),
								image,
								standard,
								provider,
								config,
								enableTools,
							});
							await registerLinkForFile(toFileUrl(imagePath), imagePath);
							return { result, path: imagePath };
						} catch (e) {
							return { error: e instanceof Error ? e.message : String(e), path: imagePath };
						}
					}, concurrency);

					const showProgress = opts.progress && !isJsonFormat(opts.format);
					const progress = showProgress ? createProgressBar(images.length) : undefined;

					const tasks = images.map((imagePath) =>
						limitedValuate(imagePath).then((entry) => {
							progress?.tick();
							return entry;
						}),
					);

					const entries: BatchEntry[] = await Promise.all(tasks);
					progress?.complete();

					const results = entries
						.filter((e): e is BatchEntry & { result: ValuationResult } => e.result !== undefined)
						.map((e) => e.result);

					const errors = entries.filter((e) => e.error !== undefined);
					const skipped = entries.filter((e) => e.skipped);

					if (isJsonFormat(opts.format)) {
						console.log(renderJsonArray(results));
					} else {
						if (opts.mode === 'sync' && skipped.length > 0) {
						console.log(`跳过并更新 url 已估值 ${skipped.length} 张:`);
						for (const s of skipped) {
						console.log(`  ${s.path}`);
						}
					} else if (opts.mode === 'skip' && skipped.length > 0) {
						console.log(`跳过已估值 ${skipped.length} 张:`);
						for (const s of skipped) {
						console.log(`  ${s.path}`);
						}
					}
						console.log(renderBatchTable(results));
						if (errors.length > 0) {
						console.error(`\n失败 ${errors.length} 张:`);
						for (const e of errors) {
						console.error(`  ${e.path}: ${e.error}`);
						}
					}
					}

					if (errors.length > 0 && results.length === 0) {
						process.exit(4);
					}
				} else {
					const encodedUrl = pathToFileURL(absPath).href;
					const image = await processImage(encodedUrl, config.maxImageDimension);
					const result = await valuate({
						url: toFileUrl(absPath),
						image,
						standard,
						provider,
						config,
						enableTools,
					});
					await registerLinkForFile(toFileUrl(absPath), absPath);

					if (isJsonFormat(opts.format)) {
						console.log(renderJson(result));
					} else {
						console.log(renderValuationCard(result));
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
