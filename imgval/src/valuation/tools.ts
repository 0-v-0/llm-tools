import type { ToolDef } from '@llm-image/shared';
import { z } from 'zod';
import type { SearchParams, ValuationRecord } from '../storage/types.js';
import { search as searchRepository } from '../storage/repository.search.js';

export const SEARCH_VALUATIONS_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'search_valuations',
		description:
			'查询历史图片估值记录，按价值区间、标准名称、日期范围、图片格式过滤。仅用于参考，不决定本次估值。',
		parameters: {
			type: 'object',
			properties: {
				min_value: { type: 'number', description: '最低价值 (人民币元)' },
				max_value: { type: 'number', description: '最高价值 (人民币元)' },
				standard_name: { type: 'string' },
				date_from: { type: 'string', description: 'ISO date YYYY-MM-DD' },
				date_to: { type: 'string', description: 'ISO date YYYY-MM-DD' },
				format: { type: 'string', enum: ['jpeg', 'png', 'webp'] },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
			},
		},
	},
};

const searchParamsSchema = z.object({
	min_value: z.number().optional(),
	max_value: z.number().optional(),
	standard_name: z.string().optional(),
	date_from: z.string().optional(),
	date_to: z.string().optional(),
	format: z.enum(['jpeg', 'png', 'webp']).optional(),
	limit: z.number().int().min(1).max(50).default(10),
});

export type ToolExecutionResult = { ok: true; result: unknown } | { ok: false; error: string };

export function executeToolCall(name: string, args: unknown): ToolExecutionResult {
	if (name !== 'search_valuations') {
		return { ok: false, error: `unknown tool: ${name}` };
	}

	const parsed = searchParamsSchema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.message };
	}

	const params: SearchParams = {
		minValue: parsed.data.min_value,
		maxValue: parsed.data.max_value,
		standardName: parsed.data.standard_name,
		dateFrom: parsed.data.date_from,
		dateTo: parsed.data.date_to,
		format: parsed.data.format,
		limit: parsed.data.limit,
	};

	const records: ValuationRecord[] = searchRepository(params);

	// Return simplified records to LLM
	const simplified = records.map((r) => ({
		min: r.minValue,
		max: r.maxValue,
		standard: r.standardName,
		format: r.imageFormat,
		valued_at: r.valuedAt,
		description: r.description.slice(0, 120),
	}));

	return { ok: true, result: simplified };
}
