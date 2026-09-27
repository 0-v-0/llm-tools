import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppConfig } from 'img-cleanup/api';
import { fakeProvider, setupEnv, type TestEnv } from './helpers.ts';
import { createApp } from '../src/server/app.ts';
import { SessionManager } from '../src/server/session.ts';

const config = {
	llm: {},
	batchSize: 2,
	maxImageDimension: 256,
	bucketBoundaries: [0, 1000],
	storeRaw: false,
	maxToolRounds: 4,
	checkpointEnabled: true,
} as unknown as AppConfig;

describe('HTTP API', () => {
	let env: TestEnv;
	let app: ReturnType<typeof createApp>;

	beforeEach(async () => {
		env = await setupEnv(4);
		const manager = new SessionManager({
			config,
			provider: fakeProvider,
			checkpointPath: join(env.dir, 'checkpoint.json'),
			checkpointEnabled: true,
		});
		app = createApp({ manager });
	});
	afterEach(() => {
		env.cleanup();
	});

	test('GET /api/config 返回统计与标准列表', async () => {
		const res = await app.request('/api/config');
		expect(res.status).toBe(200);
		const dto = await res.json();
		expect(dto.totalImages).toBe(4);
		expect(dto.standards).toEqual([{ name: 'default-photo', count: 4 }]);
		expect(dto.checkpointEnabled).toBe(true);
	});

	test('POST /api/sessions 缺参数 → 400', async () => {
		const res = await app.request('/api/sessions', { method: 'POST', body: '{}' });
		expect(res.status).toBe(400);
	});

	test('批次 auto / manual / suggest / run-remaining 全流程', async () => {
		const created = await app.request('/api/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mArg: '2', targetDir: join(env.dir, 'trash'), dryRun: true }),
		});
		expect(created.status).toBe(201);
		const session = await created.json();
		expect(session.batches.length).toBe(2);

		// suggest 不改变状态
		const sug = await app.request(`/api/sessions/${session.id}/batches/0/suggest`, { method: 'POST' });
		expect(sug.status).toBe(200);
		const sugBody = await sug.json();
		expect(sugBody.keptUrl).toContain('img-');

		// manual
		const batch0 = session.batches[0];
		const manual = await app.request(`/api/sessions/${session.id}/batches/0/manual`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ keptUrl: batch0.images[1].url }),
		});
		expect(manual.status).toBe(200);
		const manualDto = await manual.json();
		expect(manualDto.source).toBe('manual');

		// run-remaining
		const run = await app.request(`/api/sessions/${session.id}/run-remaining`, { method: 'POST' });
		expect(run.status).toBe(200);
		// 服务端异步执行 —— 轮询至完成
		for (let i = 0; i < 50; i++) {
			const s = await (await app.request(`/api/sessions/${session.id}`)).json();
			if (s.batches.every((b: { status: string }) => b.status === 'decided')) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const after = await (await app.request(`/api/sessions/${session.id}`)).json();
		expect(after.batches.every((b: { status: string }) => b.status === 'decided')).toBe(true);

		// finalize
		const fin = await app.request(`/api/sessions/${session.id}/finalize`, { method: 'POST' });
		expect(fin.status).toBe(200);
		const finBody = await fin.json();
		expect(finBody.status).toBe('finalized');
		expect(finBody.toRemoveImages.length).toBe(2);

		// move（dry-run）
		const mv = await app.request(`/api/sessions/${session.id}/move`, { method: 'POST' });
		expect(mv.status).toBe(200);
		const mvBody = await mv.json();
		expect(mvBody.status).toBe('moved');
		expect(mvBody.moveResults.every((r: { status: string }) => r.status === 'dry-run')).toBe(true);
	});

	test('预览后调整裁决自动重赛（HTTP）', async () => {
		const body = (target: string) => ({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(target ? { mArg: '1', targetDir: target } : {}),
		});
		const created = await app.request('/api/sessions', {
			...body(''),
			body: JSON.stringify({ mArg: '1', targetDir: join(env.dir, 'trash'), dryRun: true }),
		});
		const session = await created.json();

		await app.request(`/api/sessions/${session.id}/run-remaining`, { method: 'POST' });
		await waitDecided(session.id);
		const fin = await (await app.request(`/api/sessions/${session.id}/finalize`, { method: 'POST' })).json();
		expect(fin.status).toBe('finalized');
		const firstRemove = fin.toRemoveImages[0].url as string;

		// 调整 batch1 为 LLM 淘汰的那张 → 触发后台重赛
		const batch1 = session.batches[1];
		const manual = await app.request(`/api/sessions/${session.id}/batches/1/manual`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ keptUrl: batch1.images[1].url }),
		});
		expect(manual.status).toBe(200);

		// 轮询至重赛完成
		let after: Record<string, unknown>;
		for (let i = 0; i < 50; i++) {
			after = await (await app.request(`/api/sessions/${session.id}`)).json();
			if (!after.running) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(after!.running).toBe(false);
		expect(after!.status).toBe('finalized');
		expect(after!.error).toBeUndefined();
		const removed = (after!.toRemoveImages as { url: string }[]).map((i) => i.url);
		// 新落选者 [img1, img2] → 配对中 img1 被救回 → toRemove = [img2]（batch1 原保留者）
		expect(removed).toEqual([batch1.images[0].url]);
		expect(removed[0]).not.toBe(firstRemove);
	});

	async function waitDecided(id: string): Promise<void> {
		for (let i = 0; i < 50; i++) {
			const s = await (await app.request(`/api/sessions/${id}`)).json();
			if (s.batches.every((b: { status: string }) => b.status === 'decided')) return;
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	test('SSE：连接即推当前状态，变更时推送', async () => {
		const created = await app.request('/api/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mArg: '2', targetDir: 'x' }),
		});
		const session = await created.json();

		const res = await app.request(`/api/sessions/${session.id}/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		const reader = (res.body as ReadableStream).getReader();
		const decoder = new TextDecoder();
		let buf = '';
		const readEvent = async (): Promise<{ event: string; data: string }> => {
			while (!buf.includes('\n\n')) {
				const { value, done } = await reader.read();
				if (done) throw new Error('stream ended unexpectedly');
				buf += decoder.decode(value, { stream: true });
			}
			const i = buf.indexOf('\n\n');
			const raw = buf.slice(0, i);
			buf = buf.slice(i + 2);
			const ev = { event: '', data: '' };
			for (const line of raw.split('\n')) {
				if (line.startsWith('event:')) ev.event = line.slice(6).trim();
				if (line.startsWith('data:')) ev.data += line.slice(5).trim();
			}
			return ev;
		};

		// 连接即推当前状态（此时已订阅，后续变更不会漏）
		const first = await readEvent();
		expect(first.event).toBe('session');
		expect(JSON.parse(first.data).batches).toHaveLength(2);

		// 触发一次人工裁决 → 收到推送
		await app.request(`/api/sessions/${session.id}/batches/0/manual`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ keptUrl: session.batches[0].images[0].url }),
		});
		const second = await readEvent();
		expect(second.event).toBe('session');
		const dto = JSON.parse(second.data);
		expect(dto.batches[0].source).toBe('manual');
		expect(dto.status).toBe('selecting');

		await reader.cancel();
	});

	test('GET /api/image 白名单校验：未知 url → 403', async () => {
		const res = await app.request('/api/image?u=file:///C:/Windows/system.ini');
		expect(res.status).toBe(403);
	});

	test('GET /api/image 会话内图片 → webp 缩略图', async () => {
		const created = await app.request('/api/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mArg: '2', targetDir: 'x' }),
		});
		const session = await created.json();
		const url = session.batches[0].images[0].url as string;
		const res = await app.request(`/api/image?u=${encodeURIComponent(url)}&w=64`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/webp');
		const buf = await res.arrayBuffer();
		expect(buf.byteLength).toBeGreaterThan(0);
	});

	test('GET /api/image raw=1 → 原图原样返回', async () => {
		const created = await app.request('/api/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mArg: '2', targetDir: 'x' }),
		});
		const session = await created.json();
		const url = session.batches[0].images[0].url as string;
		const res = await app.request(`/api/image?u=${encodeURIComponent(url)}&raw=1`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		const buf = Buffer.from(await res.arrayBuffer());
		const seed = env.images.find((i) => i.url === url)!;
		expect(buf.equals(await readFile(seed.path))).toBe(true);
	});

	test('DELETE 会话后 GET /api/session → 404', async () => {
		const created = await app.request('/api/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mArg: '2', targetDir: 'x' }),
		});
		const session = await created.json();
		await app.request(`/api/sessions/${session.id}`, { method: 'DELETE' });
		const res = await app.request('/api/session');
		expect(res.status).toBe(404);
	});

	test('重复创建会话 → 409', async () => {
		const body = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mArg: '2', targetDir: 'x' }),
		};
		expect((await app.request('/api/sessions', body)).status).toBe(201);
		expect((await app.request('/api/sessions', body)).status).toBe(409);
	});

	test('批次大小超上限 → 400', async () => {
		const res = await app.request('/api/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mArg: '2', targetDir: 'x', batchSize: 101 }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain('100');
	});
});

describe('手动模式（provider: null）', () => {
	let env: TestEnv;
	let app: ReturnType<typeof createApp>;

	function makeManager(): SessionManager {
		return new SessionManager({
			config,
			provider: null,
			checkpointPath: join(env.dir, 'checkpoint.json'),
			checkpointEnabled: true,
		});
	}

	beforeEach(async () => {
		env = await setupEnv(4);
		app = createApp({ manager: makeManager() });
	});
	afterEach(() => {
		env.cleanup();
	});

	async function createSession(mArg: string): Promise<Record<string, any>> {
		const created = await app.request('/api/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mArg, targetDir: join(env.dir, 'trash'), dryRun: true }),
		});
		expect(created.status).toBe(201);
		return created.json();
	}

	test('GET /api/config → llmAvailable false', async () => {
		const dto = await (await app.request('/api/config')).json();
		expect(dto.llmAvailable).toBe(false);
	});

	test('auto / suggest / run-remaining → 409；manual 与 finalize（落选 ≤ m）可用', async () => {
		const session = await createSession('2');
		const post = (p: string) => app.request(`/api/sessions/${session.id}${p}`, { method: 'POST' });
		expect((await post('/batches/0/auto')).status).toBe(409);
		expect((await post('/batches/0/suggest')).status).toBe(409);
		expect((await post('/run-remaining')).status).toBe(409);

		for (const [i, b] of session.batches.entries()) {
			const manual = await app.request(`/api/sessions/${session.id}/batches/${i}/manual`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ keptUrl: b.images[0].url }),
			});
			expect(manual.status).toBe(200);
			expect((await manual.json()).source).toBe('manual');
		}

		// 落选 2 张 ≤ m=2 → 无需锦标赛即可完成选择
		const fin = await (await post('/finalize')).json();
		expect(fin.status).toBe('finalized');
		expect(fin.tournamentUsed).toBe(false);
		expect(fin.toRemoveImages).toHaveLength(2);
	});

	test('落选 > m 时 finalize → 409（锦标赛需要 LLM）', async () => {
		const session = await createSession('1');
		for (const [i, b] of session.batches.entries()) {
			await app.request(`/api/sessions/${session.id}/batches/${i}/manual`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ keptUrl: b.images[0].url }),
			});
		}
		const fin = await app.request(`/api/sessions/${session.id}/finalize`, { method: 'POST' });
		expect(fin.status).toBe(409);
		const body = await fin.json();
		expect(body.error).toContain('锦标赛');
		expect(body.error).toContain('LLM');
		// 校验在任何状态变更前发生：会话未被标记错误、仍处于选择阶段
		const after = await (await app.request(`/api/sessions/${session.id}`)).json();
		expect(after.error).toBeUndefined();
		expect(after.status).toBe('selecting');
		expect(after.running).toBe(false);
	});
});
