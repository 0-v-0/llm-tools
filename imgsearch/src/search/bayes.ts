/**
 * Pure Bayesian inference functions for the image search algorithm.
 * No I/O, no side effects — all functions are deterministic and testable.
 */

/**
 * Cosine similarity mapped to [0, 1] range.
 * Standard cosine returns [-1, 1]; we map via (cos + 1) / 2.
 */
export function cosineSim01(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const ai = a[i]!;
		const bi = b[i]!;
		dot += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 0;
	const cos = dot / denom;
	return (cos + 1) / 2;
}

/**
 * Blended score for a candidate image against a question.
 * alpha controls text vs visual blend: alpha=1 → text only, alpha=0 → visual only.
 */
export function scoreCandidate(
	qVec: Float32Array,
	textVec: Float32Array,
	visualVec: Float32Array,
	alpha: number,
): number {
	const textScore = cosineSim01(qVec, textVec);
	const visualScore = cosineSim01(qVec, visualVec);
	return alpha * textScore + (1 - alpha) * visualScore;
}

/**
 * Bayesian update: multiply each probability by the Gaussian likelihood kernel.
 * L_i = exp(-λ * (answer - s_i)²)
 * Returns unnormalized probabilities; caller should normalize.
 */
export function bayesianUpdate(
	probs: ReadonlyMap<number, number>,
	scores: ReadonlyMap<number, number>,
	answer: number,
	lambda: number,
): Map<number, number> {
	const result = new Map<number, number>();
	for (const [id, p] of probs) {
		const s = scores.get(id);
		if (s === undefined) {
			// No score for this candidate — keep probability unchanged
			result.set(id, p);
			continue;
		}
		const likelihood = Math.exp(-lambda * (answer - s) ** 2);
		result.set(id, p * likelihood);
	}
	return result;
}

/**
 * Normalize probabilities so they sum to 1.
 * If all probabilities are 0, returns the input unchanged (caller should handle collapse).
 */
export function normalize(probs: Map<number, number>): Map<number, number> {
	let sum = 0;
	for (const p of probs.values()) sum += p;
	if (sum === 0) return probs;

	const result = new Map<number, number>();
	for (const [id, p] of probs) result.set(id, p / sum);
	return result;
}

/**
 * Shannon entropy (in nats): H = -Σ p_i * log(p_i).
 */
export function entropy(probs: Iterable<number>): number {
	let h = 0;
	for (const p of probs) {
		if (p > 0) h -= p * Math.log(p);
	}
	return h;
}

/**
 * Expected information gain for a question.
 *
 * Discretizes the user's answer into bins, computes the expected posterior entropy
 * for each bin, and returns IG = H(prior) - E[H(posterior)].
 *
 * - probs: current candidate probabilities (should be normalized)
 * - scores: matching score s_i for each candidate (in [0, 1])
 * - bins: discretized answer values (e.g. [0.05, 0.15, ..., 0.95])
 * - lambda: Gaussian likelihood sharpness
 */
export function expectedInfoGain(
	probs: ReadonlyMap<number, number>,
	scores: ReadonlyMap<number, number>,
	bins: number[],
	lambda: number,
): { expectedH: number; infoGain: number; binProbabilities: number[] } {
	const probsArray = Array.from(probs.values());
	const currentH = entropy(probsArray);

	// For each bin, compute unnormalized P(a_b) and posterior entropy
	const binUnnormProbs: number[] = [];
	const binEntropies: number[] = [];

	for (const binValue of bins) {
		// Compute likelihoods and unnormalized posterior
		const likelihoods: number[] = [];
		let totalLikelihood = 0;

		for (const [id, p] of probs) {
			const s = scores.get(id);
			const l = s !== undefined ? Math.exp(-lambda * (binValue - s) ** 2) : 1;
			const weighted = p * l;
			likelihoods.push(weighted);
			totalLikelihood += weighted;
		}

		// P(a_b) ∝ totalLikelihood
		binUnnormProbs.push(totalLikelihood);

		// Posterior entropy for this bin
		if (totalLikelihood > 0) {
			let h = 0;
			for (const w of likelihoods) {
				const posterior = w / totalLikelihood;
				if (posterior > 0) h -= posterior * Math.log(posterior);
			}
			binEntropies.push(h);
		} else {
			binEntropies.push(currentH);
		}
	}

	// Normalize bin probabilities
	const totalBinProb = binUnnormProbs.reduce((a, b) => a + b, 0);
	const binProbabilities =
		totalBinProb > 0
			? binUnnormProbs.map((p) => p / totalBinProb)
			: binUnnormProbs.map(() => 1 / bins.length);

	// Expected posterior entropy
	let expectedH = 0;
	for (let b = 0; b < bins.length; b++) {
		expectedH += binProbabilities[b]! * binEntropies[b]!;
	}

	const infoGain = currentH - expectedH;
	return { expectedH, infoGain, binProbabilities };
}

/**
 * Mean pairwise diversity of a set of vectors.
 * Returns mean (1 - cosineSim01), which is in [0, 1].
 * Low diversity (< 0.1) indicates a homogeneous candidate set.
 */
export function candidateDiversity(vectors: Float32Array[]): number {
	if (vectors.length < 2) return 0;
	let totalDist = 0;
	let count = 0;
	for (let i = 0; i < vectors.length; i++) {
		for (let j = i + 1; j < vectors.length; j++) {
			totalDist += 1 - cosineSim01(vectors[i]!, vectors[j]!);
			count++;
		}
	}
	return count > 0 ? totalDist / count : 0;
}

/**
 * Tempered (blended) posterior to prevent collapse from inconsistent answers.
 * p_i ← (1 - β) * posterior_i + β * prior_i
 */
export function temperPosterior(
	posterior: ReadonlyMap<number, number>,
	prior: ReadonlyMap<number, number>,
	beta: number,
): Map<number, number> {
	const result = new Map<number, number>();
	for (const [id, post] of posterior) {
		const pri = prior.get(id) ?? 0;
		result.set(id, (1 - beta) * post + beta * pri);
	}
	return result;
}

/**
 * Default answer bins: 10 evenly spaced values in (0, 1).
 */
export const DEFAULT_BINS = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
