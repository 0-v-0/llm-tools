import { describe, expect, it } from 'vitest'
import { TopKRunner } from '../src/top-k.ts'
import type { MediaItem } from '../src/types.ts'

const items = (n: number): MediaItem[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))

/** 以固定质量序 driver：quality(id) 互不相同，越大越好。 */
function driveTopK(n: number, quality: Map<string, number>, k: number): { ranking: string[]; comparisons: number } {
	const r = new TopKRunner(items(n), k)
	let guard = n * n + 10
	while (!r.completed) {
		const cmp = r.comparison!
		r.decide(quality.get(cmp.a.id)! > quality.get(cmp.b.id)! ? cmp.a.id : cmp.b.id)
		if (guard-- <= 0)
			throw new Error('未收敛')
	}
	return { ranking: r.ranking!.map((m) => m.id), comparisons: r.comparisonsMade }
}

function qualityMap(n: number, perm: number[]): Map<string, number> {
	return new Map(items(n).map((m, i) => [m.id, perm[i] ?? i]))
}

describe('TopKRunner', () => {
	it('k=n 时按真实质量序输出完整排名（答案一致时）', () => {
		const perm = [4, 0, 3, 1, 2]
		const q = qualityMap(5, perm)
		const { ranking } = driveTopK(5, q, 5)
		const expected = perm.map((_, i) => `m${perm.indexOf(4 - i)}`)
		// 期望 = 质量降序
		const desc = [...q.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
		expect(ranking).toEqual(desc)
		expect(expected.length).toBe(5)
	})

	it('k<n 时前 k 名与真实质量序的前 k 名一致（多种 k 与排列）', () => {
		for (let n = 3; n <= 7; n++) {
			for (let k = 1; k <= n; k++) {
				const perm = Array.from({ length: n }, (_, i) => (i + 3) % n) // 双射偏移
				const q = qualityMap(n, perm)
				const { ranking } = driveTopK(n, q, k)
				const desc = [...q.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
				expect(ranking, `n=${n} k=${k}`).toEqual(desc.slice(0, k))
			}
		}
	})

	it('k=1 时冠军为真实最优（单败淘汰最优性）', () => {
		for (const perm of [[2, 0, 1], [0, 1, 2], [1, 2, 0]]) {
			const q = qualityMap(3, perm)
			const { ranking, comparisons } = driveTopK(3, q, 1)
			expect(ranking).toEqual([perm.indexOf(2)].map((i) => `m${i}`))
			expect(comparisons).toBe(2)
		}
	})

	it('比较次数不超过 knockout + 提取的理论上界', () => {
		for (let n = 2; n <= 10; n++) {
			for (const k of [1, Math.ceil(n / 2), n]) {
				const perm = Array.from({ length: n }, (_, i) => (i * 5 + 2) % n)
				const q = qualityMap(n, perm)
				const { comparisons } = driveTopK(n, q, k)
				const bound = n - 1 + (k - 1) * Math.ceil(Math.log2(n) + 1)
				expect(comparisons, `n=${n} k=${k}`).toBeLessThanOrEqual(bound)
			}
		}
	})

	it('快照重放：toJSON → 重建后比较序列与最终前 k 名一致', () => {
		const r = new TopKRunner(items(7), 3)
		for (let i = 0; i < 9 && !r.completed; i++)
			r.decide(r.comparison!.a.id)
		const snap = r.toJSON()
		const b = new TopKRunner(snap.items, snap.target, snap.answers)
		expect(b.comparisonsMade).toBe(r.comparisonsMade)
		expect(b.extractedCount).toBe(r.extractedCount)
		expect(b.comparison?.a.id).toBe(r.comparison?.a.id)
		expect(b.comparison?.b.id).toBe(r.comparison?.b.id)
		while (!b.completed)
			b.decide(b.comparison!.a.id)
		while (!r.completed)
			r.decide(r.comparison!.a.id)
		expect(b.ranking!.map((m) => m.id)).toEqual(r.ranking!.map((m) => m.id))
	})

	it('非法输入报错：betterId 不在当前比较中；快照与比较不符', () => {
		const r = new TopKRunner(items(4), 2)
		expect(() => r.decide('m99')).toThrow()
		// 'm3' 不在首个比较对 [m0, m1] 中
		expect(() => new TopKRunner(items(4), 2, ['m3']).comparison).toThrow()
		expect(() => new TopKRunner(items(4), 0)).toThrow()
	})

	it('边界：k=1 只需 n−1 次比较；候选数 ≤ 1 直接完成', () => {
		const { comparisons } = driveTopK(6, qualityMap(6, [3, 0, 5, 1, 4, 2]), 1)
		expect(comparisons).toBe(5)
		expect(new TopKRunner([], 1).completed).toBe(true)
		expect(new TopKRunner(items(1), 1).ranking).toEqual([{ id: 'm0' }])
	})
})
