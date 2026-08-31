import type { ProcessedImage, LLMMessage } from '@llm-image/shared';
import type { Standard } from '../standards/parser.js';
import { decodeUrl } from '../util/url.js';

export interface BuiltPrompt {
	systemPrompt: string;
	userMessages: LLMMessage[];
}

export function buildPrompt(
	standard: Standard,
	image: ProcessedImage,
	enableTools: boolean,
	enableSearchTools: boolean | undefined = enableTools,
	constrained: boolean = false,
	bound?: 'min' | 'max',
): BuiltPrompt {
	// 构建规则列表（最小化原则）
	const rules: string[] = ['1. 完全遵循下方《估值标准》中的评分维度、权重与参考价格区间。'];

	// 仅在启用工具时添加工具规则
	if (enableTools) {
		const toolParts: string[] = [];
		if (enableSearchTools) {
			toolParts.push('可调用 search_valuations 工具查询历史估值记录作参考');
		}
		toolParts.push(
			'可调用 get_exif 工具获取图片的 EXIF 信息（相机型号、镜头、拍摄参数、拍摄日期、GPS 位置等），辅助评估图片技术质量',
		);
		rules.push(`2. ${toolParts.join('，亦可')}；但最终定价须基于本次图片与本次标准。`);
	}

	const jsonRuleIndex = enableTools ? 3 : 2;
	if (bound === 'min') {
		// 仅估算【客观假设】下的最低价值，避免被 max 锚定
		if (constrained) {
			rules.push(
				`${jsonRuleIndex}. 本请求仅估算【客观假设】下的最低价值。输出 JSON，仅含字段: min_value (最低价值, 即图片对大多数人的客观价值，可能无意义、可丢弃), rationale (≤200字中文说明)。不要参考或推导 max_value。`,
			);
		} else {
			rules.push(
				`${jsonRuleIndex}. 输出必须为合法 JSON，且仅包含以下字段（不要参考或推导 max_value）：
{
	"min_value": <number>,
	"rationale": "<不超过 200 字的中文说明，解释客观价值依据>"
}`,
			);
		}
	} else if (bound === 'max') {
		// 仅估算【最好假设】下的最高价值，避免被 min 锚定
		if (constrained) {
			rules.push(
				`${jsonRuleIndex}. 本请求仅估算【最好假设】下的最高价值。输出 JSON，仅含字段: max_value (最高价值, 即图片可能承载重大情感或数据价值、难以替代的情况), rationale (≤200字中文说明)。不要参考或推导 min_value。`,
			);
		} else {
			rules.push(
				`${jsonRuleIndex}. 输出必须为合法 JSON，且仅包含以下字段（不要参考或推导 min_value）：
{
	"max_value": <number>,
	"rationale": "<不超过 200 字的中文说明，解释最佳价值依据>"
}`,
			);
		}
	} else {
		// 兼容/回退：单次合并估算
		if (constrained) {
			rules.push(
				`${jsonRuleIndex}. 输出 JSON，包含字段: min_value (最低价值), max_value (最高价值, >= min_value), rationale (≤200字中文说明)。`,
			);
		} else {
			rules.push(
				`${jsonRuleIndex}. 输出必须为合法 JSON，且仅包含以下字段，不要附加其他内容在 JSON 之外：
{
	"min_value": <number>,
	"max_value": <number>,
	"rationale": "<不超过 200 字的中文说明，解释依据和评估维度>"
}`,
			);
		}
	}

	// 仅在图片损坏时添加损坏规则
	if (image.undecodablePixels > 0) {
		const damageRuleIndex = jsonRuleIndex + 1;
		rules.push(
			`${damageRuleIndex}. 图片为损坏或部分解码，已在用户消息中标注；按可观察内容估值，并对损坏部分相应下调价值。`,
		);
	}

	const maxLimit = standard.frontmatter.max_value ?? 1000000;
	const finalRuleIndex = rules.length + 1;
	// 仅对当前估算的边界施加上限约束；min 边界同样不应超出标准上限
	const limitField = bound === 'min' ? 'min_value' : 'max_value';
	rules.push(`${finalRuleIndex}. 严禁输出负数或非数字。${limitField} 不应超过 ${maxLimit.toLocaleString()} 元。`);

	const systemPrompt = `你的任务是根据《估值标准》对给定的图片估值，单位为人民币元。

严格遵守以下规则：
${rules.join('\n')}

《估值标准》
名称: ${standard.frontmatter.name}
描述: ${standard.frontmatter.description}
版本: ${standard.frontmatter.version ?? 'n/a'}

${standard.body}`;

	// 构建用户消息（最小化原则）
	const userParts: string[] = [];
	userParts.push(`当前时间: ${new Date().toISOString()}`);
	if (image.url) {
		userParts.push(`图片 URL: ${decodeUrl(image.url)}`);
	}
	userParts.push(`图片格式: ${image.format}`);
	userParts.push(`尺寸: ${image.width}x${image.height}`);

	// 仅在通道数已知时添加
	if (image.channels !== null) {
		userParts.push(`通道数: ${image.channels}`);
	}

	userParts.push(`文件大小: ${(image.sizeBytes / 1024).toFixed(1)} KB`);

	// 仅在图片损坏时添加损坏状态
	if (image.undecodablePixels > 0) {
		const totalPixels = Math.max(1, image.width * image.height);
		const damagePercent = ((image.undecodablePixels / totalPixels) * 100).toFixed(1);
		userParts.push(`损坏状态: 部分解码, ${damagePercent}% 像素不可解码`);
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
