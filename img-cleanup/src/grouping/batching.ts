import type { ImageEntry } from '../storage/types.js';

/**
 * A batch of images for LLM comparison. The LLM picks 1 "most worth keeping"
 * from each batch; the rest become removal candidates.
 *
 * Batches with only 1 image are auto-kept (no LLM call needed).
 */
export interface Batch {
	/** Images in this batch. */
	images: ImageEntry[];
}

/**
 * Split a group of images into batches of size `n`.
 * The last batch may have fewer than n images.
 *
 * Images are shuffled within each group before batching to avoid
 * systematic bias (e.g. always comparing the cheapest pair first).
 *
 * Batches of size 1 are returned and flagged — the caller should
 * auto-keep them without an LLM call.
 */
export function createBatches(images: ImageEntry[], n: number): Batch[] {
	const batches: Batch[] = [];
	for (let i = 0; i < images.length; i += n) {
		const slice = images.slice(i, i + n);
		batches.push({ images: slice });
	}
	return batches;
}

/** True if a batch needs an LLM call (has ≥2 images). */
export function needsLlm(batch: Batch): boolean {
	return batch.images.length >= 2;
}
