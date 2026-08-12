import type { EnvConfig } from '../config/env.js';
import type { LLMProvider } from './provider.js';
import { validateProviderConfig } from '../config/env.js';
import { ConfigError } from '../util/errors.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export function createProvider(env: EnvConfig): LLMProvider {
	validateProviderConfig(env);

	switch (env.LLM_PROVIDER) {
		case 'openai':
			return new OpenAIProvider({
				apiBase: env.OPENAI_API_BASE,
				apiKey: env.OPENAI_API_KEY!,
				model: env.OPENAI_MODEL,
				visionDetail: env.OPENAI_VISION_DETAIL,
			});
		case 'anthropic':
			return new AnthropicProvider({
				apiKey: env.ANTHROPIC_API_KEY!,
				model: env.ANTHROPIC_MODEL,
				apiBase: env.ANTHROPIC_API_BASE,
			});
		default:
			throw new ConfigError(`未知的 LLM_PROVIDER: ${env.LLM_PROVIDER}`);
	}
}
