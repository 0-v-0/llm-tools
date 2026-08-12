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
		corruption: row.corruption as ValuationRecord['corruption'],
		minValue: row.min_value as number,
		maxValue: row.max_value as number,
		uncertainty: row.uncertainty as number,
		currency: row.currency as string,
		standardName: row.standard_name as string,
		standardVersion: (row.standard_version as string | null) ?? null,
		llmProvider: row.llm_provider as string,
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
      corruption, min_value, max_value, uncertainty, currency,
      standard_name, standard_version, llm_provider, llm_model,
      description, notes, tool_used, tool_fallback, input_tokens, output_tokens, raw_llm_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

	const result = stmt.run(
		r.imageHash,
		r.url,
		r.imageFormat,
		r.width,
		r.height,
		r.channels,
		r.sizeBytes,
		r.corruption,
		r.minValue,
		r.maxValue,
		r.uncertainty,
		r.currency,
		r.standardName,
		r.standardVersion,
		r.llmProvider,
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

export function count(): number {
	const db = getDb();
	const row = db.prepare('SELECT COUNT(*) AS cnt FROM valuation').get() as Record<string, unknown>;
	return row.cnt as number;
}
