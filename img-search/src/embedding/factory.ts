import { ConfigError } from '@llm-image/shared';
import type { EnvConfig } from '../config/env.js';
import type { EmbeddingProvider } from './provider.js';
import { JinaEmbeddingProvider } from './jina.js';

export function createEmbeddingProvider(env: EnvConfig): EmbeddingProvider {
	if (!env.JINA_API_KEY) {
		throw new ConfigError('JINA_API_KEY is not set');
	}

	return new JinaEmbeddingProvider({
		apiKey: env.JINA_API_KEY,
		model: env.JINA_MODEL,
		apiBase: env.JINA_API_BASE,
		dimensions: env.JINA_DIMENSIONS,
		textBatchSize: env.IMGSEARCH_EMBED_TEXT_BATCH,
		imageBatchSize: env.IMGSEARCH_EMBED_IMAGE_BATCH,
	});
}
