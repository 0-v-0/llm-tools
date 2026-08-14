import fs from 'fs/promises';
import minimist from 'minimist';
import path from 'path';
import { extname, ensureUnique, completeChat, parseList, walk, info, error } from './util.js';

function parseArgs() {
	const argv = minimist(process.argv.slice(2), {
		boolean: ['dry-run'],
		string: ['formats', 'depth', 'max-size', 'max-retry', 'timeout'],
		alias: { 'max-size': 'maxSize', 'max-retry': 'maxRetry' },
		default: { formats: 'jpg,jpeg,png,gif' },
	});

	return {
		formats: parseList(argv.formats || 'jpg,jpeg,png,gif'),
		depth: argv.depth === undefined ? Infinity : isFinite(+argv.depth) ? +argv.depth : Infinity,
		maxSize: argv['max-size'] ? Number(argv['max-size']) : 10485760, // 10MB
		maxRetry: argv['max-retry'] ? Number(argv['max-retry']) : 3,
		timeout: argv.timeout ? Number(argv.timeout) : 60,
		// 如果设置了 --dry-run 则只打印日志不执行重命名
		dryRun: !!argv['dry-run'],
	};
}

const prompt = `请根据图片内容生成一个简洁、有描述性的中文文件名（不含扩展名），长度尽量短。直接输出文件名，不要包含其他内容。`;

async function main() {
	const opts = parseArgs();
	const start = Date.now();
	// 并发控制：默认并发 2，可用环境变量 CONCURRENCY 调整
	const concurrency = Math.max(1, Number(process.env.CONCURRENCY) || 2);

	info(`查找格式：${opts.formats.join(',') || '所有文件'}`);
	const files = await walk(process.cwd(), opts.formats, opts.depth);
	info(`找到 ${files.length} 个图片文件`);

	let processed = 0,
		skipped = 0,
		failed = 0;

	async function processFile(file) {
		try {
			const stat = await fs.stat(file);
			if (stat.size > opts.maxSize) {
				skipped += 1;
				return;
			}

			const dir = path.dirname(file);
			const ext = extname(file);
			const base = path.basename(file, '.' + ext);

			// Try to get a unique name from AI. If AI-suggested name already exists,
			// ask AI again up to opts.maxRetry times. Only after exhausting retries
			// append a numeric suffix to make the name unique.
			let newName = base;
			let url = `data:image/${ext};base64,`;
			try {
				const data = await fs.readFile(file);
				url += data.toString('base64');
			} catch (e) {
				throw new Error(`无法读取文件: ${e.message}`);
			}

			const messages = [
				{
					role: 'user',
					content: [
						{ type: 'text', text: prompt },
						{ type: 'image_url', image_url: { url } },
					],
				},
			];
			for (let i = 0; i < opts.maxRetry; i++) {
				try {
					newName = (await completeChat(messages, opts.timeout))
						.replace(/\.[a-zA-Z0-9]{1,6}$/, '')
						.replace(/[\s]+/g, '_');
				} catch {}
				if (newName.length > 35) continue; // 过长不合理，重试

				try {
					await fs.access(path.join(dir, `${newName}.${ext}`));
					// exists, try again
					messages.push(
						{ role: 'assistant', content: newName },
						{ role: 'user', content: `文件名 "${newName}" 已存在，请再生成一个。` },
					);
					continue;
				} catch {
					break;
				}
			}

			let target = path.join(
				dir,
				newName === base ? await ensureUnique(dir, base, ext) : `${newName}.${ext}`,
			);
			if (opts.dryRun) {
				info(`[DRY-RUN] ${file} -> ${target}`);
			} else {
				await fs.rename(file, target);
			}
			processed += 1;

			if (processed % 20 === 0) info(`已处理 ${processed} 个文件`);
		} catch (e) {
			failed += 1;
			error(`处理失败: ${file} -> ${e.message}`);
		}
	}

	let i = 0;
	const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
		while (i < files.length) {
			await processFile(files[i++]);
		}
	});

	await Promise.all(workers);

	info(`成功：${processed} 个文件`);
	info(`跳过：${skipped} 个文件`);
	info(`失败：${failed} 个文件`);
	info(`耗时：${((Date.now() - start) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
	error(e.message);
	process.exitCode = 1;
});
