import type { MediaItem } from './types.ts'

/** 精确模式（Ford-Johnson 合并插入排序）快照：保存候选与裁决记录，
	恢复 = 按序重放（比较序列确定于先前的裁决）。 */
export interface PreciseSnapshot {
	kind: 'precise'
	items: MediaItem[]
	/** 精确全排序：target = items.length（记录以保持快照契约一致） */
	target: number
	/** 第 i 次比较中更好一项的 id（按比较发生顺序） */
	answers: string[]
}

type Cmp = [MediaItem, MediaItem]

/**
 * Ford-Johnson（合并插入排序）的比较序列生成器。
 *
 * 结构：候选两两配对比较 → 胜者递归排序成主链（升序：最差在前）→ 败者按
 * Jacobsthal 分组顺序（[0], [2,1], [4,3], [10..5], [20..11]…）有界二分插入
 * （a_i < b_i 把插入位置限制在 b_i 之前的前缀内，Jacobsthal 顺序使每组
 * 插入的二分范围 ≤ 2^k − 1，从而达到 FJ 的比较次数上界）；奇数尾项最后
 * 无界二分插入。输出最优在前的前序（内部升序链反转）。
 *
 * yield 一对候选（请求裁决：哪个更好），receive 更好一项；返回完整排名。
 */
function* fjSort(items: readonly MediaItem[]): Generator<Cmp, MediaItem[], string> {
	// 约定：返回升序链（最差在前）——败者插入的前缀边界依赖此方向；
	// 最优在前由调用方（MergeInsertionRunner）反转得到。
	if (items.length < 2)
		return [...items]
	const winners: MediaItem[] = []
	const loserOf = new Map<string, MediaItem>()
	for (let i = 0; i + 1 < items.length; i += 2) {
		const betterId: string = yield [items[i]!, items[i + 1]!]
		const better = betterId == items[i]!.id ? items[i]! : items[i + 1]!
		const loser = better.id == items[i]!.id ? items[i + 1]! : items[i]!
		winners.push(better)
		loserOf.set(better.id, loser)
	}
	const straggler = items.length % 2 == 1 ? items[items.length - 1]! : null
	// 递归排序胜者 → 升序主链（最差在前）
	const chain: MediaItem[] = yield* fjSort(winners)
	const base = [...chain]
	// a_1：最差胜者的败者，位置强制（插到链首），0 次比较
	const w0 = base[0]!
	const l0 = loserOf.get(w0.id)
	if (l0)
		chain.unshift(l0)
	// 其余败者按 Jacobsthal 组插入：[2,1], [4,3], [10..5], [20..11]…
	{
		const k = base.length
		let prev = 1
		let a = 3
		let b = 5
		while (prev < k) {
			for (let i = Math.min(a, k) - 1; i >= prev; i--) {
				const winner = base[i]!
				const loser = loserOf.get(winner.id)
				if (!loser)
					continue
				// 有界二分：loser < winner → 插入位置 ∈ [0, winner 当前下标]（含端点）
				let lo = 0
				let hi = chain.findIndex((c) => c.id == winner.id)
				while (lo < hi) {
					const mid = (lo + hi) >> 1
					const betterId: string = yield [loser, chain[mid]!]
					if (betterId == loser.id)
						lo = mid + 1
					else
						hi = mid
				}
				chain.splice(lo, 0, loser)
			}
			prev = a
			;[a, b] = [b, b + 2 * a]
		}
	}
	// 奇数尾项：无先验边界，整链二分（经校准此位置最接近经典 FJ 次数；
	// n=5/9 最坏比经典多 1 次，见 tests/merge-insertion.test.ts 的容差断言）
	if (straggler) {
		let lo = 0
		let hi = chain.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const betterId: string = yield [straggler, chain[mid]!]
			if (betterId == straggler.id)
				lo = mid + 1
			else
				hi = mid
		}
		chain.splice(lo, 0, straggler)
	}
	return chain
}

/**
 * Ford-Johnson 精确排序交互引擎：每次提供一个待比较对（A、B），裁决后
 * 推进到下一对，收束后给出经认证的完整排名（最优在前）。
 *
 * 比较序列确定于先前的裁决序列——所有查询经「重放 answers」得出，
 * 快照即 { items, answers }，恢复零成本。每次查询重放 O(比较数) 步，
 * 纯逻辑、无副作用。
 */
export class MergeInsertionRunner {
	constructor(
		private readonly items: readonly MediaItem[],
		private readonly answers: string[] = [],
	) {}

	private replay(): { cmp: Cmp | null; ranking: MediaItem[] | null } {
		const gen = fjSort(this.items)
		let step = gen.next()
		let i = 0
		while (!step.done && i < this.answers.length) {
			const [x, y] = step.value
			const ans = this.answers[i]!
			if (ans != x.id && ans != y.id)
				throw new Error('无效的精确模式快照：裁决与比较不符')
			step = gen.next(ans)
			i++
		}
		if (step.done)
			return { cmp: null, ranking: [...step.value].reverse() }
		return { cmp: step.value, ranking: null }
	}

	/** 是否已收束（全部比较完成） */
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

	/** 候选总数 */
	get size(): number {
		return this.items.length
	}

	/** 完整排名（最优在前）；仅 completed 后非空 */
	get ranking(): MediaItem[] | null {
		return this.replay().ranking
	}

	/** 裁决当前比较：betterId 为 A/B 之一 */
	decide(betterId: string): void {
		const cmp = this.comparison
		if (!cmp)
			throw new Error('精确模式已完成，无待裁决比较')
		if (betterId != cmp.a.id && betterId != cmp.b.id)
			throw new Error(`betterId 不在当前比较中：${betterId}`)
		this.answers.push(betterId)
	}

	toJSON(): PreciseSnapshot {
		return { kind: 'precise', items: [...this.items], target: this.items.length, answers: [...this.answers] }
	}
}
