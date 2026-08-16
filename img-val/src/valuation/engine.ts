import type { LLMProvider, ProcessedImage, ToolDef } from '@llm-image/shared';
import type { EnvConfig } from '../config/env.js';
import type { Standard } from '../standards/parser.js';
import type { Confidence, ImageFormat } from '../storage/types.js';
import { buildPrompt } from '../llm/prompt.js';
import {
	parseValuationResponse,
	VALUATION_RESPONSE_FORMAT,
	SUBMIT_VALUATION_TOOL,
} from '../llm/response-parser.js';
import {
	insert as insertValuation,
	count as countValuations,
} from '../storage/repository.valuation.js';
import { runToolFlow, type ToolFlowResult } from './tool-flow.js';
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

export async function valuate(req: ValuationRequest): Promise<ValuationResult> {
	const { image, standard, provider, env, enableTools } = req;

	const imageHash = image.hash;

	// search_valuations 仅在数据库有记录时可用；get_exif 始终可用
	const enableSearchTools = enableTools && hasDbRecords();

	// 系统级尺寸修正因子（基于分辨率阈值，由元信息计算，LLM 无需处理）
	const sizeResult = computeResolutionCorrection(
		image.width,
		image.height,
		standard.frontmatter.size_correction,
	);

	// Build prompt (constrained=true since we always pass responseSchema)
	const { systemPrompt, userMessages } = buildPrompt(
		standard,
		image,
		enableTools,
		enableSearchTools,
		true,
	);

	try {
		// Run tool flow with constrained decoding
		const flowResult = await runToolFlow({
			provider,
			systemPrompt,
			userMessages,
			enableTools,
			enableSearchTools,
			maxRounds: env.IMGVAL_MAX_TOOL_ROUNDS,
			responseSchema: VALUATION_RESPONSE_FORMAT,
			imageUrl: req.url,
			standardName: standard.frontmatter.name,
		});

		// Parse LLM response
		const parsed = parseValuationResponse(flowResult.text);

		return finalizeValuation({
			req,
			image,
			imageHash,
			standard,
			env,
			sizeResult,
			parsed,
			llmModel: `${env.LLM_PROVIDER}/${provider.model}`,
			flowResult,
		});
	} catch (e) {
		// 记录失败的完整请求（仅当 IMGVAL_FAIL_LOG 配置时）
		if (env.IMGVAL_FAIL_LOG) {
			const tools: ToolDef[] = [];
			if (enableTools) tools.push(GET_EXIF_TOOL);
			if (enableTools && enableSearchTools) tools.push(SEARCH_VALUATIONS_TOOL);
			tools.push(SUBMIT_VALUATION_TOOL);

			logFailedRequest(env.IMGVAL_FAIL_LOG, {
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
				systemPrompt,
				userMessages,
				tools,
				responseSchema: VALUATION_RESPONSE_FORMAT,
				error: e instanceof Error ? e.message : String(e),
			});
		}
		throw e;
	}
}

function finalizeValuation(args: {
	req: ValuationRequest;
	image: ProcessedImage;
	imageHash: string;
	standard: Standard;
	env: EnvConfig;
	sizeResult: ReturnType<typeof computeResolutionCorrection>;
	parsed: ReturnType<typeof parseValuationResponse>;
	llmModel: string;
	flowResult: ToolFlowResult;
}): ValuationResult {
	const { image, standard, env, sizeResult, parsed, llmModel, imageHash, req, flowResult } = args;
	const rawMin = parsed.minValue;
	const rawMax = parsed.maxValue;
	const clampedMin = Math.max(0, Math.round(rawMin * sizeResult.multiplier * 100) / 100);
	const clampedMax = Math.max(clampedMin, Math.round(rawMax * sizeResult.multiplier * 100) / 100);
	const uncertainty = clampedMax - clampedMin;

	const timestamp = new Date().toISOString();
	const notes = [...image.notes];

		const valuationRationale =
			sizeResult.multiplier !== 1 && sizeResult.reason
				? `${parsed.rationale}（尺寸修正 ×${sizeResult.multiplier.toFixed(2)}：${sizeResult.reason}）`
				: parsed.rationale;

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
				minValue: clampedMin,
				maxValue: clampedMax,
				uncertainty,
				currency: standard.frontmatter.currency,
				rationale: valuationRationale,
				confidence: parsed.confidence,
			},
		standard: {
			name: standard.frontmatter.name,
			version: standard.contentHash,
		},
		llm: {
			model: llmModel,
			toolUsed: flowResult.toolUsed,
			toolFallback: flowResult.toolFallback,
			inputTokens: flowResult.usage?.inputTokens ?? null,
			outputTokens: flowResult.usage?.outputTokens ?? null,
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
		minValue: clampedMin,
		maxValue: clampedMax,
		currency: standard.frontmatter.currency,
		standardName: standard.frontmatter.name,
		standardVersion: standard.contentHash,
		llmModel,
		description: parsed.rationale,
		notes,
		toolUsed: flowResult.toolUsed,
		toolFallback: flowResult.toolFallback,
		inputTokens: flowResult.usage?.inputTokens ?? null,
		outputTokens: flowResult.usage?.outputTokens ?? null,
		rawLlmText: env.IMGVAL_STORE_RAW ? flowResult.text : null,
	});

	return result;
}
