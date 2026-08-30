import type { ResponseSchema, ToolDef, LogprobInfo } from '@llm-image/shared';
import { ParseError } from '@llm-image/shared';
import { z } from 'zod';
import type { Confidence } from '../storage/types.js';

const valuationResponseSchema = z
	.object({
		min_value: z.number().nonnegative(),
		max_value: z.number().nonnegative(),
		rationale: z.string(),
		confidence: z.enum(['low', 'medium', 'high']),
	})
	.refine((d) => d.max_value >= d.min_value, {
		message: 'max_value 必须 >= min_value',
	});

/**
 * JSON Schema for constrained decoding (OpenAI response_format / tool input_schema).
 * Follows OpenAI strict mode rules: all fields required, additionalProperties: false.
 */
export const VALUATION_RESPONSE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		min_value: { type: 'number' },
		max_value: { type: 'number' },
		rationale: { type: 'string', description: '不超过 200 字的中文说明' },
		confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
	},
	required: ['min_value', 'max_value', 'rationale', 'confidence'],
	additionalProperties: false,
};

/** ResponseSchema for OpenAI response_format */
export const VALUATION_RESPONSE_FORMAT: ResponseSchema = {
	name: 'valuation_result',
	schema: VALUATION_RESPONSE_SCHEMA,
};

/**
 * submit_valuation tool — used for Anthropic (no native response_format).
 * The model calls this tool with structured arguments; we extract args as the response.
 */
/**
 * Build a constrained-decoding submit tool from a response schema.
 * Used so that the min-only / max-only flows each carry the schema describing
 * only their bound (plan C: two independent scenario requests).
 */
export function submitToolFor(schema: ResponseSchema): ToolDef {
	return {
		type: 'function',
		function: {
			name: 'submit_valuation',
			description: '提交最终估值结果',
			parameters: schema.schema,
		},
	};
}

/** Generic submit tool (combined bounds) — kept for backward-compat and fail-log. */
export const SUBMIT_VALUATION_TOOL: ToolDef = submitToolFor(VALUATION_RESPONSE_FORMAT);

// ---------------------------------------------------------------------------
// Plan C: independent min / max estimation
//
// min_value (客观假设) and max_value (最好假设) are estimated in two separate
// requests so that the upper bound is not anchored on the just-generated lower
// bound. Each request returns only its own bound + rationale + confidence.
// ---------------------------------------------------------------------------

const minValueSchema = z.object({
	min_value: z.number().nonnegative(),
	rationale: z.string(),
	confidence: z.enum(['low', 'medium', 'high']),
});

const maxValueSchema = z.object({
	max_value: z.number().nonnegative(),
	rationale: z.string(),
	confidence: z.enum(['low', 'medium', 'high']),
});

export const MIN_VALUE_RESPONSE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		min_value: { type: 'number' },
		rationale: { type: 'string', description: '不超过 200 字的中文说明' },
		confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
	},
	required: ['min_value', 'rationale', 'confidence'],
	additionalProperties: false,
};

export const MAX_VALUE_RESPONSE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		max_value: { type: 'number' },
		rationale: { type: 'string', description: '不超过 200 字的中文说明' },
		confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
	},
	required: ['max_value', 'rationale', 'confidence'],
	additionalProperties: false,
};

export const MIN_VALUE_RESPONSE_FORMAT: ResponseSchema = {
	name: 'min_value_result',
	schema: MIN_VALUE_RESPONSE_SCHEMA,
};

export const MAX_VALUE_RESPONSE_FORMAT: ResponseSchema = {
	name: 'max_value_result',
	schema: MAX_VALUE_RESPONSE_SCHEMA,
};

export interface ParsedValuation {
	minValue: number;
	maxValue: number;
	rationale: string;
	confidence: Confidence;
}

export interface ParsedMinValue {
	minValue: number;
	rationale: string;
	confidence: Confidence;
}

export interface ParsedMaxValue {
	maxValue: number;
	rationale: string;
	confidence: Confidence;
}

/** Parse an LLM response that contains only min_value. Mirrors parseValuationResponse. */
export function parseMinResponse(text: string): ParsedMinValue {
	const direct = tryParseJson(text);
	if (direct) return validateMinValue(direct);
	const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fence?.[1]) {
		const f = tryParseJson(fence[1]);
		if (f) return validateMinValue(f);
	}
	const json = text.match(/\{[\s\S]*\}/);
	if (json) {
		const j = tryParseJson(json[0]);
		if (j) return validateMinValue(j);
	}
	throw new ParseError(`LLM 响应无法解析为 min_value JSON: ${text.slice(0, 200)}...`);
}

/** Parse an LLM response that contains only max_value. Mirrors parseValuationResponse. */
export function parseMaxResponse(text: string): ParsedMaxValue {
	const direct = tryParseJson(text);
	if (direct) return validateMaxValue(direct);
	const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fence?.[1]) {
		const f = tryParseJson(fence[1]);
		if (f) return validateMaxValue(f);
	}
	const json = text.match(/\{[\s\S]*\}/);
	if (json) {
		const j = tryParseJson(json[0]);
		if (j) return validateMaxValue(j);
	}
	throw new ParseError(`LLM 响应无法解析为 max_value JSON: ${text.slice(0, 200)}...`);
}

function validateMinValue(data: Record<string, unknown>): ParsedMinValue {
	const result = minValueSchema.safeParse(data);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new ParseError(`min_value JSON 校验失败: ${issues}`);
	}
	return {
		minValue: result.data.min_value,
		rationale: result.data.rationale,
		confidence: result.data.confidence,
	};
}

function validateMaxValue(data: Record<string, unknown>): ParsedMaxValue {
	const result = maxValueSchema.safeParse(data);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new ParseError(`max_value JSON 校验失败: ${issues}`);
	}
	return {
		maxValue: result.data.max_value,
		rationale: result.data.rationale,
		confidence: result.data.confidence,
	};
}

/**
 * Parse the LLM's text response to extract a valuation JSON.
 * Handles: clean JSON, JSON in code fences, JSON with trailing prose.
 */
export function parseValuationResponse(text: string): ParsedValuation {
	// Try direct parse first
	const directResult = tryParseJson(text);
	if (directResult) return validateValuation(directResult);

	// Try extracting from code fence
	const codeFenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (codeFenceMatch?.[1]) {
		const fencedResult = tryParseJson(codeFenceMatch[1]);
		if (fencedResult) return validateValuation(fencedResult);
	}

	// Try extracting first JSON object from text
	const jsonMatch = text.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		const extractedResult = tryParseJson(jsonMatch[0]);
		if (extractedResult) return validateValuation(extractedResult);
	}

	throw new ParseError(`LLM 响应无法解析为 JSON: ${text.slice(0, 200)}...`);
}

function tryParseJson(text: string): Record<string, unknown> | null {
	try {
		return JSON.parse(text.trim()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * 计算某个边界数值（min_value / max_value）对应 token 的**平均 logprob**。
 *
 * 提供者只在「JSON 以文本/内容 token 形式产出」时返回 logprobs（OpenAI
 * response_format、Anthropic 文本 JSON），tool_use 的参数 token 不返回。因此
 * 调用方需保证数值走 content 路径（见 tool-flow）。
 *
 * 做法：用 logprobs token 序列重建文本与每个 token 的字符区间，再用正则定位
 * 该 key 对应的数值子串，对与其重叠的 token 的 logprob 求平均。返回 null 表示
 * 无 logprobs 或未能定位数值。
 */
export function meanLogprobForValue(
	logprobs: LogprobInfo | undefined,
	jsonText: string,
	key: 'min_value' | 'max_value',
): number | null {
	if (!logprobs || logprobs.tokens.length === 0) return null;

	// 重建完整文本与各 token 的字符区间
	let rebuilt = '';
	const ranges: Array<[number, number]> = [];
	for (const tok of logprobs.tokens) {
		const start = rebuilt.length;
		rebuilt += tok.token;
		ranges.push([start, rebuilt.length]);
	}

	const re = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g');
	let best: { start: number; end: number } | null = null;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rebuilt)) !== null) {
		const valueStart = m.index + m[0].indexOf(m[1]!);
		best = { start: valueStart, end: valueStart + m[1]!.length };
	}
	if (!best) return null;

	let sum = 0;
	let count = 0;
	for (let i = 0; i < logprobs.tokens.length; i++) {
		const [s, e] = ranges[i]!;
		// token 与数值区间存在重叠即计入（数字可能被拆成多个 token）
		if (e > best.start && s < best.end) {
			sum += logprobs.tokens[i]!.logprob;
			count++;
		}
	}
	if (count === 0) return null;
	return sum / count;
}

function validateValuation(data: Record<string, unknown>): ParsedValuation {
	const result = valuationResponseSchema.safeParse(data);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new ParseError(`估值 JSON 校验失败: ${issues}`);
	}

	return {
		minValue: result.data.min_value,
		maxValue: result.data.max_value,
		rationale: result.data.rationale,
		confidence: result.data.confidence,
	};
}
