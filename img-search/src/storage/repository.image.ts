import type { ImageImportRecord, ImageImportInsert, ImportStatus } from './types.js';
import { getDb } from './db.js';

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

/**
 * Insert a new import record. Uses INSERT OR IGNORE so that a pre-existing row
 * with the same visual `hash` (e.g., two images differing only in EXIF) is left
 * untouched and the caller can detect the dedup via `result.lastInsertRowid === 0`.
 */
export function insert(insert: ImageImportInsert): number {
	const db = getDb();
	const stmt = db.prepare(`
    INSERT OR IGNORE INTO image_import (blake3, hash, status)
    VALUES (?, ?, ?)
  `);
	const result = stmt.run(insert.blake3, insert.hash, insert.status);
	return Number(result.lastInsertRowid);
}

export function getById(id: number): ImageImportRecord | null {
	const db = getDb();
	const row = db.prepare('SELECT * FROM image_import WHERE id = ?').get(id) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToRecord(row) : null;
}

/**
 * Find by visual content hash. Two images differing only in EXIF share the same
 * `hash` and thus resolve to the same import record.
 */
export function getByHash(hash: string): ImageImportRecord | null {
	const db = getDb();
	const row = db.prepare('SELECT * FROM image_import WHERE hash = ?').get(hash) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToRecord(row) : null;
}

/**
 * Find by original-file BLAKE3. Returns the row whose `blake3` matches; note that
 * for images differing only in EXIF, only the first-imported blake3 is stored.
 */
export function getByBlake3(blake3: string): ImageImportRecord | null {
	const db = getDb();
	const row = db.prepare('SELECT * FROM image_import WHERE blake3 = ?').get(blake3) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToRecord(row) : null;
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
	const db = getDb();
	if (extra) {
		const sets: string[] = ['status = ?', "processed_at = datetime('now')"];
		const values: (string | number)[] = [status];
		if (extra.qdrantPointId !== undefined) {
			sets.push('qdrant_point_id = ?');
			values.push(extra.qdrantPointId);
		}
		if (extra.textDescription !== undefined) {
			sets.push('text_description = ?');
			values.push(extra.textDescription);
		}
		if (extra.descriptionModel !== undefined) {
			sets.push('description_model = ?');
			values.push(extra.descriptionModel);
		}
		if (extra.error !== undefined) {
			sets.push('error = ?');
			values.push(extra.error);
		}
		values.push(id);
		db.prepare(`UPDATE image_import SET ${sets.join(', ')} WHERE id = ?`).run(...values);
	} else {
		db.prepare(
			"UPDATE image_import SET status = ?, processed_at = datetime('now') WHERE id = ?",
		).run(status, id);
	}
}

export function countByStatus(): Record<ImportStatus, number> {
	const db = getDb();
	const rows = db
		.prepare(`
    SELECT status, COUNT(*) as cnt FROM image_import GROUP BY status
  `)
		.all() as { status: ImportStatus; cnt: number }[];

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
	const row = db.prepare('SELECT COUNT(*) as cnt FROM image_import').get() as { cnt: number };
	return row.cnt;
}

export function getPending(limit = 100): ImageImportRecord[] {
	const db = getDb();
	const rows = db
		.prepare(`
    SELECT * FROM image_import WHERE status IN ('pending', 'processing', 'failed')
    ORDER BY id LIMIT ?
  `)
		.all(limit) as Record<string, unknown>[];
	return rows.map(rowToRecord);
}
