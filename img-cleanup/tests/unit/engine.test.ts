import { describe, it, expect } from 'vitest';
import { parseM } from '../../src/selection/engine.js';

describe('parseM', () => {
	it('parses absolute number', () => {
		expect(parseM('50', 1000)).toBe(50);
		expect(parseM('0', 1000)).toBe(0);
		expect(parseM('1', 1000)).toBe(1);
	});

	it('parses percentage', () => {
		expect(parseM('10%', 1000)).toBe(100);
		expect(parseM('5%', 200)).toBe(10);
		expect(parseM('1%', 1000)).toBe(10);
	});

	it('rounds up percentage', () => {
		expect(parseM('10%', 305)).toBe(31); // ceil(30.5) = 31
		expect(parseM('1%', 3)).toBe(1); // ceil(0.03) = 1
	});

	it('handles 100 percent', () => {
		expect(parseM('100%', 500)).toBe(500);
	});

	it('throws on invalid percentage (zero)', () => {
		expect(() => parseM('0%', 1000)).toThrow();
	});

	it('throws on invalid percentage (over 100)', () => {
		expect(() => parseM('150%', 1000)).toThrow();
	});

	it('throws on negative number', () => {
		expect(() => parseM('-5', 1000)).toThrow();
	});

	it('throws on non-numeric string', () => {
		expect(() => parseM('abc', 1000)).toThrow();
	});

	it('throws on NaN', () => {
		expect(() => parseM('NaN', 1000)).toThrow();
	});
});
