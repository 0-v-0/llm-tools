import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getDbPath } from '../config/paths.js';
import { StorageError } from '../util/errors.js';

// Use createRequire to load node:sqlite — bypasses Vite's ESM resolution issues
// with experimental Node.js built-in modules
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
	DatabaseSync: typeof import('node:sqlite').DatabaseSync;
};

type DB = InstanceType<typeof DatabaseSync>;

let dbInstance: DB | null = null;

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

function runMigrations(db: DB): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

	const stmt = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
	const row = stmt.get() as { version?: number } | undefined;
	const currentVersion = row?.version ?? 0;

	const migrationFile = join(MIGRATIONS_DIR, '001_init.sql');
	if (currentVersion < 1 && existsSync(migrationFile)) {
		const sql = readFileSync(migrationFile, 'utf-8');
		db.exec(sql);
		// Mark version 1 as applied (the migration SQL itself creates the table, so insert after)
		db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (1)').run();
	}
}

export function getDb(): DB {
	if (dbInstance) return dbInstance;

	const dbPath = getDbPath(process.env.IMGVAL_DB_DIR);
	try {
		dbInstance = new DatabaseSync(dbPath);
		dbInstance.exec('PRAGMA journal_mode = WAL');
		dbInstance.exec('PRAGMA foreign_keys = ON');
		runMigrations(dbInstance);
	} catch (e) {
		throw new StorageError(`数据库初始化失败: ${dbPath}`, e);
	}

	return dbInstance;
}

export function closeDb(): void {
	if (dbInstance) {
		dbInstance.close();
		dbInstance = null;
	}
}

/** For testing: use an in-memory database */
export function setDb(db: DB): void {
	dbInstance = db;
}
