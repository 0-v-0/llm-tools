import { processImage, createProvider, resolveProviderConfig, AppError } from '@llm-image/shared';
import { blake3HexFile, toFileUrl, mimeFromUrl, type LinkStatus } from '@llm-image/file-index';
import { Command } from 'commander';
import { limitAsync } from 'es-toolkit';
import { stat } from 'node:fs/promises';
import type { AppConfig } from '../config/config.ts';
import { loadConfig } from '../config/config.ts';
import { loadEnv, type EnvConfig } from '../config/env.ts';
import { bootstrap } from '../config/paths.ts';
import { createEmbeddingProvider } from '../embedding/factory.ts';
import type { EmbeddingProvider } from '../embedding/provider.ts';
import { collectImages, type CollectOptions } from '../image/collect.ts';
import { describeImage } from '../search/describe.ts';
import { getFileIndexRepo } from '../fileindex.ts';
import { closeDb, getDb } from '../storage/db.ts';
import { QdrantStore } from '../storage/qdrant.ts';
import * as imageRepo from '../storage/repository.image.ts';
import { toErrorMessage } from '../util/error-message.ts';
import { sanitizeForTerminal } from '../util/sanitize.ts';

// @llm-image/file-index 未导出命名状态常量（仅有 LinkStatus 类型 0|1|2|3）；
// status=3 表示哈希已验证（blake3 与文件内容一致）
const FILE_INDEX_STATUS_HASH_VERIFIED: LinkStatus = 3;

interface ImportResult {
	path: string;
	status: 'success' | 'skipped' | 'failed';
	error?: string;
}

/** 单张图片导入所需的运行时依赖。 */
interface ImportContext {
	config: AppConfig;
	provider: ReturnType<typeof createProvider>;
	embeddingProvider: EmbeddingProvider;
	qdrant: QdrantStore;
	verbose: boolean;
}

const MAX_ERROR_LENGTH = 500;

function truncateError(message: string): string {
	return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message;
}

/** 登记文件元信息到 file-index（url/type/size 由 file-index 统一管理） */
async function registerInFileIndex(imagePath: string, url: string, blake3: string): Promise<void> {
	const { size } = await stat(imagePath);
	getFileIndexRepo().register({
		url,
		blake3,
		type: mimeFromUrl(url),
		size: BigInt(size),
		status: FILE_INDEX_STATUS_HASH_VERIFIED,
	});
}

/**
 * 处理单张图片：blake3/视觉哈希去重 → LLM 描述 → 文本+视觉嵌入 → Qdrant 入库。
 * 任何一步失败都只将该图片标记为 failed，不影响其他图片的导入。
 */
async function importImage(ctx: ImportContext, imagePath: string): Promise<ImportResult> {
	let rowId: number | null = null;
	try {
		const url = toFileUrl(imagePath);
		const blake3 = await blake3HexFile(imagePath);

		// Dedup by blake3 (original file identity) via image_import:
		// skips re-importing the exact same file (already indexed).
		const existing = imageRepo.getByBlake3(blake3);
		if (existing && existing.status === 'indexed') {
			return { path: imagePath, status: 'skipped', error: 'Duplicate blake3' };
		}

		const processed = await processImage(url, ctx.config.maxImageDimension);

		// Dedup by hash (visual content) via image_import:
		// two images differing only in EXIF have different blake3 but identical hash
		// → skip the second one (avoid redundant LLM/embedding/Qdrant work).
		const hashRecord = imageRepo.getByHash(processed.hash);
		if (hashRecord && hashRecord.status === 'indexed') {
			// Still register this file's blake3 in file-index so its url is tracked
			await registerInFileIndex(imagePath, url, blake3);
			return { path: imagePath, status: 'skipped', error: 'Duplicate visual hash' };
		}

		rowId = imageRepo.insert({
			blake3,
			hash: processed.hash,
			status: 'processing',
		});

		if (rowId === 0) {
			// INSERT OR IGNORE hit a pre-existing hash row. If that row is a
			// previous failure ('failed') or a crash leftover ('processing'),
			// reuse it so the import retries properly; otherwise skip.
			const existingRow = imageRepo.getByHash(processed.hash);
			if (!existingRow || existingRow.status === 'indexed') {
				rowId = null;
				return { path: imagePath, status: 'skipped', error: 'Duplicate visual hash' };
			}
			rowId = existingRow.id;
			imageRepo.updateStatus(rowId, 'processing');
		}

		const description = await describeImage({
			provider: ctx.provider,
			imageDataUri: processed.base64,
		});

		const [textVecs, visualVecs] = await Promise.all([
			ctx.embeddingProvider.embedText([description]),
			ctx.embeddingProvider.embedImage([processed.base64]),
		]);
		const textVec = textVecs[0];
		const visualVec = visualVecs[0];
		if (!textVec || !visualVec) {
			throw new Error('Embedding returned empty result');
		}

		await ctx.qdrant.upsertPoints([
			{
				id: rowId,
				textVec,
				visualVec,
				payload: {
					blake3,
					hash: processed.hash,
					description,
				},
			},
		]);

		imageRepo.updateStatus(rowId, 'indexed', {
			qdrantPointId: String(rowId),
			textDescription: description,
			descriptionModel: ctx.provider.model,
		});

		// Register link in file-index after successful indexing
		// (url/type/size are the file metadata owned by file-index;
		//  every original blake3 is tracked, even if its visual hash collides
		//  with another file's — e.g., EXIF-only differences)
		await registerInFileIndex(imagePath, url, blake3);

		if (ctx.verbose) {
			console.error(`[debug] indexed: ${imagePath}`);
		}

		return { path: imagePath, status: 'success' };
	} catch (e) {
		// 错误信息可能内嵌远端 API 响应体，写入终端前需清理转义序列/控制字符
		const error = truncateError(sanitizeForTerminal(toErrorMessage(e)));
		console.error(`[error] ${imagePath}: ${error}`);
		if (rowId !== null) {
			try {
				imageRepo.updateStatus(rowId, 'failed', { error });
			} catch (dbError) {
				console.error(`[error] ${imagePath}: 更新失败状态时出错: ${sanitizeForTerminal(toErrorMessage(dbError))}`);
			}
		}
		return { path: imagePath, status: 'failed', error };
	}
}

/** 解析 --concurrency 选项；无效值回退到配置文件中的 importConcurrency。 */
function resolveConcurrency(optionValue: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(optionValue ?? String(fallback), 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/** 解析 --include 选项，如 "*.{jpg,png}" 或 "jpg,png" → ["jpg", "png"]。 */
function parseExtensions(optionValue: string | undefined): string[] | undefined {
	if (optionValue === undefined) return undefined;
	return optionValue
		.replace(/[{}*]/g, '')
		.split(',')
		.map((e) => e.trim().toLowerCase())
		.filter((e) => e.length > 0);
}

/** 根据环境变量与配置构建单张图片导入所需的运行时依赖。 */
function createImportContext(env: EnvConfig, config: AppConfig, verbose: boolean): ImportContext {
	const embeddingProvider = createEmbeddingProvider(env, config);
	return {
		config,
		provider: createProvider(resolveProviderConfig(config.llm, env)),
		embeddingProvider,
		qdrant: new QdrantStore(
			env.QDRANT_URL,
			env.QDRANT_COLLECTION,
			embeddingProvider.dimensions,
			env.QDRANT_API_KEY,
		),
		verbose,
	};
}

/** 输出导入结果统计；verbose 时列出所有失败图片。 */
function printImportSummary(results: ImportResult[], verbose: boolean): void {
	const success = results.filter((r) => r.status === 'success').length;
	const skipped = results.filter((r) => r.status === 'skipped').length;
	const failedResults = results.filter((r) => r.status === 'failed');

	console.log(`\nImport complete:`);
	console.log(`  Success: ${success}`);
	console.log(`  Skipped: ${skipped}`);
	console.log(`  Failed:  ${failedResults.length}`);

	if (failedResults.length > 0 && verbose) {
		console.error('\nFailed images:');
		for (const r of failedResults) {
			console.error(`  ${r.path}: ${r.error}`);
		}
	}
}

export const importCommand = new Command('import')
	.description('导入目录中的图片到搜索索引')
	.argument('<dir>', '图片目录路径')
	.option('--recursive', '递归子目录')
	.option('--concurrency <n>', '并发数（默认取配置 importConcurrency）')
	.option('--include <exts>', '文件扩展名，逗号分隔（默认 jpg,jpeg,png,webp）')
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
				const config = loadConfig();
				bootstrap(env.IMGDATA_DIR);

				const concurrency = resolveConcurrency(opts.concurrency, config.importConcurrency);
				const collectOpts: CollectOptions = {};
				if (opts.recursive !== undefined) collectOpts.recursive = opts.recursive;
				const extensions = parseExtensions(opts.include);
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
				const ctx = createImportContext(env, config, opts.verbose === true);
				await ctx.qdrant.ensureCollection();

				const importWithLimit = limitAsync((imagePath: string) => importImage(ctx, imagePath), concurrency);
				const results: ImportResult[] = await Promise.all(images.map((imagePath) => importWithLimit(imagePath)));

				printImportSummary(results, ctx.verbose);
			} catch (e) {
				if (e instanceof AppError) {
					console.error(sanitizeForTerminal(e.message));
					process.exit(e.exitCode);
				}
				throw e;
			} finally {
				closeDb();
			}
		},
	);
