import type { MediaItem } from './types.ts'

/** 顺序约束：before 对应的条目必须排在 after 之前（按 id 匹配）。 */
export interface OrderConstraint {
	before: string
	after: string
}

/**
 * 依据约束对锦标赛排名做稳定拓扑重排，得到「保持每个有序歌单内相对顺序」
 * 的最终排名：
 *
 * - 每步在剩余条目中选取锦标赛序最靠前且全部前驱已输出的条目——无约束或
 *   约束未被锦标赛结果违反时，结果与原排名一致；仅在约束强制时局部调整，
 *   偏离最小。
 * - 约束成环（如两个有序歌单对同一对歌曲给出相反顺序）时无法满足，此时
 *   `cycle` 返回参与循环的条目、`ranking` 原样返回，由调用方提示检查输入。
 * - 约束两端不在排名中（如跨会话的旧约束）时忽略该条约束。
 */
export function applyOrderConstraints(
	ranking: readonly MediaItem[],
	constraints: readonly OrderConstraint[],
): { ranking: MediaItem[]; cycle: MediaItem[] } {
	const pos = new Map<string, number>()
	ranking.forEach((m, i) => pos.set(m.id, i))
	// 去重后的 before → afters 边；入度计数
	const afters = new Map<string, Set<string>>()
	const inDeg = new Map<string, number>()
	for (const c of constraints) {
		if (c.before == c.after || !pos.has(c.before) || !pos.has(c.after))
			continue
		const set = afters.get(c.before) ?? new Set<string>()
		if (!set.has(c.after)) {
			set.add(c.after)
			afters.set(c.before, set)
			inDeg.set(c.after, (inDeg.get(c.after) ?? 0) + 1)
		}
	}

	const remaining = new Set(ranking.map((m) => m.id))
	const out: MediaItem[] = []
	for (;;) {
		let pick: MediaItem | null = null
		for (const m of ranking) {
			if (remaining.has(m.id) && (inDeg.get(m.id) ?? 0) == 0) {
				pick = m
				break
			}
		}
		if (!pick)
			break
		remaining.delete(pick.id)
		out.push(pick)
		for (const after of afters.get(pick.id) ?? [])
			inDeg.set(after, inDeg.get(after)! - 1)
	}
	return {
		ranking: out,
		cycle: ranking.filter((m) => remaining.has(m.id)),
	}
}
