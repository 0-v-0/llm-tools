import type {
	LLMProvider,
	LLMMessage,
	CompleteRequest,
	CompleteResponse,
	ToolCall,
	ToolDef,
	UsageInfo,
	ResponseSchema,
	LogprobInfo,
} from '@llm-image/shared';
import { LLMError } from '@llm-image/shared';
import { submitToolFor } from '../llm/response-parser.js';
import { SEARCH_VALUATIONS_TOOL, GET_EXIF_TOOL, executeToolCall } from './tools.js';

export interface ToolFlowResult {
	text: string;
	toolUsed: boolean;
	toolFallback: boolean;
	usage?: UsageInfo | undefined;
	logprobs?: LogprobInfo | undefined;
	modelUsed: string;
}

export interface ToolFlowInput {
	provider: LLMProvider;
	systemPrompt: string;
	userMessages: LLMMessage[];
	enableTools: boolean;
	enableSearchTools?: boolean;
	maxRounds: number;
	responseSchema?: ResponseSchema | undefined;
	imageUrl?: string;
	standardName?: string;
	/** 请求 per-token logprobs，用于校准置信度。启用时数值走 JSON content 路径。 */
	logprobs?: boolean | undefined;
	/** top-k 候选 token（需要 logprobs）。 */
	topLogprobs?: number | undefined;
	/** 采样温度；多样本聚合时由 engine 传入 > 0 以产生多样性。 */
	temperature?: number | undefined;
}

/**
 * Run the LLM with optional tool calling and constrained decoding.
 * - When responseSchema is set, OpenAI uses response_format (native constrained decoding).
 * - For Anthropic (no response_format), a submit_valuation tool is added so the model
 *   returns structured arguments; we extract args as the final text response.
 * - If enableTools and the provider fails, falls back to no-search-tools mode once
 *   (but keeps constrained decoding if set).
 */
export async function runToolFlow(input: ToolFlowInput): Promise<ToolFlowResult> {
	const {
		provider,
		systemPrompt,
		userMessages,
		enableTools,
		enableSearchTools = true,
		maxRounds,
		responseSchema,
		imageUrl,
		standardName,
	} = input;

	if (!enableTools) {
		// Direct call without search tools (constrained decoding still applies if set)
		const resp = await callProvider(
			provider,
			systemPrompt,
			userMessages,
			false,
			false,
			undefined,
			undefined,
			responseSchema,
			maxRounds,
			input.logprobs,
			input.topLogprobs,
			input.temperature,
		);
		return {
			text: resp.text,
			toolUsed: false,
			toolFallback: false,
			usage: resp.usage,
			logprobs: resp.logprobs,
			modelUsed: provider.model,
		};
	}

	try {
		const resp = await callProvider(
			provider,
			systemPrompt,
			userMessages,
			true,
			enableSearchTools,
			imageUrl,
			standardName,
			responseSchema,
			maxRounds,
			input.logprobs,
			input.topLogprobs,
			input.temperature,
		);
		return {
			text: resp.text,
			toolUsed: resp.toolUsed,
			toolFallback: false,
			usage: resp.usage,
			logprobs: resp.logprobs,
			modelUsed: provider.model,
		};
	} catch {
		// Fallback: retry without search tools (keep constrained decoding).
		// Note: this degraded retry drops logprobs/temperature — acceptable; we
		// simply lose the calibration signal rather than failing the valuation.
		const resp = await callProvider(
			provider,
			systemPrompt,
			userMessages,
			false,
			false,
			undefined,
			undefined,
			responseSchema,
			maxRounds,
		);
		return {
			text: resp.text,
			toolUsed: false,
			toolFallback: true,
			usage: resp.usage,
			logprobs: resp.logprobs,
			modelUsed: provider.model,
		};
	}
}

interface InternalResult {
	text: string;
	toolUsed: boolean;
	usage?: UsageInfo | undefined;
	logprobs?: LogprobInfo | undefined;
}

async function callProvider(
	provider: LLMProvider,
	systemPrompt: string,
	userMessages: LLMMessage[],
	withTools: boolean,
	enableSearchTools: boolean,
	imageUrl: string | undefined,
	standardName: string | undefined,
	responseSchema: ResponseSchema | undefined,
	maxRounds: number,
	logprobs?: boolean | undefined,
	topLogprobs?: number | undefined,
	temperature?: number | undefined,
): Promise<InternalResult> {
	const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }, ...userMessages];

	// Build tools list: get_exif + search_valuations + submit_valuation (for constrained output on providers without response_format)
	const tools: ToolDef[] = [];
	if (withTools) tools.push(GET_EXIF_TOOL);
	if (withTools && enableSearchTools) tools.push(SEARCH_VALUATIONS_TOOL);
	// submit tool is derived from the response schema so each bound (min/max) carries its own schema (plan C).
	// 但当启用 logprobs 时，必须让数值以 JSON **content** 形式产出（OpenAI response_format / Anthropic 文本 JSON），
	// 否则数值落在 tool_use 参数里，提供者不会返回其 token logprobs。因此此处不再下发 submit 工具。
	if (responseSchema && !logprobs) tools.push(submitToolFor(responseSchema));

	let toolUsed = false;

	for (let round = 0; round < maxRounds; round++) {
		const req: CompleteRequest = {
			model: provider.model,
			messages,
		};
		if (tools.length > 0) req.tools = tools;
		if (responseSchema) req.responseSchema = responseSchema;
		if (logprobs) req.logprobs = true;
		if (topLogprobs && topLogprobs > 0) req.topLogprobs = topLogprobs;
		if (temperature !== undefined) req.temperature = temperature;

		const resp: CompleteResponse = await provider.complete(req);

		if (resp.stopReason === 'tool_use' && resp.toolCalls.length > 0) {
			// Check if submit_valuation was called (constrained output via tool)
			const submitCall = resp.toolCalls.find((tc) => tc.name === 'submit_valuation');
			if (submitCall) {
				// Extract arguments as the final JSON text response
				return { text: submitCall.arguments, toolUsed, usage: resp.usage, logprobs: resp.logprobs };
			}

			// Handle real tool calls (search_valuations etc.)
			toolUsed = true;

			// Append assistant message with tool calls
			messages.push({
				role: 'assistant',
				content: [
					...(resp.text ? [{ type: 'text' as const, text: resp.text }] : []),
					...resp.toolCalls.map((tc: ToolCall) => ({
						type: 'tool_call' as const,
						id: tc.id,
						name: tc.name,
						arguments: tc.arguments,
					})),
				],
			});

			// Execute each tool call and append results
			for (const tc of resp.toolCalls) {
				const args = JSON.parse(tc.arguments) as unknown;
				const result = await executeToolCall(tc.name, args, { imageUrl, standardName });

				messages.push({
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_call_id: tc.id,
							content: result.ok ? JSON.stringify(result.result) : `Error: ${result.error}`,
						},
					],
				});
			}

			// Continue loop for next round
			continue;
		}

		// stop or length — return final text
		return { text: resp.text, toolUsed, usage: resp.usage, logprobs: resp.logprobs };
	}

	// Exhausted rounds — return last text or throw
	throw new LLMError(`工具调用循环超过最大轮次 (${maxRounds})`);
}
