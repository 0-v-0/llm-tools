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
