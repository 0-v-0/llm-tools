import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type {
	LLMProvider,
	CompleteRequest,
	CompleteResponse,
	ToolCall,
} from '@llm-image/shared';
import type { FileIndexRepo, LinkRecord } from '@llm-image/file-index';
import type { EmbeddingProvider } from '../../src/embedding/provider.ts';
import type { QdrantStore, QdrantHit, RetrievedVectors } from '../../src/storage/qdrant.ts';
import { cosineSim01 } from '../../src/search/bayes.ts';
import { SearchAlgorithm, type SearchAlgorithmDeps } from '../../src/search/algorithm.ts';
import type { SessionConfig } from '../../src/search/session.ts';
import type { ParsedQuestion } from '../../src/search/question-parser.ts';

// ---------------------------------------------------------------------------
// Fixed vector space (3-D unit vectors, chosen so cosine similarities are
// exactly predictable):
//   E1..E4 span the z=0 plane at 90° steps (pairwise cos ∈ {-1, 0})
//   Z is orthogonal to all of E1..E4 → cosineSim01 = 0.5 (neutral) vs each
// ---------------------------------------------------------------------------
function unit3(x: number, y: number, z: number): Float32Array {
	const n = Math.hypot(x, y, z);
	return new Float32Array([x / n, y / n, z / n]);
}
const E1 = unit3(1, 0, 0);
const E2 = unit3(0, 1, 0);
const E3 = unit3(-1, 0, 0);
const E4 = unit3(0, -1, 0);
const Z = unit3(0, 0, 1);
const NEG_Z = unit3(0, 0, -1);

const Q_CAT: ParsedQuestion = { question: 'Is it a cat?', rationale: 'distinguishes cats' };
const Q_COLOR: ParsedQuestion = {
	question: 'Is it a black-and-white photo?',
	rationale: 'distinguishes color',
};
const Q_INDOOR: ParsedQuestion = { question: 'Was it taken indoors?', rationale: 'distinguishes place' };

interface MockPoint {
	id: number;
	textVec: Float32Array;
	visualVec: Float32Array;
	payload: Record<string, unknown>;
}

/** Deterministic library: ids 1-4 span the plane, 5+ are neutral (Z) points. */
function makeLibrary(count = 8): MockPoint[] {
	const vecs = [E1, E2, E3, E4, Z, Z, Z, Z];
	return Array.from({ length: count }, (_, i) => ({
		id: i + 1,
		textVec: vecs[i]!,
		visualVec: vecs[i]!,
		payload: { description: `desc-${i + 1}`, blake3: `blake-${i + 1}` },
	}));
}

function makeVectorRegistry(extra: Record<string, Float32Array> = {}): Map<string, Float32Array> {
	return new Map(
		Object.entries({
			'a red cat': E1,
			[Q_CAT.question]: E1, // highly discriminative against E1..E4 beam
			[Q_COLOR.question]: Z, // neutral vs all E1..E4 → ~0 IG
			[Q_INDOOR.question]: NEG_Z, // also neutral, and dissimilar to Q_COLOR
			...extra,
		}),
	);
}

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
	return {
		beamSize: 4,
		maxRounds: 3,
		minRounds: 2,
		igThreshold: 0,
		alpha: 1, // text-only scoring so visual vectors are irrelevant
		lambda: 8,
		candidateQuestions: 5,
		topKQuestions: 4,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface MockEmbedding extends EmbeddingProvider {
	calls: string[][];
}

function makeEmbedding(registry: ReadonlyMap<string, Float32Array>): MockEmbedding {
	const calls: string[][] = [];
	return {
		model: 'mock-embed',
		dimensions: 3,
		embedText: vi.fn(async (texts: string[]) => {
			calls.push([...texts]);
			return texts.map((t) => {
				const vec = registry.get(t);
				if (!vec) throw new Error(`mock embedding: no vector registered for "${t}"`);
				return vec;
			});
		}),
		embedImage: vi.fn(async () => {
			throw new Error('mock embedding: embedImage not expected in these tests');
		}),
		calls,
	};
}

interface MockQdrant {
	readonly scrollCalls: number;
}

function makeQdrant(
	points: MockPoint[],
	opts: { omitRetrieveIds?: number[]; reverseRetrieve?: boolean } = {},
): QdrantStore & MockQdrant {
	const omit = new Set(opts.omitRetrieveIds ?? []);
	let scrollCalls = 0;
	return {
		get scrollCalls() {
			return scrollCalls;
		},
		scroll: vi.fn(async (limit: number) => {
			scrollCalls++;
			// deterministic: first `limit` points in id order
			return points.slice(0, limit).map((p) => ({ id: p.id, payload: p.payload }));
		}),
		searchText: vi.fn(async (queryVec: Float32Array, limit: number): Promise<QdrantHit[]> =>
			points
				.map((p) => ({ id: p.id, score: cosineSim01(queryVec, p.textVec), payload: p.payload }))
				.sort((a, b) => b.score - a.score || a.id - b.id)
				.slice(0, limit),
		),
		// Qdrant retrieve does not guarantee order and omits missing ids — the
		// mock can reproduce both behaviors via opts.
		retrieveVectors: vi.fn(async (ids: number[]): Promise<RetrievedVectors[]> => {
			const found = points
				.filter((p) => ids.includes(p.id) && !omit.has(p.id))
				.map((p) => ({ id: p.id, text: p.textVec, visual: p.visualVec }));
			return opts.reverseRetrieve ? found.reverse() : found;
		}),
		count: vi.fn(async () => points.length),
	} as unknown as QdrantStore & MockQdrant;
}

interface MockLlm extends LLMProvider {
	requests: CompleteRequest[];
}

/**
 * LLM mock that always answers with a submit_questions tool call carrying the
 * given question sets (the last set repeats once the list is exhausted).
 */
function makeLlm(questionSets: ParsedQuestion[][]): MockLlm {
	const requests: CompleteRequest[] = [];
	let call = 0;
	return {
		model: 'mock-llm',
		provider: 'openai',
		complete: vi.fn(async (req: CompleteRequest): Promise<CompleteResponse> => {
			requests.push(req);
			const qs = questionSets[Math.min(call, questionSets.length - 1)] ?? [];
			call++;
			const toolCalls: ToolCall[] = [
				{
					id: 'tc-1',
					name: 'submit_questions',
					arguments: JSON.stringify({ questions: qs }),
				},
			];
			return { stopReason: 'tool_use', text: '', toolCalls };
		}),
		requests,
	};
}

function makeLinkRecord(blake3: string, url: string): LinkRecord {
	return { id: 1, url, blake3, type: 'file', size: 0n, status: 1, createdAt: 0n, updatedAt: 0n };
}

function makeFileIndexRepo(urls: Record<string, string> = {}): FileIndexRepo {
	const urlMap = new Map(Object.entries(urls));
	return {
		resolveBestUrl: vi.fn((blake3: string) => {
			const url = urlMap.get(blake3);
			return url ? makeLinkRecord(blake3, url) : undefined;
		}),
	} as unknown as FileIndexRepo;
}

interface HarnessOptions {
	points?: MockPoint[];
	registry?: Map<string, Float32Array>;
	questionSets?: ParsedQuestion[][];
	urls?: Record<string, string>;
	omitRetrieveIds?: number[];
	reverseRetrieve?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
	const points = opts.points ?? makeLibrary();
	const registry = opts.registry ?? makeVectorRegistry();
	const embedding = makeEmbedding(registry);
	const qdrant = makeQdrant(points, {
		omitRetrieveIds: opts.omitRetrieveIds,
		reverseRetrieve: opts.reverseRetrieve,
	});
	const llm = makeLlm(opts.questionSets ?? [[Q_CAT, Q_COLOR]]);
	const fileIndexRepo = makeFileIndexRepo(opts.urls);
	const deps: SearchAlgorithmDeps = { llm, embedding, qdrant, fileIndexRepo };
	return { algorithm: new SearchAlgorithm(deps), deps, embedding, qdrant, llm, fileIndexRepo };
}

/** Collect (id → prob) pairs from the algorithm's observable results. */
function probById(algorithm: SearchAlgorithm, topK = 10): Map<number, number> {
	return new Map(algorithm.getResults(topK).map((r) => [r.id, r.probability]));
}

describe('SearchAlgorithm.initialize', () => {
	it('bootstraps the beam from searchText results when a hint is given', async () => {
		const { algorithm, embedding, qdrant } = makeHarness();
		const config = makeConfig({ beamSize: 4 });

		await algorithm.initialize(config, { hint: 'a red cat' });

		// hint was embedded, then searched against the text vectors
		expect(embedding.calls[0]).toEqual(['a red cat']);
		expect(qdrant.searchText).toHaveBeenCalledTimes(1);
		expect(qdrant.searchText).toHaveBeenCalledWith(E1, 4);

		// searchText ranking: id 1 (cos 1), then the 0.5-ties by id (2, 4, 5);
		// id 3 (cos -1) and ids 6-8 are cut by the beam size.
		const results = algorithm.getResults(10);
		expect(results.map((r) => r.id)).toEqual([1, 2, 4, 5]);
		// uniform beam over the search hits
		for (const r of results) {
			expect(r.probability).toBeCloseTo(0.25, 10);
		}
		// descriptions come from the cached payloads, not the "Image N" fallback
		expect(results.map((r) => r.description)).toEqual(['desc-1', 'desc-2', 'desc-4', 'desc-5']);
	});

	it('bootstraps the beam from scroll (first beamSize points) when no hint is given', async () => {
		const { algorithm, qdrant, embedding } = makeHarness();
		const config = makeConfig({ beamSize: 4 });

		await algorithm.initialize(config, {});

		expect(embedding.calls).toHaveLength(0); // no hint → nothing embedded
		expect(qdrant.scroll).toHaveBeenCalledTimes(1);
		expect(qdrant.scroll).toHaveBeenCalledWith(4);

		const results = algorithm.getResults(10);
		expect(results.map((r) => r.id)).toEqual([1, 2, 3, 4]);
		for (const r of results) {
			expect(r.probability).toBeCloseTo(0.25, 10);
		}
	});

	it('throws 图库为空 when scroll returns nothing (no hint)', async () => {
		const { algorithm } = makeHarness({ points: [] });
		await expect(algorithm.initialize(makeConfig(), {})).rejects.toThrow(
			'图库为空：请先使用 import 命令导入图片',
		);
	});

	it('throws 图库为空 when searchText returns nothing (hint branch)', async () => {
		const { algorithm } = makeHarness({ points: [] });
		await expect(algorithm.initialize(makeConfig(), { hint: 'a red cat' })).rejects.toThrow(
			'图库为空',
		);
	});

	it('throws Session not initialized when used before initialize', async () => {
		const { algorithm } = makeHarness();
		await expect(algorithm.nextQuestion({})).rejects.toThrow('Session not initialized');
		expect(() => algorithm.getResults()).toThrow('Session not initialized');
	});
});

describe('SearchAlgorithm.nextQuestion', () => {
	it('returns the candidate question with the highest expected information gain', async () => {
		const { algorithm, llm } = makeHarness();
		await algorithm.initialize(makeConfig(), {});

		// Q_CAT (E1) splits the E1..E4 beam (scores 1 / .5 / 0 / .5) while
		// Q_COLOR (Z) is neutral against everything (~0 IG) → Q_CAT must win.
		const question = await algorithm.nextQuestion({});
		expect(question).not.toBeNull();
		expect(question!.question).toBe(Q_CAT.question);
		expect(llm.complete).toHaveBeenCalledTimes(1);
	});

	it('passes the top-5 results to the onQuestion callback', async () => {
		const { algorithm } = makeHarness();
		const seen: Array<{ question: string; results: ReturnType<SearchAlgorithm['getResults']> }> = [];
		await algorithm.initialize(makeConfig({ beamSize: 8, topKQuestions: 8 }), {});

		const question = await algorithm.nextQuestion({
			onQuestion: (q, results) => seen.push({ question: q.question, results }),
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]!.question).toBe(question!.question);
		// beam holds 8 candidates at 1/8 each → top-5 snapshot
		const results = seen[0]!.results;
		expect(results).toHaveLength(5);
		expect(results.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]); // stable ties in beam order
		for (const r of results) {
			expect(r.probability).toBeCloseTo(0.125, 10);
		}
		expect(results.map((r) => r.description)).toEqual(['desc-1', 'desc-2', 'desc-3', 'desc-4', 'desc-5']);
	});
});

describe('SearchAlgorithm.processAnswer', () => {
	it('updates beam probabilities toward candidates matching a numeric answer', async () => {
		const { algorithm } = makeHarness();
		await algorithm.initialize(makeConfig(), {});

		const question = await algorithm.nextQuestion({});
		await algorithm.processAnswer(question!, 0.5);

		// scores: id1=1, id2=0.5, id3=0, id4=0.5; answer 0.5, λ=8
		// L_match = 1, L_other = e^-2 → posterior [0.0596, 0.4404, 0.0596, 0.4404]
		const probs = probById(algorithm);
		expect(probs.get(1)).toBeCloseTo(0.0596, 3);
		expect(probs.get(2)).toBeCloseTo(0.4404, 3);
		expect(probs.get(3)).toBeCloseTo(0.0596, 3);
		expect(probs.get(4)).toBeCloseTo(0.4404, 3);
		let sum = 0;
		for (const p of probs.values()) sum += p;
		expect(sum).toBeCloseTo(1, 10);
		expect(probs.get(2)!).toBeGreaterThan(probs.get(1)!);
		expect(algorithm.isTerminated()).toBe(false);
	});

	it("an 'unknown' answer leaves the beam unchanged and skips the question next round", async () => {
		const { algorithm } = makeHarness();
		await algorithm.initialize(makeConfig(), {});

		const q1 = await algorithm.nextQuestion({});
		expect(q1!.question).toBe(Q_CAT.question);
		await algorithm.processAnswer(q1!, 'unknown');

		// beam untouched (still uniform) and session still alive
		const probs = probById(algorithm);
		for (const p of probs.values()) {
			expect(p).toBeCloseTo(0.25, 10);
		}
		expect(algorithm.isTerminated()).toBe(false);

		// next round must not re-ask the skipped question
		const q2 = await algorithm.nextQuestion({});
		expect(q2).not.toBeNull();
		expect(q2!.question).toBe(Q_COLOR.question);
	});

	it("terminates with 'max_rounds' after answering unknown for maxRounds rounds", async () => {
		// minRounds=5 keeps the low-IG check inert so only the round limit fires
		const { algorithm } = makeHarness({
			questionSets: [[Q_CAT, Q_COLOR, Q_INDOOR]],
		});
		await algorithm.initialize(makeConfig({ maxRounds: 3, minRounds: 5 }), {});

		for (let i = 0; i < 3; i++) {
			const q = await algorithm.nextQuestion({});
			expect(q).not.toBeNull();
			await algorithm.processAnswer(q!, 'unknown');
		}

		expect(algorithm.getRound()).toBe(3);
		expect(algorithm.isTerminated()).toBe(true);
		expect(algorithm.getTerminationReason()).toBe('max_rounds');

		// once terminated, no further question is produced
		await expect(algorithm.nextQuestion({})).resolves.toBeNull();

		// probabilities were never updated
		for (const p of probById(algorithm).values()) {
			expect(p).toBeCloseTo(0.25, 10);
		}
	});

	it("terminates with 'confidence' when one answer pushes maxProb >= 0.9", async () => {
		// λ=100: answer 1 matches id1's score exactly (1) while the rest fall off
		// as e^-25 or worse → posterior max ≈ 1
		const { algorithm } = makeHarness();
		await algorithm.initialize(makeConfig({ lambda: 100 }), {});

		const question = await algorithm.nextQuestion({});
		await algorithm.processAnswer(question!, 1);

		expect(algorithm.isTerminated()).toBe(true);
		expect(algorithm.getTerminationReason()).toBe('confidence');
		expect(algorithm.getRound()).toBe(1); // before maxRounds

		const top = algorithm.getResults(1);
		expect(top[0]!.id).toBe(1);
		expect(top[0]!.probability).toBeGreaterThan(0.9);
	});

	it("terminates with 'low_ig' when IG stays below the threshold after minRounds", async () => {
		// igThreshold=5 is unreachable (max entropy of 4 candidates is ln 4 ≈ 1.39),
		// so once round > minRounds the very next nextQuestion must terminate.
		const { algorithm } = makeHarness({ questionSets: [[Q_CAT]] });
		await algorithm.initialize(makeConfig({ maxRounds: 10, minRounds: 2, igThreshold: 5 }), {});

		const q1 = await algorithm.nextQuestion({});
		expect(q1).not.toBeNull();
		await algorithm.processAnswer(q1!, 0.5);
		expect(algorithm.isTerminated()).toBe(false); // round 1 is not > minRounds

		const q2 = await algorithm.nextQuestion({});
		expect(q2).not.toBeNull();
		await algorithm.processAnswer(q2!, 0.5);
		expect(algorithm.isTerminated()).toBe(false); // round 2 is not > minRounds

		await expect(algorithm.nextQuestion({})).resolves.toBeNull(); // round 3 → low_ig
		expect(algorithm.isTerminated()).toBe(true);
		expect(algorithm.getTerminationReason()).toBe('low_ig');
		expect(algorithm.getRound()).toBe(3);
	});

	it("terminates with 'no_questions' when the LLM returns an empty question list", async () => {
		const { algorithm, llm } = makeHarness({ questionSets: [[]] });
		await algorithm.initialize(makeConfig(), {});

		await expect(algorithm.nextQuestion({})).resolves.toBeNull();
		expect(llm.complete).toHaveBeenCalledTimes(1);
		expect(algorithm.isTerminated()).toBe(true);
		expect(algorithm.getTerminationReason()).toBe('no_questions');
	});

	it("terminates with 'no_questions' when every generated question was already skipped", async () => {
		const { algorithm } = makeHarness({ questionSets: [[Q_CAT]] });
		await algorithm.initialize(makeConfig({ maxRounds: 3 }), {});

		const q1 = await algorithm.nextQuestion({});
		expect(q1).not.toBeNull();
		await algorithm.processAnswer(q1!, 'unknown');

		// round 2: the only known question is skipped → no askable questions left
		await expect(algorithm.nextQuestion({})).resolves.toBeNull();
		expect(algorithm.isTerminated()).toBe(true);
		expect(algorithm.getTerminationReason()).toBe('no_questions');
	});
});

describe('SearchAlgorithm vector retrieval resilience', () => {
	it('handles unordered retrieveVectors without corrupting id → probability pairing', async () => {
		const { algorithm } = makeHarness({ reverseRetrieve: true });
		await algorithm.initialize(makeConfig(), {});

		const question = await algorithm.nextQuestion({});
		await algorithm.processAnswer(question!, 1);

		// scores id1=1, id2=0.5, id3=0, id4=0.5 (reverse delivery must not swap them)
		// answer 1, λ=8 → [0.7868, 0.1065, 0.000264, 0.1065]
		const probs = probById(algorithm);
		expect(probs.get(1)).toBeCloseTo(0.7868, 3);
		expect(probs.get(2)).toBeCloseTo(0.1065, 3);
		expect(probs.get(3)).toBeCloseTo(0.000264, 4); // worst match stays the worst
		expect(probs.get(4)).toBeCloseTo(0.1065, 3);
		let sum = 0;
		for (const p of probs.values()) sum += p;
		expect(sum).toBeCloseTo(1, 10);
	});

	it('scores candidates with missing vectors at the neutral 0.5 and still updates them', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const { algorithm } = makeHarness({ omitRetrieveIds: [3] });
			await algorithm.initialize(makeConfig(), {});

			const question = await algorithm.nextQuestion({});
			await algorithm.processAnswer(question!, 1);

			// id3's score is the neutral 0.5 (same as ids 2 and 4) instead of 0,
			// so all three tie at e^-2 likelihood → [0.7112, 0.0963, 0.0963, 0.0963].
			// A frozen (unscored) id3 would have kept 0.25 instead.
			const probs = probById(algorithm);
			expect(probs.get(1)).toBeCloseTo(0.7112, 3);
			expect(probs.get(3)).toBeCloseTo(0.0963, 3);
			expect(probs.get(3)!).toBeLessThan(0.25); // updated, not frozen
			expect(probs.get(2)).toBeCloseTo(probs.get(3)!, 6); // same neutral score → same posterior
			let sum = 0;
			for (const p of probs.values()) sum += p;
			expect(sum).toBeCloseTo(1, 10);

			// the homogeneity check must be skipped (not falsely terminate) when
			// vectors are missing
			expect(algorithm.isTerminated()).toBe(false);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe('SearchAlgorithm.getResults source path resolution', () => {
	it('maps blake3 → decoded local path via fileIndexRepo.resolveBestUrl', async () => {
		const { algorithm, fileIndexRepo } = makeHarness({
			urls: {
				'blake-1': 'file:///D:/imgs/a%20b.jpg',
				'blake-2': 'file:///D:/imgs/plain.jpg',
			},
		});
		await algorithm.initialize(makeConfig(), {});

		const results = algorithm.getResults(4);
		expect(fileIndexRepo.resolveBestUrl).toHaveBeenCalledWith('blake-1');
		// percent-encoded file URL is decoded into a filesystem path
		expect(results[0]!.sourcePath).toBe(fileURLToPath('file:///D:/imgs/a%20b.jpg'));
		expect(results[1]!.sourcePath).toBe(fileURLToPath('file:///D:/imgs/plain.jpg'));
		// no link registered for blake-3/blake-4 → no sourcePath property
		expect(results[2]!.sourcePath).toBeUndefined();
		expect(results[3]!.sourcePath).toBeUndefined();
	});

	it('falls back to the raw url when it cannot be converted to a path', async () => {
		const { algorithm } = makeHarness({
			urls: { 'blake-1': 'https://example.com/cat.jpg' },
		});
		await algorithm.initialize(makeConfig(), {});

		const results = algorithm.getResults(1);
		expect(results[0]!.sourcePath).toBe('https://example.com/cat.jpg');
	});
});

describe('SearchAlgorithm beam collapse reset', () => {
	it('resets to a uniform scroll beam when an answer collapses all probabilities', async () => {
		// Q_COLOR scores every candidate at exactly 0.5; with λ=1e6 the answer 1
		// underflows every likelihood to 0 → all-zero beam → collapse reset.
		const { algorithm, qdrant } = makeHarness({ questionSets: [[Q_COLOR]] });
		await algorithm.initialize(makeConfig({ lambda: 1e6 }), {});
		expect(qdrant.scrollCalls).toBe(1);

		const question = await algorithm.nextQuestion({});
		expect(question!.question).toBe(Q_COLOR.question);
		await algorithm.processAnswer(question!, 1);

		// beam reset to the deterministic first-beamSize scroll points, uniform
		expect(qdrant.scrollCalls).toBe(2);
		const results = algorithm.getResults(10);
		expect(results.map((r) => r.id)).toEqual([1, 2, 3, 4]);
		for (const r of results) {
			expect(r.probability).toBeCloseTo(0.25, 10);
		}
		expect(algorithm.isTerminated()).toBe(false);
	});
});
