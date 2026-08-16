import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageError } from './errors.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
	DatabaseSync: typeof import('node:sqlite').DatabaseSync;
};

export type DB = InstanceType<typeof DatabaseSync>;

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./storage/migrations/', import.meta.url));

export function openFileIndexDb(dbPath: string): DB {
	let db: DB;
	try {
		db = new DatabaseSync(dbPath);
		db.exec('PRAGMA journal_mode = WAL');
		db.exec('PRAGMA foreign_keys = ON');
	} catch (e) {
		throw new StorageError(`数据库初始化失败: ${dbPath}`, e);
	}

	runMigrations(db);
	return db;
}

function runMigrations(db: DB): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);

	const stmt = db.prepare('SELECT version FROM schema_version ORDER BY version');
	const rows = stmt.all() as { version: number }[];
	const applied = new Set(rows.map((r) => r.version));

	if (!existsSync(DEFAULT_MIGRATIONS_DIR)) return;

	const files = readdirSync(DEFAULT_MIGRATIONS_DIR)
		.filter((f) => /^\d+_.+\.sql$/.test(f))
		.sort((a, b) => {
			const numA = parseInt(a.split('_')[0]!);
			const numB = parseInt(b.split('_')[0]!);
			return numA - numB;
		});

	for (const file of files) {
		const match = file.match(/^(\d+)_/);
		if (!match || !match[1]) continue;
		const version = parseInt(match[1]);

		if (applied.has(version)) continue;

		const sql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), 'utf-8');
		db.exec(sql);
		db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
	}
}