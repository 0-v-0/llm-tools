import { describe, expect, it } from 'vitest'
import { TournamentRunner } from '../src/tournament.ts'
import type { MediaItem } from '../src/types.ts'

const items = (n: number): MediaItem[] =>
	Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))

/** 按状态机的 pending 顺序裁决完当前轮：每对保留 a（首个候选）。 */
function decideRoundKeptA(r: TournamentRunner): void {
	const pairs = r.pending.slice() // decide 会从 pending 移除元素，须快照
	for (const p of pairs)
		r.decide(p.index, p.a.id)
}

/** 逐轮裁决直到收束。 */
function decideAllKeptA(r: TournamentRunner): void {
	while (!r.completed)
		decideRoundKeptA(r)
}

describe('TournamentRunner', () => {
	it('候选数 ≤ target 时立即收束，无需开赛', () => {
		const r = new TournamentRunner(items(3), 3)
		expect(r.completed).toBe(true)
		expect(r.round).toBe(0)
		expect(r.pending).toHaveLength(0)
		const result = r.getResult()
		expect(result.survivors).toHaveLength(3)
		expect(result.ranking).toHaveLength(3)
		expect(result.rounds).toHaveLength(0)
	})

	it('每对裁决保留 1 张、淘汰 1 张，淘汰者不再出现在候选中', () => {
		const r = new TournamentRunner(items(4), 1)
		expect(r.pending).toHaveLength(2)
		decideRoundKeptA(r)
		// 第 1 轮后剩 2 个胜者，第 2 轮 1 对
		expect(r.round).toBe(2)
		expect(r.pending).toHaveLength(1)
		const finalPair = r.pending[0]!
		decideAllKeptA(r)
		expect(r.completed).toBe(true)
		const result = r.getResult()
		expect(result.survivors).toHaveLength(1)
		// 冠军是最后一轮保留的 a
		expect(result.ranking[0]!.id).toBe(finalPair.a.id)
		// 完整排名覆盖全部候选且无重复
		expect(new Set(result.ranking.map((m) => m.id)).size).toBe(4)
	})

	it('奇数候选产生轮空，轮空项进入下一轮候选', () => {
		const r = new TournamentRunner(items(5), 1)
		expect(r.pending).toHaveLength(2)
		expect(r.byes).toHaveLength(1)
		const byeId = r.byes[0]!.id
		decideRoundKeptA(r)
		// 第 1 轮：2 对 + 1 轮空 → 3 个胜者进入第 2 轮（1 对 + 1 轮空）
		expect(r.round).toBe(2)
		expect(r.pending).toHaveLength(1)
		decideAllKeptA(r)
		expect(r.completed).toBe(true)
		const result = r.getResult()
		// 首轮轮空记录在案，且未在该轮被淘汰
		expect(result.rounds[0]!.byes.map((b) => b.id)).toContain(byeId)
		expect(result.rounds[0]!.pairs.flatMap((p) => [p.kept.id, p.eliminated.id])).not.toContain(byeId)
		// 轮空项出现在后续某轮（对局或轮空）或最终保留集中，即未被丢弃
		const later = result.rounds.slice(1).flatMap((rd) => [
			...rd.pairs.flatMap((p) => [p.kept.id, p.eliminated.id]),
			...rd.byes.map((b) => b.id),
		])
		expect([...later, ...result.survivors.map((m) => m.id)]).toContain(byeId)
		// 完整排名恰好覆盖全部候选一次
		expect(result.ranking).toHaveLength(5)
		expect(new Set(result.ranking.map((m) => m.id)).size).toBe(5)
	})

	it('排名次序：越晚淘汰名次越高', () => {
		const r = new TournamentRunner(items(4), 1)
		const pairs1 = [...r.pending]
		const round1Losers = pairs1.map((p) => p.a.id)
		// 第 1 轮每对保留 b，淘汰 a
		for (const p of pairs1) r.decide(p.index, p.b.id)
		// 第 2 轮保留 a
		decideRoundKeptA(r)
		const result = r.getResult()
		// 第 1 轮淘汰者排最后，且顺序为淘汰记录序
		expect(result.ranking.slice(-2).map((m) => m.id)).toEqual([...round1Losers].reverse())
		// 第 2 轮淘汰者名次高于第 1 轮淘汰者
		const round2Loser = result.ranking[1]!.id
		expect(round1Losers).not.toContain(round2Loser)
	})

	it('target > 1 时收敛到 target 以内', () => {
		const r = new TournamentRunner(items(7), 3)
		// 7 个候选：3 对 + 1 轮空 → 4 胜者；第 2 轮 2 对 → 2 胜者 ≤ 3 收束
		decideAllKeptA(r)
		decideAllKeptA(r)
		expect(r.completed).toBe(true)
		expect(r.getResult().survivors.length).toBeLessThanOrEqual(3)
	})

	it('非法裁决报错：未知对局序号、keptId 不在对局中', () => {
		const r = new TournamentRunner(items(4), 1)
		expect(() => r.decide(99, 'm0')).toThrow()
		expect(() => r.decide(0, 'm9')).toThrow()
		// 已裁决的对局再次裁决报错
		const idx = r.pending[0]!.index
		r.decide(idx, r.pending[0]!.a.id)
		expect(() => r.decide(idx, r.pending[0]!.b.id)).toThrow()
	})

	it('快照往返：toJSON → fromJSON 后内部状态一致，续跑结果与原状态机相同', () => {
		const a = new TournamentRunner(items(7), 2)
		decideRoundKeptA(a) // 第 1 轮完成，进入第 2 轮
		const snapshot = a.toJSON()
		const b = TournamentRunner.fromJSON(snapshot)
		// 内部可观察状态一致
		expect(b.round).toBe(a.round)
		expect(b.candidatesLeft).toBe(a.candidatesLeft)
		expect(b.pending.map((p) => [p.index, p.a.id, p.b.id])).toEqual(a.pending.map((p) => [p.index, p.a.id, p.b.id]))
		expect(b.byes.map((m) => m.id)).toEqual(a.byes.map((m) => m.id))
		expect(b.roundsLog).toEqual(a.roundsLog)
		// 深拷贝：改动快照对象不影响状态机
		snapshot.candidates.pop()
		expect(b.candidatesLeft).toBe(a.candidatesLeft)
		// 续跑结果与原状态机完全相同（同一批待裁决对、同一裁决序列）
		const finish = (r: TournamentRunner) => {
			while (!r.completed)
				decideRoundKeptA(r)
			return r.getResult().ranking.map((m) => m.id)
		}
		expect(finish(b)).toEqual(finish(a))
	})

	it('fromJSON 拒绝损坏的快照', () => {
		const ok = new TournamentRunner(items(4), 1).toJSON()
		expect(() => TournamentRunner.fromJSON(null as never)).toThrow()
		expect(() => TournamentRunner.fromJSON({ ...ok, target: 0 })).toThrow()
		expect(() => TournamentRunner.fromJSON({ ...ok, pending: 'x' as never })).toThrow()
		expect(() => TournamentRunner.fromJSON({ ...ok, rounds: [{ round: 1 }] as never })).toThrow()
		expect(() => TournamentRunner.fromJSON({ ...ok, candidates: [{}] as never })).toThrow()
	})

	it('恢复中途快照后可直接完成；完成态快照可直接取结果', () => {
		// 中途：裁决 1 对后中断
		const a = new TournamentRunner(items(4), 1)
		const p = a.pending[0]!
		a.decide(p.index, p.a.id)
		const mid = TournamentRunner.fromJSON(a.toJSON())
		expect(mid.round).toBe(a.round)
		expect(mid.pending).toHaveLength(a.pending.length)
		// 完成态
		const full = new TournamentRunner(items(4), 1)
		decideAllKeptA(full)
		const done = TournamentRunner.fromJSON(full.toJSON())
		expect(done.completed).toBe(true)
		expect(done.getResult()).toEqual(full.getResult())
	})

	it('未收束时 getResult 抛错', () => {
		const r = new TournamentRunner(items(4), 1)
		expect(() => r.getResult()).toThrow()
	})

	it('输入数组不被修改；结果与内部状态解耦', () => {
		const src = items(4)
		const snapshot = src.map((m) => m.id)
		const r = new TournamentRunner(src, 1)
		decideAllKeptA(r)
		decideAllKeptA(r)
		expect(src.map((m) => m.id)).toEqual(snapshot)
		const result1 = r.getResult()
		result1.survivors.push({ id: 'x' })
		expect(r.getResult().survivors).toHaveLength(1)
	})
})
