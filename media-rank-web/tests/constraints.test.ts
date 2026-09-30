import { describe, expect, it } from 'vitest'
import { applyOrderConstraints } from '../src/constraints.ts'
import type { OrderConstraint } from '../src/constraints.ts'
import type { MediaItem } from '../src/types.ts'

const items = (ids: string[]): MediaItem[] => ids.map((id) => ({ id }))
const ids = (ms: MediaItem[]) => ms.map((m) => m.id)
const chainXyz = (): OrderConstraint[] => [
	{ before: 'x', after: 'y' },
	{ before: 'y', after: 'z' },
]

describe('applyOrderConstraints', () => {
	it('无约束时保持原排名', () => {
		const r = items(['a', 'b', 'c'])
		expect(ids(applyOrderConstraints(r, []).ranking)).toEqual(['a', 'b', 'c'])
	})

	it('约束未被违反时保持原排名', () => {
		const r = items(['a', 'b', 'c'])
		expect(ids(applyOrderConstraints(r, [{ before: 'a', after: 'c' }]).ranking)).toEqual(['a', 'b', 'c'])
	})

	it('约束被违反时局部调整，其余保持原序', () => {
		const r = items(['a', 'b', 'c'])
		// a 必须在 b 之后：仅调整 a 的位置，c 不受影响
		expect(ids(applyOrderConstraints(r, [{ before: 'b', after: 'a' }]).ranking)).toEqual(['b', 'a', 'c'])
	})

	it('每步优先选取锦标赛序最靠前的可行项（偏离最小）', () => {
		const r = items(['a', 'b', 'c'])
		// 约束 c 在 a 之前：a 被阻塞，b 先行；随后 c、a 保持原相对序
		expect(ids(applyOrderConstraints(r, [{ before: 'c', after: 'a' }]).ranking)).toEqual(['b', 'c', 'a'])
	})

	it('链式约束（有序歌单）整体保持相对顺序', () => {
		const r = items(['y', 'p', 'x', 'z', 'q'])
		const chain = chainXyz()
		// y 被约束阻塞，p 先行；x→y→z 的相对顺序与 p、q 的原位保持
		expect(ids(applyOrderConstraints(r, chain).ranking)).toEqual(['p', 'x', 'y', 'z', 'q'])
	})

	it('链式约束未违反时不改变原排名', () => {
		const r = items(['x', 'p', 'y', 'q', 'z'])
		const chain = chainXyz()
		expect(ids(applyOrderConstraints(r, chain).ranking)).toEqual(['x', 'p', 'y', 'q', 'z'])
	})

	it('约束成环时返回参与循环的条目，可行项照常输出', () => {
		const r = items(['a', 'b', 'c'])
		const out = applyOrderConstraints(r, [
			{ before: 'a', after: 'b' },
			{ before: 'b', after: 'a' },
		])
		expect(ids(out.ranking)).toEqual(['c'])
		expect(ids(out.cycle)).toEqual(['a', 'b'])
	})

	it('引用排名外条目的约束被忽略', () => {
		const r = items(['a', 'b'])
		expect(ids(applyOrderConstraints(r, [{ before: 'a', after: 'zz' }]).ranking)).toEqual(['a', 'b'])
	})
})
