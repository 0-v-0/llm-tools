import type { SearchParams, ValuationRecord } from './types.js';
import { getDb } from './db.js';

function rowToRecord(row: Record<string, unknown>): ValuationRecord {
	return {
		id: row.id as number,
		imageHash: row.image_hash as string,
		url: row.url as string,
		imageFormat: row.image_format as ValuationRecord['imageFormat'],
		width: row.width as number,
		height: row.height as number,
		channels: (row.channels as number | null) ?? null,
		sizeBytes: row.size_bytes as number,
		undecodablePixels: row.undecodable_pixels as number,
		minValue: row.min_value as number,
		maxValue: row.max_value as number,
		currency: row.currency as string,
		standardName: row.standard_name as string,
		standardVersion: (row.standard_version as string | null) ?? null,
		llmModel: row.llm_model as string,
		description: row.description as string,
		notes: JSON.parse(row.notes as string) as string[],
		toolUsed: row.tool_used === 1,
		toolFallback: row.tool_fallback === 1,
		inputTokens: (row.input_tokens as number | null) ?? null,
		outputTokens: (row.output_tokens as number | null) ?? null,
		minLogprob: (row.min_logprob as number | null) ?? null,
		maxLogprob: (row.max_logprob as number | null) ?? null,
		confidenceScore: (row.confidence_score as number | null) ?? null,
		samplesMin: (row.samples_min as number | null) ?? 1,
		samplesMax: (row.samples_max as number | null) ?? 1,
		valuedAt: row.valued_at as string,
	};
}

/**
 * Structured search by value range, standard, date, format.
 * Used by both the CLI `search` subcommand and the LLM `search_valuations` tool.
 */
export function search(params: SearchParams): ValuationRecord[] {
	const db = getDb();
	const conditions: string[] = [];
	const args: (string | number)[] = [];

	if (params.minValue !== undefined) {
		conditions.push('min_value >= ?');
		args.push(params.minValue);
	}
	if (params.maxValue !== undefined) {
		conditions.push('max_value <= ?');
		args.push(params.maxValue);
	}
	if (params.standardName) {
		conditions.push('standard_name = ?');
		args.push(params.standardName);
	}
	if (params.dateFrom) {
		conditions.push('valued_at >= ?');
		args.push(params.dateFrom);
	}
	if (params.dateTo) {
		conditions.push('valued_at <= ?');
		args.push(params.dateTo);
	}
	if (params.format) {
		const formats = Array.isArray(params.format) ? params.format : [params.format];
		const placeholders = formats.map(() => '?').join(',');
		conditions.push(`image_format IN (${placeholders})`);
		args.push(...formats);
	}

	const limit = Math.min(params.limit ?? 20, 50);
	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT * FROM valuation ${where} ORDER BY valued_at DESC LIMIT ?`;
	args.push(limit);

	const stmt = db.prepare(sql);
	const rows = stmt.all(...args) as Record<string, unknown>[];
	return rows.map(rowToRecord);
}

/**
 * Free-text search on description via FTS5.
 */
export function searchByText(query: string, limit = 20): ValuationRecord[] {
	const db = getDb();
	const safeLimit = Math.min(limit, 50);
	// FTS5 MATCH query — escape special chars by quoting
	const ftsQuery = query.replace(/["']/g, ' ').trim();
	if (!ftsQuery) return [];

	const rows = db
		.prepare(`
    SELECT v.* FROM valuation v
    JOIN valuation_fts f ON v.id = f.rowid
    WHERE valuation_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `)
		.all(ftsQuery, safeLimit) as Record<string, unknown>[];

	return rows.map(rowToRecord);
}
