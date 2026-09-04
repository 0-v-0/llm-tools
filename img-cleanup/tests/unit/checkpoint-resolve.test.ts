import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkpoint } from '../../src/checkpoint/store.js';
import { CHECKPOINT_VERSION } from '../../src/checkpoint/types.js';
import { resolveCheckpoint, cacheKeyFor, type RunInputs } from '../../src/checkpoint/resolve.js';
import { hashStrings } from '../../src/checkpoint/fingerprint.js';

function makeInputs(overrides: Partial<RunInputs> = {}): RunInputs {
	return {
		m: 10,
		mArg: '10',
		batchSize: 2,
		bucketBoundaries: [0, 30, 100],
		pathGlobs: [],
		standardName: null,
		targetDir: 'D:/tmp/target',
		dryRun: true,
		imageUrls: ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg', 'file:///d.jpg'],
		provider: 'openai',
		model: 'gpt-4o',
		maxImageDimension: 1568,
		...overrides,
	};
}

/** 无交互依赖的 prompt 注入。 */
function scriptedPrompt(answer: string) {
	const calls: string[] = [];
	return {
		calls,
		prompt: {
			isTTY: true,
			ask: async (q: string) => {
				calls.push(q);
				return answer;
			},
		},
	};
}

function makeExisting(path: string, inputs: RunInputs, verdicts: number): Checkpoint {
	const ckpt = Checkpoint.create(path, {
		version: CHECKPOINT_VERSION,
		createdAt: '2025-01-01T00:00:00.000Z',
		updatedAt: '2025-01-01T00:00:00.000Z',
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
	for (let i = 0; i < verdicts; i++) {
		ckpt.record({
			urls: [`file:///v${i}a.jpg`, `file:///v${i}b.jpg`],
			keptUrl: `file:///v${i}a.jpg`,
			loserUrls: [`file:///v${i}b.jpg`],
			reason: `r${i}`,
			phase: 'batch',
		});
	}
	return ckpt;
}

describe('resolveCheckpoint', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'imgcleanup-res-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('creates a fresh checkpoint when none exists', async () => {
		const path = join(dir, 'c.json');
		const res = await resolveCheckpoint(path, makeInputs());
		expect(res.resumed).toBe(false);
		expect(res.cachedVerdicts).toBe(0);
		expect(res.checkpoint.size).toBe(0);
	});

	it('reuses verdicts when inputs unchanged', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs();
		makeExisting(path, inputs, 3);
		const res = await resolveCheckpoint(path, inputs);
		expect(res.resumed).toBe(true);
		expect(res.cachedVerdicts).toBe(3);
		expect(res.checkpoint.size).toBe(3);
		expect(res.notes).toHaveLength(0);
	});

	it('m change reuses verdicts (soft key)', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs();
		makeExisting(path, inputs, 3);
		const res = await resolveCheckpoint(path, makeInputs({ m: 99, mArg: '99' }));
		expect(res.resumed).toBe(true);
		expect(res.cachedVerdicts).toBe(3);
		expect(res.notes.some((n) => n.includes('m 10 → 99'))).toBe(true);
	});

	it('targetDir change reuses verdicts and notes move reset', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs();
		makeExisting(path, inputs, 2);
		const res = await resolveCheckpoint(path, makeInputs({ targetDir: 'D:/tmp/other' }));
		expect(res.resumed).toBe(true);
		expect(res.cachedVerdicts).toBe(2);
		expect(res.notes.some((n) => n.includes('目标目录'))).toBe(true);
	});

	it('dryRun change reuses verdicts and notes move reset', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs({ dryRun: true });
		makeExisting(path, inputs, 2);
		const res = await resolveCheckpoint(path, makeInputs({ dryRun: false }));
		expect(res.resumed).toBe(true);
		expect(res.cachedVerdicts).toBe(2);
	});

	it('image set change reuses verdicts with a note', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs();
		makeExisting(path, inputs, 2);
		const res = await resolveCheckpoint(path, makeInputs({
			imageUrls: ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg', 'file:///d.jpg', 'file:///e.jpg'],
		}));
		expect(res.resumed).toBe(true);
		expect(res.cachedVerdicts).toBe(2);
		expect(res.notes.some((n) => n.includes('图片集合变化'))).toBe(true);
	});

	it('batchSize change reuses verdicts with a note (cache is url-set keyed)', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs();
		makeExisting(path, inputs, 2);
		const res = await resolveCheckpoint(path, makeInputs({ batchSize: 3 }));
		expect(res.resumed).toBe(true);
		expect(res.cachedVerdicts).toBe(2);
		expect(res.notes.some((n) => n.includes('batchSize'))).toBe(true);
	});

	it('judge change (model) invalidates checkpoint', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs();
		makeExisting(path, inputs, 2);
		const res = await resolveCheckpoint(path, makeInputs({ model: 'gpt-4o-mini' }));
		expect(res.resumed).toBe(false);
		expect(res.cachedVerdicts).toBe(0);
		expect(res.checkpoint.size).toBe(0);
		expect(res.notes[0]).toContain('裁判');
	});

	it('standard change prompts; declining starts fresh', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs({ standardName: null });
		makeExisting(path, inputs, 2);
		const { prompt, calls } = scriptedPrompt('n');
		const res = await resolveCheckpoint(path, makeInputs({ standardName: 'recovery-value' }), { prompt });
		expect(calls.length).toBeGreaterThan(0);
		expect(res.resumed).toBe(false);
		expect(res.checkpoint.size).toBe(0);
	});

	it('standard change prompts; confirming forces reuse', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs({ standardName: null });
		makeExisting(path, inputs, 2);
		const { prompt, calls } = scriptedPrompt('y');
		const res = await resolveCheckpoint(path, makeInputs({ standardName: 'recovery-value' }), { prompt });
		expect(calls.length).toBeGreaterThan(0);
		expect(res.resumed).toBe(true);
		expect(res.cachedVerdicts).toBe(2);
		expect(res.notes.some((n) => n.includes('强制复用'))).toBe(true);
	});

	it('standard change with force skips the prompt entirely', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs({ standardName: null });
		makeExisting(path, inputs, 2);
		const { prompt, calls } = scriptedPrompt('n');
		const res = await resolveCheckpoint(path, makeInputs({ standardName: 'recovery-value' }), { prompt, force: true });
		expect(calls).toHaveLength(0);
		expect(res.resumed).toBe(true);
		expect(res.cachedVerdicts).toBe(2);
	});

	it('standard change on non-TTY without force starts fresh (no prompt)', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs({ standardName: null });
		makeExisting(path, inputs, 2);
		const { prompt, calls } = scriptedPrompt('y');
		const nonTty = { ...prompt, isTTY: false };
		const res = await resolveCheckpoint(path, makeInputs({ standardName: 'recovery-value' }), { prompt: nonTty });
		expect(calls).toHaveLength(0);
		expect(res.resumed).toBe(false);
		expect(res.checkpoint.size).toBe(0);
	});

	it('selection state cleared when m changed (toRemoveUrls no longer applicable)', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs();
		const ckpt = makeExisting(path, inputs, 2);
		ckpt.setToRemoveUrls(['file:///v0a.jpg']);
		ckpt.appendMoveResult(inputs.targetDir, { path: 'p', status: 'moved' });
		const res = await resolveCheckpoint(path, makeInputs({ m: 5 }));
		expect(res.resumed).toBe(true);
		expect(res.checkpoint.data.toRemoveUrls).toBeNull();
		expect(res.checkpoint.move).toBeNull();
	});

	it('selection state kept when inputs fully unchanged', async () => {
		const path = join(dir, 'c.json');
		const inputs = makeInputs();
		const ckpt = makeExisting(path, inputs, 2);
		ckpt.setToRemoveUrls(['file:///v0a.jpg']);
		const res = await resolveCheckpoint(path, inputs);
		expect(res.resumed).toBe(true);
		expect(res.checkpoint.data.toRemoveUrls).toEqual(['file:///v0a.jpg']);
	});
});
