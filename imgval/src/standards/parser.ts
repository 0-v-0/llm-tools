import matter from 'gray-matter';
import { z } from 'zod';
import { StandardError } from '../util/errors.js';

const frontmatterSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	version: z.string().optional(),
	currency: z.string().default('CNY'),
	image_formats: z.array(z.string()).optional(),
	tags: z.array(z.string()).optional(),
});

export type StandardFrontmatter = z.infer<typeof frontmatterSchema>;

export interface Standard {
	frontmatter: StandardFrontmatter;
	body: string;
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
		source,
		filePath,
	};
}
