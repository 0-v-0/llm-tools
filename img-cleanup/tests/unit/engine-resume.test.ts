import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, CompleteRequest, CompleteResponse } from '@llm-image/shared';
import type { ImageEntry } from '../../src/storage/types.js';
import type { AppConfig } from '../../src/config/config.js';
import { runCleanupPipeline } from '../../src/selection/engine.js';

// processImage 会读取真实文件；测试中 mock 为纯内存操作
vi.mock('@llm-image/shared', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@llm-image/shared')>();
	return {
		...actual,
		processImage: vi.fn(async (url: string) => ({
			hash: 'mock-hash-' + url,
			base64: 'data:image/jpeg;base64,mock',
			format: 'jpeg',
			width: 1000,
			height: 800,
			notes: [],
		})),
	};
});
import { Checkpoint } from '../../src/checkpoint/store.js';
import { CHECKPOINT_VERSION } from '../../src/checkpoint/types.js';
import { cacheKeyFor, type RunInputs } from '../../src/checkpoint/resolve.js';
import { hashStrings } from '../../src/checkpoint/fingerprint.js';

function makeEntry(url: string, maxValue: number, standardName = 'default-photo'): ImageEntry {
	return {
		url,
		imageHash: 'hash-' + url,
		maxValue,
		minValue: Math.max(0, maxValue - 10),
		standardName,
		imageFormat: 'jpeg',
		width: 1000,
		height: 800,
		channels: 3,
		sizeBytes: 100000,
		undecodablePixels: 0,
	};
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		llm: {
			provider: 'openai',
			openai: { visionDetail: 'high' as const },
		},
		batchSize: 2,
		maxImageDimension: 1568,
		bucketBoundaries: [0, 30, 100, 500, 2000, 5000, 15000],
		maxToolRounds: 4,
		storeRaw: false,
		checkpointEnabled: true,
		...overrides,
	};
}

/** Mock provider：按字母序选择标签，统计调用次数。 */
function makeProvider(nextSelected?: (callIndex: number) => string): {
	provider: LLMProvider;
	callCount: () => number;
} {
	let calls = 0;
	const provider: LLMProvider = {
		model: 'mock-model',
		provider: 'openai',
		async complete(_req: CompleteRequest): Promise<CompleteResponse> {
			calls++;
			const selected = nextSelected ? nextSelected(calls - 1) : 'A';
			return {
				stopReason: 'stop',
				text: JSON.stringify({ selected, reason: `mock-${calls}` }),
				toolCalls: [],
			};
		},
	};
	return { provider, callCount: () => calls };
}

function toRunInputs(images: ImageEntry[], m: number, targetDir: string): RunInputs {
	return {
		m,
		mArg: String(m),
		batchSize: 2,
		bucketBoundaries: [0, 30, 100, 500, 2000, 5000, 15000],
		pathGlobs: [],
		standardName: null,
		targetDir,
		dryRun: true,
		imageUrls: images.map((i) => i.url),
		provider: 'openai',
		model: 'mock-model',
		maxImageDimension: 1568,
	};
}

function makeCheckpoint(path: string, inputs: RunInputs): Checkpoint {
	return Checkpoint.create(path, {
		version: CHECKPOINT_VERSION,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cacheKey: cacheKeyFor(inputs),
		params: {
			m: inputs.m,
			mArg: inputs.mArg,
			totalImages: inputs.imageUrls.length,
			batchSize: inputs.batchSize,
			bucketBoundaries: [...inputs.bucketBoundaries],
			pathGlobs: [...inputs.pathGlobs],
			standardName: inputs.standardName,
			targetDir: inputs.targetDir,
			dryRun: inputs.dryRun,
			imageSetHash: hashStrings(inputs.imageUrls),
		},
	});
}

describe('runCleanupPipeline with checkpoint (中断恢复)', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'imgcleanup-eng-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('first run records verdicts; second run reuses them (zero LLM calls)', async () => {
		const images = [
			makeEntry('file:///a.jpg', 10),
			makeEntry('file:///b.jpg', 20),
			makeEntry('file:///c.jpg', 10),
			makeEntry('file:///d.jpg', 20),
		];
		const config = makeConfig();
		const path = join(dir, 'c.json');
		const inputs = toRunInputs(images, 2, 'D:/t');

		// 第一次运行：4 张图、batchSize=2 → 2 个 LLM 批次
		const p1 = makeProvider();
		const ckpt1 = makeCheckpoint(path, inputs);
		const r1 = await runCleanupPipeline(images, 2, config, p1.provider, { checkpoint: ckpt1 });
		expect(p1.callCount()).toBe(2);
		expect(r1.reusedBatches).toBe(0);
		expect(r1.llmCalls).toBe(2);
		expect(ckpt1.size).toBe(2);

		// 第二次运行（模拟中断后重跑）：全部命中缓存
		const p2 = makeProvider();
		const ckpt2 = Checkpoint.resumed(
			// 通过 load 拿到已序列化数据
			JSON.parse(JSON.stringify(ckpt1.data)),
			path,
		);
		const r2 = await runCleanupPipeline(images, 2, config, p2.provider, { checkpoint: ckpt2 });
		expect(p2.callCount()).toBe(0);
		expect(r2.reusedBatches).toBe(2);
		expect(r2.llmCalls).toBe(0);
		// 结果一致
		expect(r2.toRemove.map((i) => i.url)).toEqual(r1.toRemove.map((i) => i.url));
	});

	it('m change: batch verdicts reused, only tournament pairs call LLM', async () => {
		// 8 张图 → 4 批 → 4 落选者；m=1 触发锦标赛（2 对比较）
		const images = [
			makeEntry('file:///a.jpg', 10),
			makeEntry('file:///b.jpg', 20),
			makeEntry('file:///c.jpg', 10),
			makeEntry('file:///d.jpg', 20),
			makeEntry('file:///e.jpg', 10),
			makeEntry('file:///f.jpg', 20),
			makeEntry('file:///g.jpg', 10),
			makeEntry('file:///h.jpg', 20),
		];
		const config = makeConfig();
		const path = join(dir, 'c.json');

		// 第一次：m=1（锦标赛 2 对）
		const inputs1 = toRunInputs(images, 1, 'D:/t');
		const p1 = makeProvider();
		const ckpt1 = makeCheckpoint(path, inputs1);
		await runCleanupPipeline(images, 1, config, p1.provider, { checkpoint: ckpt1 });
		const firstCalls = p1.callCount();
		expect(firstCalls).toBe(4 + 3); // 4 批 + 3 对（round1: 2 对 + round2: 1 对）

		// 第二次：m=4（无需锦标赛）—— 批次全复用，0 次调用
		const inputs2 = toRunInputs(images, 4, 'D:/t');
		const p2 = makeProvider();
		const ckpt2 = Checkpoint.resumed(JSON.parse(JSON.stringify(ckpt1.data)), path);
		const r2 = await runCleanupPipeline(images, 4, config, p2.provider, { checkpoint: ckpt2 });
		expect(p2.callCount()).toBe(0);
		expect(r2.reusedBatches).toBe(4);
		expect(r2.toRemove).toHaveLength(4);
	});

	it('checkpoint data persists after each record (crash-safe)', async () => {
		const images = [makeEntry('file:///a.jpg', 10), makeEntry('file:///b.jpg', 20)];
		const config = makeConfig();
		const path = join(dir, 'c.json');
		const inputs = toRunInputs(images, 1, 'D:/t');
		const p = makeProvider();
		const ckpt = makeCheckpoint(path, inputs);
		await runCleanupPipeline(images, 1, config, p.provider, { checkpoint: ckpt });

		// 无需显式 save：record 内部即时落盘
		const { loadCheckpoint } = await import('../../src/checkpoint/store.js');
		const loaded = loadCheckpoint(path);
		expect(loaded).not.toBeNull();
		expect(loaded!.verdicts).toHaveLength(1);
		expect(loaded!.toRemoveUrls).not.toBeNull();
	});

	it('no checkpoint → behaves as before (all LLM calls made)', async () => {
		const images = [makeEntry('file:///a.jpg', 10), makeEntry('file:///b.jpg', 20)];
		const config = makeConfig();
		const p = makeProvider();
		const r = await runCleanupPipeline(images, 1, config, p.provider, {});
		expect(p.callCount()).toBe(1);
		expect(r.llmCalls).toBe(1);
		expect(r.reusedBatches).toBe(0);
	});
});
