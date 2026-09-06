import { readdir } from 'node:fs/promises';
import { extname as pathExtname, join } from 'node:path';

export function extname(name: string): string {
	return pathExtname(name).replace('.', '').toLowerCase();
}

export interface WalkOptions {
	formats?: string[] | undefined;
	maxDepth?: number | undefined;
}

/** 递归收集文件；formats 为空数组/undefined 时收集所有文件。 */
export async function walk(
	dir: string,
	options: WalkOptions = {},
	current = 0,
	results: string[] = [],
): Promise<string[]> {
	const { formats, maxDepth = Infinity } = options;
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
			await walk(full, { formats, maxDepth }, current + 1, results);
		} else if (ent.isFile()) {
			const ext = extname(ent.name);
			if (!formats?.length || formats.includes(ext)) results.push(full);
		}
	}
	return results;
}