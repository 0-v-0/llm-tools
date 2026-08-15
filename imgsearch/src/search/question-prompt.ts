import type { LLMMessage } from '@llm-image/shared';

export interface CandidateInfo {
	id: number;
	description: string;
	probability: number;
}

export interface QuestionHistoryEntry {
	question: string;
	answer: number | 'unknown';
}

export interface BuildQuestionPromptOptions {
	candidates: CandidateInfo[];
	history: QuestionHistoryEntry[];
	showThumbnails?: boolean;
}

const SYSTEM_PROMPT = `你是图片搜索助手。用户心中有一张目标图片，通过提问从候选集中找出它。

规则:
1. 生成 1~5 个是非问题，用户用 0(完全不是)~1(完全是) 或"不知道"回答
2. 优先生成能最大化区分当前候选集的问题
3. 不重复已问过的问题（包括被回答"不知道"的）
4. 聚焦单一视觉/语义属性，避免复合问题
5. 调用 submit_questions 工具提交`;

/**
 * 构建询问问题的 prompt
 */
export function buildQuestionPrompt(opts: BuildQuestionPromptOptions): LLMMessage[] {
	const { candidates, history, showThumbnails = false } = opts;

	// 构建候选列表
	const candidateLines = candidates.map((c, idx) => {
		const line = `${idx + 1}. [概率 ${(c.probability * 100).toFixed(1)}%] ${c.description}`;
		return line;
	});

	const candidateSection = `候选图片（按概率排序，共 ${candidates.length} 张）:\n${candidateLines.join('\n')}`;

	// 构建历史问答
	let historySection = '已问过的问题与回答:\n';
	if (history.length === 0) {
		historySection += '(暂无)';
	} else {
		const historyLines = history.map((h) => {
			const answerStr = h.answer === 'unknown' ? '不知道' : h.answer.toFixed(2);
			return `- Q: ${h.question}\n  A: ${answerStr}`;
		});
		historySection += historyLines.join('\n');
	}

	// 缩略图提示
	const thumbnailNote = showThumbnails
		? '\n\n注意: 候选图片的缩略图已提供，可以参考视觉特征生成问题。'
		: '';

	const userContent = `${candidateSection}\n\n${historySection}${thumbnailNote}\n\n请生成能最大化区分当前候选集的问题。`;

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: userContent },
	];
}
