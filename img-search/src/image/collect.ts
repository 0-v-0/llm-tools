import { walk as walkFiles } from '@llm-image/shared';

export interface CollectOptions {
	recursive?: boolean;
	extensions?: string[];
}

const DEFAULT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

export async function collectImages(dir: string, opts: CollectOptions = {}): Promise<string[]> {
	const exts = (opts.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase());
	return walkFiles(dir, {
		extensions: exts,
		maxDepth: opts.recursive ? Infinity : 0,
	});
}
