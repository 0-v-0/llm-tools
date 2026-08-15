import type { ResponseSchema, ToolDef } from '@llm-image/shared';
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
export const SUBMIT_VALUATION_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'submit_valuation',
		description: '提交最终估值结果',
		parameters: VALUATION_RESPONSE_SCHEMA,
	},
};

export interface ParsedValuation {
	minValue: number;
	maxValue: number;
	rationale: string;
	confidence: Confidence;
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
