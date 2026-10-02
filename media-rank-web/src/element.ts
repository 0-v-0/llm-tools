import { CydonElement } from 'cydon'
import template from './template.html?raw'
import { MergeInsertionRunner } from './merge-insertion.ts'
import { TopKRunner } from './top-k.ts'
import { VerifyOrderRunner } from './verify-order.ts'
import { carryPair } from './pair-carry.ts'
import { applyOrderConstraints } from './constraints.ts'
import type { PreciseSnapshot } from './merge-insertion.ts'
import type { TopKSnapshot } from './top-k.ts'
import type { VerifySnapshot } from './verify-order.ts'
import type { OrderConstraint } from './constraints.ts'
import type { MediaItem, MediaSource, MediaSourceParams, MediaKind, RankResult } from './types.ts'

/** 排名模式：precise Ford-Johnson 精确全排序（target ≥ 候选数）；
	topK 前 target 名提取（target < 候选数）；verify 顺序校验（只播重听）。 */
export type RankMode = 'topK' | 'precise' | 'verify'
/** 中断恢复快照（各模式各自的完整状态）。 */
export type RankSnapshot = PreciseSnapshot | TopKSnapshot | VerifySnapshot

function basename(id: string): string {
	return id.replaceAll('\\', '/').split('/').pop() ?? id
}

interface PairCard {
	pairIndex: number
	id: string
	name: string
	kind: MediaKind
	meta: string
	/** 承接自上一轮对局（「上一首」）：不重播，仅作为听感锚点 */
	carried: boolean
}

interface RankRow {
	/** 名次（数值，用于「当前播放行」等比较） */
	rank: number
	/** 序号显示文本：前三名用奖牌 emoji，其后为数字 */
	rankText: string
	id: string
	name: string
	kind: MediaKind
	meta: string
}

const pairCard = (pairIndex: number, item: MediaItem, carried = false): PairCard => ({
	pairIndex,
	id: item.id,
	name: item.name ?? basename(item.id),
	kind: item.kind ?? 'image',
	meta: item.meta ?? '',
	carried,
})

/** 前三名序号用奖牌 emoji；第四名起为数字。 */
const RANK_MEDALS = ['🥇', '🥈', '🥉']
const rankRows = (result: RankResult): RankRow[] =>
	result.ranking.map((item, i) => ({
		rank: i + 1,
		rankText: RANK_MEDALS[i] ?? String(i + 1),
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
	'renameItem',
	'renameMeta',
	'openEditor',
	'closeEditor',
	'editToggleDiscard',
	'submitEditor',
	'onCardClick',
	'openViewer',
	'closeViewer',
	'previewOn',
	'previewOff',
	'restart',
	'playPlaylist',
	'playPlaylistFrom',
	'stopPlaylist',
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
	/**
	 * 音频用播放列表布局、其余（图片/视频）用两列卡片布局。
	 *
	 * 音频一次只能听一个，并排两张卡没有意义，且「上一首 vs 下一首」更贴近
	 * 听感流；图片能同屏并排对比，两列卡片才更好用。暂不考虑一对待裁决项
	 * 混合多种类型，按首个候选的 kind 决定整对待局的布局。
	 */
	audioLayout = false
	result: RankResult | null = null
	rankingRows: RankRow[] = []
	/** 排名完成后的可连续播放列表（播放列表视图的数据源） */
	playlistRows: RankRow[] = []
	/** 校验模式：本次是顺序校验（而非求最优序） */
	verified = false
	/** 校验模式：发现的顺序错误处数 */
	inversionCount = 0
	/** 校验模式：顺序错误处的曲目 */
	inversionRows: RankRow[] = []

	// ---- 已裁决项编辑面板 ----
	/** 正在编辑的项 id；空串 = 面板关闭 */
	editId = ''
	/** 编辑中的新 id（提交时与 editId 不同即视为换曲，须丢弃裁决） */
	editNewId = ''
	editName = ''
	editMeta = ''
	/** 提交时丢弃该项的裁决并回退重做 */
	editDiscard = false
	/** 被编辑项是否已卷入裁决（决定是否展示「丢弃原裁决」选项） */
	editDecided = false
	/** 新 id 与现有项重复等校验错误（空串 = 无） */
	editError = ''

	// ---- 播放列表连播（结果视图的整列顺序播放，与对局连播器相互独立） ----
	/** 正在连播的播放列表下标；-1 为未在连播 */
	playlistIndex = -1
	playlistPlaying = false
	private playlistTimer: ReturnType<typeof setInterval> | undefined

	// ---- 悬停预览 / 原始文件查看 ----
	previewUrl = ''
	previewName = ''
	viewerId = ''
	viewerName = ''
	viewerKind: MediaKind = 'image'
	/** ref="viewerBox" 绑定的查看层内容区（关闭时暂停其中的播放器） */
	viewerBox: HTMLElement | null = null

	// ---- 自动连播：直接顺序播放待裁决两行的行内播放器 ----

	private fj: MergeInsertionRunner | null = null
	private topK: TopKRunner | null = null
	private verify: VerifyOrderRunner | null = null
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
		// 单实例播放：任一 audio/video（含行内播放器）开始播放时暂停其余
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
		if (this.playlistTimer !== undefined) {
			clearInterval(this.playlistTimer)
			this.playlistTimer = undefined
		}
	}

/** 设置候选、媒体源与目标名次 k，开始（或重新开始）排名。
	 *  k ≥ 候选数（或留空）→ Ford-Johnson 精确全排序；k < 候选数 → 前 k 名提取。
	 *  传 verifyOnly = true 则改为顺序校验（n−1 次相邻比较，不改变给定顺序）。 */
	/** 重置连播与衔接状态（开赛/恢复时调用，避免上一轮运行的行泄漏进衔接判定）。 */
	private resetChainState() {
		this.chainPair = null
		this.chainKey = ''
		this.chainStage = 'done'
		this.chainCarriedId = ''
		// sync() 的衔接判定读取上一轮展示行，跨运行必须清空
		Object.assign(this.data, { pairCards: [] })
	}

	start(items: readonly MediaItem[], source: MediaSource, target?: number, verifyOnly = false) {
		const n = items.length
		const t = Math.max(1, Math.min(target ?? this.target ?? n, n))
		this.fj = null
		this.topK = null
		this.verify = null
		let mode: RankMode
		if (verifyOnly) {
			if (n < 2) throw new Error('顺序校验至少需要 2 项')
			mode = 'verify'
			this.verify = new VerifyOrderRunner(items)
		} else if (t >= n) {
			mode = 'precise'
			this.fj = new MergeInsertionRunner(items)
		} else {
			mode = 'topK'
			this.topK = new TopKRunner(items, t)
		}
		this.resetChainState()
		Object.assign(this.data, { items: [...items], source, target: t, mode })
		this.sync()
	}

	/** 用当前候选与媒体源重新排名（重新洗牌 / 重新比较）。 */
	restart() {
		const { items, source, target, mode } = this.data
		if (source) this.start(items, source, target, mode == 'verify')
	}

	/**
	 * 从快照恢复排名进度（中断恢复）。精确模式重放裁决记录；前 k 名模式
	 * 依据确定性种子洗牌的 knockout 重放；校验模式重放相邻比较。
	 * 恢复后照常发出 rank-change/rank-complete。
	 */
	restore(snapshot: RankSnapshot, source: MediaSource) {
		const items: MediaItem[] = [...snapshot.items]
		this.fj = null
		this.topK = null
		this.verify = null
		if (snapshot.kind == 'precise') {
			this.fj = new MergeInsertionRunner(snapshot.items, snapshot.answers)
			Object.assign(this.data, { items, source, target: snapshot.target, mode: 'precise' })
		} else if (snapshot.kind == 'topK') {
			this.topK = new TopKRunner(snapshot.items, snapshot.target, snapshot.answers)
			Object.assign(this.data, { items, source, target: snapshot.target, mode: 'topK' })
		} else {
			this.verify = new VerifyOrderRunner(snapshot.items, snapshot.answers)
			Object.assign(this.data, { items, source, target: snapshot.target, mode: 'verify' })
		}
		this.resetChainState()
		this.sync()
	}

	// ---------- 媒体源取直链 ----------

	/**
	 * 按 id 取直链，附带该项的当前显示名。
	 *
	 * 显示名优先从 data.items 现取（引擎持旧引用，改名只落在 data 上），取不到
	 * 才退回 id 的 basename——与 MediaItem.name 的缺省口径一致。
	 */
	private url(id: string, params: MediaSourceParams): string {
		const item = (this.data.items as MediaItem[]).find((m) => m.id == id)
		return (this.data.source as MediaSource | null)?.getUrl(id, {
			...params,
			name: item?.name ?? basename(id),
		}) ?? ''
	}

	private zoomSrc(id: string, zoom: number): string {
		return this.url(id, { zoom })
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
		return this.url(id, { raw: true })
	}

	// ---------- 待裁决项改名 ----------

	/**
	 * 改写某个**未裁决**项的展示名。
	 *
	 * 只有当前待裁决对里的项可改——它们按定义尚未产生裁决记录，因此 id 引用的
	 * 仍是未改动的原始项，改名不会与引擎状态或快照脱节；已裁决项走编辑面板
	 * （openEditor）。
	 *
	 * 引擎按 id（源自宿主，playlist-rank-web 用「歌名 - 歌手」）取直链，所以
	 * 改名只影响**显示**；要让新歌名参与检索需重新开始排名。
	 */
	renameItem(pc: PairCard, name: string) {
		this.patchPending(pc, (item) => ({ ...item, name: name.trim() || item.name || basename(item.id) }))
	}

	/** 改写某个未裁决项的元数据（时长/尺寸等徽标文本）。 */
	renameMeta(pc: PairCard, meta: string) {
		this.patchPending(pc, (item) => ({ ...item, meta: meta.trim() }))
	}

	/**
	 * 未裁决项的原地改写：定位待裁决对中的原始项 → 替换 items → 重建派生状态。
	 *
	 * 补丁基底从 data.items 按 id 现取，而**不是**引擎返回的 cmp.a/cmp.b——
	 * 引擎持有 start() 时的旧引用，若用旧对象做基底，连续两次编辑（先改名再改
	 * 元数据）会让后一次把前一次的改动整个回退掉。
	 */
	private patchPending(pc: PairCard, patch: (item: MediaItem) => MediaItem) {
		const cmp = this.currentPair()
		if (!cmp || (pc.id != cmp.a.id && pc.id != cmp.b.id)) return
		const item = (this.data.items as MediaItem[]).find((m) => m.id == pc.id)
			?? (pc.id == cmp.a.id ? cmp.a : cmp.b)
		const next = patch(item)
		if (next.name == item.name && next.meta == item.meta) return
		const items = (this.data.items as MediaItem[]).map((m) => (m.id == item.id ? next : m))
		Object.assign(this.data, { items })
		// sync() 会据此重建 pairCards / 播放列表行
		this.sync()
		this.dispatchEvent(new CustomEvent('rank-rename', {
			bubbles: true,
			composed: true,
			detail: { id: item.id, name: next.name, meta: next.meta ?? '' },
		}))
	}

	// ---------- 已裁决项编辑 ----------

	/**
	 * 打开编辑面板。
	 *
	 * `decided` 决定面板默认勾不勾「丢弃原裁决」：已裁决项勾上（默认安全），
	 * 未裁决项不勾（没有裁决可丢）。名称/元数据是纯展示信息，改动不影响裁决；
	 * 改 id 则是换了另一首，旧 id 在裁决日志里已不成立。
	 */
	openEditor(item: { id: string }) {
		const cur = (this.data.items as MediaItem[]).find((m) => m.id == item.id)
		if (!cur)
			return
		const decided = this.hasVerdictsFor(item.id)
		Object.assign(this.data, {
			editId: cur.id,
			editNewId: cur.id,
			editName: cur.name ?? basename(cur.id),
			editMeta: cur.meta ?? '',
			editDiscard: decided,
			editDecided: decided,
			editError: '',
		})
	}

	closeEditor() {
		Object.assign(this.data, { editId: '', editError: '' })
	}

	/** 手动切换「丢弃原裁决」（默认由是否已裁决决定）。 */
	editToggleDiscard() {
		Object.assign(this.data, { editDiscard: !this.data.editDiscard })
	}

	/** 该项是否已卷入裁决（日志里出现过它）。 */
	private hasVerdictsFor(id: string): boolean {
		const r = this.fj ?? this.topK ?? this.verify
		if (!r || r.comparisonsMade == 0)
			return false
		return r.comparisonsUpTo(r.comparisonsMade).some(([a, b]) => a.id == id || b.id == id)
	}

	/**
	 * 提交编辑。
	 *
	 * - 名称 / 元数据：纯展示信息，改动不动 id，裁决保持有效。
	 * - id：引擎与快照的唯一键。改 id 意味着换了另一首，旧裁决无法沿用
	 *   （answers 是位置日志，见 verdict-log.ts），故改 id **一律**丢弃并回退
	 *   重做，不受「丢弃」勾选影响——保留旧裁决只会与新 id 矛盾。
	 * - 丢弃勾选：已裁决项可主动要求丢弃（连 id 一起回退到首次出场之前）。
	 *
	 * 新 id 不得与现有任一项重复：id 是重放的唯一键，重复会让「裁决与比较
	 * 不符」且无法区分两条记录。
	 */
	submitEditor() {
		const oldId = this.data.editId as string
		const item = (this.data.items as MediaItem[]).find((m) => m.id == oldId)
		if (!item) {
			this.closeEditor()
			return
		}
		const rawId = (this.data.editNewId as string).trim()
		const newId = rawId || oldId
		const name = (this.data.editName as string).trim() || basename(newId)
		const meta = (this.data.editMeta as string).trim()
		if (newId != oldId && (this.data.items as MediaItem[]).some((m) => m.id == newId)) {
			Object.assign(this.data, { editError: `「${newId}」已存在于候选中，请换一个不重复的标识` })
			return
		}
		const idChanged = newId != oldId
		// 改 id 隐含丢弃（裁决日志按 id 记录，旧裁决已不成立）
		const discard = idChanged || (this.data.editDiscard as boolean)
		const decided = this.hasVerdictsFor(oldId)
		const next: MediaItem = { ...item, id: newId, name, meta }
		const items = (this.data.items as MediaItem[]).map((m) => (m.id == oldId ? next : m))
		Object.assign(this.data, { items, editId: '', editError: '' })
		// 改 id 一定要重建引擎：它持有 start() 时的 items 引用，只改 data.items
		// 会让引擎与展示各持一份 id（后续裁决将错配）。仅改展示信息时 sync() 即可，
		// 其 latest() 覆盖会按 id 取到新名称。
		if (idChanged || (discard && decided))
			this.rebuildFrom(items, oldId)
		else
			this.sync()
		this.dispatchEvent(new CustomEvent('rank-rename', {
			bubbles: true,
			composed: true,
			detail: {
				id: newId,
				previousId: oldId,
				name,
				meta,
				discardedVerdicts: discard && decided,
			},
		}))
	}

	/** 当前引擎的裁决日志副本（三模式统一取出）。 */
	private currentAnswers(): string[] {
		if (this.fj) return this.fj.toJSON().answers
		if (this.topK) return this.topK.toJSON().answers
		return this.verify ? this.verify.toJSON().answers : []
	}

	/**
	 * 依新 items 重建引擎，并丢弃被改项首次出场之后的全部裁决。
	 *
	 * 回退点由**旧**引擎重放定位（旧 items 尚完好），新引擎只继承该前缀——
	 * 其后的每一步都建立在被改项之上，必须重做。
	 *
	 * 前 k 名模式有个额外约束：淘汰赛签表由候选 id 派生种子确定性洗牌得出
	 * （见 top-k.ts 的 seededShuffle），故**任何**一项改 id 都会重排整张签表，
	 * 已答裁决全部失配——此时必须从零重做，不能只回退到该曲目的首次出场。
	 */
	private rebuildFrom(items: readonly MediaItem[], changedId: string) {
		const mode = this.data.mode as RankMode
		const answers = this.currentAnswers()
		const first = (this.fj ?? this.topK ?? this.verify)!.comparisonsUpTo(answers.length)
			.findIndex(([a, b]) => a.id == changedId || b.id == changedId)
		// topK：签表随 id 变 ⇒ 全部作废；其余模式：回退到该曲目首次出场之前
		const keep = mode == 'topK' ? 0 : first < 0 ? answers.length : first
		const target = this.data.target as number
		this.fj = null
		this.topK = null
		this.verify = null
		if (mode == 'precise')
			this.fj = new MergeInsertionRunner(items, answers.slice(0, keep))
		else if (mode == 'topK')
			this.topK = new TopKRunner(items, target, answers.slice(0, keep))
		else
			this.verify = new VerifyOrderRunner(items, answers.slice(0, keep))
		this.resetChainState()
		this.sync()
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
		else if (this.data.mode == 'verify')
			this.verify!.decide(pc.id)
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

	// ---------- 播放列表连播（结果视图） ----------

	/**
	 * 从头连续播放排名列表：每次播放一首，播完自动接下一首。
	 *
	 * 与对局连播（待裁决行的行内播放器顺序播放）相互独立：任一开始播放都会
	 * 暂停对方（沿用组件的单实例约定），互不干扰。
	 */
	playPlaylist() {
		const rows = this.data.playlistRows as RankRow[]
		if (!rows.length)
			return
		this.stopPlaylist()
		const first = rows[0]!
		if (first.kind != 'audio') {
			// 非纯音频列表（如图片/视频）无整列连播可言，退化为逐行手动播放
			Object.assign(this.data, { playlistIndex: -1, playlistPlaying: false })
			return
		}
		Object.assign(this.data, { playlistIndex: 0, playlistPlaying: true })
		this.playPlaylistStep()
	}

	/** 播放当前下标的一首并安排下一首（定时驱动，对后台标签页 rAF 暂停免疫）。 */
	private playPlaylistStep() {
		const rows = this.data.playlistRows as RankRow[]
		const i = this.data.playlistIndex as number
		const row = rows[i]
		const player = this.playlistPlayer
		if (!row || !player) {
			this.stopPlaylist()
			return
		}
		player.src = this.rawSrc(row.id)
		player.currentTime = 0
		this.playMedia(player)
		if (this.playlistTimer === undefined)
			this.playlistTimer = setInterval(() => this.playlistTick(), 400)
	}

	private playlistTick() {
		const player = this.playlistPlayer
		if (!player)
			return
		if (!this.data.playlistPlaying)
			return
		// 播完当前这首（或播放出错）→ 接下一首
		if (!player.paused && (player.ended || player.error))
			this.nextPlaylistStep()
	}

	private nextPlaylistStep() {
		const rows = this.data.playlistRows as RankRow[]
		const i = (this.data.playlistIndex as number) + 1
		if (i >= rows.length) {
			this.stopPlaylist()
			return
		}
		Object.assign(this.data, { playlistIndex: i })
		this.playPlaylistStep()
	}

	stopPlaylist() {
		if (this.playlistTimer !== undefined) {
			clearInterval(this.playlistTimer)
			this.playlistTimer = undefined
		}
		const player = this.playlistPlayer
		if (player)
			player.pause()
		Object.assign(this.data, { playlistIndex: -1, playlistPlaying: false })
	}

	/** 结果视图里点某一行：立即从该首开始连播。 */
	playPlaylistFrom(row: RankRow) {
		const rows = this.data.playlistRows as RankRow[]
		const i = rows.findIndex((r) => r.id == row.id)
		if (i < 0)
			return
		this.stopPlaylist()
		if (rows[i]!.kind != 'audio') {
			this.openViewer(row)
			return
		}
		Object.assign(this.data, { playlistIndex: i, playlistPlaying: true })
		this.playPlaylistStep()
	}

	// ---------- 播放：自动连播与单实例 ----------

	private pauseAllMedia() {
		for (const m of this.querySelectorAll<HTMLMediaElement>('audio,video')) {
			// 行播放器的 onended 负责对局 A→B 推进，打开查看层时一并清除，
			// 关闭后由连播巡检重新挂上
			m.onended = null
			m.pause()
		}
	}

	/** 事件目标是否为待裁决对的行内播放器（对局连播的载体）。 */
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
	/** 当前对局中承接自上一轮的曲目 id（不重播；空串 = 无衔接） */
	private chainCarriedId = ''
	private chainUserPaused = false
	private autoplayTimer: ReturnType<typeof setInterval> | undefined
	/** ref="playlistPlayer"：播放列表视图的整列连播播放器（同样位于静态模板区） */
	playlistPlayer: HTMLAudioElement | null = null

	/**
	 * 对局连播没有独立播放器：直接顺序播放待裁决两行**各自的行内播放器**
	 * （待裁决 ol，data-role="pair-list"）。行节点在 sync 间原地合并、不被替换，
	 * 行内播放器的播放状态因此可靠；进入新对局时行内容重合并，src 由绑定更新。
	 */
	private stageRowAudio(): HTMLAudioElement | null {
		const p = this.chainPair
		if (!p || this.chainStage == 'done')
			return null
		const id = this.chainStage == 'a' ? p.a.id : p.b.id
		const i = (this.data.pairCards as PairCard[]).findIndex((pc) => pc.id == id)
		if (i < 0)
			return null
		return this.querySelectorAll<HTMLAudioElement>('[data-role=pair-list] > li audio')[i] ?? null
	}

	/** 播放当前阶段那一行的行内播放器，并挂 ended 推进。 */
	private playStageRow() {
		const audio = this.stageRowAudio()
		if (!audio)
			return
		audio.onended = () => this.advanceChain()
		this.playMedia(audio)
	}

	/** A 播完接续 B；B 为衔接项（上一轮已播）时跳过并等待裁决。 */
	private advanceChain() {
		const p = this.chainPair
		if (!p || this.chainStage == 'done') {
			this.chainStage = 'done'
			return
		}
		if (this.chainStage == 'a') {
			this.chainStage = 'b'
			if (p.b.id == this.chainCarriedId) {
				// 衔接项不重播：A（新曲）播完即等待裁决
				this.chainStage = 'done'
				return
			}
			this.playStageRow()
		} else {
			this.chainStage = 'done'
		}
	}

/** 当前引擎的待裁决对（精确/前 k 名取当前比较对；校验模式取相邻对，
	 *  a = 上一首、b = 当前曲，符合「当前是否比上一首更好听」的听感）。 */
	private currentPair(): { a: MediaItem; b: MediaItem } | null {
		const mode = this.data.mode as RankMode
		if (mode == 'precise')
			return this.fj?.comparison ?? null
		if (mode == 'verify')
			return this.verify?.comparison ?? null
		const cmp = this.topK?.comparison
		return cmp ? { a: cmp.a, b: cmp.b } : null
	}

	/**
	 * 连播巡检（定时驱动，对 cydon 渲染时序与后台标签页的 rAF 暂停免疫）：
	 * 待裁决对变化（开赛/裁决推进/恢复）时，自动播放两行各自的行内播放器
	 * 先 A 后 B；用户手动暂停行播放器时不强行恢复。纯图片对局或含视频的
	 * 对局跳过自动连播。
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
		// 播放衔接：新对局包含上一轮已播的曲目（chainCarriedId，与 pairCards 的
		// carried 行一致）时不重播，只播新的一首——插入链中即「败者锚点只在
		// 首次比较时完整播放」（播放次数 ≈ 比较次数 + n，对两种排序模式生效）
		const carriedId = (this.data.pairCards as PairCard[]).find(pc => pc.carried)?.id ?? ''
		const shared = this.chainPair != null && carriedId != ''
			&& (p.a.id == carriedId || p.b.id == carriedId)
		this.chainCarriedId = shared ? carriedId : ''
		this.chainPair = p
		if (shared) {
			// 从新曲一侧开始播；衔接项不重播（advanceChain 亦会跳过）
			this.chainStage = p.a.id == carriedId ? 'b' : 'a'
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
		const n = this.items.length
		// 上一轮展示的行：衔接判定（新对局包含其中一首 → 该首作为「上一首」首行）
		const prevRows = this.data.pairCards as PairCard[]
		/**
		 * 引擎持有 start() 时的 items 引用，改名只落在 data.items 上；
		 * 因此按 id 用 data.items 的最新展示信息覆盖引擎返回的项。
		 */
		const latest = (m: MediaItem): MediaItem =>
			(this.data.items as MediaItem[]).find(x => x.id == m.id) ?? m
		const buildPair = (cmp: { a: MediaItem; b: MediaItem }): PairCard[] => {
			const a = latest(cmp.a), b = latest(cmp.b)
			if ((a.kind ?? 'image') != 'audio' || (b.kind ?? 'image') != 'audio')
				return [pairCard(0, a), pairCard(0, b)]
			// 同一对重渲染（如改名后 sync）：保持原行序与 carried 标记，只刷新展示
			// 信息。carry 是「新对局衔接上一轮」的规则——同一对不该重排，否则编辑
			// 第二行会让它跳到第一行、序号错乱，且被标「上一首」后无法重听刚改名
			// 的曲目。
			const samePair = prevRows.length == 2
				&& ((prevRows[0]!.id == a.id && prevRows[1]!.id == b.id)
					|| (prevRows[0]!.id == b.id && prevRows[1]!.id == a.id))
			if (samePair)
				return prevRows.map((pc) => pairCard(0, pc.id == a.id ? a : b, pc.carried))
			return carryPair(prevRows, a, b)
				.map(({ item, carried }) => pairCard(0, item, carried))
		}

		let completed: boolean
		let result: RankResult | null = null
		let round = 0
		let candidatesLeft = 0
		let pendingCount = 0
		let pairCards: PairCard[] = []
		let playlistRows: RankRow[] = []
		let snapshot: RankSnapshot
		// 校验模式的结论数据（不属于 RankResult，单独派发）
		let verified = false
		let inversionCount = 0
		let inversionRows: RankRow[] = []

		if (mode == 'precise') {
			const fj = this.fj!
			completed = fj.completed
			round = fj.comparisonsMade
			candidatesLeft = fj.size
			const cmp = fj.comparison
			pendingCount = cmp ? 1 : 0
			if (cmp)
				pairCards = buildPair(cmp)
			snapshot = fj.toJSON()
			if (completed)
				result = { ranking: fj.ranking!, survivors: fj.ranking!.slice(0, target), rounds: [] }
		} else if (mode == 'topK') {
			const tk = this.topK!
			completed = tk.completed
			round = tk.comparisonsMade
			candidatesLeft = tk.size - tk.extractedCount
			const cmp = tk.comparison
			pendingCount = cmp ? 1 : 0
			if (cmp)
				pairCards = buildPair(cmp)
			snapshot = tk.toJSON()
			if (completed)
				result = { ranking: tk.ranking!, survivors: tk.ranking!, rounds: [] }
		} else {
			const vf = this.verify!
			completed = vf.completed
			round = vf.comparisonsMade
			candidatesLeft = vf.size
			const cmp = vf.comparison
			pendingCount = cmp ? 1 : 0
			if (cmp)
				pairCards = buildPair(cmp)
			snapshot = vf.toJSON()
			verified = true
			// 顺序错误处：相邻对中「后一项更好听」的那些后项
			inversionRows = rankRows({
				ranking: vf.inversions.map((i) => vf.items[i + 1]!),
				survivors: [],
				rounds: [],
			})
			inversionCount = vf.inversions.length
			if (completed) {
				// 校验不改顺序：原样返回给定顺序，仅标记已校验
				result = { ranking: [...vf.items], survivors: [...vf.items], rounds: [] }
			}
		}
		// 布局：音频走播放列表、其余走两列卡片。取待裁决首项的 kind 即可决定
		// 整对（同对两项同类）；完成后的结果列表同样沿用该布局。
		const audioLayout = pairCards.length > 0
			? (pairCards[0]!.kind == 'audio')
			: (this.items[0]?.kind ?? 'image') == 'audio'
		// 已完成前给出可连续播放的排名列表（播放列表视图的数据源）
		if (result)
			result = { ...result, ranking: result.ranking.map(latest), survivors: result.survivors.map(latest) }
		const estimateTotal = mode == 'precise'
			? (n > 1 ? Math.round(n * Math.log2(n) - 1.44 * n) : 0)
			: mode == 'verify'
				? Math.max(0, n - 1)
				: Math.max(0, (n - 1) + (target - 1) * Math.ceil(Math.log2(Math.max(2, n))))
		if (result) {
			// 顺序约束：稳定拓扑重排，保持有序歌单内的相对顺序（host 负责冲突校验）
			const adj = applyOrderConstraints(result.ranking, this.data.constraints as OrderConstraint[])
			if (!adj.cycle.length)
				result = { ...result, ranking: adj.ranking, survivors: adj.ranking.slice(0, result.survivors.length) }
			playlistRows = rankRows(result)
		}
		const extractedCount = result?.ranking.length ?? (mode == 'topK' ? this.topK!.extractedCount : 0)
		clearTimeout(this.previewTimer)
		Object.assign(this.data, {
			started: true,
			completed,
			mode,
			round,
			candidatesLeft,
			totalCount: n,
			target,
			extractedCount,
			estimateTotal,
			survivorsCount: result?.survivors.length ?? 0,
			pairCards,
			audioLayout,
			playlistRows,
			verified,
			inversionCount,
			inversionRows,
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
