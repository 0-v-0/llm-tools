import type { LLMProvider } from '@llm-image/shared';
import type { CandidateInfo, QuestionHistoryEntry } from './question-prompt.ts';
import type { ParsedQuestion } from './question-parser.ts';
import { parseQuestionsResponse, createQuestionsTool } from './question-parser.ts';
import { buildQuestionPrompt } from './question-prompt.ts';

export interface GenerateQuestionsOptions {
	llm: LLMProvider;
	candidates: CandidateInfo[];
	history: QuestionHistoryEntry[];
	/** 单轮最多生成的问题数 */
	maxQuestions: number;
}

/**
 * 调用 LLM 生成区分性问题
 */
export async function generateQuestions(opts: GenerateQuestionsOptions): Promise<ParsedQuestion[]> {
	const { llm, candidates, history, maxQuestions } = opts;

	const messages = buildQuestionPrompt({ candidates, history });

	const response = await llm.complete({
		model: llm.model,
		messages,
		tools: [createQuestionsTool(maxQuestions)],
	});

	return parseQuestionsResponse(response.text, response.toolCalls);
}
