import { describe, it, expect } from 'vitest';
import { computeResolutionCorrection } from '../../src/valuation/resolution-correction.js';

describe('resolution-correction', () => {
	it('returns multiplier 1 when no size_correction is provided', () => {
		const result = computeResolutionCorrection(1920, 1080, undefined);
		expect(result.multiplier).toBe(1);
		expect(result.reason).toBeNull();
	});

	it('applies min_width rule when width meets threshold', () => {
		const rule = { min_width: 4000, multiplier: 1.2 };
		const result = computeResolutionCorrection(4500, 3000, rule);
		expect(result.multiplier).toBe(1.2);
		expect(result.reason).toContain('4000');
	});

	it('does not apply min_width rule when width is below threshold', () => {
		const rule = { min_width: 4000, multiplier: 1.2 };
		const result = computeResolutionCorrection(1920, 1080, rule);
		expect(result.multiplier).toBe(1);
		expect(result.reason).toBeNull();
	});

	it('applies max_width rule when width is below threshold', () => {
		const rule = { max_width: 500, multiplier: 0.7 };
		const result = computeResolutionCorrection(400, 300, rule);
		expect(result.multiplier).toBe(0.7);
		expect(result.reason).toContain('500');
	});

	it('does not apply max_width rule when width exceeds threshold', () => {
		const rule = { max_width: 500, multiplier: 0.7 };
		const result = computeResolutionCorrection(1920, 1080, rule);
		expect(result.multiplier).toBe(1);
		expect(result.reason).toBeNull();
	});

	it('applies both min_width and min_height with 且 separator', () => {
		const rule = { min_width: 2000, min_height: 1000, multiplier: 1.2 };
		const result = computeResolutionCorrection(2500, 1500, rule);
		expect(result.multiplier).toBe(1.2);
		expect(result.reason).toContain('宽度≥2000px');
		expect(result.reason).toContain('高度≥1000px');
		expect(result.reason).toContain('且');
	});

	it('does not apply when height does not meet min_height', () => {
		const rule = { min_width: 2000, min_height: 1000, multiplier: 1.2 };
		const result = computeResolutionCorrection(2500, 500, rule);
		expect(result.multiplier).toBe(1);
		expect(result.reason).toBeNull();
	});

	it('applies first matching rule in array', () => {
		const rules = [
			{ max_width: 500, multiplier: 0.7 },
			{ min_width: 4000, multiplier: 1.2 },
		];
		const result = computeResolutionCorrection(400, 300, rules);
		expect(result.multiplier).toBe(0.7);
	});

	it('applies second rule when first does not match', () => {
		const rules = [
			{ min_width: 500, max_width: 2000, multiplier: 0.7 },
			{ min_width: 4000, multiplier: 1.2 },
		];
		const result = computeResolutionCorrection(5000, 3000, rules);
		expect(result.multiplier).toBe(1.2);
	});

	it('returns multiplier 1 when no array rule matches', () => {
		const rules = [
			{ min_width: 500, max_width: 2000, multiplier: 0.7 },
			{ min_width: 4000, multiplier: 1.2 },
		];
		const result = computeResolutionCorrection(3000, 2000, rules);
		expect(result.multiplier).toBe(1);
		expect(result.reason).toBeNull();
	});
});
