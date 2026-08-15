import type { SizeCorrection } from '../standards/parser.js';

export interface ResolutionResult {
	multiplier: number;
	reason: string | null;
}

function evaluateSingle(rule: SizeCorrection, width: number, height: number): ResolutionResult {
	const { min_width, max_width, min_height, max_height, multiplier } = rule;

	const meetsWidth =
		(min_width === undefined || width >= min_width) &&
		(max_width === undefined || width <= max_width);
	const meetsHeight =
		(min_height === undefined || height >= min_height) &&
		(max_height === undefined || height <= max_height);

	const widthMatch =
		min_width !== undefined ? `宽度≥${min_width}px` : max_width !== undefined ? `宽度≤${max_width}px` : null;
	const heightMatch =
		min_height !== undefined ? `高度≥${min_height}px` : max_height !== undefined ? `高度≤${max_height}px` : null;

	const matches: string[] = [];
	if (widthMatch) matches.push(widthMatch);
	if (heightMatch) matches.push(heightMatch);

	const reason = meetsWidth && meetsHeight ? matches.join(' 且 ') : null;

	return {
		multiplier: reason ? multiplier : 1,
		reason,
	};
}

/**
 * Compute the resolution-based size correction multiplier for an image.
 * Supports multiple rules (array) — applies the first matching rule.
 * Returns multiplier=1 with reason=null when no rule matches.
 */
export function computeResolutionCorrection(
	width: number,
	height: number,
	sizeCorrection: SizeCorrection | SizeCorrection[] | undefined,
): ResolutionResult {
	if (!sizeCorrection) {
		return { multiplier: 1, reason: null };
	}

	const rules = Array.isArray(sizeCorrection) ? sizeCorrection : [sizeCorrection];

	for (const rule of rules) {
		const result = evaluateSingle(rule, width, height);
		if (result.multiplier !== 1) {
			return result;
		}
	}

	return { multiplier: 1, reason: null };
}
