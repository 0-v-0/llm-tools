import type { ImageEntry } from './types.ts';
import type { ImageFormat } from '@llm-image/shared';
import { matchesAnyGlob } from '../util/path-match.ts';
import { fileUrlToPath } from '../util/url.ts';
import { getDb } from './db.ts';

/**
 * Query all distinct files from the valuation table, taking the valuation
 * with the highest max_value per URL. Returns ImageEntry objects with
 * technical metadata (no valuation rationale or price info — those are
 * never sent to the LLM).
 *
 * Optional pathGlobs filter narrows to file URLs whose local path matches
 * at least one glob. Optional standardName filter narrows to a single
 * valuation standard.
 */
export function getAllImages(pathGlobs?: string[], standardName?: string): ImageEntry[] {
	const db = getDb();

	const conditions: string[] = [];
	const params: string[] = [];
	if (standardName) {
		conditions.push('standard_name = ?');
		params.push(standardName);
	}
	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	// One row per url: the valuation with the highest max_value. The
	// aggregation runs in JS — a GROUP BY subquery joined back on url has no
	// index to use and was O(n²) (~6s on 12k rows, blocking the event loop);
	// a full scan + map is single-digit ms. Ties keep the first row by rowid.
	const rows = db
		.prepare(
			`SELECT url, image_hash AS imageHash, max_value AS maxValue, min_value AS minValue,
			        standard_name AS standardName, image_format AS imageFormat,
			        width, height, channels, size_bytes AS sizeBytes,
			        undecodable_pixels AS undecodablePixels
			 FROM valuation
			 ${whereClause}
			 ORDER BY rowid`,
		)
		.all(...params) as Record<string, unknown>[];

	const best = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		const url = row.url as string;
		const prev = best.get(url);
		if (!prev || (row.maxValue as number) > (prev.maxValue as number)) best.set(url, row);
	}
	return [...best.values()]
		.map(rowToEntry)
		.sort((a, b) => a.standardName.localeCompare(b.standardName) || a.maxValue - b.maxValue)
		.filter((e) => pathMatches(e, pathGlobs));
}

/** Total number of distinct files (by url) in the database. */
export function countDistinctFiles(pathGlobs?: string[]): number {
	const db = getDb();
	const row = db.prepare('SELECT COUNT(DISTINCT url) AS cnt FROM valuation').get() as { cnt: number } | undefined;
	if (!row) return 0;
	if (!pathGlobs || pathGlobs.length === 0) return row.cnt;

	// Need to filter by path — count matching URLs
	const urls = db.prepare('SELECT DISTINCT url FROM valuation').all() as { url: string }[];
	let count = 0;
	for (const { url } of urls) {
		const localPath = url.startsWith('file://') ? fileUrlToPath(url) : null;
		if (localPath !== null && matchesAnyGlob(localPath, pathGlobs)) count++;
	}
	return count;
}

/** Point all records referencing the old url to the new location (after move). */
export function updateRecordUrl(oldUrl: string, newUrl: string): number {
	const db = getDb();
	const result = db.prepare('UPDATE valuation SET url = ? WHERE url = ?').run(newUrl, oldUrl);
	return Number(result.changes);
}

function rowToEntry(row: Record<string, unknown>): ImageEntry {
	return {
		url: row.url as string,
		imageHash: row.imageHash as string,
		maxValue: row.maxValue as number,
		minValue: row.minValue as number,
		standardName: row.standardName as string,
		imageFormat: row.imageFormat as ImageFormat,
		width: row.width as number,
		height: row.height as number,
		channels: (row.channels as number | null) ?? null,
		sizeBytes: row.sizeBytes as number,
		undecodablePixels: row.undecodablePixels as number,
	};
}

function pathMatches(entry: ImageEntry, pathGlobs?: string[]): boolean {
	if (!pathGlobs || pathGlobs.length === 0) return true;
	const localPath = entry.url.startsWith('file://') ? fileUrlToPath(entry.url) : null;
	if (localPath === null) return false;
	return matchesAnyGlob(localPath, pathGlobs);
}
