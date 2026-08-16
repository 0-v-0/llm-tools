/**
 * Embedding provider abstraction for multimodal (text + image) embeddings.
 * Both text and image are embedded into the same vector space,
 * enabling cross-modal similarity search.
 */
export interface EmbeddingProvider {
	readonly model: string;
	readonly dimensions: number;

	/** Embed a batch of text strings. */
	embedText(texts: string[]): Promise<Float32Array[]>;

	/** Embed a batch of images (as base64 data URIs). */
	embedImage(base64DataUris: string[]): Promise<Float32Array[]>;
}
