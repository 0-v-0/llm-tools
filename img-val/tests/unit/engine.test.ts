import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { LLMProvider, CompleteRequest, CompleteResponse, LogprobInfo, TopLogprob } from '@llm-image/shared';
import { setDb, closeDb } from '../../src/storage/db.js';
import { valuate } from '../../src/valuation/engine.js';
import {
	MIN_VALUE_RESPONSE_FORMAT,
	MAX_VALUE_RESPONSE_FORMAT,
} from '../../src/llm/response-parser.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'src', 'storage', 'migrations');

function createTestDb() {
	const db = new DatabaseSync(':memory:');
	// 按文件名顺序应用全部迁移（含 002 新增的 logprob / 采样数列）
	for (const file of ['001_init.sql', '002_logprobs.sql']) {
		const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
		db.exec(sql);
	}
	return db;
}

/** Fake provider that returns scripted responses in order. */
class FakeProvider implements LLMProvider {
	readonly model = 'fake-model';
	private responses: CompleteResponse[];
	readonly requests: CompleteRequest[] = [];
	private callCount = 0;

	constructor(responses: CompleteResponse[]) {
		this.responses = responses;
	}

	async complete(req: CompleteRequest): Promise<CompleteResponse> {
		this.requests.push(req);
		const resp = this.responses[this.callCount];
		this.callCount++;
		if (!resp) throw new Error('No more scripted responses');
		return resp;
	}

	get callCountValue() {
		return this.callCount;
	}
}

function lp(text: string, logprob: number): LogprobInfo {
	return { tokens: [{ token: text, logprob }] };
}

function minResp(value: number, rationale: string, confidence: 'low' | 'medium' | 'high', logprob: number) {
	const text = JSON.stringify({ min_value: value, rationale, confidence });
	return {
		stopReason: 'stop' as const,
		text,
		toolCalls: [],
		usage: { inputTokens: 10, outputTokens: 5 },
		logprobs: lp(text, logprob),
	};
}

function maxResp(value: number, rationale: string, confidence: 'low' | 'medium' | 'high', logprob: number) {
	const text = JSON.stringify({ max_value: value, rationale, confidence });
	return {
		stopReason: 'stop' as const,
		text,
		toolCalls: [],
		usage: { inputTokens: 12, outputTokens: 6 },
		logprobs: lp(text, logprob),
	};
}

const mockStandard = {
	frontmatter: {
		name: 'recovery-value',
		description: '测试标准',
		version: '1.0.0',
		currency: 'CNY',
	},
	body: '# Test Standard\nContent.',
	contentHash: 'b'.repeat(64),
	source: 'builtin' as const,
};

const mockImage = {
	url: 'file:///test/image.jpg',
	hash: 'img-hash-1',
	base64: 'data:image/jpeg;base64,test',
	format: 'jpeg',
	width: 1920,
	height: 1080,
	channels: 3,
	sizeBytes: 102400,
	undecodablePixels: 0,
	notes: [],
};

const mockEnv = { LLM_PROVIDER: 'openai' } as unknown as import('../../src/config/env.js').EnvConfig;

/** 默认配置：min/max 各采样 1 次（确定性）。 */
const baseConfig = {
	standardsDir: '/tmp/standards',
	storeRaw: true,
	maxImageDimension: 1568,
	maxToolRounds: 4,
	enableTools: false,
	failLogDir: undefined,
	samplesMin: 1,
	samplesMax: 1,
	samplingTemperature: 0.7,
	enableLogprobs: true,
} as unknown as import('../../src/config/config.js').AppConfig;

describe('engine (plan C: two independent requests)', () => {
	beforeEach(() => {
		setDb(createTestDb());
	});

	afterEach(() => {
		closeDb();
	});

	it('issues one min request then one max request with distinct schemas', async () => {
		const provider = new FakeProvider([
			minResp(100, '客观价值低', 'low', -1.0),
			maxResp(9000, '重大情感价值', 'high', -1.5),
		]);

		const result = await valuate({
			url: mockImage.url,
			image: mockImage,
			standard: mockStandard,
			provider,
			env: mockEnv,
			config: baseConfig,
			enableTools: false,
		});

		// 两次独立请求
		expect(provider.callCountValue).toBe(2);
		expect(provider.requests[0]?.responseSchema?.name).toBe(MIN_VALUE_RESPONSE_FORMAT.name);
		expect(provider.requests[1]?.responseSchema?.name).toBe(MAX_VALUE_RESPONSE_FORMAT.name);

		// 各自独立解析，未被锚定
		expect(result.valuation.minValue).toBe(100);
		expect(result.valuation.maxValue).toBe(9000);
		expect(result.valuation.uncertainty).toBe(8900);

		// 连续置信分由较弱边界的 logprob 派生：min(-1.0, -1.5) = -1.5 → medium
		expect(result.valuation.confidence).toBe('medium');
		expect(result.valuation.confidenceScore).toBeCloseTo(Math.exp(-1.5), 4);

		// token 求和
		expect(result.llm.inputTokens).toBe(22);
		expect(result.llm.outputTokens).toBe(11);

		// 合并 rationale 同时含两个假设
		expect(result.valuation.rationale).toContain('下界(客观假设)');
		expect(result.valuation.rationale).toContain('上界(最好假设)');

		// 单次采样：logprob 透传，采样次数=1
		expect(result.valuation.minLogprob).toBeCloseTo(-1.0);
		expect(result.valuation.maxLogprob).toBeCloseTo(-1.5);
		expect(result.valuation.samplesMin).toBe(1);
		expect(result.valuation.samplesMax).toBe(1);
	});

	it('reconciles when max < min by reordering into a valid interval', async () => {
		const provider = new FakeProvider([
			minResp(800, '客观价值高', 'high', -0.4),
			maxResp(200, '最好假设反而低', 'low', -3.0),
		]);

		const result = await valuate({
			url: mockImage.url,
			image: mockImage,
			standard: mockStandard,
			provider,
			env: mockEnv,
			config: baseConfig,
			enableTools: false,
		});

		// 交叉被重排：finalMin = 200, finalMax = 800
		expect(result.valuation.minValue).toBe(200);
		expect(result.valuation.maxValue).toBe(800);
		expect(result.valuation.minValue).toBeLessThanOrEqual(result.valuation.maxValue);
		expect(result.valuation.rationale).toContain('上下界估算交叉');
	});

	it('samples min N times, aggregates via logprobs-weighted mean, and sets temperature per sample count', async () => {
		// min 采样 3 次：100(-0.5)、200(-1.5)、150(-1.0)；max 采样 1 次：9000(-2.0)
		const provider = new FakeProvider([
			minResp(100, 'r1', 'low', -0.5),
			minResp(200, 'r2', 'low', -1.5),
			minResp(150, 'r3', 'low', -1.0),
			maxResp(9000, '重大情感价值', 'high', -2.0),
		]);

		const config = {
			...baseConfig,
			samplesMin: 3,
			samplesMax: 1,
		} as unknown as import('../../src/config/config.js').AppConfig;

		const result = await valuate({
			url: mockImage.url,
			image: mockImage,
			standard: mockStandard,
			provider,
			env: mockEnv,
			config,
			enableTools: false,
		});

		// 共 3(min) + 1(max) = 4 次请求
		expect(provider.callCountValue).toBe(4);

		// 多次采样用 samplingTemperature(0.7)；单次采样用 temp=0（确定性）
		expect(provider.requests[0]?.temperature).toBeCloseTo(0.7);
		expect(provider.requests[1]?.temperature).toBeCloseTo(0.7);
		expect(provider.requests[2]?.temperature).toBeCloseTo(0.7);
		expect(provider.requests[3]?.temperature).toBe(0);

		// logprobs 加权均值 ≈ 134（exp 加权）
		// w = [e^-0.5, e^-1.5, e^-1.0] → 0.6065*100 + 0.2231*200 + 0.3679*150 = 160.46 / 1.1975 = 133.98
		expect(result.valuation.minValue).toBeCloseTo(134, 0);
		expect(result.valuation.maxValue).toBe(9000);
		expect(result.valuation.samplesMin).toBe(3);
		expect(result.valuation.samplesMax).toBe(1);

		// 聚合 logprob：min 均值 (-0.5-1.5-1.0)/3 = -1.0；max -2.0
		expect(result.valuation.minLogprob).toBeCloseTo(-1.0);
		expect(result.valuation.maxLogprob).toBeCloseTo(-2.0);
		// 连续置信分取较弱边界 logprob = min(-1.0, -2.0) = -2.0 → 枚举 medium
		expect(result.valuation.confidence).toBe('medium');
		expect(result.valuation.confidenceScore).toBeCloseTo(Math.exp(-2.0), 4);

		// rationale 取最自信样本（logprob 最高 == -0.5 的 r1）
		expect(result.valuation.rationale).toContain('r1');
	});
});

/** 按 token 列表构造 LogprobInfo（支持每个位置携带 top-k 候选，用于路径重建测试）。 */
function lpTokens(tokens: Array<{ token: string; logprob: number; topLogprobs?: TopLogprob[] }>): LogprobInfo {
	return { tokens: tokens.map((t) => ({ token: t.token, logprob: t.logprob, topLogprobs: t.topLogprobs ?? [] })) };
}

/** min 边界响应，数值 100 被拆成 token "10"+"0"，且两个位置各带 top-k 候选，
 *  使路径重建可枚举出 100/105/150/155 四条候选数值路径。 */
function minRespPath(): CompleteResponse {
	const text = `{"min_value": 100,"rationale":"r","confidence":"low"}`;
	const tokens = [
		{ token: `{"min_value": `, logprob: -0.1 },
		{ token: '10', logprob: -0.5, topLogprobs: [{ token: '10', logprob: -0.5 }, { token: '15', logprob: -1.5 }] },
		{ token: '0', logprob: -1.0, topLogprobs: [{ token: '0', logprob: -1.0 }, { token: '5', logprob: -3.0 }] },
		{ token: `,"rationale":"r","confidence":"low"}`, logprob: -0.1 },
	];
	return {
		stopReason: 'stop' as const,
		text,
		toolCalls: [],
		usage: { inputTokens: 10, outputTokens: 5 },
		logprobs: lpTokens(tokens),
	};
}

describe('engine: usePathDecoding (constrained expected-value decoding)', () => {
	beforeEach(() => {
		setDb(createTestDb());
	});

	afterEach(() => {
		closeDb();
	});

	it('uses 1 call per bound with top_logprobs and returns the path-expectation (not argmax)', async () => {
		// min 边界：100(主路径) 但 top-k 提供 100/105/150/155 四条候选路径
		const provider = new FakeProvider([
			minRespPath(),
			maxResp(9000, '重大情感价值', 'high', -2.0),
		]);

		const config = {
			...baseConfig,
			usePathDecoding: true,
			pathTopK: 20,
		} as unknown as import('../../src/config/config.js').AppConfig;

		const result = await valuate({
			url: mockImage.url,
			image: mockImage,
			standard: mockStandard,
			provider,
			env: mockEnv,
			config,
			enableTools: false,
		});

		// 每边界仅 1 次调用（替代 samples 次）
		expect(provider.callCountValue).toBe(2);
		expect(result.valuation.samplesMin).toBe(1);
		expect(result.valuation.samplesMax).toBe(1);

		// min 请求携带 top_logprobs（= pathTopK）与 temp=0
		expect(provider.requests[0]?.topLogprobs).toBe(20);
		expect(provider.requests[0]?.temperature).toBe(0);

		// 结果采用路径期望（≈114）而非主路径单点（100）
		const expValue = 114.04; // 由 100/105/150/155 按路径概率加权求得
		expect(result.valuation.minValue).not.toBeCloseTo(100, 0);
		expect(result.valuation.minValue).toBeCloseTo(expValue, 0);
		expect(result.valuation.maxValue).toBe(9000);

		// 聚合 logprob ≈ -1.00（路径概率加权平均 token logprob），弱边界 -2.0 → medium
		expect(result.valuation.minLogprob).toBeCloseTo(-1.0, 1);
		expect(result.valuation.confidence).toBe('medium');
		expect(result.valuation.confidenceScore).toBeCloseTo(Math.exp(-2.0), 3);

		// 标注区分于普通多样本聚合
		expect(result.notes[0]).toContain('路径期望解码');
	});

	it('degrades to argmax single point when logprobs are disabled', async () => {
		// usePathDecoding=true 但 enableLogprobs=false：不请求 top_logprobs，退化为 argmax 单点
		const provider = new FakeProvider([
			minResp(100, '客观价值低', 'low', -1.0),
			maxResp(9000, '重大情感价值', 'high', -1.5),
		]);

		const config = {
			...baseConfig,
			usePathDecoding: true,
			enableLogprobs: false,
		} as unknown as import('../../src/config/config.js').AppConfig;

		const result = await valuate({
			url: mockImage.url,
			image: mockImage,
			standard: mockStandard,
			provider,
			env: mockEnv,
			config,
			enableTools: false,
		});

		// 不请求 top_logprobs
		expect(provider.requests[0]?.topLogprobs).toBeUndefined();

		// 退化为 argmax 单点（与 usePathDecoding=false 的 samples=1 行为一致）
		expect(result.valuation.minValue).toBe(100);
		expect(result.valuation.maxValue).toBe(9000);
		expect(result.valuation.samplesMin).toBe(1);
		expect(result.valuation.confidenceScore).toBeNull();
		expect(result.notes[0]).toContain('路径期望解码');
	});
});
