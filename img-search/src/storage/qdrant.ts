import { StorageError } from '@llm-image/shared';
import { QdrantClient, type QdrantClientParams } from '@qdrant/js-client-rest';

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

export interface SearchResult {
	id: number;
	score: number;
	payload: Record<string, unknown>;
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
	 * Idempotent — safe to call on every startup.
	 */
	async ensureCollection(): Promise<void> {
		try {
			// Check if collection already exists
			try {
				await this.client.getCollection(this.collection);
				return; // Collection exists
			} catch {
				// Collection doesn't exist — create it
			}

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
	 * Retrieve text and visual vectors for a list of point IDs.
	 * Used during the search loop to get beam candidate vectors.
	 */
	async retrieveVectors(ids: number[]): Promise<RetrievedVectors[]> {
		if (ids.length === 0) return [];

		try {
			const records = await this.client.retrieve(this.collection, {
				ids: ids,
				with_vector: true,
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
	 * Search for nearest neighbors using the visual vector.
	 * Used for initial beam bootstrap and re-expansion.
	 */
	async searchVisual(queryVec: Float32Array, limit: number): Promise<SearchResult[]> {
		return this.searchNamed('visual', queryVec, limit);
	}

	/**
	 * Search for nearest neighbors using the text vector.
	 * Used for initial beam bootstrap with a text hint.
	 */
	async searchText(queryVec: Float32Array, limit: number): Promise<SearchResult[]> {
		return this.searchNamed('text', queryVec, limit);
	}

	private async searchNamed(
		vectorName: string,
		queryVec: Float32Array,
		limit: number,
	): Promise<SearchResult[]> {
		try {
			const response = await this.client.query(this.collection, {
				query: Array.from(queryVec),
				using: vectorName,
				limit,
				with_payload: true,
				with_vector: false,
			});

			const points = (response as { points?: unknown[] }).points ?? [];
			return (
				points as { id: number | string; score: number; payload: Record<string, unknown> }[]
			).map((p) => ({
				id: typeof p.id === 'number' ? p.id : parseInt(String(p.id), 10),
				score: p.score,
				payload: p.payload ?? {},
			}));
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
		} catch {
			return 0;
		}
	}

	/**
	 * Scroll through points for initial beam bootstrap (no hint).
	 * Returns a random sample of points.
	 */
	async scroll(
		limit: number,
		offset?: number,
	): Promise<{ id: number; payload: Record<string, unknown> }[]> {
		try {
			const scrollParams: Record<string, unknown> = {
				limit,
				with_payload: true,
				with_vector: false,
			};
			if (offset !== undefined) scrollParams.offset = offset;
			const result = await this.client.scroll(this.collection, scrollParams);

			const points = (result as { points?: unknown[] }).points ?? [];
			return (points as { id: number | string; payload: Record<string, unknown> }[]).map((p) => ({
				id: typeof p.id === 'number' ? p.id : parseInt(String(p.id), 10),
				payload: p.payload ?? {},
			}));
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
