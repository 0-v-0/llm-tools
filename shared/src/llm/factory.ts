import type { LLMProvider } from './provider.js';
import { ConfigError } from '../util/errors.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

/**
 * Provider configuration interface.
 * Both img-val's EnvConfig and img-search's EnvConfig structurally satisfy this.
 */
export interface ProviderConfig {
	LLM_PROVIDER: 'openai' | 'anthropic';
	OPENAI_API_BASE: string;
	OPENAI_API_KEY?: string | undefined;
	OPENAI_MODEL: string;
	OPENAI_VISION_DETAIL: 'low' | 'high' | 'auto';
	ANTHROPIC_API_KEY?: string | undefined;
	ANTHROPIC_MODEL: string;
	ANTHROPIC_API_BASE?: string | undefined;
}

export function validateProviderConfig(config: ProviderConfig): void {
	if (config.LLM_PROVIDER === 'openai' && !config.OPENAI_API_KEY) {
		throw new ConfigError('OPENAI_API_KEY is not set (LLM_PROVIDER=openai)');
	}
	if (config.LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
		throw new ConfigError('ANTHROPIC_API_KEY is not set (LLM_PROVIDER=anthropic)');
	}
}

export function createProvider(config: ProviderConfig): LLMProvider {
	validateProviderConfig(config);

	switch (config.LLM_PROVIDER) {
		case 'openai':
			return new OpenAIProvider({
				apiBase: config.OPENAI_API_BASE,
				apiKey: config.OPENAI_API_KEY!,
				model: config.OPENAI_MODEL,
				visionDetail: config.OPENAI_VISION_DETAIL,
			});
		case 'anthropic':
			return new AnthropicProvider({
				apiKey: config.ANTHROPIC_API_KEY!,
				model: config.ANTHROPIC_MODEL,
				apiBase: config.ANTHROPIC_API_BASE,
			});
		default:
			throw new ConfigError(`未知的 LLM_PROVIDER: ${config.LLM_PROVIDER}`);
	}
}
