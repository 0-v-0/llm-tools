import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface CollectOptions {
	recursive?: boolean;
	extensions?: string[];
}

const DEFAULT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

export async function collectImages(dir: string, opts: CollectOptions = {}): Promise<string[]> {
	const images: string[] = [];
	const exts = (opts.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase());
	const recursive = opts.recursive ?? false;

	async function walk(d: string) {
		const entries = await readdir(d);
		for (const entry of entries) {
			const fullPath = join(d, entry);
			const s = await stat(fullPath);
			if (s.isDirectory() && recursive) {
				await walk(fullPath);
			} else if (s.isFile()) {
				const ext = entry.split('.').pop()?.toLowerCase();
				if (ext && exts.includes(ext)) {
					images.push(fullPath);
				}
			}
		}
	}

	await walk(dir);
	return images;
}
