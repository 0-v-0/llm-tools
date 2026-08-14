import type { LLMProvider, ProcessedImage } from '@llm-image/shared';
import { ImageError } from '@llm-image/shared';
import type { EnvConfig } from '../config/env.js';
import type { Standard } from '../standards/parser.js';
import type { Confidence, ImageFormat, Corruption } from '../storage/types.js';
import { buildPrompt } from '../llm/prompt.js';
import { parseValuationResponse, VALUATION_RESPONSE_FORMAT } from '../llm/response-parser.js';
import {
	insert as insertValuation,
	count as countValuations,
} from '../storage/repository.valuation.js';
import { runToolFlow } from './tool-flow.js';

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
		corruption: Corruption;
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
		provider: string;
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

	if (image.corruption === 'unreadable') {
		throw new ImageError(`图片不可读，无法估值: ${req.url}`);
	}

	const imageHash = image.hash;

	// Disable search tools when DB is empty — no reference data to offer
	const effectiveEnableTools = enableTools && hasDbRecords();

	// Build prompt (constrained=true since we always pass responseSchema)
	const { systemPrompt, userMessages } = buildPrompt(standard, image, effectiveEnableTools, true);

	// Run tool flow with constrained decoding
	const flowResult = await runToolFlow({
		provider,
		systemPrompt,
		userMessages,
		enableTools: effectiveEnableTools,
		maxRounds: env.IMGVAL_MAX_TOOL_ROUNDS,
		responseSchema: VALUATION_RESPONSE_FORMAT,
	});

	// Parse LLM response
	const parsed = parseValuationResponse(flowResult.text);
	const uncertainty = parsed.maxValue - parsed.minValue;

	const timestamp = new Date().toISOString();
	const notes = [...image.notes];

	const result: ValuationResult = {
		image: {
			url: req.url,
			format: image.format,
			width: image.width,
			height: image.height,
			channels: image.channels,
			sizeBytes: image.sizeBytes,
			corruption: image.corruption,
			hash: imageHash,
		},
		valuation: {
			minValue: parsed.minValue,
			maxValue: parsed.maxValue,
			uncertainty,
			currency: standard.frontmatter.currency,
			rationale: parsed.rationale,
			confidence: parsed.confidence,
		},
		standard: {
			name: standard.frontmatter.name,
			version: standard.frontmatter.version ?? null,
		},
		llm: {
			provider: env.LLM_PROVIDER,
			model: provider.model,
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
		corruption: image.corruption,
		minValue: parsed.minValue,
		maxValue: parsed.maxValue,
		uncertainty,
		currency: standard.frontmatter.currency,
		standardName: standard.frontmatter.name,
		standardVersion: standard.frontmatter.version ?? null,
		llmProvider: env.LLM_PROVIDER,
		llmModel: provider.model,
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
