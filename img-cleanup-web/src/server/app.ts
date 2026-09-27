import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { getDb } from 'img-cleanup/api';
import type { ConfigDTO, CreateSessionBody, ManualDecisionBody, PickFolderDTO, TournamentDecisionBody } from '../shared/api-types.ts';
import { makeThumbnail, mimeOf, openOriginal } from './images.ts';
import { pickFolder } from './dialog.ts';
import { HttpError } from './errors.ts';
import { type CleanupSession, SessionManager } from './session.ts';

/** 依赖注入入口，便于测试。 */
export interface AppDeps {
	manager: SessionManager;
	/** 静态资源目录（生产模式托管前端构建产物）；不设则仅提供 API。 */
	webDist?: string;
}

export function createApp({ manager, webDist }: AppDeps): Hono {
	const app = new Hono();

	// 统一错误 → JSON
	app.onError((err, c) => {
		const status = err instanceof HttpError ? err.status : 500;
		if (status === 500) console.error('[img-cleanup-web]', err);
		return c.json({ error: err.message }, status as 400 | 404 | 409 | 500 | 502);
	});

	app.get('/api/config', (c) => {
		const cfg = manager.config;
		const dto: ConfigDTO = {
			batchSize: cfg.batchSize,
			maxImageDimension: cfg.maxImageDimension,
			bucketBoundaries: [...cfg.bucketBoundaries],
			checkpointEnabled: manager.checkpointEnabled,
			llmAvailable: manager.llmAvailable,
			standards: [],
			totalImages: 0,
		};
		try {
			const db = getDb();
			const standards = db
				.prepare('SELECT standard_name AS name, COUNT(DISTINCT url) AS count FROM valuation GROUP BY standard_name ORDER BY name')
				.all() as { name: string; count: number }[];
			const row = db.prepare('SELECT COUNT(DISTINCT url) AS count FROM valuation').get() as
				| { count: number }
				| undefined;
			dto.standards = standards;
			dto.totalImages = row?.count ?? 0;
		} catch (e) {
			// 数据库尚未创建（img-val 未运行）——返回空统计，前端提示
			console.error('[img-cleanup-web] 读取数据库统计失败:', e instanceof Error ? e.message : e);
		}
		return c.json(dto);
	});

	app.get('/api/session', (c) => {
		const active = manager.active;
		if (!active) return c.json({ error: '没有进行中的会话' }, 404);
		return c.json(active.toDTO());
	});

	app.post('/api/sessions', async (c) => {
		const body = (await c.req.json<CreateSessionBody>().catch(() => null)) as CreateSessionBody | null;
		if (!body?.mArg || !body?.targetDir) {
			throw new HttpError(400, '缺少必填参数 mArg / targetDir');
		}
		const session = await manager.create(body);
		return c.json(session.toDTO(), 201);
	});

	app.get('/api/sessions/:id', (c) => {
		const s = manager.get(c.req.param('id'));
		return c.json(s.toDTO());
	});

	/**
	 * SSE 状态推送：连接即推当前状态，之后每次会话变更推送一次；
	 * 15s 心跳保活（防代理超时断连）。REST 仍是唯一写路径。
	 */
	app.get('/api/sessions/:id/events', (c) => {
		const s = manager.get(c.req.param('id'));
		return streamSSE(c, async (stream) => {
			let open = true;
			let abortResolve: (() => void) | undefined;
			let unsubscribe: () => void = () => {};
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			const close = () => {
				if (!open) return;
				open = false;
				unsubscribe();
				if (heartbeat !== undefined) clearInterval(heartbeat);
				abortResolve?.();
			};
			const push = async () => {
				if (!open) return;
				try {
					await stream.writeSSE({ event: 'session', data: JSON.stringify(s.toDTO()) });
				} catch {
					close();
				}
			};
			unsubscribe = s.onUpdate(() => {
				if (open) void push();
			});
			heartbeat = setInterval(() => {
				if (!open) return;
				stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => close());
			}, 15000);
			stream.onAbort(close);
			await push();
			await new Promise<void>((resolve) => {
				if (stream.aborted) {
					close();
					resolve();
				} else {
					abortResolve = resolve;
				}
			});
		});
	});

	app.delete('/api/sessions/:id', (c) => {
		manager.get(c.req.param('id')); // 404 if unknown
		manager.remove(c.req.param('id'));
		return c.json({ ok: true });
	});

	/** LLM 自动选择（缓存命中即返回缓存裁决）。 */
	app.post('/api/sessions/:id/batches/:idx/auto', async (c) => {
		const s = requireSelectingSession(manager, c.req.param('id'));
		const dto = await s.autoBatch(batchIndex(c));
		return c.json(dto);
	});

	/** 人工选择/改选保留者。已进入预览阶段时自动触发后台重赛。 */
	app.post('/api/sessions/:id/batches/:idx/manual', async (c) => {
		const s = manager.get(c.req.param('id'));
		const body = (await c.req.json<ManualDecisionBody>().catch(() => null)) as ManualDecisionBody | null;
		if (!body?.keptUrl) throw new HttpError(400, '缺少 keptUrl');
		const dto = s.manualBatch(batchIndex(c), body.keptUrl, body.reason);
		if (s.status === 'finalized') s.startRecomputeInBackground();
		return c.json(dto);
	});

	/** LLM 建议（不写缓存，手动挑选界面用）。 */
	app.post('/api/sessions/:id/batches/:idx/suggest', async (c) => {
		const s = requireSelectingSession(manager, c.req.param('id'));
		return c.json(await s.suggest(batchIndex(c)));
	});

	/** 自动跑完剩余批次（长任务：立即返回，进度由 SSE 推送）。 */
	app.post('/api/sessions/:id/run-remaining', (c) => {
		const s = requireSelectingSession(manager, c.req.param('id'));
		if (!manager.llmAvailable) throw new HttpError(409, 'LLM 未配置，自动完成剩余批次不可用，请手动挑选');
		void s.runRemaining().catch(() => undefined);
		return c.json({ ok: true, running: true });
	});

	/** 选择阶段收束 / 重算（幂等，调整裁决后可重复调用触发重赛）。 */
	app.post('/api/sessions/:id/finalize', async (c) => {
		const s = manager.get(c.req.param('id'));
		await s.recomputeSelection();
		return c.json(s.toDTO());
	});

	/** 手动裁决一对加赛（LLM 未配置的锦标赛）。 */
	app.post('/api/sessions/:id/tournament', async (c) => {
		const s = manager.get(c.req.param('id'));
		const body = (await c.req.json<TournamentDecisionBody>().catch(() => null)) as TournamentDecisionBody | null;
		if (!Number.isInteger(body?.pairIndex) || !body?.keptUrl) {
			throw new HttpError(400, '缺少 pairIndex / keptUrl');
		}
		return c.json(s.decidePair(body.pairIndex, body.keptUrl));
	});

	/** 移动待移除图片。 */
	app.post('/api/sessions/:id/move', async (c) => {
		const s = manager.get(c.req.param('id'));
		await s.move();
		return c.json(s.toDTO());
	});

	/**
	 * 缩略图（raw=1 时返回原图流）。u 必须属于某个活跃会话的图片集合（防任意文件读取）。
	 */
	app.get('/api/image', async (c) => {
		const url = c.req.query('u');
		if (!url) throw new HttpError(400, '缺少参数 u');
		if (!isKnownUrl(manager, url)) throw new HttpError(403, '图片不在当前会话的图片集合中');
		if (c.req.query('raw')) {
			return c.body(openOriginal(url), 200, {
				'content-type': mimeOf(url),
				'cache-control': 'private, max-age=604800',
			});
		}
		const buf = await makeThumbnail(url, Number(c.req.query('w') ?? 512));
		return c.body(new Uint8Array(buf), 200, {
			'content-type': 'image/webp',
			'cache-control': 'private, max-age=604800',
		});
	});

	/** 调出系统「选择文件夹」对话框（后端本机执行，模态阻塞至用户选择/取消）。 */
	app.post('/api/pick-folder', async (c) => {
		const path = await pickFolder();
		const dto: PickFolderDTO = { path };
		return c.json(dto);
	});

	if (webDist) {
		// 生产模式：托管前端构建产物（/api 之外的路径回落到静态文件）
		app.use('*', async (c, next) => {
			if (c.req.path.startsWith('/api/')) return next();
			return serveStatic({ root: webDist })(c, next);
		});
	}

	return app;
}

function requireSelectingSession(manager: SessionManager, id: string): CleanupSession {
	const s = manager.get(id);
	if (s.status !== 'selecting') {
		throw new HttpError(409, `会话已结束选择阶段（${s.status}）`);
	}
	return s;
}

function batchIndex(c: { req: { param(name: string): string } }): number {
	const idx = Number(c.req.param('idx'));
	if (!Number.isInteger(idx) || idx < 0) throw new HttpError(400, `无效的批次序号: ${c.req.param('idx')}`);
	return idx;
}

function isKnownUrl(manager: SessionManager, url: string): boolean {
	for (const s of manager.all()) {
		if (s.urlSet.has(url)) return true;
		// finalize 后 toRemove 中的 url 仍在 urlSet（子集），无需单独检查
	}
	return false;
}
