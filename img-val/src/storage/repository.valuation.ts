import type { ValuationInsert, ValuationRecord } from './types.js';
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
		valuedAt: row.valued_at as string,
	};
}

export function insert(r: ValuationInsert): number {
	const db = getDb();
	const stmt = db.prepare(`
    INSERT INTO valuation (
      image_hash, url, image_format, width, height, channels, size_bytes,
      undecodable_pixels, min_value, max_value, currency,
      standard_name, standard_version, llm_model,
      description, notes, tool_used, tool_fallback, input_tokens, output_tokens, raw_llm_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

	const result = stmt.run(
		r.imageHash,
		r.url,
		r.imageFormat,
		r.width,
		r.height,
		r.channels,
		r.sizeBytes,
		r.undecodablePixels,
		r.minValue,
		r.maxValue,
		r.currency,
		r.standardName,
		r.standardVersion,
		r.llmModel,
		r.description,
		JSON.stringify(r.notes),
		r.toolUsed ? 1 : 0,
		r.toolFallback ? 1 : 0,
		r.inputTokens,
		r.outputTokens,
		r.rawLlmText,
	);
	return Number(result.lastInsertRowid);
}

export function getById(id: number): ValuationRecord | null {
	const db = getDb();
	const row = db.prepare('SELECT * FROM valuation WHERE id = ?').get(id) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToRecord(row) : null;
}

export function getByHash(hash: string): ValuationRecord[] {
	const db = getDb();
	const rows = db
		.prepare('SELECT * FROM valuation WHERE image_hash = ? ORDER BY valued_at DESC')
		.all(hash) as Record<string, unknown>[];
	return rows.map(rowToRecord);
}

export function existsByHashAndStandard(hash: string, standardName: string): boolean {
	const db = getDb();
	const row = db
		.prepare('SELECT 1 FROM valuation WHERE image_hash = ? AND standard_name = ? LIMIT 1')
		.get(hash, standardName) as Record<string, unknown> | undefined;
	return row !== undefined;
}

export function updateUrlByHashAndStandard(hash: string, standardName: string, newUrl: string): number {
	const db = getDb();
	const result = db
		.prepare('UPDATE valuation SET url = ? WHERE image_hash = ? AND standard_name = ?')
		.run(newUrl, hash, standardName);
	return Number(result.changes);
}

export function count(): number {
	const db = getDb();
	const row = db.prepare('SELECT COUNT(*) AS cnt FROM valuation').get() as Record<string, unknown>;
	return row.cnt as number;
}
