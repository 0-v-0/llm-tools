import type { MediaItem, PairRecord, RankResult, TournamentRound } from './types.ts'

export interface PendingPair {
	index: number
	a: MediaItem
	b: MediaItem
}

/**
 * 状态机完整快照：恢复用。配对经 shuffle 非确定，中断恢复必须序列化
 * 全量内部状态（候选序/待裁决对/轮空/轮次日志），仅回放裁决记录无法重建
 * 同样的对局。
 */
export interface TournamentSnapshot {
	kind: 'elimination'
	target: number
	round: number
	/** 当前候选（含本轮轮空项，顺序即收束后的名次序） */
	candidates: MediaItem[]
	/** 本轮已胜出项（对局胜者 + 轮空），closeRound 时并入 candidates */
	winners: MediaItem[]
	/** 本轮已记录的对局裁决 */
	roundPairs: PairRecord[]
	pending: PendingPair[]
	byes: MediaItem[]
	rounds: TournamentRound[]
}

/** 就地 Fisher–Yates 洗牌，避免固定候选序导致配对偏置。 */
function shuffle<T>(arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
	}
	return arr
}

/**
 * 单败淘汰锦标赛状态机：逐轮两两配对、每对保留 1 张（另一张出局记入轮次
 * 日志）、奇数轮空自动保留，候选收敛到 target 以内结束。
 *
 * 同步纯逻辑、无 IO。淘汰顺序即排名依据：存活者名次最高，越晚被淘汰名次
 * 越高。宿主可通过监听组件事件（或自行封装本类）持久化每轮裁决。
 */
export class TournamentRunner {
	readonly target: number
	/** 当前轮次（从 1 起；候选已收敛时为最后一轮的轮次，从未开赛则为 0） */
	round = 0
	/** 本轮待裁决对局；空且 completed 为 true 表示已收束 */
	pending: PendingPair[] = []
	/** 本轮轮空项（自动保留） */
	byes: MediaItem[] = []

	private candidates: MediaItem[]
	private winners: MediaItem[] = []
	private roundPairs: PairRecord[] = []
	private rounds: TournamentRound[] = []

	constructor(items: readonly MediaItem[], target = 1) {
		this.target = Math.max(1, target)
		this.candidates = [...items]
		if (this.candidates.length > this.target)
			this.startRound()
	}

	/** 是否已收束（候选数 ≤ target 且无待裁决对局） */
	get completed(): boolean {
		return this.pending.length == 0 && this.candidates.length <= this.target
	}

	/** 剩余候选数（含本轮轮空） */
	get candidatesLeft(): number {
		return this.candidates.length
	}

	/** 已完成的轮次日志 */
	get roundsLog(): readonly TournamentRound[] {
		return this.rounds
	}

	/** 开启新一轮：洗牌、两两配对、奇数轮空。调用前提是候选数 > target。 */
	startRound(): void {
		this.round++
		const pool = shuffle([...this.candidates])
		this.pending = []
		this.byes = []
		this.winners = []
		this.roundPairs = []
		for (let i = 0; i + 1 < pool.length; i += 2)
			this.pending.push({ index: this.pending.length, a: pool[i]!, b: pool[i + 1]! })
		if (pool.length % 2 == 1) {
			// 奇数轮空：自动保留，直接进入下一轮候选
			const bye = pool[pool.length - 1]!
			this.byes.push(bye)
			this.winners.push(bye)
		}
	}

	/** 裁决一对：保留 keptId 对应项，另一项出局。本轮全部裁决完自动推进。 */
	decide(pairIndex: number, keptId: string): void {
		const idx = this.pending.findIndex((p) => p.index == pairIndex)
		if (idx < 0)
			throw new Error(`未知对局序号：${pairIndex}`)
		const pair = this.pending[idx]!
		const kept = pair.a.id == keptId ? pair.a : pair.b.id == keptId ? pair.b : null
		if (!kept)
			throw new Error(`keptId 不在对局 ${pairIndex} 中：${keptId}`)
		const eliminated = kept == pair.a ? pair.b : pair.a
		this.pending.splice(idx, 1)
		this.winners.push(kept)
		this.roundPairs.push({ kept, eliminated })
		if (this.pending.length == 0)
			this.closeRound()
	}

	private closeRound(): void {
		this.rounds.push({ round: this.round, pairs: this.roundPairs, byes: [...this.byes] })
		this.candidates = [...this.winners]
		this.pending = []
		this.byes = []
		this.roundPairs = []
		if (this.candidates.length > this.target)
			this.startRound()
	}

	/** 导出排名结果。仅在 completed 后可调用。 */
	getResult(): RankResult {
		if (!this.completed)
			throw new Error('锦标赛尚未收束')
		return {
			survivors: [...this.candidates],
			ranking: [
				...this.candidates,
				...this.rounds.flatMap((r) => r.pairs.map((p) => p.eliminated)).reverse(),
			],
			rounds: this.rounds.map((r) => ({ ...r, pairs: [...r.pairs], byes: [...r.byes] })),
		}
	}

	/** 导出完整快照（深拷贝，与内部状态解耦），供宿主持久化。 */
	toJSON(): TournamentSnapshot {
		const cloneItem = (m: MediaItem): MediaItem => ({ ...m })
		return {
			kind: 'elimination',
			target: this.target,
			round: this.round,
			candidates: this.candidates.map(cloneItem),
			winners: this.winners.map(cloneItem),
			roundPairs: this.roundPairs.map((p) => ({ kept: cloneItem(p.kept), eliminated: cloneItem(p.eliminated) })),
			pending: this.pending.map((p) => ({ index: p.index, a: cloneItem(p.a), b: cloneItem(p.b) })),
			byes: this.byes.map(cloneItem),
			rounds: this.rounds.map((r) => ({
				round: r.round,
				pairs: r.pairs.map((p) => ({ kept: cloneItem(p.kept), eliminated: cloneItem(p.eliminated) })),
				byes: r.byes.map(cloneItem),
			})),
		}
	}

	/** 从快照恢复状态机。快照损坏（缺字段/类型不符）时抛错。 */
	static fromJSON(data: TournamentSnapshot): TournamentRunner {
		const bad = (what: string): never => {
			throw new Error(`无效的锦标赛快照：${what}`)
		}
		if (typeof data != 'object' || data == null || data.kind != 'elimination')
			bad('不是淘汰赛快照')
		if (!Number.isInteger(data.target) || data.target < 1)
			bad('target')
		if (!Number.isInteger(data.round) || data.round < 0)
			bad('round')
		for (const [key, guard] of [
			['candidates', (m: unknown) => typeof (m as MediaItem)?.id == 'string'],
			['winners', (m: unknown) => typeof (m as MediaItem)?.id == 'string'],
			['roundPairs', (p: unknown) => typeof (p as PairRecord)?.kept?.id == 'string' && typeof (p as PairRecord)?.eliminated?.id == 'string'],
			['byes', (m: unknown) => typeof (m as MediaItem)?.id == 'string'],
		] as const) {
			const arr = (data as unknown as Record<string, unknown>)[key]
			if (!Array.isArray(arr) || !arr.every(guard))
				bad(key)
		}
		if (!Array.isArray(data.pending) || !data.pending.every((p) => Number.isInteger(p?.index) && typeof p?.a?.id == 'string' && typeof p?.b?.id == 'string'))
			bad('pending')
		if (!Array.isArray(data.rounds) || !data.rounds.every((r) => Number.isInteger(r?.round) && Array.isArray(r?.pairs) && Array.isArray(r?.byes)))
			bad('rounds')

		const r = new TournamentRunner([], data.target)
		r.round = data.round
		r.candidates = data.candidates.map((m) => ({ ...m }))
		r.winners = data.winners.map((m) => ({ ...m }))
		r.roundPairs = data.roundPairs.map((p) => ({ kept: { ...p.kept }, eliminated: { ...p.eliminated } }))
		r.pending = data.pending.map((p) => ({ index: p.index, a: { ...p.a }, b: { ...p.b } }))
		r.byes = data.byes.map((m) => ({ ...m }))
		r.rounds = data.rounds.map((rd) => ({
			round: rd.round,
			pairs: rd.pairs.map((p) => ({ kept: { ...p.kept }, eliminated: { ...p.eliminated } })),
			byes: rd.byes.map((m) => ({ ...m })),
		}))
		// 不应出现「无待裁决且候选未收束」的快照（轮次推进是同步的）；兜底开新一轮
		if (r.pending.length == 0 && r.candidates.length > r.target)
			r.startRound()
		return r
	}
}
