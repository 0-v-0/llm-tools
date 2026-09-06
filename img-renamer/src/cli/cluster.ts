import { AppError, createProvider, resolveProviderConfig, extname, walk, type ProviderConfig } from '@llm-image/shared';
import { Command } from 'commander';
import { mkdir, rename as fsRename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import OpenAI from 'openai';
import { imageSizeFromFile } from 'image-size/fromFile';
import { loadConfig } from '../config/config.ts';
import { loadEnv } from '../config/env.ts';
import { bootstrap } from '../config/paths.ts';
import { ensureUnique } from '../util/unique.ts';
import { error, info, sanitizeName } from '../util/log.ts';

type ClusterMetric = 'name' | 'resolution' | 'aspect-ratio';

interface ClusterOptions {
	n?: string;
	metric?: ClusterMetric;
	formats?: string;
	depth?: string;
	maxRetry?: string;
	concurrency?: string;
	dryRun?: boolean;
	verbose?: boolean;
}

// ---------- KMeans++ ----------

function dist2(a: number[], b: number[]): number {
	let s = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		s += d * d;
	}
	return s;
}

function closestDist2(point: number[], centroids: number[][]): number {
	let best = Infinity;
	for (const centroid of centroids) {
		best = Math.min(best, dist2(point, centroid));
	}
	return best;
}

function add(a: number[], b: number[]): void {
	for (let i = 0; i < a.length; i++) a[i] = (a[i] ?? 0) + (b[i] ?? 0);
}

function scale(a: number[], s: number): void {
	for (let i = 0; i < a.length; i++) a[i] = (a[i] ?? 0) * s;
}

function kmeansPlusPlus(points: number[][], k: number, maxIter = 1000): number[][] {
	const n = points.length;
	if (k <= 0) return [];
	if (k >= n) return points.map((p, i) => [i]);

	const centroids: number[][] = [];
	centroids.push(points[Math.floor(Math.random() * n)]!.slice());

	const closestDist = Array<number>(n).fill(Infinity);

	for (let c = 1; c < k; c++) {
		let total = 0;
		for (let i = 0; i < n; i++) {
			const d = closestDist2(points[i]!, centroids);
			closestDist[i] = Math.min(closestDist[i] ?? Infinity, d);
			total += closestDist[i] ?? 0;
		}
		if (total === 0) {
			centroids.push(points[Math.floor(Math.random() * n)]!.slice());
			continue;
		}
		let r = Math.random() * total;
		let idx = 0;
		while (r > 0 && idx < n) {
			r -= closestDist[idx] ?? 0;
			idx++;
		}
		centroids.push(points[Math.max(0, idx - 1)]!.slice());
	}

	const assignments = Array<number>(n).fill(-1);

	for (let iter = 0; iter < maxIter; iter++) {
		let changed = false;
		for (let i = 0; i < n; i++) {
			let best = -1;
			let bestd = Infinity;
			for (let j = 0; j < centroids.length; j++) {
				const d = dist2(points[i]!, centroids[j]!);
				if (d < bestd) {
					bestd = d;
					best = j;
				}
			}
			if (assignments[i] !== best) {
				assignments[i] = best;
				changed = true;
			}
		}
		if (!changed) break;

		const sums = Array.from({ length: k }, () => Array<number>(points[0]!.length).fill(0));
		const counts = Array<number>(k).fill(0);
		for (let i = 0; i < n; i++) {
			const a = assignments[i]!;
			add(sums[a]!, points[i]!.slice());
			counts[a] = (counts[a] ?? 0) + 1;
		}
		for (let j = 0; j < k; j++) {
			if ((counts[j] ?? 0) === 0) {
				centroids[j] = points[Math.floor(Math.random() * n)]!.slice();
			} else {
				scale(sums[j]!, 1 / (counts[j] ?? 1));
				centroids[j] = sums[j]!;
			}
		}
	}

	const clusters: number[][] = Array.from({ length: k }, () => []);
	for (let i = 0; i < n; i++) clusters[assignments[i]!]!.push(i);
	return clusters;
}

// ---------- LLM 类别命名（name metric） ----------

function createEmbeddingClient(providerConfig: ProviderConfig): OpenAI {
	return new OpenAI({
		baseURL: providerConfig.OPENAI_API_BASE,
		apiKey: providerConfig.OPENAI_API_KEY,
	});
}

async function getEmbeddings(texts: string[], providerConfig: ProviderConfig): Promise<number[][]> {
	const client = createEmbeddingClient(providerConfig);
	const resp = await client.embeddings.create({
		model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
		input: texts,
	});
	return resp.data.map((d) => d.embedding);
}

function formatAspectRatio(width: number, height: number): string {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
	return sanitizeName(`aspect_${(width / height).toFixed(2)}`);
}

export const clusterCommand = new Command('cluster')
	.description('按文件名语义 / 分辨率 / 宽高比对图片聚类并移动到类别目录')
	.requiredOption('-n, --n <k>', '类别数（必需）')
	.option('--metric <name|resolution|aspect-ratio>', '聚类依据', 'name')
	.option('--formats <exts>', '图片格式列表，逗号分隔（空=所有文件）', '')
	.option('--depth <n>', '最大递归子目录深度', 'Infinity')
	.option('--max-retry <n>', '类别命名 LLM 重试次数', '3')
	.option('--concurrency <n>', '并发数', '4')
	.option('--dry-run', '仅输出将要执行的移动日志，不实际移动文件')
	.option('--verbose', '输出调试信息')
	.action(async (opts: ClusterOptions) => {
		try {
			const env = loadEnv();
			bootstrap(env.IMGDATA_DIR);
			const config = loadConfig(); // 校验配置文件（LLM provider 由下方 resolve 使用）

			const k = Math.max(1, parseInt(opts.n ?? '0', 10) || 0);
			if (k <= 0) {
				throw new AppError('INVALID_K', '请通过 -n 指定类别数，例如: imgrenamer cluster -n 5', 2);
			}
			const metric = (opts.metric ?? 'name') as ClusterMetric;
			if (!['name', 'resolution', 'aspect-ratio'].includes(metric)) {
				throw new AppError(
					'INVALID_METRIC',
					'参数 --metric 仅支持 "name"、"resolution" 或 "aspect-ratio"',
					2,
				);
			}
			const depth =
				opts.depth === 'Infinity' || opts.depth === undefined
					? Infinity
					: Math.max(0, parseInt(opts.depth, 10) || 0);
			const formats = (opts.formats ?? '')
				.split(',')
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			const maxRetry = Math.max(1, parseInt(opts.maxRetry ?? '3', 10) || 3);
			const dryRun = opts.dryRun ?? false;
			const verbose = opts.verbose ?? false;

			const providerConfig = resolveProviderConfig(config.llm, env);
			info(`使用聚类指标：${metric}`);
			info(`查找格式：${formats.join(',') || '所有文件'}`);
			const files = await walk(process.cwd(), { extensions: formats, maxDepth: depth });
			info(`找到 ${files.length} 个文件`);

			if (files.length === 0) {
				info('没有要处理的文件');
				return;
			}

			const names = files.map((f) => basename(f, '.' + extname(f)));
			let points: number[][] = [];

			if (metric === 'name') {
				try {
					points = await getEmbeddings(names, providerConfig);
				} catch (e) {
					throw new AppError(
						'EMBEDDING_FAILED',
						`获取嵌入失败: ${e instanceof Error ? e.message : String(e)}`,
						1,
					);
				}
			} else if (metric === 'resolution' || metric === 'aspect-ratio') {
				for (const f of files) {
					let width = 0;
					let height = 0;
					try {
						const s = await imageSizeFromFile(f);
						width = s.width || 0;
						height = s.height || 0;
					} catch {}
					if (metric === 'resolution') {
						points.push([width, height]);
					} else {
						points.push([width > 0 && height > 0 ? width / height : 0]);
					}
				}
			}

			const clusters = kmeansPlusPlus(points, k);
			info(`生成 ${clusters.length} 个类别`);

			const provider = createProvider(providerConfig);
			const categories = Array<string>(clusters.length);
			for (let i = 0; i < clusters.length; i++) {
				const idxs = clusters[i]!;
				const sampleNames = idxs.slice(0, 50).map((j) => names[j] ?? '');
				let catName = '';
				if (metric === 'name') {
					for (let attempt = 0; attempt < maxRetry; attempt++) {
						try {
							const resp = await provider.complete({
								model: provider.model,
								messages: [
									{
										role: 'system',
										content: '你是一个文件分类助手，负责根据文件名生成一个简洁、有描述性的类别名称。',
									},
									{
										role: 'user',
										content: `请为以下文件名生成一个中文目录名，直接输出目录名，不要输出其他内容：\n${sampleNames.join('\n')}`,
									},
								],
								maxTokens: 100,
								temperature: 0.5,
							});
							catName = sanitizeName(resp.text);
							if (catName.length > 35) catName = '';
						} catch {
							catName = '';
						}
						if (catName) break;
					}
					catName ||= `category_${i + 1}`;
				} else if (metric === 'resolution') {
					let sumW = 0;
					let sumH = 0;
					let cnt = 0;
					for (const idx of idxs) {
						const p = points[idx] || [0, 0];
						sumW += p[0] ?? 0;
						sumH += p[1] ?? 0;
						cnt += 1;
					}
					catName =
						cnt === 0
							? `category_${i + 1}`
							: sanitizeName(`${Math.round(sumW / cnt)}x${Math.round(sumH / cnt)}`);
				} else if (metric === 'aspect-ratio') {
					let sumRatio = 0;
					let cnt = 0;
					for (const idx of idxs) {
						const p = points[idx] || [0];
						sumRatio += p[0] ?? 0;
						cnt += 1;
					}
					catName =
						cnt === 0 ? `category_${i + 1}` : formatAspectRatio(sumRatio / cnt, 1) || `category_${i + 1}`;
				}
				categories[i] = catName;
				info(`类别 ${i + 1}: ${catName} (${idxs.length})`);
			}

			let moved = 0;
			let failed = 0;
			for (let i = 0; i < clusters.length; i++) {
				const dirName = categories[i]!;
				const targetDir = join(process.cwd(), dirName);
				if (!dryRun) await mkdir(targetDir, { recursive: true });
				for (const idx of clusters[i]!) {
					const file = files[idx]!;
					try {
						const ext = extname(file);
						const base = basename(file, '.' + ext);
						const targetName = await ensureUnique(targetDir, base, ext);
						if (dryRun) {
							info(`[DRY-RUN] ${file} -> ${join(targetDir, targetName)}`);
						} else {
							await fsRename(file, join(targetDir, targetName));
						}
						moved += 1;
					} catch (e) {
						failed += 1;
						error(`移动失败: ${file} -> ${e instanceof Error ? e.message : String(e)}`);
					}
				}
			}

			info(`已移动 ${moved} 个文件，失败 ${failed} 个`);
		} catch (e) {
			if (e instanceof AppError) {
				console.error(e.message);
				process.exit(e.exitCode);
			}
			throw e;
		}
	});