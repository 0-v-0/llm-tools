import type { ImageEntry } from '../storage/types.js';

/**
 * A group of images sharing the same valuation standard and max_value bucket.
 * Within each group, images are batched for LLM comparison.
 */
export interface ImageGroup {
	/** The valuation standard name (e.g. "default-photo"). */
	standardName: string;
	/** Bucket index (0-based). */
	bucketIndex: number;
	/** Human-readable bucket label (e.g. "0-30", "500-2000"). */
	bucketLabel: string;
	/** Images in this group, ordered by max_value ascending (cheapest first). */
	images: ImageEntry[];
}

/**
 * Determine which bucket an image's max_value falls into.
 * Boundaries are ascending, e.g. [0, 30, 100, 500, 2000, 5000, 15000].
 * An image with max_value=250 falls in bucket 3 (100-500).
 * The last bucket is [lastBoundary, +∞).
 */
export function bucketIndexFor(maxValue: number, boundaries: number[]): number {
	for (let i = 0; i < boundaries.length; i++) {
		const lo = boundaries[i]!;
		const hi = i + 1 < boundaries.length ? boundaries[i + 1]! : Infinity;
		if (maxValue >= lo && maxValue < hi) {
			return i;
		}
	}
	// Above the last boundary
	return boundaries.length - 1;
}

/** Human-readable label for a bucket. */
export function bucketLabel(index: number, boundaries: number[]): string {
	const lo = boundaries[index] ?? 0;
	const hi = index + 1 < boundaries.length ? boundaries[index + 1]! : Infinity;
	if (hi === Infinity) return `${lo}+`;
	return `${lo}-${hi}`;
}

/**
 * Group images by (standard_name, max_value bucket). Within each group,
 * images are ordered by max_value ascending so the cheapest come first
 * (making them natural candidates for removal if the LLM agrees).
 *
 * Empty groups (no images) are not returned.
 */
export function groupImages(
	images: ImageEntry[],
	boundaries: number[],
): ImageGroup[] {
	// First pass: group by standard_name
	const byStandard = new Map<string, ImageEntry[]>();
	for (const img of images) {
		const list = byStandard.get(img.standardName) ?? [];
		list.push(img);
		byStandard.set(img.standardName, list);
	}

	// Second pass: within each standard, group by max_value bucket
	const groups: ImageGroup[] = [];
	for (const [standardName, imgs] of byStandard) {
		// Sort by max_value ascending within standard
		imgs.sort((a, b) => a.maxValue - b.maxValue);

		// Sub-group by bucket
		const byBucket = new Map<number, ImageEntry[]>();
		for (const img of imgs) {
			const idx = bucketIndexFor(img.maxValue, boundaries);
			const list = byBucket.get(idx) ?? [];
			list.push(img);
			byBucket.set(idx, list);
		}

		for (const [bucketIdx, bucketImgs] of byBucket) {
			groups.push({
				standardName,
				bucketIndex: bucketIdx,
				bucketLabel: bucketLabel(bucketIdx, boundaries),
				images: bucketImgs,
			});
		}
	}

	return groups;
}
