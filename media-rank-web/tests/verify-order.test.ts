import { describe, expect, test } from 'vitest'
import { VerifyOrderRunner } from '../src/verify-order.ts'
import type { MediaItem } from '../src/types.ts'

const items = (n: number): MediaItem[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}` }))

describe('VerifyOrderRunner', () => {
	test('比较对恒为相邻两项，共 n−1 次', () => {
		const src = items(5)
		const r = new VerifyOrderRunner(src)
		const pairs: string[] = []
		while (!r.completed) {
			const c = r.comparison!
			pairs.push(`${c.a.id}~${c.b.id}`)
			r.decide(c.a.id) // 顺序正确：上一首更好
		}
		expect(pairs).toEqual(['i0~i1', 'i1~i2', 'i2~i3', 'i3~i4'])
		expect(r.comparisonsMade).toBe(4)
		expect(r.size).toBe(5)
	})

	test('全部顺序正确时零逆序', () => {
		const r = new VerifyOrderRunner(items(4))
		while (!r.completed) {
			const c = r.comparison!
			r.decide(c.a.id)
		}
		expect(r.inversions).toEqual([])
	})

	test('判定「后一首更好」记为逆序，且不改变既定顺序', () => {
		const src = items(4)
		const r = new VerifyOrderRunner(src)
		r.decide(src[0]!.id)   // 0~1 正确
		r.decide(src[2]!.id)   // 1~2 逆序：后一首更好
		r.decide(src[2]!.id)   // 2~3 正确
		expect(r.completed).toBe(true)
		expect(r.inversions).toEqual([1])
		// items 保持原样——校验不做排序
		expect(r.items.map((m) => m.id)).toEqual(['i0', 'i1', 'i2', 'i3'])
	})

	test('恢复：快照重放出相同进度与逆序', () => {
		const src = items(4)
		const r = new VerifyOrderRunner(src)
		r.decide(src[0]!.id)
		r.decide(src[2]!.id)
		const snap = r.toJSON()
		expect(snap.kind).toBe('verify')
		expect(snap.target).toBe(4)

		const back = new VerifyOrderRunner(snap.items, snap.answers)
		expect(back.comparisonsMade).toBe(2)
		expect(back.inversions).toEqual([1])
		expect(back.comparison?.a.id).toBe('i2')
	})

	test('完成后 comparison 为 null，decide 抛错', () => {
		const r = new VerifyOrderRunner(items(2))
		r.decide('i0')
		expect(r.completed).toBe(true)
		expect(r.comparison).toBeNull()
		expect(() => r.decide('i0')).toThrow()
	})

	test('decide 拒绝不属当前比较的 id', () => {
		const r = new VerifyOrderRunner(items(3))
		expect(() => r.decide('i2')).toThrow(/不在当前比较/)
	})

	test('少于 2 项时构造即报错', () => {
		expect(() => new VerifyOrderRunner(items(1))).toThrow(/至少需要 2 项/)
	})
})