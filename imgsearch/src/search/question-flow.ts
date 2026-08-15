import type { LLMProvider } from '@llm-image/shared';
import type { CandidateInfo, QuestionHistoryEntry } from './question-prompt.js';
import {
	parseQuestionsResponse,
	ParsedQuestion,
	SUBMIT_QUESTIONS_TOOL,
} from './question-parser.js';
import { buildQuestionPrompt } from './question-prompt.js';

export type { ParsedQuestion };

export interface GenerateQuestionsOptions {
	llm: LLMProvider;
	candidates: CandidateInfo[];
	history: QuestionHistoryEntry[];
	showThumbnails: boolean;
}

/**
 * 调用 LLM 生成区分性问题
 */
export async function generateQuestions(opts: GenerateQuestionsOptions): Promise<ParsedQuestion[]> {
	const { llm, candidates, history, showThumbnails } = opts;

	const messages = buildQuestionPrompt({ candidates, history, showThumbnails });

	const response = await llm.complete({
		model: llm.model,
		messages,
		tools: [SUBMIT_QUESTIONS_TOOL],
	});

	return parseQuestionsResponse(response.text, response.toolCalls);
}
