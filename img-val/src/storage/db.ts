import { openSqlite, type DB } from '@llm-image/shared';
import { join } from 'node:path';
import { getDbPath } from '../config/paths.js';

let dbInstance: DB | null = null;

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export function getDb(): DB {
	if (dbInstance) return dbInstance;

	const dbPath = getDbPath(process.env.IMGDATA_DIR);
	dbInstance = openSqlite(dbPath, MIGRATIONS_DIR);
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
