import { matchesAnyGlob } from '../util/path-match.js';
import { fileUrlToPath } from '../util/url.js';
import { getDb } from './db.js';

export interface LowValueFile {
	url: string;
	imageHash: string;
	maxValue: number;
	recordCount: number;
}

/**
 * Distinct source files whose highest recorded valuation (MAX(max_value))
 * is below the threshold, grouped by url. Ordered by max_value ascending so
 * the cheapest files come first. Used by the `move-low` subcommand.
 */
export function findLowValueFiles(threshold: number, pathGlobs?: string[]): LowValueFile[] {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT url, image_hash AS imageHash, MAX(max_value) AS maxValue, COUNT(*) AS recordCount
       FROM valuation
       GROUP BY url
       HAVING MAX(max_value) < ?
       ORDER BY maxValue ASC`,
		)
		.all(threshold) as Record<string, unknown>[];
	return rows.map(rowToLowValueFile).filter((f) => pathMatches(f, pathGlobs));
}

/**
 * Returns the N files with the lowest max_value, ordered ascending.
 * Used by the percentage threshold mode of `move-low`.
 */
export function findLowestNFiles(n: number, pathGlobs?: string[]): LowValueFile[] {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT url, image_hash AS imageHash, MAX(max_value) AS maxValue, COUNT(*) AS recordCount
       FROM valuation
       GROUP BY url
       ORDER BY maxValue ASC`,
		)
		.all() as Record<string, unknown>[];
	return rows.map(rowToLowValueFile).filter((f) => pathMatches(f, pathGlobs)).slice(0, n);
}

/** Total number of distinct files (by url) in the database. */
export function countDistinctFiles(pathGlobs?: string[]): number {
	if (!pathGlobs || pathGlobs.length === 0) {
		const db = getDb();
		const row = db.prepare('SELECT COUNT(DISTINCT url) AS cnt FROM valuation').get() as {
			cnt: number;
		};
		return row.cnt as number;
	}
	const db = getDb();
	const rows = db
		.prepare('SELECT DISTINCT url FROM valuation')
		.all() as Record<string, unknown>[];
	let count = 0;
	for (const r of rows) {
		const url = r.url as string;
		const localPath = url.startsWith('file://') ? fileUrlToPath(url) : null;
		if (localPath !== null && matchesAnyGlob(localPath, pathGlobs)) count++;
	}
	return count;
}

/** Point all records referencing the old url to the new location. */
export function updateRecordUrl(oldUrl: string, newUrl: string): number {
	const db = getDb();
	const result = db.prepare('UPDATE valuation SET url = ? WHERE url = ?').run(newUrl, oldUrl);
	return Number(result.changes);
}

/** Highest recorded max_value for a url, or null if there are no records. */
export function getMaxValueByUrl(url: string): number | null {
	const db = getDb();
	const row = db
		.prepare('SELECT MAX(max_value) AS maxValue FROM valuation WHERE url = ?')
		.get(url) as Record<string, unknown> | undefined;
	if (!row || row.maxValue === null || row.maxValue === undefined) return null;
	return row.maxValue as number;
}

function rowToLowValueFile(r: Record<string, unknown>): LowValueFile {
	return {
		url: r.url as string,
		imageHash: r.imageHash as string,
		maxValue: r.maxValue as number,
		recordCount: r.recordCount as number,
	};
}

/** True when the file's URL/path passes the (optional) path glob filter. */
function pathMatches(file: LowValueFile, pathGlobs?: string[]): boolean {
	if (!pathGlobs || pathGlobs.length === 0) return true;
	const localPath = file.url.startsWith('file://') ? fileUrlToPath(file.url) : null;
	if (localPath === null) return false;
	return matchesAnyGlob(localPath, pathGlobs);
}
