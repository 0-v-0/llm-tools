import type { ImageImportRecord, ImageImportInsert, ImportStatus } from './types.ts';
import type { DB } from '@llm-image/shared';
import { getDb } from './db.ts';

function rowToRecord(row: Record<string, unknown>): ImageImportRecord {
	return {
		id: row.id as number,
		blake3: row.blake3 as string,
		hash: row.hash as string,
		status: row.status as ImportStatus,
		qdrantPointId: (row.qdrant_point_id as string | null) ?? null,
		textDescription: (row.text_description as string | null) ?? null,
		descriptionModel: (row.description_model as string | null) ?? null,
		error: (row.error as string | null) ?? null,
		importedAt: row.imported_at as string,
		processedAt: (row.processed_at as string | null) ?? null,
	};
}

function rowToNullableRecord(row: unknown): ImageImportRecord | null {
	return row ? rowToRecord(row as Record<string, unknown>) : null;
}

interface RepositoryStatements {
	insert: ReturnType<DB['prepare']>;
	getById: ReturnType<DB['prepare']>;
	getByHash: ReturnType<DB['prepare']>;
	getByBlake3: ReturnType<DB['prepare']>;
	countByStatus: ReturnType<DB['prepare']>;
	countTotal: ReturnType<DB['prepare']>;
}

/**
 * Prepared statements are cached per DB instance: closeDb/reopen or test-injected
 * databases naturally get a fresh set of statements via the WeakMap.
 */
const statementCache = new WeakMap<DB, RepositoryStatements>();

function stmts(db: DB): RepositoryStatements {
	let cached = statementCache.get(db);
	if (!cached) {
		cached = {
			insert: db.prepare(`
				INSERT INTO image_import (blake3, hash, status)
				VALUES (?, ?, ?)
				ON CONFLICT(hash) DO NOTHING
			`),
			getById: db.prepare('SELECT * FROM image_import WHERE id = ?'),
			getByHash: db.prepare('SELECT * FROM image_import WHERE hash = ?'),
			getByBlake3: db.prepare('SELECT * FROM image_import WHERE blake3 = ?'),
			countByStatus: db.prepare(`
				SELECT status, COUNT(*) as cnt FROM image_import GROUP BY status
			`),
			countTotal: db.prepare('SELECT COUNT(*) as cnt FROM image_import'),
		};
		statementCache.set(db, cached);
	}
	return cached;
}

/**
 * Insert a new import record. Uses ON CONFLICT(hash) DO NOTHING so that a
 * pre-existing row with the same visual `hash` (e.g., two images differing
 * only in EXIF) is left untouched. Returns the new rowid, or 0 when the insert
 * was ignored as a duplicate — detected via `result.changes === 1`, since an
 * ignored insert does not reset `last_insert_rowid()`.
 */
export function insert(insert: ImageImportInsert): number {
	const db = getDb();
	const result = stmts(db).insert.run(insert.blake3, insert.hash, insert.status);
	return result.changes === 1 ? Number(result.lastInsertRowid) : 0;
}

export function getById(id: number): ImageImportRecord | null {
	return rowToNullableRecord(stmts(getDb()).getById.get(id));
}

/**
 * Find by visual content hash. Two images differing only in EXIF share the same
 * `hash` and thus resolve to the same import record.
 */
export function getByHash(hash: string): ImageImportRecord | null {
	return rowToNullableRecord(stmts(getDb()).getByHash.get(hash));
}

/**
 * Find by original-file BLAKE3. Returns the row whose `blake3` matches; note that
 * for images differing only in EXIF, only the first-imported blake3 is stored.
 */
export function getByBlake3(blake3: string): ImageImportRecord | null {
	return rowToNullableRecord(stmts(getDb()).getByBlake3.get(blake3));
}

export function updateStatus(
	id: number,
	status: ImportStatus,
	extra?: {
		qdrantPointId?: string;
		textDescription?: string;
		descriptionModel?: string;
		error?: string;
	},
): void {
	// Base fragments are always present; extra fields are appended when given.
	const sets: string[] = ['status = ?', "processed_at = datetime('now')"];
	const values: (string | number)[] = [status];
	if (extra?.qdrantPointId !== undefined) {
		sets.push('qdrant_point_id = ?');
		values.push(extra.qdrantPointId);
	}
	if (extra?.textDescription !== undefined) {
		sets.push('text_description = ?');
		values.push(extra.textDescription);
	}
	if (extra?.descriptionModel !== undefined) {
		sets.push('description_model = ?');
		values.push(extra.descriptionModel);
	}
	if (extra?.error !== undefined) {
		sets.push('error = ?');
		values.push(extra.error);
	}
	values.push(id);
	// Not cached: the SQL varies with the optional fields. Without extras it is
	// equivalent to the cached basic update it replaced.
	const db = getDb();
	db.prepare(`UPDATE image_import SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function countByStatus(): Record<ImportStatus, number> {
	const db = getDb();
	const rows = stmts(db).countByStatus.all() as { status: ImportStatus; cnt: number }[];

	const result: Record<ImportStatus, number> = {
		pending: 0,
		processing: 0,
		embedded: 0,
		indexed: 0,
		failed: 0,
	};
	for (const row of rows) {
		result[row.status] = row.cnt;
	}
	return result;
}

export function countTotal(): number {
	const db = getDb();
	const row = stmts(db).countTotal.get() as { cnt: number };
	return row.cnt;
}
