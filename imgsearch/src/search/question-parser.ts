import type { ToolDef } from '@llm-image/shared';

export const QUESTIONS_SCHEMA = {
	type: 'object',
	properties: {
		questions: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					question: { type: 'string', description: '关于图片内容的是非问句' },
					rationale: { type: 'string', description: '此问题如何区分候选' },
				},
				required: ['question', 'rationale'],
				additionalProperties: false,
			},
			minItems: 1,
			maxItems: 5,
		},
	},
	required: ['questions'],
	additionalProperties: false,
};

export const SUBMIT_QUESTIONS_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'submit_questions',
		description: '提交候选区分问题',
		parameters: QUESTIONS_SCHEMA,
	},
};

export interface ParsedQuestion {
	question: string;
	rationale: string;
}

/**
 * 解析 LLM 返回的问题响应
 * 使用三级 fallback: tool call → direct JSON → code fence → regex
 */
export function parseQuestionsResponse(
	text: string,
	toolCalls?: { name: string; arguments: string }[],
): ParsedQuestion[] {
	// 优先使用 tool call
	if (toolCalls && toolCalls.length > 0) {
		const submitCall = toolCalls.find((tc) => tc.name === 'submit_questions');
		if (submitCall) {
			try {
				const parsed = JSON.parse(submitCall.arguments);
				return validateQuestions(parsed.questions);
			} catch {
				// fallback to text parsing
			}
		}
	}

	// 尝试直接解析 JSON
	try {
		const parsed = JSON.parse(text.trim());
		if (parsed.questions) {
			return validateQuestions(parsed.questions);
		}
	} catch (e) {
		// 只有 JSON 解析错误才 fallback，验证错误应该直接抛出
		if (!(e instanceof SyntaxError)) {
			throw e;
		}
		// fallback to code fence
	}

	// 尝试从 code fence 中提取
	const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeMatch && codeMatch[1]) {
		try {
			const parsed = JSON.parse(codeMatch[1].trim());
			if (parsed.questions) {
				return validateQuestions(parsed.questions);
			}
		} catch {
			// fallback to regex
		}
	}

	// 尝试 regex 提取 question/rationale 对
	return extractQuestionsRegex(text);
}

function validateQuestions(raw: unknown): ParsedQuestion[] {
	if (!Array.isArray(raw)) {
		throw new Error('questions must be an array');
	}

	return raw.map((item, idx) => {
		if (typeof item !== 'object' || item === null) {
			throw new Error(`question[${idx}] must be an object`);
		}
		const { question, rationale } = item as Record<string, unknown>;
		if (typeof question !== 'string' || question.trim().length === 0) {
			throw new Error(`question[${idx}].question must be a non-empty string`);
		}
		if (typeof rationale !== 'string' || rationale.trim().length === 0) {
			throw new Error(`question[${idx}].rationale must be a non-empty string`);
		}
		return { question: question.trim(), rationale: rationale.trim() };
	});
}

function extractQuestionsRegex(text: string): ParsedQuestion[] {
	const questions: ParsedQuestion[] = [];
	const questionPattern =
		/["']?question["']?\s*:\s*["']([^"']+)["'][\s\S]*?["']?rationale["']?\s*:\s*["']([^"']+)["']/gi;
	let match;
	while ((match = questionPattern.exec(text)) !== null) {
		if (match[1] && match[2]) {
			questions.push({ question: match[1].trim(), rationale: match[2].trim() });
		}
	}
	if (questions.length === 0) {
		throw new Error('Failed to parse questions from response');
	}
	return questions;
}
