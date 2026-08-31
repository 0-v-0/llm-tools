import { ParseError } from '@llm-image/shared';
import type { LogprobInfo } from '@llm-image/shared';
import { describe, it, expect } from 'vitest';
import {
	parseValuationResponse,
	parseMinResponse,
	parseMaxResponse,
	meanLogprobForValue,
} from '../../src/llm/response-parser.js';

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

describe('response-parser (plan C split)', () => {
	it('parseMinResponse parses min-only JSON', () => {
		const text = JSON.stringify({ min_value: 100, rationale: '客观价值低', confidence: 'low' });
		const r = parseMinResponse(text);
		expect(r.minValue).toBe(100);
		expect(r.rationale).toBe('客观价值低');
	});

	it('parseMaxResponse parses max-only JSON', () => {
		const text = JSON.stringify({ max_value: 9000, rationale: '重大情感价值', confidence: 'high' });
		const r = parseMaxResponse(text);
		expect(r.maxValue).toBe(9000);
	});

	it('parseMinResponse throws when min_value missing', () => {
		const text = JSON.stringify({ rationale: 'x', confidence: 'low' });
		expect(() => parseMinResponse(text)).toThrow(ParseError);
	});

	it('parseMaxResponse throws when max_value missing', () => {
		const text = JSON.stringify({ rationale: 'x', confidence: 'low' });
		expect(() => parseMaxResponse(text)).toThrow(ParseError);
	});

	it('parseMinResponse extracts from code fence', () => {
		const text = '```json\n{"min_value": 42, "rationale": "ok", "confidence": "medium"}\n```';
		const r = parseMinResponse(text);
		expect(r.minValue).toBe(42);
	});
});

describe('meanLogprobForValue', () => {
	function lp(tokens: Array<{ token: string; logprob: number }>): LogprobInfo {
		return { tokens: tokens.map((t) => ({ token: t.token, logprob: t.logprob })) };
	}

	it('returns the single value token logprob when the whole JSON is one token', () => {
		const text = JSON.stringify({ min_value: 100, rationale: 'x', confidence: 'low' });
		const info = lp([{ token: text, logprob: -1.2 }]);
		expect(meanLogprobForValue(info, text, 'min_value')).toBeCloseTo(-1.2);
	});

	it('averages logprobs across multi-token numeric values', () => {
		const text = '{"min_value": 1234, "rationale":"x","confidence":"low"}';
		const info = lp([
			{ token: '{"min_value": ', logprob: -0.3 },
			{ token: '12', logprob: -0.5 },
			{ token: '34', logprob: -0.9 },
			{ token: ', "rationale":"x","confidence":"low"}', logprob: -0.2 },
		]);
		// 仅数值 token '12' 与 '34' 的 logprob 参与平均
		expect(meanLogprobForValue(info, text, 'min_value')).toBeCloseTo((-0.5 - 0.9) / 2);
	});

	it('locates max_value independently of min_value', () => {
		const text = JSON.stringify({ max_value: 9000, rationale: 'x', confidence: 'high' });
		const info = lp([{ token: text, logprob: -2.1 }]);
		expect(meanLogprobForValue(info, text, 'max_value')).toBeCloseTo(-2.1);
		// 反查 min_value 应返回 null（文本中无该 key）
		expect(meanLogprobForValue(info, text, 'min_value')).toBeNull();
	});

	it('handles negative values', () => {
		const text = JSON.stringify({ min_value: -50, rationale: 'x', confidence: 'low' });
		const info = lp([{ token: text, logprob: -0.8 }]);
		expect(meanLogprobForValue(info, text, 'min_value')).toBeCloseTo(-0.8);
	});

	it('returns null when no logprobs supplied', () => {
		const text = JSON.stringify({ min_value: 100, rationale: 'x', confidence: 'low' });
		expect(meanLogprobForValue(undefined, text, 'min_value')).toBeNull();
		expect(meanLogprobForValue({ tokens: [] }, text, 'min_value')).toBeNull();
	});
});
