import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { StorageError } from '../util/errors.js';

// Use createRequire to load node:sqlite — bypasses Vite's ESM resolution issues
// with experimental Node.js built-in modules
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
	DatabaseSync: typeof import('node:sqlite').DatabaseSync;
};

export type DB = InstanceType<typeof DatabaseSync>;

/**
 * Open a SQLite database and run migrations from the specified directory.
 * Migration files must be named NNN_description.sql (e.g. 001_init.sql).
 */
export function openSqlite(dbPath: string, migrationsDir: string): DB {
	let db: DB;
	try {
		db = new DatabaseSync(dbPath);
		db.exec('PRAGMA journal_mode = WAL');
		db.exec('PRAGMA foreign_keys = ON');
	} catch (e) {
		throw new StorageError(`数据库初始化失败: ${dbPath}`, e);
	}

	runMigrations(db, migrationsDir);
	return db;
}

function runMigrations(db: DB, migrationsDir: string): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

	// Get applied versions
	const stmt = db.prepare('SELECT version FROM schema_version ORDER BY version');
	const rows = stmt.all() as { version: number }[];
	const applied = new Set(rows.map((r) => r.version));

	if (!existsSync(migrationsDir)) return;

	// Scan migrations directory for NNN_*.sql files, sorted by version number
	const files = readdirSync(migrationsDir)
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

		const sql = readFileSync(join(migrationsDir, file), 'utf-8');
		db.exec(sql);
		db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
	}
}
