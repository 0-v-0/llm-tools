import { readdir } from 'node:fs/promises';
import { extname as pathExtname, join } from 'node:path';

export interface WalkOptions {
	/** 只收集扩展名在内的文件；空数组/undefined = 全部文件。 */
	extensions?: string[] | undefined;
	/**
	 * 最大递归深度。默认 Infinity（递归到全部子目录）；
	 * 0 = 只处理直接子项（不递归）。
	 */
	maxDepth?: number | undefined;
}

/** 规范化扩展名（去点、小写）。 */
export function extname(name: string): string {
	return pathExtname(name).replace('.', '').toLowerCase();
}

/**
 * 递归收集目录下的文件。
 *
 * 遍历基于 `readdir withFileTypes`（免 stat）。
 * 目录不可读时静默跳过（返回已收集部分），与既有工具行为一致。
 */
export async function walk(
	dir: string,
	options: WalkOptions = {},
	current = 0,
	results: string[] = [],
): Promise<string[]> {
	const { extensions, maxDepth = Infinity } = options;
	if (current > maxDepth) return results;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const ent of entries) {
		const full = join(dir, ent.name);
		if (ent.isDirectory()) {
			await walk(full, { extensions, maxDepth }, current + 1, results);
		} else if (ent.isFile()) {
			const ext = extname(ent.name);
			if (!extensions?.length || extensions.includes(ext)) results.push(full);
		}
	}
	return results;
}