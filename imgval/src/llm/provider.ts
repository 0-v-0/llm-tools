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

export interface CompleteResponse {
	stopReason: StopReason;
	text: string;
	toolCalls: ToolCall[];
	usage?: UsageInfo | undefined;
}

export interface LLMProvider {
	readonly model: string;
	complete(req: CompleteRequest): Promise<CompleteResponse>;
}
