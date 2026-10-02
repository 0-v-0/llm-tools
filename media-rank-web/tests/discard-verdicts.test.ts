import { describe, expect, it } from 'vitest'
import { MergeInsertionRunner } from '../src/merge-insertion.ts'
import { TopKRunner } from '../src/top-k.ts'
import { VerifyOrderRunner } from '../src/verify-order.ts'
import type { MediaItem } from '../src/types.ts'

const items = (n: number): MediaItem[] =>
	Array.from({ length: n }, (_, i) => ({ id: `m${i}`, kind: 'image' as const }))

/** 以隐藏质量序驱动引擎到指定裁决数或收束，返回引擎与实际裁决序列。 */
function drivePartial<T extends MergeInsertionRunner | TopKRunner>(
	r: T,
	quality: Map<string, number>,
	stop: number,
): string[] {
	const answers: string[] = []
	while (!r.completed && r.comparisonsMade < stop) {
		const cmp = r.comparison!
		const better = quality.get(cmp.a.id)! > quality.get(cmp.b.id)! ? cmp.a.id : cmp.b.id
		r.decide(better)
		answers.push(better)
	}
	return answers
}

const byPerm = (n: number, perm: number[]) => {
	const q = new Map<string, number>()
	items(n).forEach((m, i) => q.set(m.id, perm[i] ?? i))
	return q
}

describe('丢弃裁决：精确模式', () => {
	const n = 8
	const perm = [5, 0, 8, 3, 1, 7, 2, 6]

	it('回退到该曲目首次出场之前，其后裁决全部作废', () => {
		const q = byPerm(n, perm)
		const r = new MergeInsertionRunner(items(n))
		drivePartial(r, q, 5)
		const before = r.comparisonsMade
		const kept = r.discardVerdictsOf('m5')
		expect(kept).toBeLessThan(before)
		expect(r.comparisonsMade).toBe(kept)
		// 回退后引擎仍自洽（不抛），且给出新的待比较对
		expect(r.comparison).not.toBeNull()
	})

	it('回退后可重新驱动到与原本相同的排名（裁决可重建）', () => {
		const q = byPerm(n, perm)
		const r = new MergeInsertionRunner(items(n))
		drivePartial(r, q, 5)
		r.discardVerdictsOf('m5')
		while (!r.completed) {
			const cmp = r.comparison!
			r.decide(q.get(cmp.a.id)! > q.get(cmp.b.id)! ? cmp.a.id : cmp.b.id)
		}
		const expected = perm
			.map((v, i) => ({ v, id: `m${i}` }))
			.sort((a, b) => b.v - a.v)
			.map((x) => x.id)
		expect(r.ranking!.map((m) => m.id)).toEqual(expected)
	})

	it('截断点等于该曲目的首次出场下标', () => {
		const q = byPerm(n, perm)
		// 每次都用全新的引擎：discard 会改动状态，不可复用
		for (const id of ['m0', 'm3', 'm7']) {
			const r = new MergeInsertionRunner(items(n))
			drivePartial(r, q, 6)
			const seq = r.comparisonsUpTo(r.comparisonsMade)
			const firstAt = seq.findIndex(([a, b]) => a.id == id || b.id == id)
			if (firstAt < 0)
				continue // 该曲目在已答范围内未出场
			expect(r.discardVerdictsOf(id)).toBe(firstAt)
		}
	})

	it('从未出场的曲目不触发回退', () => {
		const q = byPerm(n, perm)
		const r = new MergeInsertionRunner(items(n))
		// 只裁决第 1 次比较（配对轮的首对），其余曲目必然未出场
		drivePartial(r, q, 1)
		const before = r.comparisonsMade
		const seq = r.comparisonsUpTo(before)
		const unseen = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
			.find((id) => !seq.some(([a, b]) => a.id == id || b.id == id))!
		expect(r.discardVerdictsOf(unseen)).toBe(before)
	})
})

describe('丢弃裁决：前 k 名模式', () => {
	const n = 8
	const perm = [5, 0, 8, 3, 1, 7, 2, 6]

	it('回退后引擎自洽且可重新驱动到认证排名', () => {
		const q = byPerm(n, perm)
		const r = new TopKRunner(items(n), 3)
		drivePartial(r, q, 6)
		const kept = r.discardVerdictsOf('m2')
		expect(r.comparisonsMade).toBe(kept)
		while (!r.completed) {
			const cmp = r.comparison!
			r.decide(q.get(cmp.a.id)! > q.get(cmp.b.id)! ? cmp.a.id : cmp.b.id)
		}
		const expected = perm
			.map((v, i) => ({ v, id: `m${i}` }))
			.sort((a, b) => b.v - a.v)
			.slice(0, 3)
			.map((x) => x.id)
		expect(r.ranking!.map((m) => m.id)).toEqual(expected)
	})

	it('收束后丢弃同样可用（回退重做，不抛）', () => {
		const q = byPerm(n, perm)
		const r = new TopKRunner(items(n), 3)
		drivePartial(r, q, 99)
		expect(r.completed).toBe(true)
		r.discardVerdictsOf('m0')
		expect(r.comparisonsMade).toBeLessThanOrEqual(r.toJSON().answers.length)
		expect(r.comparison).not.toBeNull()
	})

	it('改任一 id 都会使签表重排：旧日志无法沿用（须从零重建）', () => {
		const q = byPerm(n, perm)
		const r = new TopKRunner(items(n), 3)
		drivePartial(r, q, 5)
		// topK 的淘汰赛签表由 id 派生种子洗牌而来 —— 改一项即重排整表
		const its = r.toJSON().items.map((m) => (m.id == 'm0' ? { ...m, id: 'm0-x' } : m))
		const kept = r.toJSON().answers.slice(0, 1)   // 只保留一条旧裁决
		// 这条旧裁决已与新签表错位 → 重放会抛「裁决与比较不符」
		expect(() => new TopKRunner(its, 3, kept).comparison).toThrow(/裁决与比较不符/)
		// 正确做法：全部丢弃，从零重建
		const fresh = new TopKRunner(its, 3)
		expect(fresh.comparisonsMade).toBe(0)
		expect(fresh.comparison).not.toBeNull()
	})
})

describe('丢弃裁决：顺序校验模式', () => {
	const n = 5

	it('回退到被改曲目的相邻对之前，该对须重新裁决', () => {
		const its = items(n)
		const r = new VerifyOrderRunner(its)
		// 全部按给定顺序裁决（无逆序）
		while (!r.completed) {
			const cmp = r.comparison!
			r.decide(cmp.a.id)
		}
		expect(r.comparisonsMade).toBe(n - 1)
		// m2 首次出场于比较 1（m1 vs m2）
		expect(r.discardVerdictsOf('m2')).toBe(1)
		expect(r.comparison!.a.id).toBe('m1')
		expect(r.comparison!.b.id).toBe('m2')
	})

	it('首曲 m0 回退到 0（重做第一对比较）', () => {
		const r = new VerifyOrderRunner(items(n))
		while (!r.completed) {
			const cmp = r.comparison!
			r.decide(cmp.a.id)
		}
		expect(r.discardVerdictsOf('m0')).toBe(0)
	})

	it('末曲 m4 回退到比较 3（其与 m3 的那一次）', () => {
		const r = new VerifyOrderRunner(items(n))
		while (!r.completed) {
			const cmp = r.comparison!
			r.decide(cmp.a.id)
		}
		expect(r.discardVerdictsOf('m4')).toBe(n - 2)
	})

	it('回退后逆序记录相应减少（重做前不再计入）', () => {
		const r = new VerifyOrderRunner(items(n))
		// 前两对判「后者更好」制造逆序
		r.decide('m1')
		r.decide('m2')
		expect(r.inversions).toEqual([0, 1])
		r.discardVerdictsOf('m2')
		expect(r.inversions).toEqual([0])
	})

	it('未知 id 不触发回退', () => {
		const r = new VerifyOrderRunner(items(n))
		r.decide('m1')
		expect(r.discardVerdictsOf('zz')).toBe(1)
	})
})

describe('换 id 后的引擎重建', () => {
	const n = 6
	const perm = [5, 0, 8, 3, 1, 4]

	/**
	 * 复刻 submitEditor 的改 id 路径：以新 items + 截断后的日志重建引擎。
	 *
	 * 关键点：新 id 必须同步进 items —— 引擎持有 start() 时的 items 引用，
	 * 只改 data.items 会让引擎与展示各持一份 id，后续裁决必然错配。
	 */
	function rebuild(r: MergeInsertionRunner, oldId: string, newId: string) {
		const answers = r.toJSON().answers
		const first = r.comparisonsUpTo(answers.length)
			.findIndex(([a, b]) => a.id == oldId || b.id == oldId)
		const keep = first < 0 ? answers.length : first
		const items = r.toJSON().items.map((m) => (m.id == oldId ? { ...m, id: newId } : m))
		return { items, answers: answers.slice(0, keep), kept: keep, wasDecided: first >= 0 }
	}

	/** 以隐藏质量序驱动到收束（按新 id 映射质量）。 */
	function drive(r: MergeInsertionRunner, quality: Map<string, number>) {
		let guard = n * n + 10
		while (!r.completed) {
			const cmp = r.comparison!
			r.decide(quality.get(cmp.a.id)! > quality.get(cmp.b.id)! ? cmp.a.id : cmp.b.id)
			if (guard-- <= 0) throw new Error('未收敛')
		}
	}

	it('未裁决项换 id 后进度不变，且引擎与 items 一致', () => {
		const r = new MergeInsertionRunner(items(n))
		drivePartial(r, byPerm(n, perm), 2)
		const before = r.comparisonsMade
		// 找出尚未出场的曲目（未被裁决过）
		const seq = r.comparisonsUpTo(before)
		const unseen = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']
			.find((id) => !seq.some(([a, b]) => a.id == id || b.id == id))!
		const out = rebuild(r, unseen, `${unseen}-x`)
		expect(out.wasDecided).toBe(false)
		expect(out.kept).toBe(before)
		// 重建后引擎以新 id 工作，旧 id 不再出现
		const next = new MergeInsertionRunner(out.items, out.answers)
		expect(next.comparisonsMade).toBe(before)
		expect(next.toJSON().items.some((m) => m.id == unseen)).toBe(false)
		expect(next.toJSON().items.some((m) => m.id == `${unseen}-x`)).toBe(true)
	})

	it('已裁决项换 id 后回退到其首次出场之前，且重放不抛', () => {
		const r = new MergeInsertionRunner(items(n))
		drive(r, byPerm(n, perm))
		// m0 首次出场于第 0 次比较 → 回退到 0
		const out = rebuild(r, 'm0', 'm0-x')
		expect(out.wasDecided).toBe(true)
		expect(out.kept).toBe(0)
		const next = new MergeInsertionRunner(out.items, out.answers)
		expect(next.comparisonsMade).toBe(0)
		expect(next.comparison).not.toBeNull()
		// 重建后可重新驱动到与原排序一致的排名（新 id 沿用旧的质量）
		const q = byPerm(n, perm)
		const q2 = new Map<string, number>([...q].map(([id, v]) => [id == 'm0' ? 'm0-x' : id, v] as const))
		drive(next, q2)
		const expected = perm
			.map((v, i) => ({ v, id: i == 0 ? 'm0-x' : `m${i}` }))
			.sort((a, b) => b.v - a.v)
			.map((x) => x.id)
		expect(next.ranking!.map((m) => m.id)).toEqual(expected)
	})
})