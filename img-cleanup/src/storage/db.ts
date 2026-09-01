import { StorageError } from '@llm-image/shared';
import { createRequire } from 'node:module';
import { getDbPath } from '../config/paths.js';

// Use createRequire to load node:sqlite — bypasses ESM resolution issues
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
	DatabaseSync: typeof import('node:sqlite').DatabaseSync;
};

export type DB = InstanceType<typeof DatabaseSync>;

let dbInstance: DB | null = null;

/**
 * Open imgval.db in read-write mode WITHOUT running migrations.
 * img-cleanup reads the valuation table created by img-val and updates
 * URLs after moving files. It never creates or migrates the schema.
 */
export function getDb(): DB {
	if (dbInstance) return dbInstance;

	const dbPath = getDbPath(process.env.IMGDATA_DIR);
	try {
		dbInstance = new DatabaseSync(dbPath);
		dbInstance.exec('PRAGMA journal_mode = WAL');
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

/** For testing: use an in-memory database. */
export function setDb(db: DB): void {
	dbInstance = db;
}
