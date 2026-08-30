export type StopReason = 'stop' | 'tool_use' | 'length' | 'error';

export interface TextBlock {
	type: 'text';
	text: string;
}

export interface ImageUrlBlock {
	type: 'image_url';
	image_url: { url: string; detail?: string };
}

export interface ToolCallBlock {
	type: 'tool_call';
	id: string;
	name: string;
	arguments: string; // JSON string
}

export interface ToolResultBlock {
	type: 'tool_result';
	tool_call_id: string;
	content: string;
}

export type ContentBlock = TextBlock | ImageUrlBlock | ToolCallBlock | ToolResultBlock;

export interface LLMMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ContentBlock[];
}

export interface ToolFunctionDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ToolDef {
	type: 'function';
	function: ToolFunctionDef;
}

export interface ResponseSchema {
	name: string;
	schema: Record<string, unknown>;
}

export interface CompleteRequest {
	model: string;
	messages: LLMMessage[];
	tools?: ToolDef[] | undefined;
	temperature?: number | undefined;
	maxTokens?: number | undefined;
	responseSchema?: ResponseSchema | undefined;
	/** Request per-token logprobs for the output. Enables confidence calibration. */
	logprobs?: boolean | undefined;
	/** Number of top alternative tokens per position (requires logprobs). */
	topLogprobs?: number | undefined;
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface UsageInfo {
	inputTokens: number;
	outputTokens: number;
}

/** A single alternative token considered at one generation step. */
export interface TopLogprob {
	token: string;
	logprob: number;
}

/** One generated output token with its log-probability and top alternatives. */
export interface LogprobToken {
	token: string;
	logprob: number;
	topLogprobs?: TopLogprob[] | undefined;
}

/**
 * Flattened per-token logprobs of the model's output, in generation order.
 * Covers text / JSON-content tokens. Note: tool-call argument tokens are NOT
 * included by providers, so logprobs are only meaningful when the value is
 * emitted as JSON *content* (OpenAI response_format or Anthropic text JSON).
 */
export interface LogprobInfo {
	tokens: LogprobToken[];
}

export interface CompleteResponse {
	stopReason: StopReason;
	text: string;
	toolCalls: ToolCall[];
	usage?: UsageInfo | undefined;
	logprobs?: LogprobInfo | undefined;
}

export interface LLMProvider {
	readonly model: string;
	complete(req: CompleteRequest): Promise<CompleteResponse>;
}
