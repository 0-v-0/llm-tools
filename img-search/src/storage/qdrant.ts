import { StorageError } from '@llm-image/shared';
import { QdrantClient, type QdrantClientParams } from '@qdrant/js-client-rest';
import { toErrorMessage } from '../util/error-message.ts';

export interface QdrantPoint {
	id: number;
	textVec: Float32Array;
	visualVec: Float32Array;
	payload: Record<string, unknown>;
}

export interface RetrievedVectors {
	id: number;
	text: Float32Array;
	visual: Float32Array;
}

export interface QdrantHit {
	id: number;
	score: number;
	payload: Record<string, unknown>;
}

/** Wrap an unknown error into a StorageError with a localized message. */
function toStorageError(message: string, e: unknown): StorageError {
	return new StorageError(`${message}: ${toErrorMessage(e)}`, e);
}

/** Qdrant may return point ids as numbers or numeric strings. */
function toPointId(id: number | string): number {
	return typeof id === 'number' ? id : parseInt(String(id), 10);
}

/** Pull the `points` array out of a query/scroll response. */
function extractPoints(response: unknown): unknown[] {
	return (response as { points?: unknown[] }).points ?? [];
}

/**
 * Qdrant vector store wrapper.
 * Manages a collection with named vectors (text + visual) for multimodal search.
 */
export class QdrantStore {
	private client: QdrantClient;
	private collection: string;
	private dimensions: number;

	constructor(url: string, collection: string, dimensions: number, apiKey?: string) {
		const params: QdrantClientParams = { url };
		if (apiKey) params.apiKey = apiKey;
		this.client = new QdrantClient(params);
		this.collection = collection;
		this.dimensions = dimensions;
	}

	/**
	 * Create the collection with named vectors if it doesn't exist.
	 * If it already exists, validates that the named vector dimensions match
	 * the configured ones. Idempotent — safe to call on every startup.
	 */
	async ensureCollection(): Promise<void> {
		let exists: boolean;
		try {
			// collectionExists() maps a 404 to `{ exists: false }` and only throws
			// for real failures (auth, network, server errors).
			exists = (await this.client.collectionExists(this.collection)).exists;
		} catch (e) {
			throw toStorageError('Qdrant 连接失败', e);
		}

		if (exists) {
			try {
				const info = await this.client.getCollection(this.collection);
				this.validateVectorDimensions(info as { config?: { params?: { vectors?: unknown } } });
			} catch (e) {
				if (e instanceof StorageError) throw e;
				throw toStorageError('Qdrant 连接失败', e);
			}
			return;
		}

		try {
			await this.client.createCollection(this.collection, {
				vectors: {
					text: { size: this.dimensions, distance: 'Cosine' },
					visual: { size: this.dimensions, distance: 'Cosine' },
				},
			});
		} catch (e) {
			throw new StorageError(`Qdrant collection 创建失败: ${this.collection}`, e);
		}
	}

	/**
	 * Validate that the existing collection's named-vector sizes match
	 * this.dimensions. Skipped when params/vectors are absent (legacy collections)
	 * or when the collection uses a single unnamed vector.
	 */
	private validateVectorDimensions(info: { config?: { params?: { vectors?: unknown } } }): void {
		const vectors = info.config?.params?.vectors;
		if (!vectors || typeof vectors !== 'object' || Array.isArray(vectors)) return;
		const named = vectors as Record<string, { size?: number } | undefined>;
		for (const name of ['text', 'visual'] as const) {
			const size = named[name]?.size;
			if (typeof size === 'number' && size !== this.dimensions) {
				throw new StorageError(
					`Qdrant collection "${this.collection}" 的 ${name} 向量维度为 ${size}, 与期望的 ${this.dimensions} 不一致`,
				);
			}
		}
	}

	/**
	 * Upsert points with both text and visual vectors.
	 */
	async upsertPoints(points: QdrantPoint[]): Promise<void> {
		if (points.length === 0) return;

		try {
			await this.client.upsert(this.collection, {
				wait: true,
				points: points.map((p) => ({
					id: p.id,
					vector: {
						text: Array.from(p.textVec),
						visual: Array.from(p.visualVec),
					},
					payload: p.payload,
				})),
			});
		} catch (e) {
			throw new StorageError(`Qdrant upsert 失败 (${points.length} points)`, e);
		}
	}

	/**
	 * Retrieve vectors for a list of point IDs. By default both text and visual
	 * vectors are returned; pass `vectorNames` to restrict which named vectors
	 * are fetched (e.g. `['text']`).
	 * Used during the search loop to get beam candidate vectors.
	 */
	async retrieveVectors(ids: number[], vectorNames?: string[]): Promise<RetrievedVectors[]> {
		if (ids.length === 0) return [];

		try {
			const records = await this.client.retrieve(this.collection, {
				ids,
				with_vector: vectorNames ?? true,
				with_payload: false,
			});

			return records.map((record) => {
				const vectors = record.vector as Record<string, number[]>;
				return {
					id: record.id as number,
					text: new Float32Array(vectors.text ?? []),
					visual: new Float32Array(vectors.visual ?? []),
				};
			});
		} catch (e) {
			throw new StorageError(`Qdrant retrieve 失败 (${ids.length} ids)`, e);
		}
	}

	/**
	 * Search for nearest neighbors using the text vector.
	 * Used for initial beam bootstrap with a text hint.
	 */
	async searchText(queryVec: Float32Array, limit: number): Promise<QdrantHit[]> {
		return this.searchNamed('text', queryVec, limit);
	}

	private async searchNamed(
		vectorName: string,
		queryVec: Float32Array,
		limit: number,
	): Promise<QdrantHit[]> {
		try {
			const response = await this.client.query(this.collection, {
				query: Array.from(queryVec),
				using: vectorName,
				limit,
				with_payload: true,
				with_vector: false,
			});

			return extractPoints(response).map((p) => {
				const point = p as { id: number | string; score: number; payload?: Record<string, unknown> };
				return {
					id: toPointId(point.id),
					score: point.score,
					payload: point.payload ?? {},
				};
			});
		} catch (e) {
			throw new StorageError(`Qdrant search 失败 (${vectorName})`, e);
		}
	}

	/**
	 * Count total points in the collection.
	 */
	async count(): Promise<number> {
		try {
			const result = await this.client.count(this.collection, { exact: true });
			return result.count;
		} catch (e) {
			throw new StorageError('Qdrant count 失败', e);
		}
	}

	/**
	 * Scroll through points for initial beam bootstrap (no hint).
	 * Returns the first `limit` points in deterministic id order.
	 */
	async scroll(limit: number): Promise<{ id: number; payload: Record<string, unknown> }[]> {
		try {
			const result = await this.client.scroll(this.collection, {
				limit,
				with_payload: true,
				with_vector: false,
			});

			return extractPoints(result).map((p) => {
				const point = p as { id: number | string; payload?: Record<string, unknown> };
				return {
					id: toPointId(point.id),
					payload: point.payload ?? {},
				};
			});
		} catch (e) {
			throw new StorageError('Qdrant scroll 失败', e);
		}
	}

	/** Ping the Qdrant instance to check connectivity. */
	async ping(): Promise<boolean> {
		try {
			await this.client.getCollection(this.collection);
			return true;
		} catch {
			// Collection might not exist yet, but server is reachable
			// Try a different approach — list collections
			try {
				await this.client.getCollections();
				return true;
			} catch {
				return false;
			}
		}
	}
}
