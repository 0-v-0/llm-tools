import { LLMError } from '@llm-image/shared';
import type { EmbeddingProvider } from './provider.js';

interface JinaConfig {
	apiKey: string;
	model: string;
	apiBase: string;
	dimensions: number;
	textBatchSize: number;
	imageBatchSize: number;
}

interface JinaEmbeddingResponse {
	data: { embedding: number[]; index: number }[];
	model: string;
	usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Jina CLIP v2 embedding adapter — multimodal text+image in the same vector space.
 * API docs: https://api.jina.ai/v1/embeddings
 */
export class JinaEmbeddingProvider implements EmbeddingProvider {
	readonly model: string;
	readonly dimensions: number;
	private readonly config: JinaConfig;

	constructor(config: JinaConfig) {
		this.config = config;
		this.model = config.model;
		this.dimensions = config.dimensions;
	}

	async embedText(texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return [];

		const results: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += this.config.textBatchSize) {
			const batch = texts.slice(i, i + this.config.textBatchSize);
			const embeddings = await this.callApi(batch.map((t) => ({ text: t })));
			results.push(...embeddings);
		}
		return results;
	}

	async embedImage(base64DataUris: string[]): Promise<Float32Array[]> {
		if (base64DataUris.length === 0) return [];

		const results: Float32Array[] = [];
		for (let i = 0; i < base64DataUris.length; i += this.config.imageBatchSize) {
			const batch = base64DataUris.slice(i, i + this.config.imageBatchSize);
			const embeddings = await this.callApi(batch.map((uri) => ({ image: uri })));
			results.push(...embeddings);
		}
		return results;
	}

	private async callApi(inputs: ({ text: string } | { image: string })[]): Promise<Float32Array[]> {
		const url = `${this.config.apiBase}/embeddings`;
		const body = {
			model: this.config.model,
			input: inputs,
			dimensions: this.config.dimensions,
		};

		let resp: Response;
		try {
			resp = await fetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.config.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});
		} catch (e) {
			throw new LLMError(`Jina API 网络错误: ${(e as Error).message}`, e);
		}

		if (!resp.ok) {
			const text = await resp.text().catch(() => 'unknown error');
			throw new LLMError(`Jina API 错误 (${resp.status}): ${text}`);
		}

		const data = (await resp.json()) as JinaEmbeddingResponse;

		// Sort by index to ensure order matches input
		const sorted = [...data.data].sort((a, b) => a.index - b.index);
		return sorted.map((d) => new Float32Array(d.embedding));
	}
}
