import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	Checkpoint,
	clearCheckpoint,
	invalidateCheckpoint,
	loadCheckpoint,
	saveCheckpoint,
	imageSetHash,
} from '../../src/checkpoint/store.js';
import { verdictKey, computeCacheKey } from '../../src/checkpoint/fingerprint.js';
import { CHECKPOINT_VERSION, type CheckpointData, type Verdict } from '../../src/checkpoint/types.js';

function makeInputs(overrides: Partial<CheckpointData['params']> = {}): CheckpointData['params'] {
	return {
		m: 10,
		mArg: '10',
		totalImages: 4,
		batchSize: 2,
		bucketBoundaries: [0, 30, 100],
		pathGlobs: [],
		standardName: null,
		targetDir: 'D:/tmp/target',
		dryRun: true,
		imageSetHash: 'abc123',
		...overrides,
	};
}

function makeCheckpoint(path: string, params = makeInputs()): Checkpoint {
	return Checkpoint.create(path, {
		version: CHECKPOINT_VERSION,
		createdAt: '2025-01-01T00:00:00.000Z',
		updatedAt: '2025-01-01T00:00:00.000Z',
		cacheKey: 'k',
		params,
	});
}

describe('checkpoint store', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'imgcleanup-ckpt-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('round-trips through save/load', () => {
		const path = join(dir, 'ckpt.json');
		const ckpt = makeCheckpoint(path);
		ckpt.record({ urls: ['file:///b', 'file:///a'], keptUrl: 'file:///a', loserUrls: ['file:///b'], reason: 'r', phase: 'batch' });
		ckpt.save();

		const loaded = loadCheckpoint(path);
		expect(loaded).not.toBeNull();
		expect(loaded!.verdicts).toHaveLength(1);
		// urls 规范化为排序后的顺序
		expect(loaded!.verdicts[0]!.urls).toEqual(['file:///a', 'file:///b']);
		expect(loaded!.params.m).toBe(10);
	});

	it('returns null for missing file', () => {
		expect(loadCheckpoint(join(dir, 'nope.json'))).toBeNull();
	});

	it('returns null and keeps going for corrupted JSON', () => {
		const path = join(dir, 'bad.json');
		writeFileSync(path, '{not json', 'utf-8');
		expect(loadCheckpoint(path)).toBeNull();
	});

	it('returns null for schema mismatch (wrong version)', () => {
		const path = join(dir, 'v.json');
		const ckpt = makeCheckpoint(path);
		ckpt.save();
		const raw = JSON.parse(readJson(path));
		raw.version = 999;
		writeFileSync(path, JSON.stringify(raw), 'utf-8');
		expect(loadCheckpoint(path)).toBeNull();
	});

	it('clearCheckpoint is idempotent', () => {
		const path = join(dir, 'c.json');
		clearCheckpoint(path); // 不存在也不报错
		makeCheckpoint(path).save();
		expect(existsSync(path)).toBe(true);
		clearCheckpoint(path);
		expect(existsSync(path)).toBe(false);
		clearCheckpoint(path);
	});

	it('invalidateCheckpoint backs up the file', () => {
		const path = join(dir, 'i.json');
		makeCheckpoint(path).save();
		invalidateCheckpoint(path, 'test');
		expect(existsSync(path)).toBe(false);
		const files = readdirSync(dir).filter((f) => f.startsWith('i.json.bak.'));
		expect(files).toHaveLength(1);
	});

	it('save leaves no tmp file behind', () => {
		const path = join(dir, 's.json');
		makeCheckpoint(path).save();
		expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
	});
});

function readJson(path: string): string {
	return readFileSync(path, 'utf-8');
}

describe('Checkpoint verdict cache', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'imgcleanup-vc-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('lookup hits regardless of url order', () => {
		const path = join(dir, 'c.json');
		const ckpt = makeCheckpoint(path);
		ckpt.record({ urls: ['u1', 'u2'], keptUrl: 'u1', loserUrls: ['u2'], reason: 'x', phase: 'batch' });

		expect(ckpt.lookup(['u2', 'u1'])!.keptUrl).toBe('u1');
		expect(ckpt.lookup(['u2', 'u1'])).not.toBeNull();
		expect(ckpt.lookup(['u3', 'u4'])).toBeNull();
	});

	it('record is idempotent for the same url set', () => {
		const path = join(dir, 'c.json');
		const ckpt = makeCheckpoint(path);
		ckpt.record({ urls: ['a', 'b'], keptUrl: 'a', loserUrls: ['b'], reason: '1', phase: 'batch' });
		ckpt.record({ urls: ['b', 'a'], keptUrl: 'b', loserUrls: ['a'], reason: '2', phase: 'batch' });
		expect(ckpt.size).toBe(1);
	});

	it('reused / recorded counters', () => {
		const path = join(dir, 'c.json');
		const ckpt = makeCheckpoint(path);
		expect(ckpt.reusedCount).toBe(0);
		ckpt.lookup(['x', 'y']); // miss，不计 reused
		expect(ckpt.reusedCount).toBe(0);
		ckpt.record({ urls: ['x', 'y'], keptUrl: 'x', loserUrls: ['y'], reason: '', phase: 'batch' });
		ckpt.lookup(['y', 'x']);
		expect(ckpt.reusedCount).toBe(1);
		expect(ckpt.recordedCount).toBe(1);
	});

	it('verdictKey is order-insensitive and collision-free for different sets', () => {
		expect(verdictKey(['a', 'b'])).toBe(verdictKey(['b', 'a']));
		expect(verdictKey(['a', 'b'])).not.toBe(verdictKey(['a', 'b', 'c']));
	});

	it('move progress: appendMoveResult and reuse detection', () => {
		const path = join(dir, 'c.json');
		const ckpt = makeCheckpoint(path);
		ckpt.appendMoveResult('D:/t', { path: 'p1', status: 'moved' });
		expect(ckpt.move!.nextIndex).toBe(1);
		// 不同 targetDir 自动重建进度
		ckpt.appendMoveResult('D:/other', { path: 'p9', status: 'moved' });
		expect(ckpt.move!.results).toHaveLength(1);
		expect(ckpt.move!.targetDir).toBe('D:/other');
	});

	it('clearSelection resets toRemoveUrls and move', () => {
		const path = join(dir, 'c.json');
		const ckpt = makeCheckpoint(path);
		ckpt.setToRemoveUrls(['a']);
		ckpt.appendMoveResult('D:/t', { path: 'p', status: 'moved' });
		ckpt.clearSelection();
		expect(ckpt.data.toRemoveUrls).toBeNull();
		expect(ckpt.move).toBeNull();
	});

	it('markCompleted persists completed flag', () => {
		const path = join(dir, 'c.json');
		const ckpt = makeCheckpoint(path);
		ckpt.markCompleted();
		expect(loadCheckpoint(path)!.completed).toBe(true);
	});
});

describe('imageSetHash & cacheKey', () => {
	it('imageSetHash is order-insensitive and sensitive to content', () => {
		expect(imageSetHash(['a', 'b'])).toBe(imageSetHash(['b', 'a']));
		expect(imageSetHash(['a', 'b'])).not.toBe(imageSetHash(['a', 'b', 'c']));
		expect(imageSetHash([])).toBe('empty');
	});

	it('cacheKey distinguishes judge parameters only', () => {
		const base = { provider: 'openai', model: 'gpt-4o', temperature: 0, maxImageDimension: 1568, promptVersion: 1 };
		expect(computeCacheKey(base)).toBe(computeCacheKey({ ...base }));
		expect(computeCacheKey(base)).not.toBe(computeCacheKey({ ...base, model: 'gpt-4o-mini' }));
		expect(computeCacheKey(base)).not.toBe(computeCacheKey({ ...base, maxImageDimension: 1024 }));
	});
});

describe('saveCheckpoint atomicity', () => {
	it('overwrites existing file cleanly', () => {
		const dir = mkdtempSync(join(tmpdir(), 'imgcleanup-atom-'));
		try {
			const path = join(dir, 'a.json');
			const c1 = makeCheckpoint(path);
			c1.save();
			const c2 = Checkpoint.resumed(loadCheckpoint(path)!, path);
			c2.record({ urls: ['n1', 'n2'], keptUrl: 'n1', loserUrls: ['n2'], reason: '', phase: 'batch' });
			const loaded = loadCheckpoint(path)!;
			expect(loaded.verdicts).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// 类型层面的守卫：Verdict 构造必须带 phase
describe('verdict type shape', () => {
	it('accepts batch and tournament phases', () => {
		const a: Verdict = { urls: ['a'], keptUrl: 'a', loserUrls: [], reason: '', phase: 'batch' };
		const b: Verdict = { urls: ['b'], keptUrl: 'b', loserUrls: [], reason: '', phase: 'tournament' };
		expect(a.phase).toBe('batch');
		expect(b.phase).toBe('tournament');
	});
});

// saveCheckpoint 被直接导出并被 Checkpoint.save 使用
describe('direct saveCheckpoint export', () => {
	it('works standalone', () => {
		const dir = mkdtempSync(join(tmpdir(), 'imgcleanup-direct-'));
		try {
			const path = join(dir, 'd.json');
			const ckpt = makeCheckpoint(path);
			saveCheckpoint(path, ckpt.data);
			expect(loadCheckpoint(path)).not.toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
