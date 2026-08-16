import { processImage, createProvider, AppError } from '@llm-image/shared';
import { Command } from 'commander';
import { limitAsync } from 'es-toolkit';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { createEmbeddingProvider } from '../embedding/factory.js';
import { collectImages } from '../image/collect.js';
import { describeImage } from '../search/describe.js';
import { getDb } from '../storage/db.js';
import { QdrantStore } from '../storage/qdrant.js';
import * as imageRepo from '../storage/repository.image.js';

interface ImportResult {
	path: string;
	status: 'success' | 'skipped' | 'failed';
	error?: string;
}

export const importCommand = new Command('import')
	.description('导入目录中的图片到搜索索引')
	.argument('<dir>', '图片目录路径')
	.option('--recursive', '递归子目录')
	.option('--concurrency <n>', '并发数', '4')
	.option('--include <exts>', '文件扩展名', '*.{jpg,jpeg,png,webp}')
	.option('--verbose', '输出调试信息')
	.action(
		async (
			dir: string,
			opts: {
				recursive?: boolean;
				concurrency?: string;
				include?: string;
				verbose?: boolean;
			},
		) => {
			try {
				const env = loadEnv();
				bootstrap(env.IMGSEARCH_DB_DIR);

				const concurrency = Math.max(1, parseInt(opts.concurrency ?? '4', 10));
				const extensions = opts.include
					?.replace(/[{}*]/g, '')
					.split(',')
					.map((e) => e.trim().toLowerCase());

				const collectOpts: { recursive?: boolean; extensions?: string[] } = {};
				if (opts.recursive !== undefined) collectOpts.recursive = opts.recursive;
				if (extensions !== undefined) collectOpts.extensions = extensions;

				const images = await collectImages(dir, collectOpts);

				if (opts.verbose) {
					console.error(`[debug] found ${images.length} images, concurrency=${concurrency}`);
				}

				if (images.length === 0) {
					console.log('No images found.');
					return;
				}

				getDb();
				const provider = createProvider(env);
				const embeddingProvider = createEmbeddingProvider(env);
				const qdrant = new QdrantStore(
					env.QDRANT_URL,
					env.QDRANT_COLLECTION,
					embeddingProvider.dimensions,
					env.QDRANT_API_KEY,
				);

				await qdrant.ensureCollection();

				const limitedImport = limitAsync(async (imagePath: string): Promise<ImportResult> => {
					try {
						const url = pathToFileURL(imagePath).href;
						const processed = await processImage(url, env.IMGSEARCH_MAX_IMAGE_DIMENSION);

					const existing = imageRepo.getByHash(processed.hash);
						if (existing) {
							return { path: imagePath, status: 'skipped', error: 'Duplicate hash' };
						}

						const pathRecord = imageRepo.getBySourcePath(imagePath);
						if (pathRecord && pathRecord.status === 'indexed') {
							return { path: imagePath, status: 'skipped', error: 'Already indexed' };
						}

						const rowId = imageRepo.insert({
							sourcePath: imagePath,
							hash: processed.hash,
							status: 'processing',
						});

						if (rowId === 0) {
							return { path: imagePath, status: 'skipped', error: 'Insert failed' };
						}

						const description = await describeImage({
							provider,
							imageDataUri: processed.base64,
						});

						const textVecs = await embeddingProvider.embedText([description]);
						const visualVecs = await embeddingProvider.embedImage([processed.base64]);
						const textVec = textVecs[0];
						const visualVec = visualVecs[0];
						if (!textVec || !visualVec) {
							throw new Error('Embedding returned empty result');
						}

						await qdrant.upsertPoints([
							{
								id: rowId,
								textVec,
								visualVec,
								payload: {
									sourcePath: imagePath,
									hash: processed.hash,
									description,
								},
							},
						]);

						imageRepo.updateStatus(rowId, 'indexed', {
							qdrantPointId: String(rowId),
							textDescription: description,
							descriptionModel: provider.model,
						});

						if (opts.verbose) {
							console.error(`[debug] indexed: ${imagePath}`);
						}

						return { path: imagePath, status: 'success' };
					} catch (e) {
						const error = e instanceof Error ? e.message : String(e);
						console.error(`[error] ${imagePath}: ${error}`);
						return { path: imagePath, status: 'failed', error };
					}
				}, concurrency);

				const tasks = images.map((imagePath) => limitedImport(imagePath));
				const results: ImportResult[] = await Promise.all(tasks);

				const success = results.filter((r) => r.status === 'success').length;
				const skipped = results.filter((r) => r.status === 'skipped').length;
				const failed = results.filter((r) => r.status === 'failed').length;

				console.log(`\nImport complete:`);
				console.log(`  Success: ${success}`);
				console.log(`  Skipped: ${skipped}`);
				console.log(`  Failed:  ${failed}`);

				if (failed > 0 && opts.verbose) {
					console.error('\nFailed images:');
					for (const r of results.filter((r) => r.status === 'failed')) {
						console.error(`  ${r.path}: ${r.error}`);
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
