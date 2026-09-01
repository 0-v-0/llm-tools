import { describe, it, expect } from 'vitest';
import { parseSelectionResponse } from '../../src/llm/response-parser.js';

describe('parseSelectionResponse', () => {
	it('parses clean JSON', () => {
		const text = JSON.stringify({ selected: 'A', reason: '构图更好' });
		const result = parseSelectionResponse(text);
		expect(result.selected).toBe('A');
		expect(result.reason).toBe('构图更好');
	});

	it('normalizes selected to uppercase', () => {
		const text = JSON.stringify({ selected: 'b', reason: '清晰度更高' });
		const result = parseSelectionResponse(text);
		expect(result.selected).toBe('B');
	});

	it('parses JSON in code fence', () => {
		const text = '```json\n{"selected": "C", "reason": "色彩和谐"}\n```';
		const result = parseSelectionResponse(text);
		expect(result.selected).toBe('C');
		expect(result.reason).toBe('色彩和谐');
	});

	it('parses JSON with trailing prose', () => {
		const text = '{"selected": "A", "reason": "最佳"}\n这张图明显更好。';
		const result = parseSelectionResponse(text);
		expect(result.selected).toBe('A');
	});

	it('throws on unparseable text', () => {
		expect(() => parseSelectionResponse('not json at all')).toThrow();
	});

	it('throws on missing selected field', () => {
		expect(() => parseSelectionResponse('{"reason": "test"}')).toThrow();
	});

	it('throws on missing reason field', () => {
		expect(() => parseSelectionResponse('{"selected": "A"}')).toThrow();
	});
});
