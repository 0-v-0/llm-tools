import { ParseError } from '@llm-image/shared';
import { z } from 'zod';

const selectionSchema = z.object({
	selected: z.string().min(1),
	reason: z.string(),
});

export interface ParsedSelection {
	/** The label selected by the LLM (e.g. "A"). */
	selected: string;
	/** The reason given by the LLM. */
	reason: string;
}

/**
 * Parse the LLM's response to extract the selected image label.
 * Handles: clean JSON, JSON in code fences, JSON with trailing prose.
 */
export function parseSelectionResponse(text: string): ParsedSelection {
	// Try direct parse
	const direct = tryParseJson(text);
	if (direct) return validate(direct);

	// Try extracting from code fence
	const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fence?.[1]) {
		const f = tryParseJson(fence[1]);
		if (f) return validate(f);
	}

	// Try extracting first JSON object
	const json = text.match(/\{[\s\S]*\}/);
	if (json) {
		const j = tryParseJson(json[0]);
		if (j) return validate(j);
	}

	throw new ParseError(`LLM 响应无法解析为选择 JSON: ${text.slice(0, 200)}...`);
}

function tryParseJson(text: string): Record<string, unknown> | null {
	try {
		return JSON.parse(text.trim()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function validate(data: Record<string, unknown>): ParsedSelection {
	const result = selectionSchema.safeParse(data);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new ParseError(`选择 JSON 校验失败: ${issues}`);
	}
	return {
		selected: result.data.selected.trim().toUpperCase(),
		reason: result.data.reason,
	};
}
