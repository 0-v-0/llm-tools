import type {
	LLMProvider,
	ProcessedImage,
	ToolDef,
	UsageInfo,
	ResponseSchema,
} from '@llm-image/shared';
import type { EnvConfig } from '../config/env.js';
import type { AppConfig } from '../config/config.js';
import type { Standard } from '../standards/parser.js';
import type { Confidence, ImageFormat } from '../storage/types.js';
import { buildPrompt } from '../llm/prompt.js';
import {
	parseMinResponse,
	parseMaxResponse,
	meanLogprobForValue,
	MIN_VALUE_RESPONSE_FORMAT,
	MAX_VALUE_RESPONSE_FORMAT,
	SUBMIT_VALUATION_TOOL,
	type ParsedMinValue,
	type ParsedMaxValue,
} from '../llm/response-parser.js';
import {
	insert as insertValuation,
	count as countValuations,
} from '../storage/repository.valuation.js';
import { runToolFlow, type ToolFlowResult } from './tool-flow.js';
import {
	candidateValuesFromLogprobs,
	expectationDecode,
} from './expected-decode.js';
import { computeResolutionCorrection } from './resolution-correction.js';
import { logFailedRequest } from '../util/fail-log.js';
import { GET_EXIF_TOOL, SEARCH_VALUATIONS_TOOL } from './tools.js';

let dbHasRecords: boolean | null = null;

function hasDbRecords(): boolean {
	if (dbHasRecords === null) {
		dbHasRecords = countValuations() > 0;
	}
	return dbHasRecords;
}

export interface ValuationRequest {
	url: string;
	image: ProcessedImage;
	standard: Standard;
	provider: LLMProvider;
	env: EnvConfig;
	config: AppConfig;
	enableTools: boolean;
}

export interface ValuationResult {
	image: {
		url: string;
		format: ImageFormat;
		width: number;
		height: number;
		channels: number | null;
		sizeBytes: number;
		undecodablePixels: number;
		hash: string;
	};
	valuation: {
		minValue: number;
		maxValue: number;
		uncertainty: number;
		currency: string;
		rationale: string;
		confidence: Confidence;
		confidenceScore: number | null;
		minLogprob: number | null;
		maxLogprob: number | null;
		samplesMin: number;
		samplesMax: number;
	};
	standard: {
		name: string;
		version: string | null;
	};
	llm: {
		model: string;
		toolUsed: boolean;
		toolFallback: boolean;
		inputTokens: number | null;
		outputTokens: number | null;
	};
	notes: string[];
	timestamp: string;
}

/** 单条采样结果（一次 LLM 调用的原始产出）。 */
interface BoundSample {
	value: number;
	logprob: number | null;
	rationale: string;
	confidence: Confidence;
	text: string;
	toolUsed: boolean;
	toolFallback: boolean;
	usage?: UsageInfo | undefined;
}

/** 某边界多样本聚合后的结果。 */
export interface AggregatedBound {
	value: number;
	logprob: number | null;
	rationale: string;
	confidence: Confidence;
}

export async function valuate(req: ValuationRequest): Promise<ValuationResult> {
	const { image, standard, provider, env, config, enableTools } = req;

	const imageHash = image.hash;

	// search_valuations 仅在数据库有记录时可用；get_exif 始终可用
	const enableSearchTools = enableTools && hasDbRecords();

	// 系统级尺寸修正因子（基于分辨率阈值，由元信息计算，LLM 无需处理）
	const sizeResult = computeResolutionCorrection(
		image.width,
		image.height,
		standard.frontmatter.size_correction,
	);

	// min（客观假设）与 max（最好假设）分两次独立请求，避免相互锚定。
	// 两次请求各自携带对应边界的 prompt 与 response schema。
	const minPrompt = buildPrompt(standard, image, enableTools, enableSearchTools, true, 'min');
	const maxPrompt = buildPrompt(standard, image, enableTools, enableSearchTools, true, 'max');

	// 采样配置：默认 min/max 各 1 次（确定性、temp=0）。多次采样时用 samplingTemperature 产生多样性。
	const samplesMin = Math.max(1, config.samplesMin);
	const samplesMax = Math.max(1, config.samplesMax);
	const useLogprobs = config.enableLogprobs;
	const tempFor = (n: number) => (n > 1 ? config.samplingTemperature : 0);

	try {
		let minSamples: BoundSample[];
		let minAgg: AggregatedBound;
		let maxSamples: BoundSample[];
		let maxAgg: AggregatedBound;

		if (config.usePathDecoding) {
			// 受限期望解码：每边界仅 1 次调用（temp=0 + top_logprobs + 路径期望），
			// 用单次调用内模型自身的 top-k 分布重建候选并求概率加权期望，替代多样本聚合。
			({ samples: minSamples, agg: minAgg } = await decodePathBound({
				provider,
				systemPrompt: minPrompt.systemPrompt,
				userMessages: minPrompt.userMessages,
				enableTools,
				enableSearchTools,
				maxRounds: config.maxToolRounds,
				responseSchema: MIN_VALUE_RESPONSE_FORMAT,
				imageUrl: req.url,
				standardName: standard.frontmatter.name,
				bound: 'min',
				topK: config.pathTopK,
				logprobs: useLogprobs,
			}));
			({ samples: maxSamples, agg: maxAgg } = await decodePathBound({
				provider,
				systemPrompt: maxPrompt.systemPrompt,
				userMessages: maxPrompt.userMessages,
				enableTools,
				enableSearchTools,
				maxRounds: config.maxToolRounds,
				responseSchema: MAX_VALUE_RESPONSE_FORMAT,
				imageUrl: req.url,
				standardName: standard.frontmatter.name,
				bound: 'max',
				topK: config.pathTopK,
				logprobs: useLogprobs,
			}));
		} else {
			// 默认：min/max 各自独立采样多次，logprobs 加权聚合
			minSamples = await sampleBound({
				provider,
				systemPrompt: minPrompt.systemPrompt,
				userMessages: minPrompt.userMessages,
				enableTools,
				enableSearchTools,
				maxRounds: config.maxToolRounds,
				responseSchema: MIN_VALUE_RESPONSE_FORMAT,
				imageUrl: req.url,
				standardName: standard.frontmatter.name,
				bound: 'min',
				samples: samplesMin,
				temperature: tempFor(samplesMin),
				logprobs: useLogprobs,
			});
			minAgg = aggregateBound(minSamples, 'min');

			maxSamples = await sampleBound({
				provider,
				systemPrompt: maxPrompt.systemPrompt,
				userMessages: maxPrompt.userMessages,
				enableTools,
				enableSearchTools,
				maxRounds: config.maxToolRounds,
				responseSchema: MAX_VALUE_RESPONSE_FORMAT,
				imageUrl: req.url,
				standardName: standard.frontmatter.name,
				bound: 'max',
				samples: samplesMax,
				temperature: tempFor(samplesMax),
				logprobs: useLogprobs,
			});
			maxAgg = aggregateBound(maxSamples, 'max');
		}

		return finalizeValuation({
			req,
			image,
			imageHash,
			standard,
			config,
			sizeResult,
			minAgg,
			maxAgg,
			minSamples,
			maxSamples,
			llmModel: `${env.LLM_PROVIDER}/${provider.model}`,
		});
	} catch (e) {
		// 记录失败的完整请求（仅当 failLogDir 配置时）
		if (config.failLogDir) {
			const tools: ToolDef[] = [];
			if (enableTools) tools.push(GET_EXIF_TOOL);
			if (enableTools && enableSearchTools) tools.push(SEARCH_VALUATIONS_TOOL);
			tools.push(SUBMIT_VALUATION_TOOL);

			logFailedRequest(config.failLogDir, {
				url: req.url,
				image: {
					format: image.format,
					width: image.width,
					height: image.height,
					channels: image.channels,
					sizeBytes: image.sizeBytes,
					undecodablePixels: image.undecodablePixels,
					hash: image.hash,
				},
				standardName: standard.frontmatter.name,
				standardVersion: standard.contentHash,
				model: `${env.LLM_PROVIDER}/${provider.model}`,
				enableTools,
				// 记录最后一个（上界）请求作为失败代表；两请求共享标准与图片
				systemPrompt: maxPrompt.systemPrompt,
				userMessages: maxPrompt.userMessages,
				tools,
				responseSchema: MAX_VALUE_RESPONSE_FORMAT,
				error: e instanceof Error ? e.message : String(e),
			});
		}
		throw e;
	}
}

/**
 * 对单个边界（min/max）独立采样 `samples` 次。每次都是一次完整 tool-flow 调用：
 * - samples===1 时 temperature=0；
 * - samples>1 时由调用方传入 >0 温度以产生多样性；
 * - 启用 logprobs 时，数值走 JSON content 路径，从而能取到 value token 的 logprob。
 */
async function sampleBound(opts: {
	provider: LLMProvider;
	systemPrompt: string;
	userMessages: Parameters<typeof runToolFlow>[0]['userMessages'];
	enableTools: boolean;
	enableSearchTools: boolean;
	maxRounds: number;
	responseSchema: ResponseSchema;
	imageUrl: string;
	standardName: string;
	bound: 'min' | 'max';
	samples: number;
	temperature: number;
	logprobs: boolean;
}): Promise<BoundSample[]> {
	const out: BoundSample[] = [];
	for (let i = 0; i < opts.samples; i++) {
		const flow: ToolFlowResult = await runToolFlow({
			provider: opts.provider,
			systemPrompt: opts.systemPrompt,
			userMessages: opts.userMessages,
			enableTools: opts.enableTools,
			enableSearchTools: opts.enableSearchTools,
			maxRounds: opts.maxRounds,
			responseSchema: opts.responseSchema,
			imageUrl: opts.imageUrl,
			standardName: opts.standardName,
			logprobs: opts.logprobs,
			temperature: opts.temperature,
		});

		const parsed =
			opts.bound === 'min' ? parseMinResponse(flow.text) : parseMaxResponse(flow.text);
		const value =
			opts.bound === 'min'
				? (parsed as ParsedMinValue).minValue
				: (parsed as ParsedMaxValue).maxValue;

		const logprob = opts.logprobs
			? meanLogprobForValue(
					flow.logprobs,
					flow.text,
					opts.bound === 'min' ? 'min_value' : 'max_value',
				)
			: null;

		out.push({
			value,
			logprob,
			rationale: parsed.rationale,
			confidence: parsed.confidence,
			text: flow.text,
			toolUsed: flow.toolUsed,
			toolFallback: flow.toolFallback,
			usage: flow.usage,
		});
	}
	return out;
}

/**
 * 受限期望解码模式下的单边界采样：仅 1 次 LLM 调用（temp=0 + top_logprobs），
 * 用单次调用内模型自身的 top-k 分布重建候选数值路径并求概率加权期望。
 * 返回结构与 `sampleBound + aggregateBound` 一致，供 finalizeValuation 复用。
 *
 * 退化路径（与 usePathDecoding=false 的 samples=1 行为对齐）：
 * - 有 logprobs 但 top_logprobs 未覆盖数值 → 退化为主路径单点 + meanLogprobForValue；
 * - 调用降级丢失 logprobs（如工具回退） → 退化为 argmax 单点。
 */
async function decodePathBound(opts: {
	provider: LLMProvider;
	systemPrompt: string;
	userMessages: Parameters<typeof runToolFlow>[0]['userMessages'];
	enableTools: boolean;
	enableSearchTools: boolean;
	maxRounds: number;
	responseSchema: ResponseSchema;
	imageUrl: string;
	standardName: string;
	bound: 'min' | 'max';
	topK: number;
	logprobs: boolean;
}): Promise<{ samples: BoundSample[]; agg: AggregatedBound }> {
	const flow = await runToolFlow({
		provider: opts.provider,
		systemPrompt: opts.systemPrompt,
		userMessages: opts.userMessages,
		enableTools: opts.enableTools,
		enableSearchTools: opts.enableSearchTools,
		maxRounds: opts.maxRounds,
		responseSchema: opts.responseSchema,
		imageUrl: opts.imageUrl,
		standardName: opts.standardName,
		logprobs: opts.logprobs,
		topLogprobs: opts.logprobs ? opts.topK : undefined,
		temperature: 0,
	});

	const parsed =
		opts.bound === 'min' ? parseMinResponse(flow.text) : parseMaxResponse(flow.text);
	const argmaxValue =
		opts.bound === 'min'
			? (parsed as ParsedMinValue).minValue
			: (parsed as ParsedMaxValue).maxValue;
	const key = opts.bound === 'min' ? 'min_value' : 'max_value';

	let finalValue: number;
	let aggLogprob: number | null;
	let rationale: string;
	let confidence: Confidence;

	if (flow.logprobs && opts.logprobs) {
		const cands = candidateValuesFromLogprobs(flow.logprobs, flow.text, key, { topK: opts.topK });
		if (cands.length > 0) {
			const res = expectationDecode(cands);
			finalValue = res.value;
			aggLogprob = res.logprob;
			rationale = res.rationale ?? parsed.rationale;
			confidence = res.confidence ?? parsed.confidence;
		} else {
			// top_logprobs 未覆盖数值（罕见）：退化为单点
			finalValue = argmaxValue;
			aggLogprob = meanLogprobForValue(flow.logprobs, flow.text, key);
			rationale = parsed.rationale;
			confidence = parsed.confidence;
		}
	} else {
		// 未启用 logprobs 或调用降级丢失 logprobs：退化为 argmax 单点
		finalValue = argmaxValue;
		aggLogprob = opts.logprobs ? meanLogprobForValue(flow.logprobs, flow.text, key) : null;
		rationale = parsed.rationale;
		confidence = parsed.confidence;
	}

	const sample: BoundSample = {
		value: finalValue,
		logprob: aggLogprob,
		rationale,
		confidence,
		text: flow.text,
		toolUsed: flow.toolUsed,
		toolFallback: flow.toolFallback,
		usage: flow.usage,
	};

	return {
		samples: [sample],
		agg: { value: finalValue, logprob: aggLogprob, rationale, confidence },
	};
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** 区间可靠性受更弱的边界约束，整体 confidence 取两者中较低者。 */
function weakerConfidence(a: Confidence, b: Confidence): Confidence {
	return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * 将同一边界的多次采样聚合为单一估值。
 * - value：有 logprobs 时用 exp(均值logprob) 加权均值（更自信的采样权重更高），否则简单均值；
 * - confidence：先取各样本自报置信的较弱者，再用聚合 logprob 进一步下修；
 * - rationale：取 logprob 最高（最自信）样本的表述；无 logprobs 时取首个样本。
 */
export function aggregateBound(samples: BoundSample[], bound: 'min' | 'max'): AggregatedBound {
	if (samples.length === 0) {
		throw new Error(`aggregateBound(${bound}): 无采样结果`);
	}
	if (samples.length === 1) {
		const s = samples[0]!;
		return { value: s.value, logprob: s.logprob, rationale: s.rationale, confidence: s.confidence };
	}

	const withLp = samples.filter((s) => s.logprob !== null) as (BoundSample & { logprob: number })[];

	let value: number;
	let aggLogprob: number | null;
	if (withLp.length > 0) {
		let wsum = 0;
		let vsum = 0;
		for (const s of withLp) {
			const w = Math.exp(s.logprob);
			wsum += w;
			vsum += w * s.value;
		}
		value = wsum > 0 ? vsum / wsum : samples.reduce((a, s) => a + s.value, 0) / samples.length;
		aggLogprob = withLp.reduce((a, s) => a + s.logprob, 0) / withLp.length;
	} else {
		value = samples.reduce((a, s) => a + s.value, 0) / samples.length;
		aggLogprob = null;
	}

	// 各样本自报置信的较弱者
	let conf: Confidence = 'high';
	for (const s of samples) {
		if (CONFIDENCE_RANK[s.confidence] < CONFIDENCE_RANK[conf]) conf = s.confidence;
	}
	// 用聚合 logprob 进一步下修
	if (aggLogprob !== null) {
		const lpConf = confidenceFromLogprob(aggLogprob);
		if (CONFIDENCE_RANK[lpConf] < CONFIDENCE_RANK[conf]) conf = lpConf;
	}

	// 取最自信（logprob 最高）样本的表述
	let rep = samples[0]!;
	let best = rep.logprob ?? -Infinity;
	for (const s of withLp) {
		if (s.logprob > best) {
			best = s.logprob;
			rep = s;
		}
	}

	return { value, logprob: aggLogprob, rationale: rep.rationale, confidence: conf };
}

/** 合并两边界的聚合 logprob：都非 null 时取较弱者（更小），否则取存在者。 */
function combineLogprob(a: number | null, b: number | null): number | null {
	if (a !== null && b !== null) return Math.min(a, b);
	return a ?? b;
}

/** 将数值 token 的平均 logprob 映射为粗粒度置信（启发式阈值，可按需调参）。 */
function confidenceFromLogprob(meanLogprob: number): Confidence {
	if (meanLogprob >= -1.0) return 'high';
	if (meanLogprob >= -2.5) return 'medium';
	return 'low';
}

function finalizeValuation(args: {
	req: ValuationRequest;
	image: ProcessedImage;
	imageHash: string;
	standard: Standard;
	config: AppConfig;
	sizeResult: ReturnType<typeof computeResolutionCorrection>;
	minAgg: AggregatedBound;
	maxAgg: AggregatedBound;
	minSamples: BoundSample[];
	maxSamples: BoundSample[];
	llmModel: string;
}): ValuationResult {
	const { image, standard, config, sizeResult, minAgg, maxAgg, llmModel, imageHash, req, minSamples, maxSamples } = args;

	// 应用系统级尺寸修正因子
	const rawMin = minAgg.value;
	const rawMax = maxAgg.value;
	const clampedMin = Math.max(0, Math.round(rawMin * sizeResult.multiplier * 100) / 100);
	const clampedMax = Math.max(0, Math.round(rawMax * sizeResult.multiplier * 100) / 100);

	// Reconcile：两次独立估算可能出现交叉（max < min），重排为合法区间以保证 max >= min。
	let finalMin = clampedMin;
	let finalMax = clampedMax;
	let reorderNote = '';
	if (finalMax < finalMin) {
		finalMin = Math.min(clampedMin, clampedMax);
		finalMax = Math.max(clampedMin, clampedMax);
		reorderNote = '（上下界估算交叉，已按数值重排以保证 max≥min）';
	}
	const uncertainty = finalMax - finalMin;

	// 连续置信分：取较弱边界的聚合 logprob（区间可靠性受更弱边界约束）经 exp 派生。
	// 展示用枚举由该分经阈值映射；logprobs 缺失时回退到自报枚举较弱者。
	const combinedLogprob = combineLogprob(minAgg.logprob, maxAgg.logprob);
	const confidenceScore = combinedLogprob !== null ? Math.exp(combinedLogprob) : null;
	const confidence =
		combinedLogprob !== null
			? confidenceFromLogprob(combinedLogprob)
			: weakerConfidence(minAgg.confidence, maxAgg.confidence);

	const timestamp = new Date().toISOString();
	const notes = [...image.notes];
	if (config.usePathDecoding) {
		notes.push('路径期望解码（单次调用 + top-k 概率加权），替代多样本温度采样聚合');
	}

	// 合并两个独立假设的说明：下界(客观假设) + 上界(最好假设)
	let valuationRationale = `下界(客观假设)：${minAgg.rationale} 上界(最好假设)：${maxAgg.rationale}`;
	if (sizeResult.multiplier !== 1 && sizeResult.reason) {
		valuationRationale += `（尺寸修正 ×${sizeResult.multiplier.toFixed(2)}：${sizeResult.reason}）`;
	}
	if (reorderNote) valuationRationale += reorderNote;

	// token 用量与 raw 文本：合并所有采样
	const allSamples = [...minSamples, ...maxSamples];
	const inputTokens = allSamples.reduce((a, s) => a + (s.usage?.inputTokens ?? 0), 0) || null;
	const outputTokens = allSamples.reduce((a, s) => a + (s.usage?.outputTokens ?? 0), 0) || null;
	const toolUsed = minSamples.some((s) => s.toolUsed) || maxSamples.some((s) => s.toolUsed);
	const toolFallback =
		minSamples.some((s) => s.toolFallback) || maxSamples.some((s) => s.toolFallback);
	const rawLlmText = config.storeRaw
		? [
				'=== min(客观假设) 采样 ===',
				...minSamples.map((s, i) => `[#${i + 1}] ${s.text}`),
				'=== max(最好假设) 采样 ===',
				...maxSamples.map((s, i) => `[#${i + 1}] ${s.text}`),
			].join('\n')
		: null;

	const result: ValuationResult = {
		image: {
			url: req.url,
			format: image.format,
			width: image.width,
			height: image.height,
			channels: image.channels,
			sizeBytes: image.sizeBytes,
			undecodablePixels: image.undecodablePixels,
			hash: imageHash,
		},
		valuation: {
			minValue: finalMin,
			maxValue: finalMax,
			uncertainty,
			currency: standard.frontmatter.currency,
			rationale: valuationRationale,
			confidence,
			confidenceScore,
			minLogprob: minAgg.logprob,
			maxLogprob: maxAgg.logprob,
			samplesMin: minSamples.length,
			samplesMax: maxSamples.length,
		},
		standard: {
			name: standard.frontmatter.name,
			version: standard.contentHash,
		},
		llm: {
			model: llmModel,
			toolUsed,
			toolFallback,
			inputTokens,
			outputTokens,
		},
		notes,
		timestamp,
	};

	// Persist to DB
	insertValuation({
		imageHash,
		url: req.url,
		imageFormat: image.format,
		width: image.width,
		height: image.height,
		channels: image.channels,
		sizeBytes: image.sizeBytes,
		undecodablePixels: image.undecodablePixels,
		minValue: finalMin,
		maxValue: finalMax,
		currency: standard.frontmatter.currency,
		standardName: standard.frontmatter.name,
		standardVersion: standard.contentHash,
		llmModel,
		description: valuationRationale,
		notes,
		toolUsed,
		toolFallback,
		inputTokens,
		outputTokens,
		minLogprob: result.valuation.minLogprob,
		maxLogprob: result.valuation.maxLogprob,
		confidenceScore: result.valuation.confidenceScore,
		samplesMin: result.valuation.samplesMin,
		samplesMax: result.valuation.samplesMax,
		rawLlmText,
	});

	return result;
}
