#!/usr/bin/env node
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openFileIndexDb } from './db.js';
import { FileIndexRepo } from './repository.links.js';
import { verifyLink, verifyStale } from './verify.js';
import { blake3HexFile, blake3HexDataUri } from './fingerprint.js';
import { toFileUrl } from './url.js';
import { nowTicks, ticksToIso } from './time.js';

function resolveDbPath(cliDb?: string): string {
	if (cliDb) return cliDb;
	const envDir = process.env['IMGDATA_DIR'];
	if (envDir) return join(envDir, 'file-index.db');
	return join(homedir(), '.img-data', 'file-index.db');
}

function printJson(data: unknown): void {
	console.log(JSON.stringify({ ok: true, data }));
}

function printError(code: string, message: string): void {
	console.log(JSON.stringify({ ok: false, error: { code, message } }));
}

const program = new Command()
	.name('file-index')
	.description('文件索引管理 — BLAKE3 指纹存储与 URL 管理')
	.version('0.1.0')
	.option('--db <path>', '自定义数据库路径');

program
	.command('add <urlOrPath>')
	.description('注册一个文件/URL 到索引')
	.option('--hash <hex>', '手动指定 BLAKE3 哈希')
	.option('--type <mime>', '手动指定 MIME 类型')
	.option('--json', 'JSON 格式输出')
	.option('--status <n>', '初始状态 (0-3, 默认 1)', '1')
	.action(async (urlOrPath: string, opts, cmd) => {
		const db = openFileIndexDb(resolveDbPath(cmd.parent?.opts()?.db));
		const repo = new FileIndexRepo(db);

		let url: string;
		let hash: string;
		let type: string | undefined;

		if (urlOrPath.startsWith('data:')) {
			url = urlOrPath;
			hash = opts.hash ?? blake3HexDataUri(url);
			type = opts.type;
		} else if (urlOrPath.startsWith('file:') || urlOrPath.startsWith('http:') || urlOrPath.startsWith('https:')) {
			url = urlOrPath;
			hash = opts.hash ?? '';
			type = opts.type;
		} else {
			url = toFileUrl(urlOrPath);
			hash = opts.hash ?? (await blake3HexFile(urlOrPath));
			type = opts.type;
		}

		const record = repo.register({
			url,
			blake3: hash,
			...(type !== undefined ? { type } : {}),
			status: Number(opts.status) as 0 | 1 | 2 | 3,
		});

		if (opts.json) {
			printJson({
				id: record.id,
				url: record.url,
				blake3: record.blake3,
				type: record.type,
				size: record.size.toString(),
				status: record.status,
				createdAt: record.createdAt.toString(),
				updatedAt: record.updatedAt.toString(),
			});
		} else {
			console.log(`已注册: ${record.url}`);
			console.log(`  BLAKE3: ${record.blake3}`);
			console.log(`  Type:   ${record.type}`);
			console.log(`  Size:   ${record.size}`);
			console.log(`  Status: ${record.status}`);
		}
	});

program
	.command('verify [url]')
	.description('验证文件完整性 (读取/HEAD 探活)')
	.option('--all', '重新验证所有待验证/可访问的链接')
	.option('--json', 'JSON 格式输出')
	.action(async (url: string | undefined, opts, cmd) => {
		const db = openFileIndexDb(resolveDbPath(cmd.parent?.opts()?.db));
		const repo = new FileIndexRepo(db);

		try {
			if (opts.all || !url) {
				const results = await verifyStale(repo);
				if (opts.json) {
					printJson(results.map((r) => ({
						url: r.url,
						blake3: r.blake3,
						status: r.status,
						matched: r.matched,
					})));
				} else {
					for (const r of results) {
						console.log(`${r.matched ? '✓' : '✗'} ${r.url} → status ${r.status}${r.matched ? '' : ' (不匹配)'}`);
					}
				}
			} else {
				const result = await verifyLink(repo, url);
				if (opts.json) {
					printJson(result);
				} else {
					console.log(`${result.matched ? '✓' : '✗'} ${result.url}`);
					console.log(`  BLAKE3: ${result.blake3}`);
					console.log(`  Status: ${result.status}`);
					console.log(`  Type:   ${result.type}`);
					console.log(`  Size:   ${result.size}`);
				}
			}
		} catch (e) {
			printError('VERIFY_FAILED', e instanceof Error ? e.message : String(e));
		}
	});

program
	.command('list')
	.description('列出索引中的链接')
	.option('--hash <hex>', '按 BLAKE3 筛选')
	.option('--status <n>', '按状态筛选')
	.option('--json', 'JSON 格式输出')
	.action((opts, cmd) => {
		const db = openFileIndexDb(resolveDbPath(cmd.parent?.opts()?.db));
		const repo = new FileIndexRepo(db);

		const records = opts.hash
			? repo.findByBlake3(opts.hash)
			: opts.status
				? repo.findByStatus([Number(opts.status) as 0 | 1 | 2 | 3])
				: repo.findByStatus([0, 1, 2, 3]);

		if (opts.json) {
			printJson(records.map((r) => ({
				id: r.id,
				url: r.url,
				blake3: r.blake3,
				type: r.type,
				size: r.size.toString(),
				status: r.status,
				createdAt: r.createdAt.toString(),
				updatedAt: r.updatedAt.toString(),
			})));
		} else {
			for (const r of records) {
				console.log(`[${r.status}] ${r.url}`);
				console.log(`  BLAKE3: ${r.blake3}  Type: ${r.type}  Size: ${r.size}`);
			}
			if (records.length === 0) console.log('(无记录)');
		}
	});

program
	.command('stats')
	.description('索引统计')
	.option('--json', 'JSON 格式输出')
	.action((opts, cmd) => {
		const db = openFileIndexDb(resolveDbPath(cmd.parent?.opts()?.db));
		const repo = new FileIndexRepo(db);
		const s = repo.stats();

		if (opts.json) {
			printJson(s);
		} else {
			console.log(`总记录: ${s.total}`);
			for (const [status, count] of Object.entries(s.byStatus)) {
				console.log(`  Status ${status}: ${count}`);
			}
		}
	});

program
	.command('prune')
	.description('清理无效记录')
	.option('--all', '删除所有 status=0 的记录')
	.option('--older-than <days>', '删除早于 N 天的记录', parseInt)
	.option('--json', 'JSON 格式输出')
	.action((opts, cmd) => {
		const db = openFileIndexDb(resolveDbPath(cmd.parent?.opts()?.db));
		const repo = new FileIndexRepo(db);

		const olderThanTicks = opts.olderThan
			? nowTicks() - BigInt(opts.olderThan) * 86_400_000n * 10_000n
			: undefined;

		const pruneOpts: { onlyInvalid: boolean; olderThanTicks?: bigint } = {
			onlyInvalid: opts.all || !opts.olderThan,
		};
		if (olderThanTicks !== undefined) {
			pruneOpts.olderThanTicks = olderThanTicks;
		}

		const deleted = repo.prune(pruneOpts);

		if (opts.json) {
			printJson({ deleted });
		} else {
			console.log(`已删除 ${deleted} 条记录`);
		}
	});

program
	.command('backfill <dir>')
	.description('批量扫描目录，注册所有文件到索引')
	.option('--recursive', '递归子目录')
	.option('--include <exts>', '文件扩展名 (逗号分隔)', 'jpg,jpeg,png,webp')
	.option('--json', 'JSON 格式输出')
	.action(async (dir: string, opts, cmd) => {
		const { readdir, stat } = await import('node:fs/promises');
		const { resolve, extname, join } = await import('node:path');
		const { existsSync } = await import('node:fs');

		const db = openFileIndexDb(resolveDbPath(cmd.parent?.opts()?.db));
		const repo = new FileIndexRepo(db);

		const exts = opts.include.split(',').map((e: string) => e.trim().toLowerCase());
		const root = resolve(dir);

		if (!existsSync(root)) {
			printError('NOT_FOUND', `目录不存在: ${root}`);
			return;
		}

		const files: string[] = [];
		async function walk(d: string) {
			const entries = await readdir(d);
			for (const entry of entries) {
				const full = join(d, entry);
				const s = await stat(full);
				if (s.isDirectory() && opts.recursive) {
					await walk(full);
				} else if (s.isFile()) {
					const ext = extname(entry).toLowerCase().replace(/^\./, '');
					if (exts.includes(ext)) {
						files.push(full);
					}
				}
			}
		}
		await walk(root);

		let registered = 0;
		let skipped = 0;
		for (const filePath of files) {
			try {
				const url = toFileUrl(filePath);
				if (repo.findByUrl(url)) {
					skipped++;
					continue;
				}
				const hash = await blake3HexFile(filePath);
				const { size } = await stat(filePath);
				repo.register({ url, blake3: hash, size: BigInt(size), status: 3 });
				registered++;
			} catch {
				skipped++;
			}
		}

		if (opts.json) {
			printJson({ registered, skipped });
		} else {
			console.log(`注册 ${registered} 个文件，跳过 ${skipped} 个`);
		}
	});

export async function runCli(argv: string[]): Promise<void> {
	await program.parseAsync(argv);
}

runCli(process.argv).catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});