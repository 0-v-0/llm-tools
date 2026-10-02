import type { MediaItem } from './types.ts'

/**
 * 顺序校验（只播重听）快照：给定顺序 + 裁决记录。
 *
 * 与排序引擎同构的重放设计：比较序列确定于 items 的既定顺序，快照即
 * { items, answers }，恢复零成本。
 */
export interface VerifySnapshot {
	kind: 'verify'
	items: MediaItem[]
	/** 与其他模式保持一致的快照契约（校验不改变顺序，故 target = 候选数） */
	target: number
	/** 第 i 次比较（items[i] vs items[i+1]）中更好一项的 id */
	answers: string[]
}

type Cmp = [MediaItem, MediaItem]

/**
 * 顺序校验引擎：只比较**相邻**两项（items[i] vs items[i+1]），共 n−1 次。
 *
 * 用途是「核对一个已有顺序」——比如导入的歌单本身带顺序，先听一遍确认对不对。
 * 它不做排序：任何一次裁决与既定顺序相反，只会被记为该处顺序错误，不改变
 * items 本身。因此比较次数固定为 n−1，与 n·log₂n 的排序不可比，但**远低于**
 * 排序，且是「验证」而非「求」最优序。
 */
export class VerifyOrderRunner {
	constructor(
		/** 既定顺序（校验不改变它，仅在结果中原样返回） */
		readonly items: readonly MediaItem[],
		private readonly answers: string[] = [],
	) {
		if (items.length < 2)
			throw new Error('顺序校验至少需要 2 项')
	}

	private replay(): { cmp: Cmp | null; inversions: number[] } {
		const i = this.answers.length
		// 逆序由已答裁决推导，与是否还有待比较无关——完成后仍须可读
		const inversions = this.inversionsUpTo(i)
		if (i >= this.items.length - 1)
			return { cmp: null, inversions }
		return { cmp: [this.items[i]!, this.items[i + 1]!], inversions }
	}

	/** 前 count 次比较中，判定为「后一项更好」的位置（即顺序错误处）。 */
	private inversionsUpTo(count: number): number[] {
		const out: number[] = []
		for (let i = 0; i < count; i++) {
			const b = this.items[i + 1]!
			if (this.answers[i] === b.id) out.push(i)
		}
		return out
	}

	get completed(): boolean {
		return this.answers.length >= this.items.length - 1;
	}

	/** 当前待裁决对：items[i] vs items[i+1]（前者为「上一首」） */
	get comparison(): { a: MediaItem; b: MediaItem } | null {
		const { cmp } = this.replay()
		return cmp ? { a: cmp[0], b: cmp[1] } : null
	}

	get comparisonsMade(): number {
		return this.answers.length
	}

	/**
	 * 前 `count` 次比较，至多到已答次数为止。
	 *
	 * 校验的比较序列恒为 items[i] vs items[i+1]，无需重放即可得出——与排序
	 * 引擎的同名方法保持接口一致。
	 */
	comparisonsUpTo(count: number): [MediaItem, MediaItem][] {
		const out: [MediaItem, MediaItem][] = []
		const upto = Math.min(count, this.answers.length)
		for (let i = 0; i < upto; i++)
			out.push([this.items[i]!, this.items[i + 1]!])
		return out
	}

	/**
	 * 丢弃某曲目的裁决：回退到它首次参与比较之前。
	 *
	 * 校验的比较恒为 items[j] vs items[j+1]（与 answers 无关），故 items[i]
	 * 首次出场于比较 i−1（首曲于比较 0）。answers 是位置日志且此处任何「就地
	 * 删一条」都会让其后记录错位（见 verdict-log.ts），因此只能整段截断到 i−1，
	 * 从该对比较起重做——被改的曲目正是这一对的其中一方，必须重新裁决。
	 */
	discardVerdictsOf(id: string): number {
		const i = this.items.findIndex((m) => m.id == id)
		if (i < 0)
			return this.answers.length
		const keep = Math.min(Math.max(0, i - 1), this.answers.length)
		this.answers.length = keep
		return keep
	}

	get size(): number {
		return this.items.length
	}

	/** 已发现顺序错误的位置（相邻对中后项更优的下标）。 */
	get inversions(): number[] {
		return this.replay().inversions
	}

	/** 裁决当前比较：betterId 为 a/b 之一 */
	decide(betterId: string): void {
		const cmp = this.comparison
		if (!cmp)
			throw new Error('顺序校验已完成，无待裁决比较')
		if (betterId != cmp.a.id && betterId != cmp.b.id)
			throw new Error(`betterId 不在当前比较中：${betterId}`)
		this.answers.push(betterId)
	}

	toJSON(): VerifySnapshot {
		return { kind: 'verify', items: [...this.items], target: this.items.length, answers: [...this.answers] }
	}
}