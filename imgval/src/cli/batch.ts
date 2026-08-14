import { processImage, createProvider, AppError } from '@llm-image/shared';
import { Command } from 'commander';
import { limitAsync } from 'es-toolkit';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { resolveStandard } from '../standards/loader.js';
import { valuate, type ValuationResult } from '../valuation/engine.js';
import { renderJsonArray } from './output/json.js';
import { renderBatchTable } from './output/table.js';

interface BatchEntry {
	result?: ValuationResult;
	error?: string;
	path: string;
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

export const batchCommand = new Command('batch')
	.description('批量估值目录中的图片')
	.argument('<dir>', '图片目录路径')
	.option('--standard <name|path>', '估值标准名称或文件路径', 'default-photo')
	.option('--concurrency <n>', '并发数', '1')
	.option('--include <glob>', '文件匹配模式', '*.{jpg,jpeg,png,webp}')
	.option('--recursive', '递归子目录')
	.option('--json', '输出 JSON 格式')
	.option('--no-tools', '禁用工具调用')
	.option('--verbose', '输出调试信息')
	.action(
		async (
			dir: string,
			opts: {
				standard?: string;
				concurrency?: string;
				include?: string;
				recursive?: boolean;
				json?: boolean;
				tools?: boolean;
				verbose?: boolean;
			},
		) => {
			try {
				const env = loadEnv();
				bootstrap(env.IMGVAL_DB_DIR, env.IMGVAL_STANDARDS_DIR);

				const concurrency = Math.max(1, parseInt(opts.concurrency ?? '1', 10));
				const enableTools = opts.tools !== false && env.LLM_ENABLE_TOOLS;
				const standard = await resolveStandard(opts.standard);
				const provider = createProvider(env);

				const images = await collectImages(
					dir,
					opts.recursive ?? false,
					opts.include ?? '*.{jpg,jpeg,png,webp}',
				);

				if (opts.verbose) {
					console.error(`[debug] found ${images.length} images, concurrency=${concurrency}`);
				}

				const limitedValuate = limitAsync(async (imagePath: string): Promise<BatchEntry> => {
					try {
						const url = pathToFileURL(imagePath).href;
						const image = await processImage(url, env.IMGVAL_MAX_IMAGE_DIMENSION);
						const result = await valuate({ url, image, standard, provider, env, enableTools });
						return { result, path: imagePath };
					} catch (e) {
						return { error: e instanceof Error ? e.message : String(e), path: imagePath };
					}
				}, concurrency);

				const tasks = images.map((imagePath) => limitedValuate(imagePath));
				const entries: BatchEntry[] = await Promise.all(tasks);

				const results = entries
					.filter((e): e is BatchEntry & { result: ValuationResult } => e.result !== undefined)
					.map((e) => e.result);

				const errors = entries.filter((e) => e.error !== undefined);

				if (opts.json) {
					console.log(renderJsonArray(results));
				} else {
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
			} catch (e) {
				if (e instanceof AppError) {
					console.error(e.message);
					process.exit(e.exitCode);
				}
				throw e;
			}
		},
	);
