import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppConfig } from 'img-cleanup/api';
import { Checkpoint, loadCheckpoint } from 'img-cleanup/api';
import { fakeProvider, createFakeProvider, setupEnv, type TestEnv } from './helpers.ts';
import { type CleanupSession, SessionManager } from '../src/server/session.ts';
import { HttpError } from '../src/server/errors.ts';

const config = {
	llm: {},
	batchSize: 2,
	maxImageDimension: 256,
	bucketBoundaries: [0, 1000],
	storeRaw: false,
	maxToolRounds: 4,
	checkpointEnabled: true,
} as unknown as AppConfig;

function makeManager(env: TestEnv): SessionManager {
	return new SessionManager({
		config,
		provider: fakeProvider,
		checkpointPath: join(env.dir, 'checkpoint.json'),
		checkpointEnabled: true,
	});
}

describe('SessionManager / CleanupSession', () => {
	let env: TestEnv;
	beforeEach(async () => {
		env = await setupEnv(4);
	});
	afterEach(() => {
		env.cleanup();
	});

	test('创建会话：分组、切批、m 解析', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		expect(s.images.length).toBe(4);
		expect(s.m).toBe(2);
		expect(s.groups.length).toBe(1);
		expect(s.batches.length).toBe(2);
		expect(s.pendingCount).toBe(2);
		expect(s.status).toBe('selecting');
	});

	test('自动批次：LLM 裁决写入 checkpoint 缓存', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		const dto = await s.autoBatch(0);
		expect(dto.status).toBe('decided');
		expect(dto.source).toBe('llm');
		expect(dto.keptUrl).toBe(dto.images[0]!.url);
		expect(dto.loserUrls).toEqual([dto.images[1]!.url]);

		// 缓存落盘且复用
		const file = join(env.dir, 'checkpoint.json');
		expect(existsSync(file)).toBe(true);
		const data = loadCheckpoint(file)!;
		expect(data.verdicts.length).toBe(1);
		expect(data.verdicts[0]!.phase).toBe('batch');

		// 新会话命中缓存（先放弃当前会话）
		manager.remove(s.id);
		const s2 = await manager.create({ mArg: '2', targetDir: 'x' });
		expect(s2.batches[0]!.status).toBe('decided');
		expect(s2.batches[0]!.source).toBe('cache');
	});

	test('手动批次：覆盖 LLM 缓存裁决（recordOverride）', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		await s.autoBatch(0); // LLM 选 images[0]
		const dto = await s.manualBatch(0, s.batches[0]!.batch.images[1]!.url);
		expect(dto.source).toBe('manual');
		expect(dto.reason).toBe('手动选择');

		// 缓存中的人工裁决优先
		const data = loadCheckpoint(join(env.dir, 'checkpoint.json'))!;
		const verdict = data.verdicts.find((v) => v.urls.length === 2)!;
		expect(verdict.keptUrl).toBe(s.batches[0]!.batch.images[1]!.url);

		// 手动选择非法 url → 400
		expect(() => s.manualBatch(1, 'file:///nonexistent')).toThrow(HttpError);
	});

	test('suggest：不写缓存、不改变批次状态', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		const sug = await s.suggest(0);
		expect(sug.cached).toBe(false);
		expect(s.batches[0]!.status).toBe('pending');
		const data = loadCheckpoint(join(env.dir, 'checkpoint.json'));
		// 建议不落盘：checkpoint 文件不存在，或存在但无裁决
		expect(data === null || data.verdicts.length === 0).toBe(true);
	});

	test('runRemaining 自动完成全部待决批次', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		await s.runRemaining();
		expect(s.pendingCount).toBe(0);
		expect(s.losers.length).toBe(2);
	});

	test('重算：落选者 ≤ m 直接全部移走', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		await s.runRemaining();
		await s.recomputeSelection();
		expect(s.status).toBe('finalized');
		expect(s.tournamentUsed).toBe(false);
		expect(s.toRemove.length).toBe(2);
		// 移除清单 = 各批落选者
		const loserUrls = new Set(s.batches.flatMap((b) => b.result!.losers.map((l) => l.url)));
		expect(s.toRemove.every((i) => loserUrls.has(i.url))).toBe(true);
	});

	test('重算：落选者 > m 触发锦标赛淘汰', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '1', targetDir: 'x' });
		await s.runRemaining();
		await s.recomputeSelection();
		expect(s.tournamentUsed).toBe(true);
		expect(s.tournamentRounds.length).toBeGreaterThanOrEqual(1);
		expect(s.toRemove.length).toBe(1);
	});

	test('未决批次时重算抛 409', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		await expect(s.recomputeSelection()).rejects.toMatchObject({ status: 409 });
	});

	test('移动（dry-run 与真实移动，更新数据库 url）', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '1', targetDir: join(env.dir, 'trash'), dryRun: true });
		await s.runRemaining();
		await s.recomputeSelection();
		let results = await s.move();
		expect(results.every((r) => r.status === 'dry-run')).toBe(true);
		expect(existsSync(env.images[0]!.path)).toBe(true);

		// 真实移动
		const s2 = await manager.create({ mArg: '1', targetDir: join(env.dir, 'trash2'), dryRun: false });
		await s2.runRemaining();
		await s2.recomputeSelection();
		results = await s2.move();
		expect(results.every((r) => r.status === 'moved')).toBe(true);
		const moved = s2.toRemove[0]!;
		const localPath = moved.url.replace(/^file:\/\/\//, '');
		expect(existsSync(localPath)).toBe(false);
		// 数据库 url 已更新
		const db = (await import('img-cleanup/api')).getDb();
		const rows = db.prepare('SELECT url FROM valuation').all() as { url: string }[];
		expect(rows.some((r) => r.url !== moved.url && r.url.includes('trash2'))).toBe(true);
		expect(s2.status).toBe('moved');
	});

	test('同一时刻仅允许一个活跃会话', async () => {
		const manager = makeManager(env);
		await manager.create({ mArg: '2', targetDir: 'x' });
		await expect(manager.create({ mArg: '2', targetDir: 'x' })).rejects.toMatchObject({ status: 409 });
	});

	test('batchSize < 2 拒绝', async () => {
		const manager = makeManager(env);
		await expect(manager.create({ mArg: '2', targetDir: 'x', batchSize: 1 })).rejects.toMatchObject({
			status: 400,
		});
	});

	test('会话放弃后可新建（裁决缓存保留）', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		await s.autoBatch(0);
		manager.remove(s.id);
		const s2 = await manager.create({ mArg: '2', targetDir: 'x' });
		expect(s2.batches[0]!.source).toBe('cache');
		expect(s2.pendingCount).toBe(1);
	});

	test('预览后调整裁决 → 自动重赛更新移除清单', async () => {
		const { provider, calls } = createFakeProvider();
		const manager = new SessionManager({
			config,
			provider,
			checkpointPath: join(env.dir, 'cp.json'),
			checkpointEnabled: true,
		});
		const s = await manager.create({ mArg: '1', targetDir: 'x' });
		await s.runRemaining();
		await s.recomputeSelection();
		const firstRemove = s.toRemove[0]!.url;
		expect(s.tournamentUsed).toBe(true);

		// 调整 batch1：改选原本被 LLM 淘汰的 img3 → batch1 落选者变为 img2
		const b1 = s.batches[1]!;
		const loser1 = b1.result!.losers[0]!; // img3
		const kept1 = b1.result!.kept; // img2
		await s.manualBatch(1, loser1.url);
		await s.recomputeSelection(); // 路由层在 finalized 状态下以后台方式触发，这里同步等待

		// 新落选者 [img1, img2] → 配对 img1 vs img2 → img1 被救回，img2 进入移除清单
		expect(s.status).toBe('finalized');
		expect(s.toRemove.length).toBe(1);
		expect(s.toRemove[0]!.url).toBe(kept1.url);
		expect(s.toRemove[0]!.url).not.toBe(firstRemove);
		expect(s.error).toBeUndefined();
		// LLM 调用：2 批次 + 1 旧锦标赛 + 1 新配对 = 4（批次改选本身不调 LLM）
		expect(calls.length).toBe(4);
	});

	test('重赛复用缓存：改回原裁决不再调用 LLM', async () => {
		const { provider, calls } = createFakeProvider();
		const manager = new SessionManager({
			config,
			provider,
			checkpointPath: join(env.dir, 'cp.json'),
			checkpointEnabled: true,
		});
		const s = await manager.create({ mArg: '1', targetDir: 'x' });
		await s.runRemaining();
		await s.recomputeSelection();
		const firstRemove = s.toRemove[0]!.url;
		const b1 = s.batches[1]!;
		const loser1 = b1.result!.losers[0]!;
		const kept1 = b1.result!.kept;
		// 改走再改回
		await s.manualBatch(1, loser1.url);
		await s.recomputeSelection();
		expect(calls.length).toBe(4);
		await s.manualBatch(1, kept1.url);
		await s.recomputeSelection();
		// 落选者组合回到最初 → 锦标赛配对命中缓存 → 无新 LLM 调用
		expect(calls.length).toBe(4);
		expect(s.toRemove[0]!.url).toBe(firstRemove);
		expect(s.error).toBeUndefined();
	});

	test('移动后禁止调整历史裁决与重赛', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: join(env.dir, 'trash3'), dryRun: true });
		await s.runRemaining();
		await s.recomputeSelection();
		await s.move();
		expect(() => s.manualBatch(0, s.batches[0]!.batch.images[0]!.url)).toThrow(HttpError);
		await expect(s.recomputeSelection()).rejects.toMatchObject({ status: 409 });
	});

	test('重算幂等，可重复调用', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: 'x' });
		await s.runRemaining();
		await s.recomputeSelection();
		const first = s.toRemove.map((i) => i.url);
		await s.recomputeSelection();
		expect(s.toRemove.map((i) => i.url)).toEqual(first);
		expect(s.status).toBe('finalized');
	});

	test('移动进行中禁止调整/重赛/再次移动', async () => {
		const manager = makeManager(env);
		const s = await manager.create({ mArg: '2', targetDir: join(env.dir, 'trash4'), dryRun: true });
		await s.runRemaining();
		await s.recomputeSelection();
		// move() 在首个 await 前同步置位 moving —— 调用后立即断言互斥
		const p = s.move();
		expect(s.moving).toBe(true);
		expect(() => s.manualBatch(0, s.batches[0]!.batch.images[0]!.url)).toThrow(HttpError);
		await expect(s.recomputeSelection()).rejects.toMatchObject({ status: 409 });
		await expect(s.move()).rejects.toMatchObject({ status: 409 });
		await p;
		expect(s.moving).toBe(false);
		expect(s.status).toBe('moved');
	});

	test('Checkpoint.recordOverride 只影响同 key 裁决', () => {		const cp = Checkpoint.create(join(env.dir, 'cp2.json'), {
			version: 1,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cacheKey: 'k',
			params: {
				m: 1,
				mArg: '1',
				totalImages: 2,
				batchSize: 2,
				bucketBoundaries: [0],
				pathGlobs: [],
				standardName: null,
				targetDir: 'x',
				dryRun: true,
				imageSetHash: 'h',
			},
		});
		cp.record({ urls: ['a', 'b'], keptUrl: 'a', loserUrls: ['b'], reason: 'llm', phase: 'batch' });
		cp.recordOverride({ urls: ['a', 'b'], keptUrl: 'b', loserUrls: ['a'], reason: '手动', phase: 'batch' });
		expect(cp.data.verdicts.length).toBe(1);
		expect(cp.lookup(['a', 'b'])!.keptUrl).toBe('b');
		expect(readFileSync(join(env.dir, 'cp2.json'), 'utf-8')).toContain('手动');
	});
});
