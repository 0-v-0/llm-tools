import { describe, expect, it } from 'vitest'
import { firstVerdictIndex, truncateFor } from '../src/verdict-log.ts'

/** 引擎实际产出的形状：比较是 [a, b] 二元组。 */
const tuples = (...pairs: [string, string][]): [{ id: string }, { id: string }][] =>
	pairs.map(([a, b]) => [{ id: a }, { id: b }])

describe('firstVerdictIndex', () => {
	it('记录每首曲目首次出场的下标', () => {
		const seq = tuples(['a', 'b'], ['c', 'b'], ['c', 'd'])
		const first = firstVerdictIndex(seq, seq.length)
		expect([...first]).toEqual([['a', 0], ['b', 0], ['c', 1], ['d', 2]])
	})

	it('只统计前 count 条内的出场（已答范围之外不计）', () => {
		const seq = tuples(['a', 'b'], ['c', 'b'], ['c', 'd'])
		const first = firstVerdictIndex(seq, 1)
		expect(first.has('c')).toBe(false)
		expect(first.get('a')).toBe(0)
	})

	it('count 超过比较数时按实际长度收敛', () => {
		const seq = tuples(['a', 'b'], ['b', 'c'])
		expect(firstVerdictIndex(seq, 99).size).toBe(3)
	})
})

describe('truncateFor', () => {
	it('取首次出场下标作为回退点', () => {
		const first = new Map([['c', 1]])
		expect(truncateFor(first, 'c', 3)).toBe(1)
	})

	it('从未出场的曲目无需回退（返回全长）', () => {
		expect(truncateFor(new Map(), 'zz', 3)).toBe(3)
	})
})