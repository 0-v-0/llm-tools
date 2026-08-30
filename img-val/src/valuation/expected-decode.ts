import type { Confidence } from '../storage/types.js';
import type { LogprobInfo, TopLogprob } from '@llm-image/shared';

/**
 * 一条"可形成有效数字"的解码路径（由 beam 在单次调用内枚举出的 top-k 候选之一）。
 * - value：该路径解析出的数值（min_value / max_value）。
 * - tokenLogprobs：该路径每个 token 的 logprob；路径概率 = exp(Σ tokenLogprobs)。
 * - confidence / rationale：可选，用于回退展示。
 */
export interface Candidate {
	value: number;
	tokenLogprobs: number[];
	confidence?: Confidence;
	rationale?: string;
}

export interface ExpectationDecodeResult {
	/** 对所有有效路径按路径概率求得的数值期望。 */
	value: number;
	/** 路径概率加权的平均 token logprob（与 meanLogprobForValue 同量纲，便于 A/B 对比）；无则 null。 */
	logprob: number | null;
	/** 最自信（路径概率最高）候选的置信；无则 null。 */
	confidence: Confidence | null;
	/** 最自信候选的表述；无则 null。 */
	rationale: string | null;
	/** 进入期望计算的合法路径数。 */
	usedPaths: number;
	/** 被"有效性掩码"丢弃的非法路径数。 */
	discardedPaths: number;
}

/**
 * 受限期望解码（constrained expected-value decoding）。
 *
 * 对所有"可形成有效数字"的候选路径，按路径概率（exp(ΣtokenLogprobs)）求数值期望，
 * 即在 top-k 路径（由 beam 枚举）上做概率加权，而非取 argmax 路径。
 *
 * 与 engine.aggregateBound（当前多样本聚合）的关系：
 * - 聚合算子同构：都是 exp(路径/样本 logprob) 加权均值；
 * - 区别在候选来源：本函数接收"单次调用内 beam 枚举的 top-k 路径"（信息来自模型
 *   自身分布），aggregateBound 接收"多次独立调用的样本"（信息来自温度扰动）；
 * - 本函数显式施加"有效性掩码"（有限、非负），aggregateBound 假设样本已解析为合法值。
 *
 * 数值稳定：logprobs 减去最大值后再 exp，避免下溢。
 */
export function expectationDecode(candidates: Candidate[]): ExpectationDecodeResult {
	const valid = candidates.filter(
		(c) => Number.isFinite(c.value) && c.value >= 0 && c.tokenLogprobs.length > 0,
	);
	const discardedPaths = candidates.length - valid.length;
	if (valid.length === 0) {
		throw new Error('expectationDecode: 无有效候选路径（均被有效性掩码丢弃）');
	}

	const logSums = valid.map((c) => c.tokenLogprobs.reduce((a, b) => a + b, 0));
	const maxLog = Math.max(...logSums);
	const weights = logSums.map((l) => Math.exp(l - maxLog));
	const wSum = weights.reduce((a, b) => a + b, 0);
	const value = weights.reduce((acc, w, i) => acc + w * valid[i]!.value, 0) / wSum;

	// 聚合 logprob：各候选的平均 token logprob，按路径概率加权。
	// 与 meanLogprobForValue 同量纲（都是"数值 token 的平均 logprob"），便于 A/B 对比。
	const meanLp = valid.map((c, i) => logSums[i]! / c.tokenLogprobs.length);
	const aggLogprob = weights.reduce((acc, w, i) => acc + w * meanLp[i]!, 0) / wSum;

	// 最自信候选（路径概率最高）用于回退展示
	let bestIdx = 0;
	for (let i = 1; i < weights.length; i++) {
		if (weights[i]! > weights[bestIdx]!) bestIdx = i;
	}
	const best = valid[bestIdx]!;

	return {
		value,
		logprob: aggLogprob,
		confidence: best.confidence ?? null,
		rationale: best.rationale ?? null,
		usedPaths: valid.length,
		discardedPaths,
	};
}

export interface PathDecodeOptions {
	/** 每个位置保留的 top-k 候选（受 OpenAI 上限 20 约束）。 */
	topK?: number;
	/** 最大组合数上限，防止多 token 数值的笛卡尔积爆炸。 */
	maxCandidates?: number;
}

/**
 * 从单次调用的 top_logprobs 在本地重建"可形成有效数字"的候选路径。
 *
 * 这是把受限期望解码接到真实模型的落地环节：OpenAI 的 `top_logprobs` 只返回
 * 每个位置的 top-k token（而非完整路径），这里：
 *   1. 用正则定位 JSON 中该数值字段对应的字符区间；
 *   2. 收集覆盖该区间的每个 token 位置的 top-k 候选；
 *   3. 受限笛卡尔积展开（maxCandidates 防爆炸），拼接后正则校验为合法数字；
 *   4. 每条合法路径记录数值与其 token logprob 序列（路径概率 = exp(Σ)）。
 *
 * 返回结果可直接喂给 `expectationDecode`。若无 topLogprobs，仅含主路径
 * （即当前 argmax 路径），从而向后兼容。
 */
export function candidateValuesFromLogprobs(
	logprobs: LogprobInfo,
	jsonText: string,
	key: 'min_value' | 'max_value',
	opts: PathDecodeOptions = {},
): Candidate[] {
	const topK = Math.min(opts.topK ?? 20, 20);
	const maxCandidates = opts.maxCandidates ?? 256;
	if (!logprobs || logprobs.tokens.length === 0) return [];

	// 重建 token 序列的字符区间
	let rebuilt = '';
	const ranges: Array<[number, number]> = [];
	for (const tok of logprobs.tokens) {
		const start = rebuilt.length;
		rebuilt += tok.token;
		ranges.push([start, rebuilt.length]);
	}

	const re = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g');
	let best: { start: number; end: number } | null = null;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rebuilt)) !== null) {
		const valueStart = m.index + m[0]!.indexOf(m[1]!);
		best = { start: valueStart, end: valueStart + m[1]!.length };
	}
	if (!best) return [];

	// 覆盖数值区间的 token 位置
	const idxs: number[] = [];
	for (let i = 0; i < logprobs.tokens.length; i++) {
		const [s, e] = ranges[i]!;
		if (e > best.start && s < best.end) idxs.push(i);
	}
	if (idxs.length === 0) return [];

	// 每个位置收集候选 token（主 token + top-k，去重）
	const perPos: TopLogprob[][] = idxs.map((i) => {
		const tok = logprobs.tokens[i]!;
		const seen = new Set<string>([tok.token]);
		const list: TopLogprob[] = [{ token: tok.token, logprob: tok.logprob }];
		for (const a of tok.topLogprobs ?? []) {
			if (!seen.has(a.token)) {
				seen.add(a.token);
				list.push(a);
			}
		}
		return list.slice(0, topK + 1);
	});

	// 受限笛卡尔积：拼接 → 校验合法数字 → 记录路径概率
	const results = new Map<number, Candidate>();
	let count = 0;
	const dfs = (pos: number, strAcc: string, lpAcc: number[]): void => {
		if (count >= maxCandidates) return;
		if (pos === perPos.length) {
			if (/^-?\d+(?:\.\d+)?$/.test(strAcc)) {
				const v = Number(strAcc);
				if (Number.isFinite(v) && v >= 0) {
					const prev = results.get(v);
					const lpSum = lpAcc.reduce((a, b) => a + b, 0);
					if (!prev || lpSum > prev.tokenLogprobs.reduce((a, b) => a + b, 0)) {
						results.set(v, { value: v, tokenLogprobs: [...lpAcc] });
					}
					count++;
				}
			}
			return;
		}
		for (const cand of perPos[pos]!) {
			dfs(pos + 1, strAcc + cand.token, [...lpAcc, cand.logprob]);
		}
	};
	dfs(0, '', []);

	return [...results.values()];
}

/**
 * 便捷链路：从单次调用的 top_logprobs 直接得到受限期望解码的数值。
 * 返回 null 表示无有效候选（调用方可回退到现有 meanLogprobForValue 单点）。
 */
export function decodeExpectedValue(
	logprobs: LogprobInfo,
	jsonText: string,
	key: 'min_value' | 'max_value',
	opts?: PathDecodeOptions,
): number | null {
	const cands = candidateValuesFromLogprobs(logprobs, jsonText, key, opts);
	if (cands.length === 0) return null;
	return expectationDecode(cands).value;
}
