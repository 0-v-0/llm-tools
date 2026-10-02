import type { MediaItem } from './types.ts'
import { firstVerdictIndex, truncateFor } from './verdict-log.ts'

/** 前 k 名提取（Ford-Johnson 同族的锦标赛选择）快照：重放裁决记录即可恢复
	（knockout 配对使用以候选 id 派生种子的确定性洗牌，重放可复现同一签表）。 */
export interface TopKSnapshot {
	kind: 'topK'
	items: MediaItem[]
	target: number
	/** 第 i 次比较中更好一项的 id（按比较发生顺序） */
	answers: string[]
}

type Cmp = [MediaItem, MediaItem]

/** 以候选 id 派生种子的确定性 Fisher–Yates 洗牌：同一候选序 → 同一配对。 */
function seededShuffle<T extends { id: string }>(arr: readonly T[]): T[] {
	let h = 2166136261
	for (const c of arr)
		for (const ch of c.id) {
			h ^= ch.charCodeAt(0)
			h = Math.imul(h, 16777619)
		}
	const rand = () => {
		h ^= h << 13
		h ^= h >>> 17
		h ^= h << 5
		return (h >>> 0) / 4294967296
	}
	const out = [...arr]
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		;[out[i], out[j]] = [out[j]!, out[i]!]
	}
	return out
}

/**
 * 前 k 名提取的比较序列生成器。
 *
 * 两阶段：
 * 1. knockout：确定性洗牌后逐轮两两比较，败者挂到胜者的「手下败将」表，
 *    直至只剩冠军（n−1 次比较，最优）；
 * 2. 提取：次优必为冠军的直接手下败将——维护一个按已知关系排序的候选
 *    阶梯（二分插入 = 用户比较），每提取一名，将其败将并入阶梯；提取
 *    k − 1 名后收束。每个名次都有比较链支撑（经认证）。
 *
 * yield 一对候选（请求裁决：哪个更好），receive 更好一项；返回前 k 名
 * （最优在前）。
 */
function* topKSort(items: readonly MediaItem[], target: number, ref: { extracted: number }): Generator<Cmp, MediaItem[], string> {
	const children = new Map<string, MediaItem[]>()
	let candidates = [...items]
	// ---- 阶段 1：knockout 至冠军 ----
	while (candidates.length > 1) {
		const pool = seededShuffle(candidates)
		const winners: MediaItem[] = []
		for (let i = 0; i + 1 < pool.length; i += 2) {
			const betterId: string = yield [pool[i]!, pool[i + 1]!]
			const better = betterId == pool[i]!.id ? pool[i]! : pool[i + 1]!
			const loser = better.id == pool[i]!.id ? pool[i + 1]! : pool[i]!
			let kids = children.get(better.id)
			if (!kids) {
				kids = []
				children.set(better.id, kids)
			}
			kids.push(loser)
			winners.push(better)
		}
		if (pool.length % 2 == 1)
			winners.push(pool[pool.length - 1]!)
		candidates = winners
	}
	// ---- 阶段 2：胜者树提取前 k 名 ----
	const ranked: MediaItem[] = [candidates[0]!]
	ref.extracted = 1
	const ladder: MediaItem[] = [] // 候选阶梯，升序（最差在前）
	const insertLadder = function* (x: MediaItem): Generator<Cmp, void, string> {
		let lo = 0
		let hi = ladder.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const betterId: string = yield [x, ladder[mid]!]
			if (betterId == x.id)
				lo = mid + 1
			else
				hi = mid
		}
		ladder.splice(lo, 0, x)
	}
	if (ranked.length < target)
		for (const kid of children.get(ranked[0]!.id) ?? [])
			yield* insertLadder(kid)
	while (ranked.length < target && ladder.length) {
		const next = ladder.pop()!
		ranked.push(next)
		ref.extracted = ranked.length
		if (ranked.length >= target)
			break
		for (const kid of children.get(next.id) ?? [])
			yield* insertLadder(kid)
	}
	return ranked
}

/**
 * 前 k 名提取交互引擎：knockout（n−1 次比较，最优）+ 胜者树逐名提取
 * （每名 ≤ ⌈log₂n⌉ 次比较），产出经认证的前 k 名（最优在前）。
 *
 * 与 MergeInsertionRunner 同构的重放设计：比较序列确定于裁决记录，
 * 快照即 { items, target, answers }。
 */
export class TopKRunner {
	constructor(
		private readonly items: readonly MediaItem[],
		private readonly target: number,
		private readonly answers: string[] = [],
	) {
		if (!(this.target >= 1))
			throw new Error('target 必须 ≥ 1')
	}

	private replay(): { cmp: Cmp | null; ranking: MediaItem[] | null; extracted: number } {
		const ref = { extracted: 0 }
		const gen = topKSort(this.items, this.target, ref)
		let step = gen.next()
		let i = 0
		while (!step.done && i < this.answers.length) {
			const [x, y] = step.value
			const ans = this.answers[i]!
			if (ans != x.id && ans != y.id)
				throw new Error('无效的前 k 名快照：裁决与比较不符')
			step = gen.next(ans)
			i++
		}
		if (step.done)
			return { cmp: null, ranking: step.value, extracted: step.value.length }
		return { cmp: step.value, ranking: null, extracted: ref.extracted }
	}

	/** 是否已提取满 k 名 */
	get completed(): boolean {
		return this.replay().cmp === null
	}

	/** 当前待比较对；已完成时 null */
	get comparison(): { a: MediaItem; b: MediaItem } | null {
		const { cmp } = this.replay()
		return cmp ? { a: cmp[0], b: cmp[1] } : null
	}

	get comparisonsMade(): number {
		return this.answers.length
	}

	/**
	 * 前 `count` 次比较（引擎按 answers 重放得出），至多到已答次数为止。
	 *
	 * 与 MergeInsertionRunner.comparisonsUpTo 同构：比较序列是重放出来的，
	 * 截断点只能这样定位。
	 */
	comparisonsUpTo(count: number): [MediaItem, MediaItem][] {
		const gen = topKSort(this.items, this.target, { extracted: 0 })
		const out: [MediaItem, MediaItem][] = []
		const upto = Math.min(count, this.answers.length)
		let step = gen.next()
		let i = 0
		while (!step.done && i < upto) {
			const [x, y] = step.value
			const ans = this.answers[i]!
			if (ans != x.id && ans != y.id)
				throw new Error('无效的前 k 名快照：裁决与比较不符')
			out.push([...step.value])
			step = gen.next(ans)
			i++
		}
		return out
	}

	/**
	 * 丢弃某曲目的裁决：回退到它首次参与比较之前。
	 *
	 * answers 是位置日志，重放逐位置喂回，抽掉中间几条会让后续记录与比较
	 * 错位——只能整段截断（见 verdict-log.ts）。topK 的一次丢弃通常连带回退
	 * 整支淘汰赛分支（该曲目的胜者树子树都建在这次裁决之上）。
	 */
	discardVerdictsOf(id: string): number {
		const first = firstVerdictIndex(this.comparisonsUpTo(this.answers.length), this.answers.length)
		const keep = truncateFor(first, id, this.answers.length)
		this.answers.length = keep
		return keep
	}

	/** 已提取名次数（进行中亦可查询） */
	get extractedCount(): number {
		return this.replay().extracted
	}

	/** 前 k 名排名（最优在前）；仅 completed 后非空 */
	get ranking(): MediaItem[] | null {
		return this.replay().ranking
	}

	get size(): number {
		return this.items.length
	}

	get k(): number {
		return this.target
	}

	/** 裁决当前比较：betterId 为 A/B 之一 */
	decide(betterId: string): void {
		const cmp = this.comparison
		if (!cmp)
			throw new Error('前 k 名提取已完成，无待裁决比较')
		if (betterId != cmp.a.id && betterId != cmp.b.id)
			throw new Error(`betterId 不在当前比较中：${betterId}`)
		this.answers.push(betterId)
	}

	toJSON(): TopKSnapshot {
		return { kind: 'topK', items: [...this.items], target: this.target, answers: [...this.answers] }
	}
}
