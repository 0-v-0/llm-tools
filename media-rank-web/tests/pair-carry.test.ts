import { describe, expect, test } from 'vitest'
import { carryPair } from '../src/pair-carry.ts'
import type { MediaItem } from '../src/types.ts'

const item = (id: string): MediaItem => ({ id, kind: 'audio', name: id })

describe('carryPair（播放列表衔接）', () => {
	test('无重叠：原样渲染两行，无衔接标记', () => {
		const slots = carryPair([item('x')], item('a'), item('b'))
		expect(slots.map(s => [s.item.id, s.carried])).toEqual([['a', false], ['b', false]])
	})

	test('上一轮最后一行仍在新对局中：作为「上一首」置于首行', () => {
		// 校验模式形态：上一轮 [s1, s2]，新一轮 [s2, s3] —— s2 从行尾变行首
		const slots = carryPair([item('s1'), item('s2')], item('s2'), item('s3'))
		expect(slots.map(s => [s.item.id, s.carried])).toEqual([['s2', true], ['s3', false]])
	})

	test('上一轮首行仍在新对局中（FJ/topK 插入链的败者锚点）：置首行不重播', () => {
		// 上一轮 [loser, b1]，新一轮 [loser, b2] —— 败者锚点延续
		const slots = carryPair([item('loser'), item('b1')], item('loser'), item('b2'))
		expect(slots.map(s => [s.item.id, s.carried])).toEqual([['loser', true], ['b2', false]])
	})

	test('两首都在上一轮出现过：取上一轮最后一行衔接', () => {
		const slots = carryPair([item('loser'), item('b1')], item('b1'), item('loser'))
		expect(slots.map(s => [s.item.id, s.carried])).toEqual([['b1', true], ['loser', false]])
	})

	test('carried 在引擎对中为 b 时渲染换位（行序与引擎序无关，裁决按 id）', () => {
		const slots = carryPair([item('x'), item('b')], item('a'), item('b'))
		expect(slots.map(s => s.item.id)).toEqual(['b', 'a'])
	})

	test('空上一轮（开赛首对）：不衔接', () => {
		const slots = carryPair([], item('a'), item('b'))
		expect(slots.map(s => [s.item.id, s.carried])).toEqual([['a', false], ['b', false]])
	})
})