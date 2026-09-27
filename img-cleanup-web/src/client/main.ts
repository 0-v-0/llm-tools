import 'uno.css'
import '@cydon/ui/src/c-message.css'
import { error, success } from '@cydon/ui/Message'
import { CydonElement } from 'cydon'
import type {
	BatchDTO,
	ConfigDTO,
	ImageDTO,
	MoveResultDTO,
	SessionDTO,
	TournamentStateDTO,
} from '../shared/api-types.ts'

type View = 'setup' | 'review' | 'playoff' | 'finalize' | 'move'

async function json<T>(r: Response): Promise<T> {
	const d = await r.json().catch(() => null)
	if (!r.ok) throw new Error(d?.error ?? r.statusText)
	return d as T
}

const post = <T>(url: string, body?: unknown): Promise<T> =>
	fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	}).then((r) => json<T>(r))

const basename = (url: string): string => url.replaceAll('\\', '/').split('/').pop() ?? url

/** 配置表单的记忆键与字段（会话放弃/中断后恢复上次输入）。 */
const FORM_KEY = 'img-cleanup-web/form'
const FORM_FIELDS = ['mArg', 'targetDir', 'formBatchSize', 'pathGlobs', 'standard', 'dryRun', 'onCollision'] as const

const SOURCE_LABEL: Record<string, string> = {
	llm: 'LLM 选择',
	cache: '历史缓存',
	manual: '手动选择',
	'auto-keep': '单张自动保留',
}

const STATUS_LABEL: Record<string, string> = {
	selecting: '选择中',
	tournament: '加赛中',
	finalized: '待确认移动',
	moved: '已完成',
}

/**
 * 根组件：所有渲染状态都是显式赋值的扁平属性（Cydon 依赖追踪按属性名记录，
 * getter / 嵌套对象原地修改不会触发更新），状态变更统一走 `up()`。
 *
 * 注意：c-for 克隆节点的事件处理器以循环上下文为 `this`，在其上读写组件
 * 属性会落到 ctx 层而非元素本身——因此所有方法一律通过模块级单例 `app`
 * 访问状态，不依赖调用方的 `this`。
 */
class IcwApp extends CydonElement {
	// ---- 配置（GET /api/config）----
	standards: { name: string; count: number }[] = []
	totalImages = 0
	defaultBatchSize = 2
	/** false = LLM 未配置（手动模式）：隐藏自动选择/自动完成入口。 */
	llmAvailable = true

	// ---- 表单 ----
	mArg = ''
	targetDir = ''
	formBatchSize: number | string = 2
	pathGlobs = ''
	standard = ''
	dryRun = false
	onCollision = 'skip'

	// ---- 会话状态 ----
	session: SessionDTO | null = null
	/** 手动加赛状态（session.status=='tournament' 时非空），模板直接引用。 */
	tournament: TournamentStateDTO | null = null
	sessionError = ''
	view: View = 'setup'
	currentIndex = 0
	currentBatch: BatchDTO | null = null
	currentImages: ImageDTO[] = []
	currentGroupLabel = ''
	decidedCount = 0
	pendingCount = 0
	losersCount = 0
	toRemoveImages: ImageDTO[] = []
	moveResults: MoveResultDTO[] = []
	tournamentLines: string[] = []

	// ---- 手动挑选 ----
	manualMode = false
	pickUrl = ''
	suggestion: { keptUrl: string; reason: string; cached: boolean } | null = null

	// ---- 手动加赛（LLM 未配置的锦标赛） ----
	/** 扁平化的待裁决对局图片（含所属对局 index，避免模板嵌套 c-for）。 */
	pairCards: Array<{ pairIndex: number; url: string; img: ImageDTO }> = []
	pairPickIndex = -1
	pairPickUrl = ''

	// ---- 原图查看 ----
	viewerUrl = ''
	viewerName = ''

	// ---- 悬停大图预览 ----
	previewUrl = ''
	previewName = ''

	busy = false
	running = false
	moving = false

	// ---- SSE 状态推送 ----
	es: EventSource | null = null
	prevRunning = false

	/** 响应式状态变更：统一经过 data 代理，触发依赖该属性的绑定更新。 */
	private up(patch: Record<string, unknown>): void {
		Object.assign(app!.data, patch)
	}

	// ---------- SSE 状态推送 ----------

	/** 按会话状态连接/断开 EventSource；REST 是唯一写路径，SSE 只做状态通知。 */
	private syncEventStream() {
		const s = app!.session
		const active = !!s && s.status != 'moved'
		if (active && !app!.es) {
			const es = new EventSource(`/api/sessions/${s.id}/events`)
			app!.es = es
			es.addEventListener('session', (e) => {
				if (app!.es !== es) return
				this.applySession(JSON.parse((e as MessageEvent).data) as SessionDTO)
			})
			es.onerror = () => {
				// 浏览器自动重连；会话已删除（404 → CLOSED）时停止
				if (es.readyState == EventSource.CLOSED) this.disconnectEvents()
			}
		} else if (!active && app!.es) {
			this.disconnectEvents()
		}
	}

	private disconnectEvents() {
		app!.es?.close()
		app!.es = null
	}

	async connectedCallback() {
		app = this
		await this.init()
		super.connectedCallback()
	}

	private async init() {
		// Esc 关闭原图查看
		window.addEventListener('keydown', (e) => {
			if (e.key == 'Escape' && app!.viewerUrl) this.closeViewer()
		})
		try {
			const cfg = await json<ConfigDTO>(await fetch('/api/config'))
			this.up({
				standards: cfg.standards,
				totalImages: cfg.totalImages,
				defaultBatchSize: cfg.batchSize,
				formBatchSize: cfg.batchSize,
				llmAvailable: cfg.llmAvailable,
			})
			this.renderStandardOptions()
		} catch {
			error('无法连接服务，请确认 img-cleanup-web server 已启动')
		}
		// 页面刷新后恢复进行中的会话
		try {
			this.applySession(await json<SessionDTO>(await fetch('/api/session')))
		} catch {
			// 没有活跃会话，停留在 setup，恢复上次输入
			this.restoreForm()
		}
	}

	// ---------- 会话状态 ----------

	/** 应用会话快照并重建全部派生状态。 */
	private applySession(s: SessionDTO, jumpToPending = false) {
		const decided = s.batches.filter((b) => b.status == 'decided')
		const wasRunning = app!.prevRunning
		app!.prevRunning = s.running
		this.up({
			session: s,
			tournament: s.tournament,
			sessionError: s.error ?? '',
			running: s.running || s.moving,
			moving: s.moving,
			decidedCount: decided.length,
			pendingCount: s.batches.length - decided.length,
			losersCount: s.batches.reduce((n, b) => n + (b.loserUrls?.length ?? 0), 0),
			toRemoveImages: s.toRemoveImages,
			moveResults: s.moveResults,
			tournamentLines: s.tournamentRounds.flatMap((r) => [
				`第 ${r.round} 轮`,
				...r.pairs.map((p) => `　保留 ${basename(p.kept)}，淘汰 ${basename(p.eliminated)} — ${p.reason}`),
				...(r.byes.length ? [`　轮空：${r.byes.map(basename).join('、')}`] : []),
			]),
			pairCards: (s.tournament?.pending ?? []).flatMap((p) => [
				{ pairIndex: p.index, url: p.a.url, img: p.a },
				{ pairIndex: p.index, url: p.b.url, img: p.b },
			]),
			view:
				s.status == 'selecting'
					? 'review'
					: s.status == 'tournament'
						? 'playoff'
						: s.status == 'finalized'
							? 'finalize'
							: 'move',
			...(s.status != 'selecting' ? { manualMode: false, pickUrl: '', suggestion: null } : {}),
			...(s.status != 'tournament' ? { pairPickIndex: -1, pairPickUrl: '' } : {}),
		})
		const valid = s.batches[this.currentIndex]
		if (jumpToPending || !valid) {
			const first = s.batches.findIndex((b) => b.status == 'pending')
			this.up({ currentIndex: first >= 0 ? first : 0 })
		}
		this.syncCurrent()
		this.syncEventStream()
		// 后台任务结束提示（用户主动触发的 finalize/move 有各自的响应路径）
		if (wasRunning && !s.running) {
			if (s.status == 'selecting' && this.pendingCount == 0) success('所有批次已完成')
			else if (s.status == 'finalized' && !s.error) success('重赛完成，移除清单已更新')
		}
	}

	private syncCurrent() {
		const s = app!.session
		const b = s?.batches[app!.currentIndex] ?? null
		this.resetOverlays()
		this.up({
			currentBatch: b,
			currentImages: b?.images ?? [],
			currentGroupLabel: b?.images[0]?.standardName ?? '',
			manualMode: false,
			pickUrl: '',
			suggestion: null,
		})
		// LLM 不可用时待决批次自动进入手动挑选模式
		if (b && b.status == 'pending' && !app!.llmAvailable) this.enterManual()
	}

	private async reload() {
		if (!app!.session) return
		try {
			this.applySession(await json<SessionDTO>(await fetch(`/api/sessions/${app!.session.id}`)))
		} catch (e) {
			error((e as Error).message)
		}
	}

	// ---------- 表单记忆（localStorage） ----------

	/** 会话创建成功时保存配置表单，供放弃/中断后恢复。 */
	private saveForm() {
		try {
			const saved: Record<string, unknown> = {}
			for (const k of FORM_FIELDS) saved[k] = (app as any)![k]
			localStorage.setItem(FORM_KEY, JSON.stringify(saved))
		} catch {
			// localStorage 不可用则忽略
		}
	}

	/** 恢复上次保存的表单值（无保存或内容损坏时保持默认）。 */
	private restoreForm() {
		try {
			const saved = JSON.parse(localStorage.getItem(FORM_KEY) ?? 'null') as Record<string, unknown> | null
			if (!saved || typeof saved != 'object') return
			const patch: Record<string, unknown> = {}
			for (const k of FORM_FIELDS) if (k in saved) patch[k] = saved[k]
			this.up(patch)
		} catch {
			// 忽略
		}
	}

	// ---------- 视图 1：创建会话 ----------

	/** 调出系统「选择文件夹」对话框（后端代开，模态阻塞至选择/取消）。 */
	async pickFolder() {
		if (app!.busy) return
		this.up({ busy: true })
		try {
			const d = await json<{ path: string | null }>(await fetch('/api/pick-folder', { method: 'POST' }))
			if (d.path) this.up({ targetDir: d.path })
		} catch (e) {
			error((e as Error).message)
		} finally {
			this.up({ busy: false })
		}
	}

	async createSession() {
		if (app!.busy || !app!.mArg.trim() || !app!.targetDir.trim()) return
		this.up({ busy: true })
		try {
			const batchSize = parseInt(String(app!.formBatchSize), 10)
			const s = await post<SessionDTO>('/api/sessions', {
				mArg: app!.mArg.trim(),
				targetDir: app!.targetDir.trim(),
				...(Number.isFinite(batchSize) && batchSize >= 2 ? { batchSize } : {}),
				pathGlobs: app!.pathGlobs.split(/\n|,/).map((x) => x.trim()).filter(Boolean),
				...(app!.standard ? { standard: app!.standard } : {}),
				dryRun: app!.dryRun,
				onCollision: app!.onCollision,
			})
			this.applySession(s, true)
			this.saveForm()
			success(`已创建会话：${s.totalImages} 张图片，${s.batches.length} 个批次`)
		} catch (e) {
			error((e as Error).message)
		} finally {
			this.up({ busy: false })
		}
	}

	// ---------- 视图 2：批次比较 ----------

	async auto() {
		const s = app!.session
		if (!s || app!.busy) return
		this.up({ busy: true })
		try {
			const dto = await post<BatchDTO>(`/api/sessions/${s.id}/batches/${app!.currentIndex}/auto`)
			this.applySession({
				...s,
				batches: s.batches.map((b) => (b.index == dto.index ? dto : b)),
			})
			if (app!.pendingCount > 0) this.goNextPending()
		} catch (e) {
			error((e as Error).message)
			await this.reload()
		} finally {
			this.up({ busy: false })
		}
	}

	async enterManual() {
		const s = app!.session
		const b = app!.currentBatch
		if (!s || !b) return
		this.up({ manualMode: true, pickUrl: '', suggestion: null })
		// 待决批次自动获取 LLM 建议（不写缓存）供参考；手动模式下无建议
		if (b.status == 'pending' && app!.llmAvailable) {
			try {
				const d = await post<{ keptUrl: string; reason: string; cached: boolean }>(
					`/api/sessions/${s.id}/batches/${b.index}/suggest`,
				)
				this.up({ suggestion: d })
			} catch {
				// 建议失败不阻塞手选
			}
		}
	}

	cancelManual() {
		this.up({ manualMode: false, pickUrl: '', suggestion: null })
	}

	onImgClick(url: string) {
		if (app!.manualMode) this.up({ pickUrl: url })
		else this.openViewer(url)
	}

	/** 手动态双击：直接确认保留该图片并跳到下一个未决批次。 */
	onImgDblClick(url: string) {
		if (!app!.manualMode || app!.busy) return
		this.up({ pickUrl: url })
		void this.confirmManual()
	}

	// ---------- 原图查看 ----------

	openViewer(url: string) {
		this.up({ viewerUrl: url, viewerName: basename(url) })
	}

	closeViewer() {
		this.up({ viewerUrl: '', viewerName: '' })
	}

	/** 复位图片浮层（悬停预览 / 全屏查看）——视图或会话切换时调用。 */
	private resetOverlays() {
		clearTimeout(previewTimer)
		this.up({ previewUrl: '', previewName: '', viewerUrl: '', viewerName: '' })
	}

	// ---------- 悬停大图预览 ----------

	/** 悬停缩略图 150ms 后显示大图：原图宽 ≤800 直接用原图，否则取 800px 缩略图。 */
	previewOn(url: string, width: number, name: string) {
		clearTimeout(previewTimer)
		previewTimer = setTimeout(() => {
			const a = app!
			a.up({
				previewUrl: width > 0 && width <= 800 ? a.rawUrl(url) : `/api/image?u=${encodeURIComponent(url)}&w=800`,
				previewName: name,
			})
		}, 150)
	}

	previewOff() {
		clearTimeout(previewTimer)
		this.up({ previewUrl: '', previewName: '' })
	}

	async confirmManual() {
		const s = app!.session
		if (!s || !app!.pickUrl || app!.busy) return
		this.up({ busy: true })
		try {
			await post(`/api/sessions/${s.id}/batches/${app!.currentIndex}/manual`, {
				keptUrl: app!.pickUrl,
				reason: '手动选择',
			})
			await this.reload()
			if (app!.running) {
				// 已进入预览阶段：服务端在后台自动重赛，推送会持续更新状态
			} else {
				this.goNextPending()
			}
		} catch (e) {
			error((e as Error).message)
			await this.reload()
		} finally {
			this.up({ busy: false })
		}
	}

	async runRemaining() {
		const s = app!.session
		if (!s || app!.running || app!.busy) return
		try {
			await post(`/api/sessions/${s.id}/run-remaining`)
			this.up({ running: true })
			// 进度与完成状态由 SSE 推送
		} catch (e) {
			error((e as Error).message)
		}
	}

	go(delta: number) {
		const s = app!.session
		if (!s) return
		const idx = Math.min(Math.max(app!.currentIndex + delta, 0), s.batches.length - 1)
		if (idx != app!.currentIndex) {
			this.up({ currentIndex: idx })
			this.syncCurrent()
		}
	}

	// ---------- 跳转到第 N 批 ----------

	jumpIndex: number | string = ''

	jumpToBatch() {
		const s = app!.session
		if (!s) return
		const n = parseInt(String(app!.jumpIndex), 10)
		if (!Number.isFinite(n)) return
		const idx = Math.min(Math.max(n - 1, 0), s.batches.length - 1)
		this.up({ currentIndex: idx, jumpIndex: '' })
		this.syncCurrent()
	}

	/** 输入框内按 Enter 跳转。keydown 先于该键的输入同步，直接读事件目标的值。 */
	onJumpKey(e: Event) {
		if ((e as KeyboardEvent).key == 'Enter') {
			this.up({ jumpIndex: (e.target as HTMLInputElement).value })
			this.jumpToBatch()
		}
	}

	private goNextPending() {
		const s = app!.session
		if (!s || app!.pendingCount == 0) return
		const idx = s.batches.findIndex((b) => b.status == 'pending')
		if (idx >= 0 && idx != app!.currentIndex) {
			this.up({ currentIndex: idx })
			this.syncCurrent()
		}
	}

	// ---------- 手动加赛 ----------

	onPairClick(pairIndex: number, url: string) {
		this.up({ pairPickIndex: pairIndex, pairPickUrl: url })
	}

	onPairDblClick(pairIndex: number, url: string) {
		if (app!.busy) return
		this.up({ pairPickIndex: pairIndex, pairPickUrl: url })
		void this.confirmPair(pairIndex)
	}

	/** 确认保留该对局所选的一张（另一张留在移除候选），服务端自动推进轮次。 */
	async confirmPair(pairIndex: number) {
		const s = app!.session
		if (!s || !s.tournament || app!.busy) return
		if (app!.pairPickIndex != pairIndex || !app!.pairPickUrl) return
		const prevRound = s.tournament.round
		this.up({ busy: true })
		try {
			this.applySession(
				await post<SessionDTO>(`/api/sessions/${s.id}/tournament`, {
					pairIndex,
					keptUrl: app!.pairPickUrl,
				}),
			)
			this.resetOverlays()
			this.up({ pairPickIndex: -1, pairPickUrl: '' })
			const t = app!.session?.tournament
			if (app!.session?.status == 'finalized') success('加赛完成，移除清单已确定')
			else if (t && t.round > prevRound) success(`进入第 ${t.round} 轮`)
		} catch (e) {
			error((e as Error).message)
			await this.reload()
		} finally {
			this.up({ busy: false })
		}
	}

	// ---------- 视图 3 / 4 ----------

	async finalize() {
		const s = app!.session
		if (!s || app!.busy) return
		this.up({ busy: true })
		try {
			this.applySession(await post<SessionDTO>(`/api/sessions/${s.id}/finalize`))
		} catch (e) {
			error((e as Error).message)
		} finally {
			this.up({ busy: false })
		}
	}

	async move() {
		const s = app!.session
		if (!s || app!.busy) return
		if (
			!s.dryRun &&
			!confirm(`确认把 ${app!.toRemoveImages.length} 张图片移动到 ${s.targetDir}？将移动文件并更新数据库记录。`)
		)
			return
		this.up({ busy: true })
		try {
			this.applySession(await post<SessionDTO>(`/api/sessions/${s.id}/move`))
			success(s.dryRun ? '干运行完成，未移动任何文件' : '移动完成')
		} catch (e) {
			error((e as Error).message)
		} finally {
			this.up({ busy: false })
		}
	}

	backToReview() {
		if (app!.session?.status != 'finalized') return
		this.resetOverlays()
		this.up({ view: 'review', manualMode: false, pickUrl: '', suggestion: null })
	}

	restart() {
		this.disconnectEvents()
		this.resetOverlays()
		this.up({ session: null, view: 'setup', moveResults: [] })
		void this.init()
	}

	async abandon() {
		const s = app!.session
		if (!s) return
		if (!confirm('放弃当前会话？已完成的比较结果保留在断点缓存中，下次运行（含 CLI --resume）可复用。')) return
		try {
			await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
		} catch {
			// 忽略
		}
		this.disconnectEvents()
		this.resetOverlays()
		this.up({ session: null, view: 'setup' })
		this.restoreForm()
		try {
			const cfg = await json<ConfigDTO>(await fetch('/api/config'))
			this.up({ totalImages: cfg.totalImages, standards: cfg.standards })
			this.renderStandardOptions()
		} catch {
			// 忽略
		}
	}

	// ---------- 模板辅助 ----------

	/**
	 * 填充估值标准输入框的 datalist 候选。datalist 内不放 cydon 模板
	 * （避开 c-for 对父节点的绑定约束），在 config 变化时命令式重建。
	 */
	private renderStandardOptions() {
		const list = document.getElementById('standard-options') as HTMLDataListElement | null
		if (!list) return
		list.innerHTML = ''
		for (const s of app!.standards) {
			const opt = document.createElement('option')
			opt.value = s.name
			opt.textContent = `${s.name}（${s.count}）`
			list.appendChild(opt)
		}
	}

	thumbUrl(url: string): string {
		return `/api/image?u=${encodeURIComponent(url)}&w=512`
	}

	rawUrl(url: string): string {
		return `/api/image?u=${encodeURIComponent(url)}&raw=1`
	}

	imgName(url: string): string {
		return basename(url)
	}

	fmtSize(n: number): string {
		if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
		if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
		return `${n} B`
	}

	sourceLabel(source?: string): string {
		return (source && SOURCE_LABEL[source]) || ''
	}

	statusLabel(status: string): string {
		return STATUS_LABEL[status] ?? status
	}

	tournamentLabel(): string {
		const s = app!.session
		if (!s?.tournamentUsed) return '未启用'
		return `${s.tournamentRounds.length} 轮`
	}
}

/** 唯一实例（connectedCallback 时赋值），供事件处理器摆脱循环上下文的 this。 */
let app: IcwApp | null = null

/** 悬停预览的延迟计时器（非响应式，挂在模块层避免污染组件状态）。 */
let previewTimer: ReturnType<typeof setTimeout> | undefined

customElements.define('icw-app', IcwApp)
