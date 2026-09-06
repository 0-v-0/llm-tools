import { AppError, createProvider, processImage, resolveProviderConfig, type LLMMessage } from '@llm-image/shared';
import { Command } from 'commander';
import { stat, rename as fsRename, access } from 'node:fs/promises';
import { dirname, join, parse as pathParse } from 'node:path';
import { loadConfig } from '../config/config.js';
import { loadEnv } from '../config/env.js';
import { bootstrap } from '../config/paths.js';
import { walk } from '../util/walk.js';
import { ensureUnique } from '../util/unique.js';
import { error, info } from '../util/log.js';

const RENAME_PROMPT = `请根据图片内容生成一个简洁、有描述性的中文文件名（不含扩展名），长度尽量短。直接输出文件名，不要包含其他内容。`;

interface RenameOptions {
	dir?: string;
	formats?: string;
	depth?: string;
	maxSize?: string;
	maxRetry?: string;
	concurrency?: string;
	dryRun?: boolean;
	verbose?: boolean;
}

function toFileUrl(file: string): string {
	return `file://${file.replace(/\\/g, '/')}`;
}

/** 单次 LLM 调用，请求一个文件名；失败/过长/为空返回空串（由调用方决定重试）。 */
async function requestName(
	provider: ReturnType<typeof createProvider>,
	messages: LLMMessage[],
): Promise<string> {
	try {
		const resp = await provider.complete({
			model: provider.model,
			messages,
			maxTokens: 64,
			temperature: 0.5,
		});
		const name = resp.text.replace(/\.[a-zA-Z0-9]{1,6}$/, '').replace(/[\s]+/g, '_');
		return name.length > 35 ? '' : name;
	} catch {
		return '';
	}
}

export const renameCommand = new Command('rename')
	.description('用 LLM 分析图片内容并为图片生成新的中文文件名')
	.argument('[dir]', '要处理的目录（默认当前工作目录）')
	.option('--formats <exts>', '图片格式列表，逗号分隔', 'jpg,jpeg,png,gif')
	.option('--depth <n>', '最大递归子目录深度', 'Infinity')
	.option('--max-size <bytes>', '超过该大小的文件将被跳过', '10485760')
	.option('--max-retry <n>', '单个文件失败最大重试次数', '3')
	.option('--concurrency <n>', '并发数', '2')
	.option('--dry-run', '仅输出将要执行的重命名日志，不实际修改文件')
	.option('--verbose', '输出调试信息')
	.action(async (dirArg: string | undefined, opts: RenameOptions) => {
		try {
			const env = loadEnv();
			bootstrap(env.IMGDATA_DIR);
			const config = loadConfig();

			const dir = dirArg ?? process.cwd();
			const formats = (opts.formats ?? 'jpg,jpeg,png,gif')
				.split(',')
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			const depth =
				opts.depth === 'Infinity' || opts.depth === undefined
					? Infinity
					: Math.max(0, parseInt(opts.depth, 10) || 0);
			const maxSize = Number(opts.maxSize) || 10 * 1024 * 1024;
			const maxRetry = Math.max(1, parseInt(opts.maxRetry ?? '3', 10) || 3);
			const concurrency = Math.max(1, parseInt(opts.concurrency ?? String(config.concurrency), 10) || 1);
			const dryRun = opts.dryRun ?? false;
			const verbose = opts.verbose ?? false;

			const provider = createProvider(resolveProviderConfig(config.llm, env));

			info(`查找格式：${formats.join(',') || '所有文件'}`);
			const files = await walk(dir, { formats, maxDepth: depth });
			info(`找到 ${files.length} 个图片文件`);

			let processed = 0;
			let skipped = 0;
			let failed = 0;

			const processFile = async (file: string): Promise<void> => {
				try {
					const s = await stat(file);
					if (s.size > maxSize) {
						skipped += 1;
						return;
					}

					const parsed = pathParse(file);
					const ext = parsed.ext.replace('.', '').toLowerCase();
					const base = parsed.name;

					const imageDataUri = (
						await processImage(toFileUrl(file), config.maxImageDimension)
					).base64;
					const messages: LLMMessage[] = [
						{
							role: 'user',
							content: [
								{ type: 'text', text: RENAME_PROMPT },
								{ type: 'image_url', image_url: { url: imageDataUri } },
							],
						},
					];

					let newName = base;
					for (let attempt = 0; attempt < maxRetry; attempt++) {
						const candidate = await requestName(provider, messages);
						if (candidate.length === 0) continue; // LLM 失败/超长/为空 → 重试
						newName = candidate;
						// 若生成名的文件已存在，追加对话让 LLM 再生成一个
						try {
							await access(join(dirname(file), `${newName}.${ext}`));
							messages.push(
								{ role: 'assistant', content: newName },
								{ role: 'user', content: `文件名 "${newName}" 已存在，请再生成一个。` },
							);
							continue;
						} catch {
							break;
						}
					}

					const target = join(
						dirname(file),
						newName === base ? await ensureUnique(dirname(file), base, ext) : `${newName}.${ext}`,
					);

					if (dryRun) {
						info(`[DRY-RUN] ${file} -> ${target}`);
					} else {
						await fsRename(file, target);
					}
					processed += 1;
					if (processed % 20 === 0) info(`已处理 ${processed} 个文件`);
				} catch (e) {
					failed += 1;
					error(`处理失败: ${file} -> ${e instanceof Error ? e.message : String(e)}`);
				}
			};

			if (verbose) {
				console.error(`[debug] concurrency=${concurrency}, formats=${formats.join(',')}, depth=${depth}, maxSize=${maxSize}`);
			}

			let i = 0;
			const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
				while (i < files.length) {
					const file = files[i++];
					if (file === undefined) break;
					await processFile(file);
				}
			});
			await Promise.all(workers);

			info(`成功：${processed} 个文件`);
			info(`跳过：${skipped} 个文件`);
			info(`失败：${failed} 个文件`);
		} catch (e) {
			if (e instanceof AppError) {
				console.error(e.message);
				process.exit(e.exitCode);
			}
			throw e;
		}
	});