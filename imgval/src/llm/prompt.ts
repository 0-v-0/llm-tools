import type { ProcessedImage, LLMMessage } from '@llm-image/shared';
import type { Standard } from '../standards/parser.js';

export interface BuiltPrompt {
	systemPrompt: string;
	userMessages: LLMMessage[];
}

export function buildPrompt(
	standard: Standard,
	image: ProcessedImage,
	enableTools: boolean,
	constrained: boolean = false,
): BuiltPrompt {
	// 构建规则列表（最小化原则）
	const rules: string[] = ['1. 完全遵循下方《估值标准》中的评分维度、权重与参考价格区间。'];

	// 仅在启用工具时添加工具规则
	if (enableTools) {
		rules.push(
			'2. 可调用 search_valuations 工具查询历史估值记录作为参考，但最终定价须基于本次图片与本次标准。',
		);
	}

	const jsonRuleIndex = enableTools ? 3 : 2;
	if (constrained) {
		// 约束解码时，schema 已由 provider 强制，prompt 只需说明字段含义
		rules.push(
			`${jsonRuleIndex}. 输出 JSON，包含字段: min_value (最低价值, 元), max_value (最高价值, 元, >= min_value), rationale (≤200字中文说明), confidence (low|medium|high)。`,
		);
	} else {
		rules.push(
			`${jsonRuleIndex}. 输出必须为合法 JSON，且仅包含以下字段，不要附加任何自然语言解释在 JSON 之外：
   {
     "min_value": <number, 人民币元>,
     "max_value": <number, 人民币元, 必须 >= min_value>,
     "rationale": "<不超过 200 字的中文说明，解释依据哪个维度、哪个参考区间>",
     "confidence": "<low | medium | high>"
   }`,
		);
	}

	// 仅在图片损坏时添加损坏规则
	if (image.corruption !== 'ok') {
		const damageRuleIndex = jsonRuleIndex + 1;
		rules.push(
			`${damageRuleIndex}. 图片为损坏或部分解码，已在用户消息中标注；按可观察内容估值并降低 confidence。`,
		);
	}

	const finalRuleIndex = rules.length + 1;
	rules.push(`${finalRuleIndex}. 严禁输出负数或非数字。max_value 不应超过 1,000,000 元。`);

	const systemPrompt = `你是图片估值专家 (Image Valuation Expert)。

你的任务：根据给定的《估值标准》对一张图片估值，输出最低价值 (min) 和最高价值 (max)，
单位为人民币元 (¥, CNY)。max - min 代表估值的不确定性区间。

严格遵守以下规则：
${rules.join('\n')}

《估值标准》：
名称: ${standard.frontmatter.name}
描述: ${standard.frontmatter.description}
版本: ${standard.frontmatter.version ?? 'n/a'}

${standard.body}`;

	// 构建用户消息（最小化原则）
	const userParts: string[] = [
		`图片 URL: ${image.url ?? 'N/A'}`,
		`图片格式: ${image.format}`,
		`尺寸: ${image.width}x${image.height}`,
	];

	// 仅在通道数已知时添加
	if (image.channels !== null) {
		userParts.push(`通道数: ${image.channels}`);
	}

	userParts.push(`文件大小: ${(image.sizeBytes / 1024).toFixed(1)} KB`);

	// 仅在图片损坏时添加损坏状态
	if (image.corruption !== 'ok') {
		const corruptionText =
			image.corruption === 'partial'
				? '部分解码 (image corrupted, only partially decodable region shown)'
				: '不可读';
		userParts.push(`损坏状态: ${corruptionText}`);
	}

	// 仅在备注非空时添加
	if (image.notes.length > 0) {
		userParts.push(`备注: ${image.notes.join('; ')}`);
	}

	userParts.push('\n请基于上述图片与《估值标准》给出估值 JSON。');

	const userText = userParts.join('\n');

	const userMessages: LLMMessage[] = [
		{
			role: 'user',
			content: [
				{ type: 'text', text: userText },
				{ type: 'image_url', image_url: { url: image.base64, detail: 'high' } },
			],
		},
	];

	return { systemPrompt, userMessages };
}
