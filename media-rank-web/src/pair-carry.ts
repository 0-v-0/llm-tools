import type { MediaItem } from './types.ts'

/** 播放列表的一行：item 为渲染项，carried 表示它承接自上一轮对局（不重播）。 */
export interface CarrySlot {
	item: MediaItem
	carried: boolean
}

/**
 * 播放列表衔接：新对局与上一轮展示的歌曲有重叠时，重叠项作为「上一首」置于
 * 首行（不重播），另一首渲染在第二行并单独播放——上一轮的比较得以沿用；
 * 无重叠则原样渲染两行。两首都在上一轮出现过时，取上一轮的**最后一行**作为
 * 衔接项（最接近「上一首」的听感）。
 *
 * 仅决定渲染顺序与播放策略，不影响引擎：裁决以 id 判定，与行序无关。
 */
export function carryPair(prev: readonly { id: string }[], a: MediaItem, b: MediaItem): CarrySlot[] {
	const aIn = prev.some(pc => pc.id == a.id)
	const bIn = prev.some(pc => pc.id == b.id)
	let carried: MediaItem | null = null
	if (aIn && bIn)
		carried = prev[prev.length - 1]?.id == b.id ? b : a
	else if (aIn)
		carried = a
	else if (bIn)
		carried = b
	if (!carried)
		return [{ item: a, carried: false }, { item: b, carried: false }]
	const other = carried.id == a.id ? b : a
	return [{ item: carried, carried: true }, { item: other, carried: false }]
}