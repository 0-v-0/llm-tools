/**
 * 裁决日志（verdict log）的下标工具：引擎的 `answers` 是**位置日志**——第 i 条
 * 记录回答第 i 次比较。各引擎的比较序列都由这套日志确定性重放得出，因此
 * 「丢弃某个曲目的裁决」只能实现为**整段回退**：截断到该曲目首次参与的那次
 * 比较之前，其后的比较全部重做。这是日志结构的直接推论，不存在「就地删除某
 * 几条」的选项——重放是逐位置喂回的，抽掉中间几条会让后续记录与比较错位，
 * 引擎将抛出「裁决与比较不符」。
 *
 * 截断点必须取**首次出场**而非最后一次出场：之后的每一步都建立在先前裁决
 * 之上（Ford-Johnson 的主链、topK 的胜者树与阶梯皆如此），只回退到最后一次
 * 会留下一段依赖着未回退中间态的比较。
 */

/** 一次比较：两个待裁决的候选（引擎内部为 [a, b] 二元组）。 */
export type VerdictCmp = readonly [{ id: string }, { id: string }]

/**
 * 在裁决日志的前 `count` 条内，各曲目首次参与比较的下标。
 *
 * 返回 Map<曲目 id, 下标>；未在前 `count` 条内出场过的曲目不在表中。
 */
export function firstVerdictIndex(
	comparisons: readonly VerdictCmp[],
	count: number,
): Map<string, number> {
	const first = new Map<string, number>()
	const n = Math.min(count, comparisons.length)
	for (let i = 0; i < n; i++) {
		for (const side of comparisons[i]!) {
			if (!first.has(side.id))
				first.set(side.id, i)
		}
	}
	return first
}

/**
 * 丢弃某曲目的裁决所需的截断长度：其首次出场下标。
 *
 * 曲目从未参与比较（count 覆盖不到、或它尚未出场）时返回 count，即无需回退。
 */
export function truncateFor(first: ReadonlyMap<string, number>, id: string, count: number): number {
	const i = first.get(id)
	return i === undefined ? count : i
}