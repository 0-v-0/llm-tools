import { ConfigError } from '@llm-image/shared';
import type { AppConfig } from '../config/config.js';
import type { EnvConfig } from '../config/env.js';
import type { EmbeddingProvider } from './provider.js';
import { JinaEmbeddingProvider } from './jina.js';

export function createEmbeddingProvider(env: EnvConfig, config: AppConfig): EmbeddingProvider {
	if (!env.JINA_API_KEY) {
		throw new ConfigError('未设置 JINA_API_KEY 环境变量，无法创建 embedding provider');
	}

	return new JinaEmbeddingProvider({
		apiKey: env.JINA_API_KEY,
		model: env.JINA_MODEL,
		apiBase: env.JINA_API_BASE,
		dimensions: env.JINA_DIMENSIONS,
		textBatchSize: config.embedTextBatch,
		imageBatchSize: config.embedImageBatch,
	});
}
