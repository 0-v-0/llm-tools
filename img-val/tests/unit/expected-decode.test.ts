import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setDb, closeDb } from '../../src/storage/db.js';
import { expectationDecode, candidateValuesFromLogprobs, decodeExpectedValue, type Candidate } from '../../src/valuation/expected-decode.js';
import { aggregateBound } from '../../src/valuation/engine.js';
import type { LogprobInfo } from '@llm-image/shared';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'src', 'storage', 'migrations');

function createTestDb() {
	const db = new DatabaseSync(':memory:');
	for (const file of ['001_init.sql', '002_logprobs.sql']) {
		db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'));
	}
	return db;
}

// 同一组候选（来自某边界的 top-k 路径）：
//   100(p=-0.5)  200(p=-1.5)  150(p=-1.0)
// 路径概率 w = [e^-0.5, e^-1.5, e^-1.0]
//   = [0.6065, 0.2231, 0.3679]，归一化和 = 1.1975
// 期望 = (0.6065*100 + 0.2231*200 + 0.3679*150) / 1.1975 ≈ 133.98
const CANDIDATES: Candidate[] = [
	{ value: 100, tokenLogprobs: [-0.5], confidence: 'low', rationale: 'r1' },
	{ value: 200, tokenLogprobs: [-1.5], confidence: 'low', rationale: 'r2' },
	{ value: 150, tokenLogprobs: [-1.0], confidence: 'low', rationale: 'r3' },
];

describe('expectationDecode (constrained expected-value decoding)', () => {
	beforeEach(() => setDb(createTestDb()));
	afterEach(() => closeDb());

	it('computes probability-weighted value across valid top-k paths', () => {
		const r = expectationDecode(CANDIDATES);
		expect(r.value).toBeCloseTo(134, 0);
		expect(r.usedPaths).toBe(3);
		expect(r.discardedPaths).toBe(0);
		// 最自信候选（路径概率最高）= 100(p=-0.5)
		expect(r.rationale).toBe('r1');
		expect(r.confidence).toBe('low');
	});

	it('applies validity mask: drops negative and non-numeric paths', () => {
		const dirty: Candidate[] = [
			{ value: 100, tokenLogprobs: [-0.5] },
			{ value: -50, tokenLogprobs: [-0.9] }, // 负：非法估值
			{ value: Number.NaN, tokenLogprobs: [-1.2] }, // 非数字
		];
		const r = expectationDecode(dirty);
		expect(r.usedPaths).toBe(1);
		expect(r.discardedPaths).toBe(2);
		expect(r.value).toBeCloseTo(100, 6);
	});

	it('is formula-equivalent to aggregateBound when candidate token counts match', () => {
		// 同一组候选：作为"1 次调用内的 top-k 路径"（期望解码）
		const expValue = expectationDecode(CANDIDATES).value;

		// 作为"3 次独立调用的样本"（当前多样本聚合）。单 token → meanLogprob == sum，
		// 故 aggregateBound 的 exp(meanLogprob) 加权与 expectationDecode 的 exp(sum) 加权等价。
		const samples = CANDIDATES.map((c) => ({
			value: c.value,
			logprob: c.tokenLogprobs[0]!,
			rationale: '',
			confidence: 'low' as const,
			text: '',
			toolUsed: false,
			toolFallback: false,
		}));
		const aggValue = aggregateBound(samples as any, 'min').value;

		expect(expValue).toBeCloseTo(aggValue, 6);
		// 收益不在聚合公式，而在信息来源：期望解码的候选来自 1 次调用的 top-k，
		// 而当前多样本聚合需要 3 次独立调用才能拿到 3 个样本。
	});

	it('beats argmax (current default: samples=1, temp=0) using the same single call', () => {
		// 当前默认 samples=1,temp=0：贪心取最高概率单点 = 100（丢弃分布信息）
		const argmaxPoint = 100;
		const expValue = expectationDecode(CANDIDATES).value;

		// 同样 1 次调用（top-k 由该次调用提供），期望解码得到 134，而非单点 100
		expect(expValue).not.toBeCloseTo(argmaxPoint, 0);
		expect(expValue).toBeCloseTo(134, 0);
	});
});

describe('candidateValuesFromLogprobs (rebuild paths from top_logprobs)', () => {
	beforeEach(() => setDb(createTestDb()));
	afterEach(() => closeDb());

	// 数值字段为单 token，其 top_logprobs 含 100/200/150
	function singleTokenLogprobs(cands: Array<[string, number]>): LogprobInfo {
		return {
			tokens: [
				{ token: '{"min_value":', logprob: -0.1 },
				{
					token: cands[0]![0],
					logprob: cands[0]![1],
					topLogprobs: cands.map(([t, lp]) => ({ token: t, logprob: lp })),
				},
				{ token: '}', logprob: -0.1 },
			],
		};
	}

	it('rebuilds numeric candidates from top_logprobs and feeds expectationDecode', () => {
		const lp = singleTokenLogprobs([
			['100', -0.5],
			['200', -1.5],
			['150', -1.0],
		]);
		const cands = candidateValuesFromLogprobs(lp, '{"min_value": 100}', 'min_value');
		expect(cands.map((c) => c.value).sort((a, b) => a - b)).toEqual([100, 150, 200]);

		// 经期望解码得 ≈134（与纯候选测试一致 → 验证"真实链路"闭环）
		const v = decodeExpectedValue(lp, '{"min_value": 100}', 'min_value');
		expect(v).toBeCloseTo(134, 0);
	});

	it('handles multi-token numbers via cartesian product of per-position top-k', () => {
		// "min_value": 1234 → tokenized "12" + "34"
		const lp: LogprobInfo = {
			tokens: [
				{ token: '{"min_value":', logprob: -0.1 },
				{
					token: '12',
					logprob: -0.5,
					topLogprobs: [
						{ token: '12', logprob: -0.5 },
						{ token: '13', logprob: -1.0 },
					],
				},
				{
					token: '34',
					logprob: -0.8,
					topLogprobs: [
						{ token: '34', logprob: -0.8 },
						{ token: '44', logprob: -1.2 },
					],
				},
				{ token: '}', logprob: -0.1 },
			],
		};
		const cands = candidateValuesFromLogprobs(lp, '{"min_value": 1234}', 'min_value');
		// 组合：1234 / 1244 / 1334 / 1344 均合法数字
		expect(cands.map((c) => c.value).sort((a, b) => a - b)).toEqual([1234, 1244, 1334, 1344]);

		const r = expectationDecode(cands);
		expect(r.usedPaths).toBe(4);
		// 主路径(1234, lp=-1.3)权重最高，但其他候选抬升期望
		expect(r.value).toBeGreaterThan(1234);
		expect(r.value).toBeLessThan(1345);
	});

	it('degrades to single argmax path when no topLogprobs present', () => {
		const lp: LogprobInfo = {
			tokens: [
				{ token: '{"min_value":', logprob: -0.1 },
				{ token: '100', logprob: -0.5 },
				{ token: '}', logprob: -0.1 },
			],
		};
		const cands = candidateValuesFromLogprobs(lp, '{"min_value": 100}', 'min_value');
		expect(cands.length).toBe(1);
		expect(cands[0]!.value).toBe(100);
	});
});
