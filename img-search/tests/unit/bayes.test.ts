import { describe, it, expect } from 'vitest';
import {
	cosineSim01,
	scoreCandidate,
	bayesianUpdate,
	normalize,
	entropy,
	expectedInfoGain,
	candidateDiversity,
	temperPosterior,
	DEFAULT_BINS,
} from '../../src/search/bayes.ts';

describe('cosineSim01', () => {
	it('returns 1 for identical vectors', () => {
		const v = new Float32Array([1, 0, 0]);
		expect(cosineSim01(v, v)).toBeCloseTo(1, 5);
	});

	it('returns 0.5 for orthogonal vectors', () => {
		const a = new Float32Array([1, 0]);
		const b = new Float32Array([0, 1]);
		expect(cosineSim01(a, b)).toBeCloseTo(0.5, 5);
	});

	it('returns 0 for opposite vectors', () => {
		const a = new Float32Array([1, 0]);
		const b = new Float32Array([-1, 0]);
		expect(cosineSim01(a, b)).toBeCloseTo(0, 5);
	});

	it('returns 0.5 (neutral) for zero vectors', () => {
		const a = new Float32Array([0, 0]);
		const b = new Float32Array([1, 1]);
		// Zero vectors have no direction, so similarity is undefined;
		// 0.5 (neutral) avoids silently ranking candidates with a missing
		// named vector as the worst match.
		expect(cosineSim01(a, b)).toBe(0.5);
	});

	it('returns 0.5 (neutral) when the second vector is zero', () => {
		// Covers the denom === 0 branch from the other side (normB === 0).
		const a = new Float32Array([1, 1]);
		const b = new Float32Array([0, 0]);
		expect(cosineSim01(a, b)).toBe(0.5);
	});

	it('ignores extra dimensions of the longer second vector', () => {
		// The accumulation loop is bounded by a.length, so trailing dims of b
		// are silently ignored: b[2] would change the true cosine but is never read.
		const a = new Float32Array([1, 0]);
		const b = new Float32Array([1, 0, 0.999]);
		// Same as comparing [1,0] vs [1,0] → cos=1 → 1
		expect(cosineSim01(a, b)).toBeCloseTo(1, 5);
	});

	it('returns NaN when the first vector is longer than the second', () => {
		// Pinned asymmetry: the loop reads b[i] for i < a.length; when a is the
		// longer array, b[i] is undefined and NaN propagates through dot/norms.
		const a = new Float32Array([1, 0, 0.999]);
		const b = new Float32Array([1, 0]);
		expect(cosineSim01(a, b)).toBeNaN();
	});
});

describe('scoreCandidate', () => {
	it('blends text and visual scores with alpha', () => {
		const q = new Float32Array([1, 0]);
		const text = new Float32Array([1, 0]); // sim = 1
		const visual = new Float32Array([0, 1]); // sim = 0.5
		// alpha=1 → text only → 1
		expect(scoreCandidate(q, text, visual, 1)).toBeCloseTo(1, 5);
		// alpha=0 → visual only → 0.5
		expect(scoreCandidate(q, text, visual, 0)).toBeCloseTo(0.5, 5);
		// alpha=0.5 → average → 0.75
		expect(scoreCandidate(q, text, visual, 0.5)).toBeCloseTo(0.75, 5);
	});
});

describe('bayesianUpdate', () => {
	it('updates probabilities using Gaussian likelihood kernel', () => {
		const probs = new Map([
			[1, 1 / 3],
			[2, 1 / 3],
			[3, 1 / 3],
		]);
		const scores = new Map([
			[1, 0.2],
			[2, 0.5],
			[3, 0.8],
		]);
		// answer=0.5, lambda=8
		// L_1 = exp(-8*(0.3)^2) = exp(-0.72) ≈ 0.4868
		// L_2 = exp(0) = 1
		// L_3 = exp(-8*(0.3)^2) = exp(-0.72) ≈ 0.4868
		const updated = bayesianUpdate(probs, scores, 0.5, 8);

		// Candidate 2 (score matches answer) should have highest unnormalized prob
		expect(updated.get(2)!).toBeCloseTo(1 / 3, 5);
		expect(updated.get(1)!).toBeCloseTo((1 / 3) * 0.4868, 3);
		expect(updated.get(3)!).toBeCloseTo((1 / 3) * 0.4868, 3);
		// Candidates 1 and 3 should be equal (symmetric)
		expect(updated.get(1)).toBeCloseTo(updated.get(3)!, 5);
	});

	it('keeps probability unchanged when no score exists', () => {
		const probs = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const scores = new Map([[1, 0.5]]);
		const updated = bayesianUpdate(probs, scores, 0.5, 8);
		expect(updated.get(2)).toBe(0.5); // unchanged
	});

	it('likelihood underflows to 0 for very large lambda (collapse)', () => {
		// exp(-lambda * (answer - score)^2) with lambda=1e6 and distance 0.5
		// underflows to exactly 0 for every candidate → all-zero output map.
		// This is pinned behavior: the caller (via normalize/Beam.isCollapsed)
		// is responsible for handling the collapse.
		const probs = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const scores = new Map([
			[1, 0],
			[2, 1],
		]);
		const updated = bayesianUpdate(probs, scores, 0.5, 1e6);
		expect(updated.get(1)).toBe(0);
		expect(updated.get(2)).toBe(0);
		// normalize is a no-op on the all-zero map (same reference returned)
		expect(normalize(updated)).toBe(updated);
	});
});

describe('normalize', () => {
	it('normalizes probabilities to sum to 1', () => {
		const probs = new Map([
			[1, 2],
			[2, 3],
			[3, 5],
		]);
		const result = normalize(probs);
		let sum = 0;
		for (const p of result.values()) sum += p;
		expect(sum).toBeCloseTo(1, 10);
		expect(result.get(1)).toBeCloseTo(0.2, 5);
		expect(result.get(2)).toBeCloseTo(0.3, 5);
		expect(result.get(3)).toBeCloseTo(0.5, 5);
	});

	it('returns input unchanged when all probabilities are 0', () => {
		const probs = new Map([
			[1, 0],
			[2, 0],
		]);
		const result = normalize(probs);
		expect(result.get(1)).toBe(0);
		expect(result.get(2)).toBe(0);
	});

	it('returns the SAME Map reference (not a copy) when sum is 0', () => {
		// Pinned identity: zero-sum short-circuits and hands back the input map,
		// so mutating the result would also mutate the caller's map.
		const probs = new Map([
			[1, 0],
			[2, 0],
		]);
		expect(normalize(probs)).toBe(probs);
	});

	it('divides by a negative sum for negative probabilities (no validation)', () => {
		// Pinned behavior: normalize does not validate inputs; negative
		// probabilities are simply divided by the (negative) sum.
		const probs = new Map([
			[1, -1],
			[2, 3],
		]);
		const result = normalize(probs);
		expect(result.get(1)).toBeCloseTo(-0.5, 10);
		expect(result.get(2)).toBeCloseTo(1.5, 10);
	});
});

describe('entropy', () => {
	it('returns 0 for a single certain candidate', () => {
		expect(entropy([1])).toBeCloseTo(0, 10);
	});

	it('returns ln(2) for uniform binary distribution', () => {
		expect(entropy([0.5, 0.5])).toBeCloseTo(Math.log(2), 5);
	});

	it('returns ln(4) for uniform 4-way distribution', () => {
		expect(entropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(Math.log(4), 5);
	});

	it('returns 0 for probabilities with zeros', () => {
		expect(entropy([0, 1])).toBeCloseTo(0, 10);
	});
});

describe('expectedInfoGain', () => {
	it('returns ~0 for non-discriminative question (all scores equal)', () => {
		const probs = new Map([
			[1, 1 / 3],
			[2, 1 / 3],
			[3, 1 / 3],
		]);
		const scores = new Map([
			[1, 0.5],
			[2, 0.5],
			[3, 0.5],
		]);
		const result = expectedInfoGain(probs, scores, DEFAULT_BINS, 8);
		// All candidates have the same score, so no answer can distinguish them
		expect(result.infoGain).toBeCloseTo(0, 2);
	});

	it('returns positive IG for discriminative question', () => {
		const probs = new Map([
			[1, 1 / 3],
			[2, 1 / 3],
			[3, 1 / 3],
		]);
		const scores = new Map([
			[1, 0.1],
			[2, 0.5],
			[3, 0.9],
		]);
		const result = expectedInfoGain(probs, scores, DEFAULT_BINS, 8);
		// Different scores → any answer narrows down candidates
		expect(result.infoGain).toBeGreaterThan(0.01);
	});

	it('returns higher IG for more discriminative question', () => {
		const probs = new Map([
			[1, 0.25],
			[2, 0.25],
			[3, 0.25],
			[4, 0.25],
		]);

		// Less discriminative: scores close together
		const scores1 = new Map([
			[1, 0.4],
			[2, 0.45],
			[3, 0.55],
			[4, 0.6],
		]);

		// More discriminative: scores far apart
		const scores2 = new Map([
			[1, 0.05],
			[2, 0.35],
			[3, 0.65],
			[4, 0.95],
		]);

		const result1 = expectedInfoGain(probs, scores1, DEFAULT_BINS, 8);
		const result2 = expectedInfoGain(probs, scores2, DEFAULT_BINS, 8);
		expect(result2.infoGain).toBeGreaterThan(result1.infoGain);
	});

	it('bin probabilities sum to 1', () => {
		const probs = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const scores = new Map([
			[1, 0.2],
			[2, 0.8],
		]);
		const result = expectedInfoGain(probs, scores, DEFAULT_BINS, 8);
		const sum = result.binProbabilities.reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(1, 5);
	});

	it('returns infoGain 0 when scores has none of the candidate ids', () => {
		// With no score for any candidate, likelihood is 1 per bin: the answer
		// cannot change the posterior, so expectedH === currentH → IG = 0.
		const probs = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const scores = new Map<number, number>([
			[99, 0.5], // unrelated id
		]);
		const result = expectedInfoGain(probs, scores, [0.2, 0.8], 8);
		expect(result.infoGain).toBeCloseTo(0, 10);
		// Every bin is equally likely since all bin weights equal the prior sum
		expect(result.binProbabilities).toEqual([0.5, 0.5]);
	});

	it('falls back to uniform binProbabilities when all candidate probs are 0', () => {
		// totalBinProb === 0 path: bin weights are all 0, so bin probabilities
		// fall back to 1 / bins.length and infoGain stays 0.
		const probs = new Map([
			[1, 0],
			[2, 0],
		]);
		const scores = new Map([
			[1, 0.2],
			[2, 0.8],
		]);
		const result = expectedInfoGain(probs, scores, [0.2, 0.8], 8);
		expect(result.binProbabilities).toEqual([0.5, 0.5]);
		expect(result.infoGain).toBeCloseTo(0, 10);
	});

	it('candidate missing from scores keeps likelihood 1 while others update', () => {
		// Candidate 1 has a score far from the bin value (likelihood ~0 with
		// large lambda); candidate 2 has no score → likelihood 1 → it absorbs
		// all posterior mass for that bin, so IG reaches the full prior entropy.
		const probs = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const scores = new Map([
			[1, 0.1],
			// no score for id 2
		]);
		const result = expectedInfoGain(probs, scores, [0.9], 1000);
		// Prior entropy = ln(2); posterior collapses to candidate 2 → entropy 0
		expect(result.infoGain).toBeCloseTo(Math.log(2), 5);
	});
});

describe('candidateDiversity', () => {
	it('returns 0 for identical vectors', () => {
		const v = new Float32Array([1, 0, 0]);
		expect(candidateDiversity([v, v, v])).toBeCloseTo(0, 5);
	});

	it('returns positive value for diverse vectors', () => {
		const a = new Float32Array([1, 0]);
		const b = new Float32Array([0, 1]);
		// cosineSim01 = 0.5, diversity = 1 - 0.5 = 0.5
		expect(candidateDiversity([a, b])).toBeCloseTo(0.5, 5);
	});

	it('returns 0 for single or empty vector set', () => {
		expect(candidateDiversity([])).toBe(0);
		expect(candidateDiversity([new Float32Array([1, 0])])).toBe(0);
	});

	it('returns high value (> 0.5) for very different vectors', () => {
		// Opposite directions: cosineSim01 = 0 → distance = 1.
		// Per the doc comment, low diversity (< 0.1) means homogeneous;
		// strongly heterogeneous sets score well above that.
		const a = new Float32Array([1, 0]);
		const b = new Float32Array([-1, 0]);
		expect(candidateDiversity([a, b])).toBeCloseTo(1, 5);
		expect(candidateDiversity([a, b])).toBeGreaterThan(0.5);
	});
});

describe('temperPosterior', () => {
	it('blends posterior with prior', () => {
		const posterior = new Map([
			[1, 0.9],
			[2, 0.1],
		]);
		const prior = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const beta = 0.2;
		const result = temperPosterior(posterior, prior, beta);
		// p_1 = 0.8*0.9 + 0.2*0.5 = 0.82
		expect(result.get(1)).toBeCloseTo(0.82, 5);
		// p_2 = 0.8*0.1 + 0.2*0.5 = 0.18
		expect(result.get(2)).toBeCloseTo(0.18, 5);
	});

	it('returns posterior when beta=0', () => {
		const posterior = new Map([
			[1, 0.7],
			[2, 0.3],
		]);
		const prior = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const result = temperPosterior(posterior, prior, 0);
		expect(result.get(1)).toBeCloseTo(0.7, 5);
		expect(result.get(2)).toBeCloseTo(0.3, 5);
	});

	it('returns prior when beta=1', () => {
		const posterior = new Map([
			[1, 0.9],
			[2, 0.1],
		]);
		const prior = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const result = temperPosterior(posterior, prior, 1);
		expect(result.get(1)).toBeCloseTo(0.5, 5);
		expect(result.get(2)).toBeCloseTo(0.5, 5);
	});

	it('treats missing prior entry as 0 and drops prior-only ids (asymmetric keys)', () => {
		// Iteration is over the posterior: an id in the posterior but not the
		// prior blends with prior weight 0; an id present only in the prior
		// never appears in the result.
		const posterior = new Map([
			[1, 0.8],
			[3, 0.2],
		]);
		const prior = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const result = temperPosterior(posterior, prior, 0.25);
		// p_1 = 0.75*0.8 + 0.25*0.5 = 0.725
		expect(result.get(1)).toBeCloseTo(0.725, 10);
		// p_3 = 0.75*0.2 + 0.25*0 (prior treated as 0) = 0.15
		expect(result.get(3)).toBeCloseTo(0.15, 10);
		// id 2 exists only in the prior → dropped
		expect(result.has(2)).toBe(false);
		expect(result.size).toBe(2);
	});
});
