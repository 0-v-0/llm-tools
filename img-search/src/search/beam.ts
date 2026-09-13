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

	/** Snapshot of all id → probability pairs (safe to mutate). */
	probabilities(): Map<number, number> {
		return new Map(this.candidates);
	}
}
