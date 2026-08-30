import Anthropic from '@anthropic-ai/sdk';
import type {
	LLMProvider,
	CompleteRequest,
	CompleteResponse,
	LLMMessage,
	ContentBlock,
	StopReason,
	ToolDef,
	LogprobInfo,
} from './provider.js';
import { LLMError } from '../util/errors.js';

interface AnthropicProviderConfig {
	apiKey: string;
	model: string;
	apiBase?: string | undefined;
}

type AnthropicContentBlock =
	| Anthropic.Messages.TextBlock
	| Anthropic.Messages.ImageBlockParam
	| Anthropic.Messages.ToolUseBlock
	| Anthropic.Messages.ToolResultBlockParam;

function toAnthropicMessages(messages: LLMMessage[]): {
	system: string | undefined;
	messages: Anthropic.Messages.MessageParam[];
} {
	let system: string | undefined;
	const anthropicMsgs: Anthropic.Messages.MessageParam[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			system = typeof msg.content === 'string' ? msg.content : '';
			continue;
		}

		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				anthropicMsgs.push({ role: 'user', content: msg.content });
				continue;
			}
			// Mixed content (text + image + tool_result)
			type UserContentBlock =
				| Anthropic.Messages.TextBlockParam
				| Anthropic.Messages.ImageBlockParam
				| Anthropic.Messages.ToolResultBlockParam;
			const blocks: UserContentBlock[] = msg.content.map((block): UserContentBlock => {
				if (block.type === 'text') {
					return { type: 'text', text: block.text };
				}
				if (block.type === 'image_url') {
					// Extract base64 from data URI: data:image/jpeg;base64,<data>
					const match = block.image_url.url.match(/^data:image\/(\w+);base64,(.+)$/);
					if (!match || !match[1] || !match[2]) {
						return { type: 'text', text: '[invalid image]' };
					}
					const mediaType = `image/${match[1]}` as
						| 'image/jpeg'
						| 'image/png'
						| 'image/gif'
						| 'image/webp';
					return {
						type: 'image',
						source: {
							type: 'base64',
							media_type: mediaType,
							data: match[2],
						},
					};
				}
				if (block.type === 'tool_result') {
					return {
						type: 'tool_result',
						tool_use_id: block.tool_call_id,
						content: block.content,
					};
				}
				// tool_call blocks don't appear in user messages
				return { type: 'text', text: '' };
			});
			anthropicMsgs.push({ role: 'user', content: blocks });
			continue;
		}

		if (msg.role === 'assistant') {
			if (typeof msg.content === 'string') {
				anthropicMsgs.push({ role: 'assistant', content: msg.content });
				continue;
			}
			const blocks: AnthropicContentBlock[] = [];
			for (const block of msg.content) {
				if (block.type === 'text') {
					blocks.push({ type: 'text', text: block.text } as Anthropic.Messages.TextBlock);
				} else if (block.type === 'tool_call') {
					blocks.push({
						type: 'tool_use',
						id: block.id,
						name: block.name,
						input: JSON.parse(block.arguments) as Record<string, unknown>,
					} as Anthropic.Messages.ToolUseBlock);
				}
			}
			anthropicMsgs.push({ role: 'assistant', content: blocks });
			continue;
		}

		// tool role — should have been merged into user message as tool_result
		// This shouldn't happen if tool-flow builds messages correctly, but handle gracefully
		if (msg.role === 'tool' && typeof msg.content !== 'string') {
			const resultBlock = msg.content.find(
				(b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result',
			);
			if (resultBlock) {
				anthropicMsgs.push({
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: resultBlock.tool_call_id,
							content: resultBlock.content,
						},
					],
				});
			}
		}
	}

	return { system, messages: anthropicMsgs };
}

function toAnthropicTools(tools?: ToolDef[]): Anthropic.Messages.Tool[] | undefined {
	if (!tools) return undefined;
	return tools.map((t) => ({
		name: t.function.name,
		description: t.function.description,
		input_schema: t.function.parameters as Anthropic.Messages.Tool.InputSchema,
	}));
}

export class AnthropicProvider implements LLMProvider {
	readonly model: string;
	readonly provider = 'anthropic' as const;
	private client: Anthropic;

	constructor(config: AnthropicProviderConfig) {
		const options = { apiKey: config.apiKey };
		if (config.apiBase) Object.assign(options, { baseURL: config.apiBase });

		this.client = new Anthropic(options);
		this.model = config.model;
	}

	async complete(req: CompleteRequest): Promise<CompleteResponse> {
		try {
			const { system, messages } = toAnthropicMessages(req.messages);
			const tools = toAnthropicTools(req.tools);

			const createOptions: Anthropic.MessageCreateParamsNonStreaming = {
				model: req.model,
				messages,
				max_tokens: req.maxTokens ?? 4096,
			};
			if (system !== undefined) createOptions.system = system;
			if (tools) createOptions.tools = tools;
			if (req.temperature !== undefined) createOptions.temperature = req.temperature;

			// logprobs is supported by the Anthropic API but not yet in this SDK's types.
			// Build params loosely so we can pass it through without `any` leaks elsewhere.
			const params: Record<string, unknown> = { ...createOptions };
			if (req.logprobs) params.logprobs = true;

			const resp = await this.client.messages.create(
				params as unknown as Anthropic.MessageCreateParamsNonStreaming,
			);

			let stopReason: StopReason = 'stop';
			if (resp.stop_reason === 'tool_use') stopReason = 'tool_use';
			else if (resp.stop_reason === 'max_tokens') stopReason = 'length';

			let text = '';
			const toolCalls: CompleteResponse['toolCalls'] = [];
			const logprobTokens: LogprobInfo['tokens'] = [];

			for (const block of resp.content) {
				if (block.type === 'text') {
					text += block.text;
					const lp = (block as unknown as {
						logprobs?: {
							tokens?: string[];
							token_logprobs?: number[];
							top_logprobs?: Array<Array<{ token: string; logprob: number }>>;
						};
					}).logprobs;
					if (lp?.tokens && lp.token_logprobs) {
						for (let i = 0; i < lp.tokens.length; i++) {
							logprobTokens.push({
								token: lp.tokens[i]!,
								logprob: lp.token_logprobs[i]!,
								topLogprobs: lp.top_logprobs?.[i]?.map((x) => ({
									token: x.token,
									logprob: x.logprob,
								})),
							});
						}
					}
				} else if (block.type === 'tool_use') {
					toolCalls.push({
						id: block.id,
						name: block.name,
						arguments: JSON.stringify(block.input),
					});
				}
			}

			const usage: CompleteResponse['usage'] = {
				inputTokens: resp.usage.input_tokens,
				outputTokens: resp.usage.output_tokens,
			};

			const result: CompleteResponse = { stopReason, text, toolCalls, usage };
			if (logprobTokens.length > 0) result.logprobs = { tokens: logprobTokens };

			return result;
		} catch (e) {
			if (e instanceof LLMError) throw e;
			throw new LLMError(`Anthropic API 调用失败: ${(e as Error).message}`, e);
		}
	}
}
