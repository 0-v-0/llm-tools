/**
 * Beam — in-memory working set of candidate images with probabilities.
 * Maintains at most `maxSize` candidates, sorted by probability.
 * The beam is the algorithm's working set; the full 100k+ image library
 * lives in Qdrant and is accessed via retrieve/search only when needed.
 */
export class Beam {
	private candidates: Map<number, number>;
	private readonly maxSize: number;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
		this.candidates = new Map();
	}

	get(id: number): number | undefined {
		return this.candidates.get(id);
	}

	set(id: number, prob: number): void {
		this.candidates.set(id, prob);
	}

	has(id: number): boolean {
		return this.candidates.has(id);
	}

	delete(id: number): boolean {
		return this.candidates.delete(id);
	}

	/** Get top-K candidates sorted by probability (descending). */
	topK(k: number): { id: number; prob: number }[] {
		return Array.from(this.candidates.entries())
			.map(([id, prob]) => ({ id, prob }))
			.sort((a, b) => b.prob - a.prob)
			.slice(0, k);
	}

	/** Keep only the top `maxSize` candidates by probability. */
	prune(): void {
		if (this.candidates.size <= this.maxSize) return;
		const sorted = this.topK(this.maxSize);
		this.candidates = new Map(sorted.map(({ id, prob }) => [id, prob]));
	}

	size(): number {
		return this.candidates.size;
	}

	/** Maximum probability in the beam. */
	maxProb(): number {
		let max = 0;
		for (const p of this.candidates.values()) {
			if (p > max) max = p;
		}
		return max;
	}

	/**
	 * Check if the beam has collapsed (all probabilities below threshold).
	 * This can happen with inconsistent answers and large λ.
	 */
	isCollapsed(threshold: number): boolean {
		for (const p of this.candidates.values()) {
			if (p >= threshold) return false;
		}
		return true;
	}

	/** All candidate IDs. */
	ids(): number[] {
		return Array.from(this.candidates.keys());
	}

	/** All probabilities as an iterable. */
	values(): IterableIterator<number> {
		return this.candidates.values();
	}

	/** All (id, prob) pairs as an iterable. */
	entries(): IterableIterator<[number, number]> {
		return this.candidates.entries();
	}

	/** Serialize for session persistence. */
	serialize(): { id: number; prob: number }[] {
		return this.topK(this.candidates.size);
	}

	/** Deserialize from saved data. */
	static deserialize(data: { id: number; prob: number }[], maxSize: number): Beam {
		const beam = new Beam(maxSize);
		for (const { id, prob } of data) {
			beam.set(id, prob);
		}
		return beam;
	}

	/** Set all candidates from a map (replaces existing). */
	setAll(candidates: Map<number, number>): void {
		this.candidates = new Map(candidates);
	}

	/** Get all candidates as a Map (read-only view). */
	getAll(): ReadonlyMap<number, number> {
		return this.candidates;
	}
}
