import type { ToolDef } from '@llm-image/shared';

/**
 * 构建 submit_questions 工具定义。
 * maxItems 控制单轮最多生成的问题数（默认 5）。
 */
export function createQuestionsTool(maxItems: number = 5): ToolDef {
	return {
		type: 'function',
		function: {
			name: 'submit_questions',
			description: '提交候选区分问题',
			parameters: {
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
						maxItems,
					},
				},
				required: ['questions'],
				additionalProperties: false,
			},
		},
	};
}

export interface ParsedQuestion {
	question: string;
	rationale: string;
}

/**
 * 解析 LLM 返回的问题响应
 * 使用四级 fallback: tool call → direct JSON → code fence → regex
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
			} catch (e) {
				// 只有 JSON 解析错误才 fallback，验证错误应该直接抛出
				if (!(e instanceof SyntaxError)) {
					throw e;
				}
				// fallback to text parsing
			}
		}
	}

	// 尝试直接解析 JSON
	try {
		const parsed = JSON.parse(text.trim()) as { questions?: unknown } | unknown[];
		// 顶层裸 JSON 数组也是合法的问题列表，直接验证
		if (Array.isArray(parsed)) {
			return validateQuestions(parsed);
		}
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
	// 先按 "question" 键切分文本，保证每个 question 只配对其后紧跟的
	// rationale，而不会跨越到下一个 question 的内容
	const segments = text.split(/["']?question["']?\s*:/i);
	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i]!;
		const qMatch = segment.match(/^\s*["']([^"']+)["']/);
		const rMatch = segment.match(/["']?rationale["']?\s*:\s*["']([^"']+)["']/i);
		if (qMatch?.[1] && rMatch?.[1]) {
			questions.push({ question: qMatch[1].trim(), rationale: rMatch[1].trim() });
		}
	}
	if (questions.length === 0) {
		throw new Error('Failed to parse questions from response');
	}
	return questions;
}
