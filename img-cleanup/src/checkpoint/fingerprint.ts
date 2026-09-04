import { createHash } from 'node:crypto';

/**
 * 对字符串数组排序后拼接，取 sha256 的 hex 前 16 位。
 * 作为图片集合 hash 使用。
 */
export function hashStrings(arr: readonly string[]): string {
	const sorted = [...arr].sort();
	if (sorted.length === 0) return 'empty';
	const payload = sorted.join('\n') + '\n';
	return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** sha256 hex（完整长度，用于 verdict 主键）。 */
export function sha256Hex(payload: string): string {
	return createHash('sha256').update(payload).digest('hex');
}

/** verdict 缓存主键：参与比较的 url 集合（排序后 join）。 */
export function verdictKey(urls: readonly string[]): string {
	return [...urls].sort().join('\n');
}

/**
 * 裁决缓存有效性键（cacheKey）。
 *
 * 回答三个问题：
 * - 谁在判（provider / model / temperature）
 * - 判什么形态（maxImageDimension，以及 prompt 版本标记）
 *
 * `m` / `targetDir` / `batchSize` / `bucketBoundaries` / `pathGlobs` 等
 * 仅影响「怎么分组」，不影响「给定一组图片谁最值得保留」，因此不加入。
 */
export function computeCacheKey(opts: {
	provider: string;
	model: string;
	temperature: number;
	maxImageDimension: number;
	/** prompt 逻辑版本；改了 prompt 文本时手动递增。 */
	promptVersion: number;
}): string {
	const payload = [
		opts.provider,
		opts.model,
		String(opts.temperature),
		String(opts.maxImageDimension),
		`prompt-v${opts.promptVersion}`,
	].join('|');
	return sha256Hex(payload).slice(0, 16);
}

/** 当前 batch prompt 的版本（改动 prompt 文本时递增，使旧缓存失效）。 */
export const BATCH_PROMPT_VERSION = 1;
