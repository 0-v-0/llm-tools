import type { LLMMessage, ProcessedImage } from '@llm-image/shared';
import type { ImageEntry } from '../storage/types.js';
import { basename } from 'node:path';
import { decodeUrl, fileUrlToPath } from '../util/url.js';

/** Label for an image in the batch (A, B, C, ...). */
const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface PreparedImage {
	/** The original ImageEntry from the DB. */
	entry: ImageEntry;
	/** The processed image (base64 + dimensions from sharp). */
	processed: ProcessedImage;
	/** Display label: A, B, C, ... */
	label: string;
}

/**
 * Build the LLM prompt for a batch comparison.
 *
 * CRITICAL: This prompt must NOT include any valuation information
 * (min_value, max_value, description, confidence, etc.). Only visual
 * quality and technical metadata are provided to the LLM.
 */
export function buildBatchPrompt(prepared: PreparedImage[]): {
	systemPrompt: string;
	userMessages: LLMMessage[];
} {
	const systemPrompt = `你是一位图片质量评审员。你将看到一组图片及其技术参数。请基于以下维度选出最值得保留的一张：

1. 构图与主体 — 主体是否突出，构图是否平衡
2. 清晰度 — 画面是否锐利，细节是否丰富
3. 光影色彩 — 色彩是否和谐，层次是否分明
4. 主题吸引力 — 内容是否有意义、有吸引力
5. 技术参数 — 分辨率、格式等客观指标

重要规则：
- 不要考虑图片的货币价值或价格
- 不要推测图片的估值
- 仅基于视觉质量和技术参数做判断
- 选出最值得保留的 1 张

输出必须为合法 JSON，且仅包含以下字段，不要附加其他内容在 JSON 之外：
{
	"selected": "<标签字母，如 A>",
	"reason": "<不超过 200 字的中文说明>"
}`;

	const userParts: string[] = [];
	userParts.push(`当前时间: ${new Date().toISOString()}`);
	userParts.push(`\n以下共 ${prepared.length} 张图片，请选出最值得保留的 1 张。\n`);

	const contentBlocks: Exclude<LLMMessage['content'], string> = [];

	// Text block with metadata for all images
	const metadataParts: string[] = [];
	for (const p of prepared) {
		const filename = getFilename(p.entry);
		metadataParts.push(formatMetadata(p.label, p.entry, filename));
	}
	userParts.push(...metadataParts);

	userParts.push(`\n请输出 JSON，选出最值得保留的一张。`);

	contentBlocks.push({ type: 'text', text: userParts.join('\n') });

	// Image blocks — one per image, in label order
	for (const p of prepared) {
		contentBlocks.push({
			type: 'image_url',
			image_url: { url: p.processed.base64, detail: 'high' },
		});
	}

	return {
		systemPrompt,
		userMessages: [{ role: 'user', content: contentBlocks }],
	};
}

/** Format technical metadata for one image (no valuation info). */
function formatMetadata(label: string, entry: ImageEntry, filename: string): string {
	const lines: string[] = [];
	lines.push(`[图片 ${label}]`);
	lines.push(`  文件名: ${filename}`);
	lines.push(`  格式: ${entry.imageFormat.toUpperCase()}`);
	lines.push(`  尺寸: ${entry.width}x${entry.height}`);
	if (entry.channels !== null) {
		lines.push(`  通道数: ${entry.channels}`);
	}
	lines.push(`  文件大小: ${(entry.sizeBytes / 1024).toFixed(1)} KB`);
	if (entry.undecodablePixels > 0) {
		const totalPixels = Math.max(1, entry.width * entry.height);
		const damagePercent = ((entry.undecodablePixels / totalPixels) * 100).toFixed(1);
		lines.push(`  损坏状态: 部分解码, ${damagePercent}% 像素不可解码`);
	}
	return lines.join('\n');
}

/** Extract filename from the URL (or return the URL if not a file URL). */
function getFilename(entry: ImageEntry): string {
	if (entry.url.startsWith('file://')) {
		try {
			const path = fileUrlToPath(entry.url);
			return basename(path);
		} catch {
			return decodeUrl(entry.url);
		}
	}
	return decodeUrl(entry.url);
}

/** Get the label for index i (A, B, C, ...). */
export function labelFor(index: number): string {
	return LABELS[index] ?? `IMG${index + 1}`;
}
