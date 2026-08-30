import OpenAI from 'openai';
import type {
	LLMProvider,
	CompleteRequest,
	CompleteResponse,
	LLMMessage,
	ContentBlock,
	StopReason,
	LogprobInfo,
} from './provider.js';
import { LLMError } from '../util/errors.js';

interface OpenAIProviderConfig {
	apiBase: string;
	apiKey: string;
	model: string;
	visionDetail: 'low' | 'high' | 'auto';
}

function toOpenAIMessages(
	messages: LLMMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
	return messages.map((msg) => {
		if (typeof msg.content === 'string') {
			if (msg.role === 'system') {
				return {
					role: 'system',
					content: msg.content,
				} as OpenAI.Chat.Completions.ChatCompletionSystemMessageParam;
			}
			if (msg.role === 'user') {
				return {
					role: 'user',
					content: msg.content,
				} as OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
			}
			if (msg.role === 'assistant') {
				return {
					role: 'assistant',
					content: msg.content,
				} as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
			}
			return {
				role: msg.role as 'tool',
				content: msg.content,
			} as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
		}

		// Array content — blocks
		if (msg.role === 'assistant') {
			// Assistant message may contain tool_calls
			const textBlocks = msg.content.filter(
				(b): b is ContentBlock & { type: 'text' } => b.type === 'text',
			);
			const toolCallBlocks = msg.content.filter(
				(b): b is ContentBlock & { type: 'tool_call' } => b.type === 'tool_call',
			);
			const text = textBlocks.map((b) => b.text).join('');
			if (toolCallBlocks.length > 0) {
				return {
					role: 'assistant',
					content: text || null,
					tool_calls: toolCallBlocks.map((b) => ({
						id: b.id,
						type: 'function',
						function: { name: b.name, arguments: b.arguments },
					})),
				} as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
			}
			return {
				role: 'assistant',
				content: text,
			} as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
		}

		if (msg.role === 'tool') {
			// Tool result message
			const resultBlock = msg.content.find(
				(b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result',
			);
			if (resultBlock) {
				return {
					role: 'tool',
					tool_call_id: resultBlock.tool_call_id,
					content: resultBlock.content,
				} as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
			}
		}

		// User message with mixed content (text + image_url)
		const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = msg.content.map((block) => {
			if (block.type === 'text') {
				return {
					type: 'text',
					text: block.text,
				} as OpenAI.Chat.Completions.ChatCompletionContentPartText;
			}
			if (block.type === 'image_url') {
				return {
					type: 'image_url',
					image_url: { url: block.image_url.url, detail: block.image_url.detail ?? 'high' },
				} as OpenAI.Chat.Completions.ChatCompletionContentPartImage;
			}
			// Skip tool_call/tool_result in user messages
			return { type: 'text', text: '' } as OpenAI.Chat.Completions.ChatCompletionContentPartText;
		});
		return {
			role: 'user',
			content: parts,
		} as OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
	});
}

export class OpenAIProvider implements LLMProvider {
	readonly model: string;
	private client: OpenAI;
	private visionDetail: 'low' | 'high' | 'auto';

	constructor(config: OpenAIProviderConfig) {
		this.client = new OpenAI({
			baseURL: config.apiBase,
			apiKey: config.apiKey,
		});
		this.model = config.model;
		this.visionDetail = config.visionDetail;
	}

	async complete(req: CompleteRequest): Promise<CompleteResponse> {
		try {
			const openaiMessages = toOpenAIMessages(req.messages);

			// Set vision detail on image_url blocks
			for (const msg of openaiMessages) {
				if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === 'image_url' && 'image_url' in part) {
							part.image_url.detail = this.visionDetail;
						}
					}
				}
			}

			const createOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: req.model,
				messages: openaiMessages,
			};

			if (req.tools) {
				createOptions.tools = req.tools.map((t) => ({
					type: 'function' as const,
					function: {
						name: t.function.name,
						description: t.function.description,
						parameters: t.function.parameters,
					},
				}));
			}

			if (req.responseSchema) {
				createOptions.response_format = {
					type: 'json_schema' as const,
					json_schema: {
						name: req.responseSchema.name,
						schema: req.responseSchema.schema,
						strict: true,
					},
				};
			}

			if (req.temperature !== undefined) createOptions.temperature = req.temperature;
			if (req.maxTokens !== undefined) createOptions.max_tokens = req.maxTokens;
			if (req.logprobs) {
				createOptions.logprobs = true;
				// Cap top_logprobs per API limits (max 20); absent means only the chosen token.
				if (req.topLogprobs && req.topLogprobs > 0) {
					createOptions.top_logprobs = Math.min(req.topLogprobs, 20);
				}
			}

			const resp = await this.client.chat.completions.create(createOptions);

			const choice = resp.choices[0];
			if (!choice) {
				throw new LLMError('LLM 返回空响应');
			}

			const finishReason = choice.finish_reason;
			let stopReason: StopReason = 'stop';
			if (finishReason === 'tool_calls') stopReason = 'tool_use';
			else if (finishReason === 'length') stopReason = 'length';

			const text = choice.message.content ?? '';
			const toolCalls = (choice.message.tool_calls ?? [])
				.filter(
					(tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
						tc.type === 'function',
				)
				.map((tc) => ({
					id: tc.id,
					name: tc.function.name,
					arguments: tc.function.arguments,
				}));

			const usage = resp.usage
				? { inputTokens: resp.usage?.prompt_tokens, outputTokens: resp.usage?.completion_tokens }
				: undefined;

			const result: CompleteResponse = { stopReason, text, toolCalls };
			if (usage) result.usage = usage;
			const logprobs = mapOpenAILogprobs(choice.logprobs);
			if (logprobs) result.logprobs = logprobs;

			return result;
		} catch (e) {
			if (e instanceof LLMError) throw e;
			throw new LLMError(`OpenAI API 调用失败: ${(e as Error).message}`, e);
		}
	}
}

/** Map OpenAI's choice.logprobs.content (text/JSON-content tokens) into LogprobInfo. */
function mapOpenAILogprobs(logprobs: unknown): LogprobInfo | undefined {
	const lp = logprobs as
		| { content?: Array<{ token: string; logprob: number; top_logprobs?: Array<{ token: string; logprob: number }> }> }
		| null
		| undefined;
	if (!lp?.content) return undefined;
	const tokens = lp.content.map((t) => ({
		token: t.token,
		logprob: t.logprob,
		topLogprobs: t.top_logprobs?.map((x) => ({ token: x.token, logprob: x.logprob })),
	}));
	return { tokens };
}
