import { LLMError } from '@llm-image/shared';
import { toErrorMessage } from '../util/error-message.ts';
import type { EmbeddingProvider } from './provider.ts';

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

type JinaEmbeddingInput = { text: string } | { image: string };

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
		return this.embedBatched(texts, this.config.textBatchSize, (text) => ({ text }));
	}

	async embedImage(base64DataUris: string[]): Promise<Float32Array[]> {
		return this.embedBatched(base64DataUris, this.config.imageBatchSize, (image) => ({ image }));
	}

	/** 按 batchSize 分批调用 API，并保持结果与输入顺序一致。 */
	private async embedBatched<T>(
		items: T[],
		batchSize: number,
		toInput: (item: T) => JinaEmbeddingInput,
	): Promise<Float32Array[]> {
		if (items.length === 0) return [];

		const results: Float32Array[] = [];
		for (let i = 0; i < items.length; i += batchSize) {
			const inputs = items.slice(i, i + batchSize).map(toInput);
			results.push(...(await this.callApi(inputs)));
		}
		return results;
	}

	private async callApi(inputs: JinaEmbeddingInput[]): Promise<Float32Array[]> {
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
				signal: AbortSignal.timeout(60_000),
			});
		} catch (e) {
			throw new LLMError(`Jina API 网络错误: ${toErrorMessage(e)}`, e);
		}

		if (!resp.ok) {
			const text = await resp.text().catch(() => 'unknown error');
			throw new LLMError(`Jina API 错误 (${resp.status}): ${text}`);
		}

		// HTTP 200 也可能返回非 JSON 响应体（代理/网关错误页等），需显式转换为 LLMError
		let data: JinaEmbeddingResponse;
		try {
			data = (await resp.json()) as JinaEmbeddingResponse;
		} catch (e) {
			throw new LLMError(`Jina API 响应解析失败: ${toErrorMessage(e)}`);
		}

		if (!Array.isArray(data?.data) || data.data.length !== inputs.length) {
			throw new LLMError(
				`Jina API 响应不完整: 期望 ${inputs.length} 条，实际 ${data?.data?.length ?? '无'}`,
			);
		}

		for (const item of data.data) {
			if (!Array.isArray(item?.embedding)) {
				throw new LLMError(
					`Jina API 响应格式错误: 第 ${item?.index ?? '?'} 条数据缺少 embedding 数组`,
				);
			}
		}

		// Sort by index to ensure order matches input
		const sorted = [...data.data].sort((a, b) => a.index - b.index);
		return sorted.map((d) => new Float32Array(d.embedding));
	}
}
