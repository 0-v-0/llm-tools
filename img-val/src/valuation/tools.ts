import type { ToolDef } from '@llm-image/shared';
import { z } from 'zod';
import type { SearchParams, ValuationRecord } from '../storage/types.js';
import { search as searchRepository } from '../storage/repository.search.js';
import { fileUrlToPath } from '../util/url.js';
import { extractExif } from './exif.js';

export const SEARCH_VALUATIONS_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'search_valuations',
		description:
			'查询当前标准下历史图片估值记录，按价值区间、日期范围、图片格式过滤。仅用于参考，不决定本次估值。date_from 默认 30 天前，date_to 默认当前时间。',
		parameters: {
			type: 'object',
			properties: {
				minValue: { type: 'number', description: '最低价值 (人民币元)' },
				maxValue: { type: 'number', description: '最高价值 (人民币元)' },
				fromDate: { type: 'string', description: '起始日期 ISO 格式 YYYY-MM-DD，默认 30 天前' },
				toDate: { type: 'string', description: '结束日期 ISO 格式 YYYY-MM-DD，默认当前日期' },
				format: { type: 'array', items: { type: 'string', enum: ['jpeg', 'png', 'webp'] }, description: '图片格式列表' },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
			},
		},
	},
};

export const GET_EXIF_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'get_exif',
		description:
			'获取当前图片的 EXIF 元数据（相机品牌/型号、镜头、光圈、快门速度、ISO、焦距、拍摄日期、GPS 位置等），用于评估图片技术质量。无需参数。',
		parameters: { type: 'object', properties: {} },
	},
};

const searchParamsSchema = z.object({
	minValue: z.number().optional(),
	maxValue: z.number().optional(),
	fromDate: z.string().optional(),
	toDate: z.string().optional(),
	format: z.array(z.enum(['jpeg', 'png', 'webp'])).optional(),
	limit: z.number().int().min(1).max(50).default(10),
});

export type ToolExecutionResult = { ok: true; result: unknown } | { ok: false; error: string };

export interface ToolExecutionContext {
	imageUrl?: string | undefined;
	standardName?: string | undefined;
}

export async function executeToolCall(
	name: string,
	args: unknown,
	context: ToolExecutionContext = {},
): Promise<ToolExecutionResult> {
	if (name === 'search_valuations') {
		const parsed = searchParamsSchema.safeParse(args);
		if (!parsed.success) {
			return { ok: false, error: parsed.error.message };
		}

		const params: SearchParams = {
			minValue: parsed.data.minValue,
			maxValue: parsed.data.maxValue,
			standardName: context.standardName,
			dateFrom: parsed.data.fromDate,
			dateTo: parsed.data.toDate,
			format: parsed.data.format,
			limit: parsed.data.limit,
		};

		const records: ValuationRecord[] = searchRepository(params);

		// Return simplified records to LLM
		const simplified = records.map((r) => ({
			min: r.minValue,
			max: r.maxValue,
			standard: r.standardName,
			format: r.imageFormat,
			valued_at: r.valuedAt,
			description: r.description.slice(0, 120),
		}));

		return { ok: true, result: simplified };
	}

	if (name === 'get_exif') {
		if (!context.imageUrl) {
			return { ok: false, error: 'get_exif: 缺少当前图片路径上下文' };
		}
		try {
			const filePath = fileUrlToPath(context.imageUrl);
			const exif = await extractExif(filePath);
			return { ok: true, result: exif };
		} catch (e) {
			return {
				ok: false,
				error: `get_exif 解析失败: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	return { ok: false, error: `unknown tool: ${name}` };
}
