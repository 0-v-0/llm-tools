import { CydonElement } from 'cydon'
import template from './template.html?raw'
import { MergeInsertionRunner } from './merge-insertion.ts'
import { TopKRunner } from './top-k.ts'
import { applyOrderConstraints } from './constraints.ts'
import type { PreciseSnapshot } from './merge-insertion.ts'
import type { TopKSnapshot } from './top-k.ts'
import type { OrderConstraint } from './constraints.ts'
import type { MediaItem, MediaSource, MediaKind, RankResult } from './types.ts'

/** 排名模式（由 target 与候选数推导）：precise Ford-Johnson 精确全排序
	（target ≥ 候选数）；topK 前 target 名提取（knockout + 胜者树，经认证）。 */
export type RankMode = 'topK' | 'precise'
/** 中断恢复快照（两种模式各自的完整状态）。 */
export type RankSnapshot = PreciseSnapshot | TopKSnapshot

function basename(id: string): string {
	return id.replaceAll('\\', '/').split('/').pop() ?? id
}

interface PairCard {
	pairIndex: number
	id: string
	name: string
	kind: MediaKind
	meta: string
}

interface RankRow {
	rank: number
	badge: string
	id: string
	name: string
	kind: MediaKind
	meta: string
}

const pairCard = (pairIndex: number, item: MediaItem): PairCard => ({
	pairIndex,
	id: item.id,
	name: item.name ?? basename(item.id),
	kind: item.kind ?? 'image',
	meta: item.meta ?? '',
})

const RANK_BADGES = ['badge-success', 'badge-warning', 'badge-info']
const rankRows = (result: RankResult): RankRow[] =>
	result.ranking.map((item, i) => ({
		rank: i + 1,
		badge: RANK_BADGES[i] ?? 'badge-ghost',
		id: item.id,
		name: item.name ?? basename(item.id),
		kind: item.kind ?? 'image',
		meta: item.meta ?? '',
	}))

/**
 * 模板引用的方法在 connectedCallback 预绑定到元素自身：事件表达式与 c-for
 * 克隆节点内的方法调用拿到的 this 不可依赖（循环上下文/globalThis/代理）。
 * 预绑定后 this 恒为元素；**状态写入必须走 `this.data`（响应式代理）**，
 * 直接在 this 上赋值不会触发更新。
 */
const BOUND_METHODS = [
	'cardSrc',
	'posterSrc',
	'thumbSrc',
	'rawSrc',
	'onCardClick',
	'openViewer',
	'closeViewer',
	'previewOn',
	'previewOff',
	'restart',
] as const

/**
 * `<media-rank>`：图片/音频/视频单败淘汰锦标赛排名组件。
 *
 * 用法：
 * ```ts
 * import 'media-rank-web'                 // 注册 <media-rank>
 * const el = document.createElement('media-rank')
 * el.start(items, source, 2)              // 候选、媒体源、目标保留数
 * el.addEventListener('rank-complete', (e) => e.detail.result)
 * container.append(el)
 * ```
 * 也可在连接前设置 `items`/`source`/`target` 属性，连接后自动开赛。
 * 事件（均冒泡）：`rank-decide`（单对裁决）、`rank-change`（轮次/收束状态）、
 * `rank-complete`（收束，detail.result 为 RankResult）。
 */
export class MediaRank extends CydonElement {
	// ---- 宿主可配置（start 前设置，连接后自动开赛） ----
	items: MediaItem[] = []
	source: MediaSource | null = null
	/** 找出前 target 名：target ≥ 候选数（或留空）时走 Ford-Johnson 精确全排序
		（默认），target < 候选数时走前 k 名提取（knockout + 胜者树，经认证）。 */
	target: number | null = null
	/**
	 * 可选顺序约束：约束 final ranking 中 before 条目排在 after 之前（按 id）。
	 * 收束时对排名结果做稳定拓扑重排（applyOrderConstraints）——保持有序
	 * 歌单/序列内部相对顺序；约束成环时无法满足，host 应在开赛前自行校验
	 * （applyOrderConstraints 返回的 cycle 非空即为冲突）。
	 */
	constraints: OrderConstraint[] = []

	// ---- 派生展示状态（sync() 统一重建，模板直接引用） ----
	started = false
	completed = false
	mode: RankMode = 'precise'
	round = 0
	candidatesLeft = 0
	totalCount = 0
	survivorsCount = 0
	/** 已提取名次数（topK 模式进行中亦可查询） */
	extractedCount = 0
	/** 预计总比较次数（按模式公式估算） */
	estimateTotal = 0
	pairCards: PairCard[] = []
	result: RankResult | null = null
	rankingRows: RankRow[] = []

	// ---- 悬停预览 / 原始文件查看 ----
	previewUrl = ''
	previewName = ''
	viewerId = ''
	viewerName = ''
	viewerKind: MediaKind = 'image'
	/** ref="viewerBox" 绑定的查看层内容区（关闭时暂停其中的播放器） */
	viewerBox: HTMLElement | null = null

	// ---- 自动连播：直接顺序播放对局两张卡各自的行内播放器 ----

	private fj: MergeInsertionRunner | null = null
	private topK: TopKRunner | null = null
	private previewTimer: ReturnType<typeof setTimeout> | undefined
	private keyHandler?: (e: KeyboardEvent) => void

	constructor() {
		super()
	}

	connectedCallback() {
		// 自带模板：须在 mount 前注入（自定义元素构造器中不得添加子节点，否则
		// createElement 升级失败）；connectedCallback 的 mount 会编译子节点
		if (!this.firstChild)
			this.innerHTML = template
		for (const k of BOUND_METHODS) {
			const fn = (this as unknown as Record<string, unknown>)[k]
			if (typeof fn == 'function')
				(this as unknown as Record<string, unknown>)[k] = (fn as (...args: unknown[]) => unknown).bind(this)
		}
		if (!this.keyHandler) {
			this.keyHandler = (e) => {
				if (e.key == 'Escape' && this.viewerId) this.closeViewer()
			}
		}
		window.addEventListener('keydown', this.keyHandler)
		// 单实例播放：任一 audio/video（含卡片行内播放器）开始播放时暂停其余
		// （play 不冒泡，捕获监听）
		this.addEventListener('play', (e) => {
			if (this.isPairAudio(e.target))
				this.chainUserPaused = false
			for (const m of this.querySelectorAll('audio,video'))
				if (m != e.target) (m as HTMLMediaElement).pause()
		}, true)
		this.addEventListener('pause', (e) => {
			if (this.isPairAudio(e.target))
				this.chainUserPaused = true
		}, true)
		// 连播巡检（对渲染时序与后台标签页 rAF 暂停免疫）
		if (this.autoplayTimer === undefined)
			this.autoplayTimer = setInterval(() => this.autoplayTick(), 250)
		super.connectedCallback()
		// 宿主已预置候选与媒体源时自动开赛
		if (!this.started && this.source && this.items.length)
			this.start(this.items, this.source, this.target ?? undefined)
	}

	disconnectedCallback() {
		if (this.keyHandler)
			window.removeEventListener('keydown', this.keyHandler)
		if (this.autoplayTimer !== undefined) {
			clearInterval(this.autoplayTimer)
			this.autoplayTimer = undefined
		}
	}

	/** 设置候选、媒体源与目标保留数 k，开始（或重新开始）排名。
		k ≥ 候选数（或留空）→ Ford-Johnson 精确全排序；k < 候选数 → 前 k 名提取。 */
	start(items: readonly MediaItem[], source: MediaSource, target?: number) {
		const n = items.length
		const t = Math.max(1, Math.min(target ?? this.target ?? n, n))
		this.fj = null
		this.topK = null
		let mode: RankMode
		if (t >= n) {
			mode = 'precise'
			this.fj = new MergeInsertionRunner(items)
		} else {
			mode = 'topK'
			this.topK = new TopKRunner(items, t)
		}
		Object.assign(this.data, { items: [...items], source, target: t, mode })
		this.sync()
	}

	/** 用当前候选与媒体源重新排名（重新洗牌 / 重新比较）。 */
	restart() {
		const { items, source, target } = this.data
		if (source) this.start(items, source, target)
	}

	/**
	 * 从快照恢复排名进度（中断恢复）。精确模式重放裁决记录；前 k 名模式
	 * 依据确定性种子洗牌的 knockout 重放。恢复后照常发出 rank-change/
	 * rank-complete。
	 */
	restore(snapshot: RankSnapshot, source: MediaSource) {
		const items: MediaItem[] = [...snapshot.items]
		if (snapshot.kind == 'precise') {
			this.topK = null
			this.fj = new MergeInsertionRunner(snapshot.items, snapshot.answers)
			Object.assign(this.data, { items, source, target: snapshot.target, mode: 'precise' })
		} else {
			this.fj = null
			this.topK = new TopKRunner(snapshot.items, snapshot.target, snapshot.answers)
			Object.assign(this.data, { items, source, target: snapshot.target, mode: 'topK' })
		}
		this.sync()
	}

	// ---------- 媒体源取直链 ----------

	private zoomSrc(id: string, zoom: number): string {
		return (this.data.source as MediaSource | null)?.getUrl(id, { zoom }) ?? ''
	}

	cardSrc(pc: PairCard): string {
		return this.zoomSrc(pc.id, 512)
	}

	posterSrc(id: string): string {
		return this.zoomSrc(id, 512)
	}

	thumbSrc(id: string): string {
		return this.zoomSrc(id, 128)
	}

	rawSrc(id: string): string {
		return (this.data.source as MediaSource | null)?.getUrl(id, { raw: true }) ?? ''
	}

	// ---------- 交互 ----------

	onCardClick(pc: PairCard) {
		// 单次点击即裁决（两种模式的比较对都唯一，无需两段确认）
		const cmp = this.currentPair()
		if (!cmp || (pc.id != cmp.a.id && pc.id != cmp.b.id)) return
		const eliminatedId = pc.id == cmp.a.id ? cmp.b.id : cmp.a.id
		this.dispatchEvent(new CustomEvent('rank-decide', {
			bubbles: true,
			composed: true,
			detail: { pairIndex: 0, keptId: pc.id, eliminatedId },
		}))
		if (this.data.mode == 'precise')
			this.fj!.decide(pc.id)
		else
			this.topK!.decide(pc.id)
		this.sync()
	}

	openViewer(item: { id: string; name?: string; kind?: MediaKind }) {
		clearTimeout(this.previewTimer)
		this.pauseAllMedia()
		Object.assign(this.data, {
			previewUrl: '',
			previewName: '',
			viewerId: item.id,
			viewerName: item.name ?? basename(item.id),
			viewerKind: item.kind ?? 'image',
		})
	}

	closeViewer() {
		this.viewerBox?.querySelectorAll('audio,video').forEach((m) => (m as HTMLMediaElement).pause())
		// 关闭查看层后允许连播从中断处继续
		this.chainUserPaused = false
		Object.assign(this.data, { viewerId: '', viewerName: '', viewerKind: 'image' })
	}

	previewOn(pc: PairCard) {
		clearTimeout(this.previewTimer)
		this.previewTimer = setTimeout(() => {
			Object.assign(this.data, { previewUrl: this.zoomSrc(pc.id, 800), previewName: pc.name })
		}, 150)
	}

	previewOff() {
		clearTimeout(this.previewTimer)
		Object.assign(this.data, { previewUrl: '', previewName: '' })
	}

	// ---------- 播放：自动连播与单实例 ----------

	private pauseAllMedia() {
		for (const m of this.querySelectorAll<HTMLMediaElement>('audio,video')) {
			// 卡片播放器的 onended 负责对局 A→B 推进，打开查看层时一并清除，
			// 关闭后由连播巡检重新挂上
			m.onended = null
			m.pause()
		}
	}

	/** 事件目标是否为对局卡片的行内播放器（对局连播的载体）。 */
	private isPairAudio(t: EventTarget | null): boolean {
		return t instanceof Element && !!t.closest('[data-role=pair-list]')
	}

	private playMedia(m: HTMLMediaElement) {
		try {
			m.play().catch(() => { /* 自动播放被策略拒绝，用户可手动播放 */ })
		} catch {
			// 个别实现对未就绪的源同步抛错，忽略
		}
	}

	// 连播状态：key 标识当前对局（防同一对反复重播），stage 为 A→B 推进阶段
	private chainKey = ''
	private chainStage: 'a' | 'b' | 'done' = 'done'
	/** 当前连播对应的对局（A 播完后接续其 B，不受裁决推进影响） */
	private chainPair: { a: MediaItem; b: MediaItem } | null = null
	private chainUserPaused = false
	private autoplayTimer: ReturnType<typeof setInterval> | undefined

	/**
	 * 对局连播没有独立播放器：直接顺序播放两张卡**各自的行内播放器**
	 * （对局网格，data-role="pair-list"）。行节点在 sync 间原地合并、不被
	 * 替换，行内播放器的播放状态因此可靠。
	 */
	private stageRowAudio(): HTMLAudioElement | null {
		const p = this.chainPair
		if (!p || this.chainStage == 'done')
			return null
		const id = this.chainStage == 'a' ? p.a.id : p.b.id
		const i = (this.data.pairCards as PairCard[]).findIndex((pc) => pc.id == id)
		if (i < 0)
			return null
		return this.querySelectorAll<HTMLAudioElement>('[data-role=pair-list] > div audio')[i] ?? null
	}

	/** 播放当前阶段那张卡的行内播放器，并挂 ended 推进。 */
	private playStageRow() {
		const audio = this.stageRowAudio()
		if (!audio)
			return
		audio.onended = () => this.advanceChain()
		this.playMedia(audio)
	}

	/** A 播完接续 B；B 播完等待用户裁决（chainStage='done'）。 */
	private advanceChain() {
		const p = this.chainPair
		if (!p || this.chainStage == 'done') {
			this.chainStage = 'done'
			return
		}
		if (this.chainStage == 'a') {
			this.chainStage = 'b'
			this.playStageRow()
		} else {
			this.chainStage = 'done'
		}
	}

	/** 当前引擎的待裁决对（精确模式取当前比较对；前 k 名模式取 knockout
		待裁决对或提取阶段的二分比较对）。 */
	private currentPair(): { a: MediaItem; b: MediaItem } | null {
		if (this.data.mode == 'precise')
			return this.fj?.comparison ?? null
		const cmp = this.topK?.comparison
		return cmp ? { a: cmp.a, b: cmp.b } : null
	}

	/**
	 * 连播巡检（定时驱动，对 cydon 渲染时序与后台标签页的 rAF 暂停免疫）：
	 * 待裁决对变化（开赛/裁决推进/恢复）时，自动播放两张卡各自的行内播放器
	 * 先 A 后 B；用户手动暂停卡片播放器时不强行恢复（任一时刻全局只播一个）。
	 * 纯图片对局或含视频的对局跳过自动连播。
	 */
	private autoplayTick() {
		const p = this.currentPair()
		const mode = this.data.mode as RankMode
		const key = p ? `${mode}:${this.round}:${p.a.id}|${p.b.id}` : ''
		if (key == this.chainKey) {
			// 同一对局：行播放器被渲染重置/意外暂停且非用户暂停时恢复播放
			if (this.chainStage != 'done') {
				const audio = this.stageRowAudio()
				if (audio && audio.paused && !audio.ended && !!audio.src && !this.chainUserPaused)
					this.playMedia(audio)
			}
			return
		}
		if (!p) {
			this.chainKey = key
			this.chainStage = 'done'
			return
		}
		this.chainKey = key
		this.chainUserPaused = false
		const ka = p.a.kind ?? 'image'
		const kb = p.b.kind ?? 'image'
		if (ka != 'audio' || kb != 'audio') {
			this.chainStage = 'done'
			return
		}
		// 播放共享（精确模式）：同一败者的连续二分比较不重播败者——败者只在
		// 首次比较时完整播放，后续比较仅播新的链元素（播放次数 ≈ 比较次数 + n）
		const shared = mode == 'precise' && this.chainPair != null && p.a.id == this.chainPair.a.id
		this.chainPair = p
		if (shared) {
			this.chainStage = 'b'
			this.playStageRow()
		} else {
			this.chainStage = 'a'
			this.playStageRow()
		}
	}

	// ---------- 状态同步 ----------

	/** 从状态机重建全部派生状态，并按需发出 rank-change / rank-complete。 */
	private sync() {
		const mode = this.data.mode as RankMode
		const target = (this.data.target as number) || this.items.length
		const completed = mode == 'precise' ? this.fj!.completed : this.topK!.completed
		let result: RankResult | null = null
		let round = 0
		let candidatesLeft = 0
		let pendingCount = 0
		let pairCards: PairCard[] = []
		let snapshot: RankSnapshot

		if (mode == 'precise') {
			const fj = this.fj!
			round = fj.comparisonsMade
			candidatesLeft = fj.size
			const cmp = fj.comparison
			pendingCount = cmp ? 1 : 0
			if (cmp)
				pairCards = [pairCard(0, cmp.a), pairCard(0, cmp.b)]
			snapshot = fj.toJSON()
			if (completed)
				result = { ranking: fj.ranking!, survivors: fj.ranking!.slice(0, target), rounds: [] }
		} else {
			const tk = this.topK!
			round = tk.comparisonsMade
			candidatesLeft = tk.size - tk.extractedCount
			const cmp = tk.comparison
			pendingCount = cmp ? 1 : 0
			if (cmp)
				pairCards = [pairCard(0, cmp.a), pairCard(0, cmp.b)]
			snapshot = tk.toJSON()
			if (completed)
				result = { ranking: tk.ranking!, survivors: tk.ranking!, rounds: [] }
		}
		// 预计总比较次数：精确 = FJ 渐近式；前 k 名 = knockout + 逐名提取
		const n = this.items.length
		const estimateTotal = mode == 'precise'
			? (n > 1 ? Math.round(n * Math.log2(n) - 1.44 * n) : 0)
			: Math.max(0, (n - 1) + (target - 1) * Math.ceil(Math.log2(Math.max(2, n))))
		if (result) {
			// 顺序约束：稳定拓扑重排，保持有序歌单内的相对顺序（host 负责冲突校验）
			const adj = applyOrderConstraints(result.ranking, this.data.constraints as OrderConstraint[])
			if (!adj.cycle.length)
				result = { ...result, ranking: adj.ranking, survivors: adj.ranking.slice(0, result.survivors.length) }
		}
		const extractedCount = result?.ranking.length ?? (mode == 'topK' ? this.topK!.extractedCount : 0)
		clearTimeout(this.previewTimer)
		Object.assign(this.data, {
			started: true,
			completed,
			mode,
			round,
			candidatesLeft,
			totalCount: this.items.length,
			target,
			extractedCount,
			estimateTotal,
			survivorsCount: result?.survivors.length ?? 0,
			pairCards,
			result,
			rankingRows: result ? rankRows(result) : [],
			previewUrl: '',
			previewName: '',
			viewerId: '',
			viewerName: '',
			viewerKind: 'image',
		})
		this.dispatchEvent(new CustomEvent('rank-change', {
			bubbles: true,
			composed: true,
			detail: {
				mode,
				round,
				target,
				extractedCount,
				candidatesLeft,
				pendingCount,
				completed,
				estimateTotal,
				// 完整快照：宿主可在 rank-change 时持久化，用于中断恢复
				snapshot,
			},
		}))
		if (result)
			this.dispatchEvent(new CustomEvent('rank-complete', { bubbles: true, composed: true, detail: { result } }))
	}
}

customElements.define('media-rank', MediaRank)
