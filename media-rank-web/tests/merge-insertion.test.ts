import { describe, expect, it } from 'vitest'
import { MergeInsertionRunner } from '../src/merge-insertion.ts'
import type { MediaItem } from '../src/types.ts'

const items = (n: number): MediaItem[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))

/** 已知 FJ 最坏情形比较次数（OEIS A001768，下标 = n）。 */
const FJ_OPTIMAL = [0, 0, 1, 3, 5, 7, 10, 13, 16, 19, 22, 26, 30]

/** 本实现的奇数尾项整链二分：n=5/9 最坏比经典 FJ 多 1 次（已校准，见
	src/merge-insertion.ts 注释）。 */
const worstBound = (n: number): number => FJ_OPTIMAL[n]! + (n >= 5 && n % 2 == 1 ? 1 : 0)

/** 以固定质量序 driver：quality(id) 为互不相同的隐藏质量，越大越好。 */
function drive(n: number, perm: number[]): { ranking: string[]; comparisons: number } {
	const its = items(n)
	const quality = new Map<string, number>()
	its.forEach((m, i) => quality.set(m.id, perm[i] ?? i))
	const r = new MergeInsertionRunner(its)
	let guard = n * n + 10
	while (!r.completed) {
		const cmp = r.comparison!
		r.decide(quality.get(cmp.a.id)! > quality.get(cmp.b.id)! ? cmp.a.id : cmp.b.id)
		if (guard-- <= 0)
			throw new Error('未收敛')
	}
	return { ranking: r.ranking!.map((m) => m.id), comparisons: r.comparisonsMade }
}

describe('MergeInsertionRunner', () => {
	it('按真实质量序输出完整排名（答案一致时）', () => {
		const perm = [5, 0, 8, 3, 1, 7, 2, 6, 4]
		const { ranking } = drive(9, perm)
		// 期望 = 按质量降序
		const expected = perm
			.map((q, i) => ({ q, id: `m${i}` }))
			.sort((x, y) => y.q - x.q)
			.map((x) => x.id)
		expect(ranking).toEqual(expected)
	})

	it('比较次数不超过 FJ 已知最优上界（多种输入排列）', () => {
		for (let n = 2; n <= 11; n++) {
			const perms: number[][] = [
				Array.from({ length: n }, (_, i) => i),
				Array.from({ length: n }, (_, i) => n - 1 - i),
				Array.from({ length: n }, (_, i) => (i * 7 + 3) % n),
			]
			for (const perm of perms) {
				const { comparisons } = drive(n, perm)
				expect(comparisons, `n=${n} perm=${perm.join(',')}`).toBeLessThanOrEqual(worstBound(n))
			}
		}
	})

	it('最坏输入下比较次数达到 FJ 最优值（n=1..8 全排列验证）', () => {
		for (let n = 1; n <= 8; n++) {
			let worst = 0
			const perm: number[] = Array.from({ length: n }, (_, i) => i)
			// 枚举全部排列（Heap 算法）
			const c = new Array<number>(n).fill(0)
			worst = Math.max(worst, drive(n, perm.slice()).comparisons)
			let i = 0
			while (i < n) {
				if (c[i]! < i) {
					if (i % 2 == 0) [perm[0], perm[i]] = [perm[i]!, perm[0]!]
					else [perm[c[i]!], perm[i]] = [perm[i]!, perm[c[i]!]!]
					worst = Math.max(worst, drive(n, perm.slice()).comparisons)
					c[i]!++
					i = 0
				} else {
					c[i]! = 0
					i++
				}
			}
			expect(worst, `n=${n}`).toBeLessThanOrEqual(worstBound(n))
		}
	})

	it('回答不一致（违反传递性）时仍可完成排序', () => {
		const its = items(4)
		const r = new MergeInsertionRunner(its)
		// 随意且自相矛盾地回答：总是选第一个
		let guard = 20
		while (!r.completed && guard-- > 0)
			r.decide(r.comparison!.a.id)
		expect(r.completed).toBe(true)
		expect(r.ranking).toHaveLength(4)
	})

	it('快照重放：toJSON → 重建后比较序列与最终排名一致', () => {
		const a = new MergeInsertionRunner(items(9))
		for (let i = 0; i < 5 && !a.completed; i++)
			a.decide(a.comparison!.a.id)
		const snap = a.toJSON()
		const b = new MergeInsertionRunner(snap.items, snap.answers)
		expect(b.comparisonsMade).toBe(a.comparisonsMade)
		expect(b.comparison?.a.id).toBe(a.comparison?.a.id)
		expect(b.comparison?.b.id).toBe(a.comparison?.b.id)
		while (!b.completed)
			b.decide(b.comparison!.a.id)
		while (!a.completed)
			a.decide(a.comparison!.a.id)
		expect(b.ranking!.map((m) => m.id)).toEqual(a.ranking!.map((m) => m.id))
	})

	it('非法输入报错：betterId 不在当前比较中；快照与比较不符', () => {
		const r = new MergeInsertionRunner(items(4))
		expect(() => r.decide('m99')).toThrow()
		// 'm2' 不在首个比较对 [m0, m1] 中（快照校验在重放时进行）
		expect(() => new MergeInsertionRunner(items(4), ['m2']).comparison).toThrow()
	})

	it('边界：0/1 个候选直接完成', () => {
		expect(new MergeInsertionRunner([]).completed).toBe(true)
		expect(new MergeInsertionRunner(items(1)).ranking).toEqual([{ id: 'm0' }])
	})
})

/**
 * 链演化不变量：精确模式维护的始终是一条哈密顿路径（全序），但维护方式是
 * **增量插入**而非「按全部已有偏序全局重排」——后者在一般情况下 NP 难，且
 * 达不到 FJ 的 n·log₂n − 1.44n 下界。
 *
 * 这组断言把该性质固化（经 runner.observer 观测真实引擎的内部链，非复刻实现）。
 */
describe('MergeInsertionRunner 链演化', () => {
	interface Step {
		chain: string[]
		anchor: string
		index: number
		depth: number
	}
	/**
	 * 驱动一次完整排序，收集**最外层**（depth 0）的链快照（升序：最差在前）。
	 *
	 * runner 的每次查询都从 answers 完整重放生成器，观察器因而报告**整条历史**。
	 * 这里在每次查询前采集一次，并只取 depth 0 的**末条**——即「上一次裁决后
	 * 该层链的终态」。末条之外的历史步骤由后续相邻比较断言覆盖。
	 */
	function trace(n: number, pick: (a: string, b: string) => string): Step[] {
		const steps: Step[] = []
		const r = new MergeInsertionRunner(items(n))
		let collected: Step[] = []
		r.observer = (chain, step) =>
			collected.push({ chain: chain.map((m) => m.id), ...step })
		let guard = n * n + 10
		while (!r.completed && guard-- > 0) {
			const outer = collected.filter((s) => s.depth == 0)
			if (outer.length) steps.push(outer[outer.length - 1]!)
			collected = []
			const cmp = r.comparison! // 本次查询触发重放，填充 collected
			r.decide(pick(cmp.a.id, cmp.b.id))
		}
		// 收尾：最后一次重放（含全部裁决）后的 depth 0 终态
		const outer = collected.filter((s) => s.depth == 0)
		if (outer.length) steps.push(outer[outer.length - 1]!)
		expect(r.completed).toBe(true)
		return steps
	}

	/** 以隐藏质量驱动（id → 质量，越大越好），得到一致的裁决序列。 */
	const byQuality = (perm: number[]) => {
		const q = new Map(perm.map((v, i) => [`m${i}`, v]))
		return (a: string, b: string) => (q.get(a)! > q.get(b)! ? a : b)
	}

	it('链是全序：元素不重不漏，长度单调递增至 n', () => {
		for (const n of [2, 3, 5, 8, 12]) {
			const steps = trace(n, byQuality([...Array(n).keys()].reverse()))
			expect(steps.length).toBeGreaterThan(0)
			let prevLen = 0
			for (const s of steps) {
				// 全序 = 无重复；链随插入逐步增长（中途长度小于 n 属正常）
				expect(new Set(s.chain).size).toBe(s.chain.length)
				expect(s.chain.length).toBeGreaterThanOrEqual(prevLen)
				prevLen = s.chain.length
			}
			// 终态链恰好覆盖全部候选
			expect(steps.at(-1)!.chain.length).toBe(n)
		}
	})

	it('每步只插入一个元素，其余元素相对次序保持不变（局部增量，非全局重排）', () => {
		// 质量序与初始数组序相反：迫使败者被插到链的前部，最大化重排压力
		const perm = [...Array(9).keys()].reverse()
		const steps = trace(9, byQuality(perm))
		// 相邻两步之间，前一步链去掉新插入的元素，应与后一步的相对次序一致
		for (let i = 1; i < steps.length; i++) {
			const prev = steps[i - 1]!.chain
			const cur = steps[i]!.chain
			// 后一步链中删掉新元素（anchor 位置可能移动，用集合差定位）
			const added = cur.find(id => !prev.includes(id))!
			const curWithoutAdded = cur.filter(id => id != added)
			// 剩余元素的相对次序必须与前一步完全相同
			expect(curWithoutAdded).toEqual(prev)
			// 插入位置即 anchor（先验边界）之前
			if (steps[i]!.anchor) {
				const ai = cur.indexOf(steps[i]!.anchor)
				expect(ai).toBeGreaterThanOrEqual(0)
				expect(steps[i]!.index).toBeLessThanOrEqual(ai)
			}
		}
	})

	it('插入位置落在先验边界内：loser < anchor ⇒ 插在 anchor 之前', () => {
		const perm = [3, 1, 4, 0, 2, 6, 5, 7, 8]
		const steps = trace(9, byQuality(perm))
		for (const s of steps) {
			if (!s.anchor) continue // 奇数尾项无先验边界（整链二分）
			expect(s.index).toBeLessThanOrEqual(s.chain.indexOf(s.anchor))
		}
	})

	it('最终链反转后与隐藏质量序完全一致（增量维护不丢约束）', () => {
		const perm = [5, 0, 8, 3, 1, 7, 2, 6, 4]
		const steps = trace(9, byQuality(perm))
		const expected = perm
			.map((q, i) => ({ q, id: `m${i}` }))
			.sort((a, b) => b.q - a.q)
			.map((x) => x.id)
		expect([...steps.at(-1)!.chain].reverse()).toEqual(expected)
	})

	it('观察器不影响行为（不传时结果相同）', () => {
		const perm = [5, 0, 8, 3, 1, 7, 2, 6, 4]
		const withObs = trace(9, byQuality(perm))
		const plain = new MergeInsertionRunner(items(9))
		while (!plain.completed) {
			const c = plain.comparison!
			plain.decide(byQuality(perm)(c.a.id, c.b.id))
		}
		expect([...withObs.at(-1)!.chain].reverse()).toEqual(plain.ranking!.map((m) => m.id))
	})
})
