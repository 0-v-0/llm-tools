import type {
	LLMProvider,
	LLMMessage,
	CompleteRequest,
	CompleteResponse,
	ToolCall,
	ToolDef,
	UsageInfo,
	ResponseSchema,
} from '../llm/provider.js';
import { SUBMIT_VALUATION_TOOL, VALUATION_RESPONSE_FORMAT } from '../llm/response-parser.js';
import { LLMError } from '../util/errors.js';
import { SEARCH_VALUATIONS_TOOL, executeToolCall } from './tools.js';

export interface ToolFlowResult {
	text: string;
	toolUsed: boolean;
	toolFallback: boolean;
	usage?: UsageInfo | undefined;
	modelUsed: string;
}

export interface ToolFlowInput {
	provider: LLMProvider;
	systemPrompt: string;
	userMessages: LLMMessage[];
	enableTools: boolean;
	maxRounds: number;
	responseSchema?: ResponseSchema | undefined;
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
	const { provider, systemPrompt, userMessages, enableTools, maxRounds, responseSchema } = input;

	if (!enableTools) {
		// Direct call without search tools (constrained decoding still applies if set)
		const resp = await callProvider(
			provider,
			systemPrompt,
			userMessages,
			false,
			responseSchema,
			maxRounds,
		);
		return {
			text: resp.text,
			toolUsed: false,
			toolFallback: false,
			usage: resp.usage,
			modelUsed: provider.model,
		};
	}

	try {
		const resp = await callProvider(
			provider,
			systemPrompt,
			userMessages,
			true,
			responseSchema,
			maxRounds,
		);
		return {
			text: resp.text,
			toolUsed: resp.toolUsed,
			toolFallback: false,
			usage: resp.usage,
			modelUsed: provider.model,
		};
	} catch {
		// Fallback: retry without search tools (keep constrained decoding)
		const resp = await callProvider(
			provider,
			systemPrompt,
			userMessages,
			false,
			responseSchema,
			maxRounds,
		);
		return {
			text: resp.text,
			toolUsed: false,
			toolFallback: true,
			usage: resp.usage,
			modelUsed: provider.model,
		};
	}
}

interface InternalResult {
	text: string;
	toolUsed: boolean;
	usage?: UsageInfo | undefined;
}

async function callProvider(
	provider: LLMProvider,
	systemPrompt: string,
	userMessages: LLMMessage[],
	withSearchTools: boolean,
	responseSchema: ResponseSchema | undefined,
	maxRounds: number,
): Promise<InternalResult> {
	const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }, ...userMessages];

	// Build tools list: search tools + submit_valuation (for constrained output on providers without response_format)
	const tools: ToolDef[] = [];
	if (withSearchTools) tools.push(SEARCH_VALUATIONS_TOOL);
	if (responseSchema) tools.push(SUBMIT_VALUATION_TOOL);

	let toolUsed = false;

	for (let round = 0; round < maxRounds; round++) {
		const req: CompleteRequest = {
			model: provider.model,
			messages,
		};
		if (tools.length > 0) req.tools = tools;
		if (responseSchema) req.responseSchema = responseSchema;

		const resp: CompleteResponse = await provider.complete(req);

		if (resp.stopReason === 'tool_use' && resp.toolCalls.length > 0) {
			// Check if submit_valuation was called (constrained output via tool)
			const submitCall = resp.toolCalls.find((tc) => tc.name === 'submit_valuation');
			if (submitCall) {
				// Extract arguments as the final JSON text response
				return { text: submitCall.arguments, toolUsed, usage: resp.usage };
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
				const result = executeToolCall(tc.name, args);

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
		return { text: resp.text, toolUsed, usage: resp.usage };
	}

	// Exhausted rounds — return last text or throw
	throw new LLMError(`工具调用循环超过最大轮次 (${maxRounds})`);
}
