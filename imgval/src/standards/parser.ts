import { StandardError, hashBuffer } from '@llm-image/shared';
import matter from 'gray-matter';
import { z } from 'zod';

const sizeCorrectionSchema = z.object({
	min_width: z.number().int().positive().optional(),
	max_width: z.number().int().positive().optional(),
	min_height: z.number().int().positive().optional(),
	max_height: z.number().int().positive().optional(),
	multiplier: z.number().positive(),
});

const frontmatterSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	version: z.string().optional(),
	currency: z.string().default('CNY'),
	max_value: z.number().positive().optional(),
	image_formats: z.array(z.string()).optional(),
	tags: z.array(z.string()).optional(),
	size_correction: z.union([sizeCorrectionSchema, z.array(sizeCorrectionSchema)]).optional(),
});

export type StandardFrontmatter = z.infer<typeof frontmatterSchema>;
export type SizeCorrection = z.infer<typeof sizeCorrectionSchema>;

export interface Standard {
	frontmatter: StandardFrontmatter;
	body: string;
	/** SHA-256 of the full raw markdown content. */
	contentHash: string;
	source: 'builtin' | 'filesystem';
	filePath?: string | undefined;
}

export function parseStandard(
	markdown: string,
	source: 'builtin' | 'filesystem',
	filePath?: string,
): Standard {
	let parsed: matter.GrayMatterFile<string>;
	try {
		parsed = matter(markdown);
	} catch (e) {
		throw new StandardError(
			`标准文件 YAML frontmatter 解析失败${filePath ? `: ${filePath}` : ''}`,
			e,
		);
	}

	const fmResult = frontmatterSchema.safeParse(parsed.data);
	if (!fmResult.success) {
		const issues = fmResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new StandardError(
			`标准 frontmatter 校验失败${filePath ? ` (${filePath})` : ''}: ${issues}`,
		);
	}

	return {
		frontmatter: fmResult.data,
		body: parsed.content.trim(),
		contentHash: hashBuffer(Buffer.from(markdown)),
		source,
		filePath,
	};
}
