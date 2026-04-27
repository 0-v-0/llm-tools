import fs from 'fs/promises';
import path from 'path';
import minimist from 'minimist';
import { imageSizeFromFile } from 'image-size/fromFile'
import { extname, ensureUnique, openai, completeChat, parseList, walk, info, error } from './util.js';

export function parseArgs() {
	const argv = minimist(process.argv.slice(2), {
		boolean: ['dry-run'],
		string: ['formats', 'depth', 'max-retry', 'n', 'timeout', 'metric'],
		alias: { 'max-retry': 'maxRetry', m: 'metric' },
		default: { formats: '', n: 0, metric: 'name' }
	});

	return {
		n: argv.n ? Number(argv.n) : 0,
		formats: argv.formats ? parseList(argv.formats) : [],
		depth: argv.depth === undefined ? Infinity : (isFinite(+argv.depth) ? +argv.depth : Infinity),
		maxRetry: argv['max-retry'] ? Number(argv['max-retry']) : 3,
		timeout: argv.timeout ? Number(argv.timeout) : 60,
		dryRun: !!argv['dry-run'],
		metric: argv.metric || 'name',
	};
}

async function getEmbeddings(texts) {
	const resp = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
	return resp.data.map(d => d.embedding);
}

function dist2(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) {
		const d = a[i] - b[i]; s += d * d;
	}
	return s;
}

function closestDist2(point, centroids) {
	let best = Infinity;
	for (const centroid of centroids) {
		best = Math.min(best, dist2(point, centroid));
	}
	return best;
}

function add(a, b) {
	for (let i = 0; i < a.length; i++) a[i] += b[i];
}

function scale(a, s) {
	for (let i = 0; i < a.length; i++) a[i] *= s;
}

function kmeansPlusPlus(points, k, maxIter = 1000) {
	const n = points.length;
	if (k <= 0) return [];
	if (k >= n) return points.map((p, i) => [i]);

	const centroids = [];
	centroids.push(points[Math.floor(Math.random() * n)].slice());

	const closestDist = Array(n).fill(Infinity);

	for (let c = 1; c < k; c++) {
		let total = 0;
		for (let i = 0; i < n; i++) {
			const d = closestDist2(points[i], centroids);
			closestDist[i] = Math.min(closestDist[i], d);
			total += closestDist[i];
		}
		if (total === 0) {
			centroids.push(points[Math.floor(Math.random() * n)].slice());
			continue;
		}
		let r = Math.random() * total;
		let idx = 0;
		while (r > 0 && idx < n) { r -= closestDist[idx++]; }
		centroids.push(points[Math.max(0, idx - 1)].slice());
	}

	let assignments = Array(n).fill(-1);

	for (let iter = 0; iter < maxIter; iter++) {
		let changed = false;
		for (let i = 0; i < n; i++) {
			let best = -1, bestd = Infinity;
			for (let j = 0; j < centroids.length; j++) {
				const d = dist2(points[i], centroids[j]);
				if (d < bestd) { bestd = d; best = j; }
			}
			if (assignments[i] !== best) { assignments[i] = best; changed = true; }
		}
		if (!changed) break;

		const sums = Array.from({ length: k }, () => Array(points[0].length).fill(0));
		const counts = Array(k).fill(0);
		for (let i = 0; i < n; i++) {
			const a = assignments[i];
			add(sums[a], points[i].slice());
			counts[a] += 1;
		}
		for (let j = 0; j < k; j++) {
			if (counts[j] === 0) {
				centroids[j] = points[Math.floor(Math.random() * n)].slice();
			} else {
				scale(sums[j], 1 / counts[j]);
				centroids[j] = sums[j];
			}
		}
	}

	const clusters = Array.from({ length: k }, () => []);
	for (let i = 0; i < n; i++) clusters[assignments[i]].push(i);
	return clusters;
}

function sanitizeName(name) {
	if (!name) return '';
	let s = name.replace(/[<>:\"/\\|?*\x00-\x1F]/g, '');
	return s.trim().replace(/[\s]+/g, '_')
		.replace(/[\. ]+$/g, '');
}

function formatAspectRatio(width, height) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
	return sanitizeName(`aspect_${(width / height).toFixed(2)}`);
}

async function main() {
	const opts = parseArgs();
	if (!opts.n || !Number.isFinite(opts.n) || opts.n <= 0)
		throw new Error('请通过 -n 指定类别数，例如: node cluster.js -n 5');
	const start = Date.now();

	if (!['name', 'resolution', 'aspect-ratio'].includes(opts.metric)) {
		throw new Error('参数 --metric 仅支持 "name"、"resolution" 或 "aspect-ratio"');
	}

	info(`使用聚类指标：${opts.metric}`);
	info(`查找格式：${opts.formats.join(',') || '所有文件'}`);
	const files = await walk(process.cwd(), opts.formats, opts.depth);
	info(`找到 ${files.length} 个文件`);

	if (files.length === 0) {
		info('没有要处理的文件');
		return;
	}

	const names = files.map(f => path.basename(f, '.' + extname(f)));
	let points = [];
	if (opts.metric === 'name') {
		let embeddings;
		try {
			embeddings = await getEmbeddings(names);
		} catch (e) {
			throw new Error("获取嵌入失败", { cause: e });
		}
		points = embeddings;
	} else if (opts.metric === 'resolution' || opts.metric === 'aspect-ratio') {
		for (const f of files) {
			let width = 0, height = 0;
			try {
				const s = await imageSizeFromFile(f);
				width = s.width || 0;
				height = s.height || 0;
			} catch {
			}
			if (opts.metric === 'resolution') {
				points.push([width, height]);
			} else {
				points.push([width > 0 && height > 0 ? width / height : 0]);
			}
		}
	}
	const clusters = kmeansPlusPlus(points, opts.n);

	info(`生成 ${clusters.length} 个类别`);

	const categories = Array(clusters.length);
	for (let i = 0; i < clusters.length; i++) {
		const idxs = clusters[i];
		const sampleNames = idxs.slice(0, 50).map(j => names[j]);
		let catName = '';
		if (opts.metric === 'name') {
			for (let attempt = 0; attempt < 5; attempt++) {
				const messages = [
					{ role: 'system', content: '你是一个文件分类助手，负责根据文件名生成一个简洁、有描述性的类别名称。' },
					{ role: 'user', content: `请为以下文件名生成一个中文目录名，直接输出目录名，不要输出其他内容：\n${sampleNames.join('\n')}` }
				];
				try {
					const resp = await completeChat(messages, opts.timeout, 100);
					catName = sanitizeName(resp);
					if (catName.length > 35) catName = '';
				} catch {
					catName = '';
				}
				if (catName) break;
			}
			catName ||= `category_${i + 1}`;
		} else if (opts.metric === 'resolution') {
			let sumW = 0, sumH = 0, cnt = 0;
			for (const idx of idxs) {
				const p = points[idx] || [0, 0];
				sumW += p[0]; sumH += p[1]; cnt += 1;
			}
			catName = cnt === 0 ? `category_${i + 1}` : sanitizeName(`${Math.round(sumW / cnt)}x${Math.round(sumH / cnt)}`);
		} else if (opts.metric === 'aspect-ratio') {
			let sumRatio = 0, cnt = 0;
			for (const idx of idxs) {
				const p = points[idx] || [0];
				sumRatio += p[0] || 0; cnt += 1;
			}
			catName = cnt === 0 ? `category_${i + 1}` : formatAspectRatio(sumRatio / cnt) || `category_${i + 1}`;
		}
		categories[i] = catName;
		info(`类别 ${i + 1}: ${catName} (${idxs.length})`);
	}

	let moved = 0, failed = 0;
	for (let i = 0; i < clusters.length; i++) {
		const dirName = categories[i];
		const targetDir = path.join(process.cwd(), dirName);
		if (!opts.dryRun) await fs.mkdir(targetDir, { recursive: true });
		for (const idx of clusters[i]) {
			const file = files[idx];
			try {
				const ext = extname(file);
				const base = path.basename(file, '.' + ext);
				let targetName = await ensureUnique(targetDir, base, ext);
				if (opts.dryRun) {
					info(`[DRY-RUN] ${file} -> ${path.join(targetDir, targetName)}`);
				} else {
					await fs.rename(file, path.join(targetDir, targetName));
				}
				moved += 1;
			} catch (e) {
				failed += 1;
				error(`移动失败: ${file} -> ${e.message}`);
			}
		}
	}

	info(`已移动 ${moved} 个文件，失败 ${failed} 个`);
	info(`耗时：${((Date.now() - start) / 1000).toFixed(1)} s`);
}

main().catch(e => { error(e.message); process.exitCode = 1; });
