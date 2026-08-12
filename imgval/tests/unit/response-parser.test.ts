import { describe, it, expect } from 'vitest';
import { parseValuationResponse } from '../../src/llm/response-parser.js';
import { ParseError } from '../../src/util/errors.js';

describe('response-parser', () => {
	it('parses clean JSON', () => {
		const text = JSON.stringify({
			min_value: 100,
			max_value: 500,
			rationale: '测试说明',
			confidence: 'medium',
		});
		const result = parseValuationResponse(text);
		expect(result.minValue).toBe(100);
		expect(result.maxValue).toBe(500);
		expect(result.rationale).toBe('测试说明');
		expect(result.confidence).toBe('medium');
	});

	it('parses JSON in code fence', () => {
		const text =
			'```json\n{"min_value": 50, "max_value": 200, "rationale": "ok", "confidence": "low"}\n```';
		const result = parseValuationResponse(text);
		expect(result.minValue).toBe(50);
		expect(result.maxValue).toBe(200);
	});

	it('parses JSON with trailing prose', () => {
		const text =
			'{"min_value": 300, "max_value": 800, "rationale": "good", "confidence": "high"}\n\n以上是我的估值。';
		const result = parseValuationResponse(text);
		expect(result.minValue).toBe(300);
		expect(result.maxValue).toBe(800);
	});

	it('throws when max_value < min_value', () => {
		const text = JSON.stringify({
			min_value: 500,
			max_value: 100,
			rationale: 'wrong',
			confidence: 'low',
		});
		expect(() => parseValuationResponse(text)).toThrow(ParseError);
	});

	it('throws when missing required field', () => {
		const text = JSON.stringify({
			min_value: 100,
			max_value: 500,
			// missing rationale and confidence
		});
		expect(() => parseValuationResponse(text)).toThrow(ParseError);
	});

	it('throws on non-numeric values', () => {
		const text = JSON.stringify({
			min_value: 'not a number',
			max_value: 500,
			rationale: 'ok',
			confidence: 'high',
		});
		expect(() => parseValuationResponse(text)).toThrow(ParseError);
	});

	it('throws on completely unparseable text', () => {
		expect(() => parseValuationResponse('This is not JSON at all')).toThrow(ParseError);
	});
});
