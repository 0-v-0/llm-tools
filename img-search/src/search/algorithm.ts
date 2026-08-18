import type { LLMProvider } from '@llm-image/shared';
import type { FileIndexRepo } from '@llm-image/file-index';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { QdrantStore } from '../storage/qdrant.js';
import { getFileIndexRepo } from '../fileindex.js';
import { fileUrlToPath } from '@llm-image/file-index';
import type { ParsedQuestion } from './question-parser.js';
import type { CandidateInfo, QuestionHistoryEntry } from './question-prompt.js';
import {
	cosineSim01,
	bayesianUpdate,
	normalize,
	entropy,
	expectedInfoGain,
	candidateDiversity,
	temperPosterior,
	DEFAULT_BINS,
} from './bayes.js';
import { Beam } from './beam.js';
import { generateQuestions } from './question-flow.js';
import { SearchSession, type SessionConfig, type SearchResult } from './session.js';

export interface SearchAlgorithmDeps {
	llm: LLMProvider;
	embedding: EmbeddingProvider;
	qdrant: QdrantStore;
	/** Optional injected file-index repo (for testing). Defaults to the shared singleton. */
	fileIndexRepo?: FileIndexRepo;
}

export interface SearchOptions {
	hint?: string;
	showThumbnails?: boolean;
	onQuestion?: (question: ParsedQuestion, candidates: SearchResult[]) => void;
	onRoundStart?: (round: number, candidateCount: number) => void;
}

export interface SearchAnswer {
	answer: number | 'unknown';
}

export interface SearchResultWithDescription extends SearchResult {
	description: string;
	sourcePath?: string;
}

/**
 * Core search algorithm — orchestrates the beam search + Bayesian update loop.
 */
export class SearchAlgorithm {
	private deps: SearchAlgorithmDeps;
	private session: SearchSession | null = null;
	private candidateCache: Map<number, { description: string; blake3: string }> = new Map();
	private fileIndexRepo: FileIndexRepo;

	constructor(deps: SearchAlgorithmDeps) {
		this.deps = deps;
		this.fileIndexRepo = deps.fileIndexRepo ?? getFileIndexRepo();
	}

	/**
	 * Resolve a display file path for a blake3 via file-index.
	 * Returns the best link's url (decoded to a filesystem path), or undefined
	 * if no link is registered for this blake3.
	 */
	private resolveSourcePath(blake3: string): string | undefined {
		const link = this.fileIndexRepo.resolveBestUrl(blake3);
		if (!link) return undefined;
		try {
			return fileUrlToPath(link.url);
		} catch {
			return link.url;
		}
	}

	/**
	 * Initialize the search session.
	 * If hint is provided, use Qdrant search to bootstrap the beam.
	 * Otherwise, use Qdrant scroll for random sampling.
	 */
	async initialize(config: SessionConfig, options: SearchOptions): Promise<void> {
		const { embedding, qdrant } = this.deps;
		let initialIds: number[];

		if (options.hint) {
			// Embed the hint text and search
			const hintVecs = await embedding.embedText([options.hint]);
			const hintVec = hintVecs[0];
			if (!hintVec) throw new Error('Embedding returned empty result for hint');
			const results = await qdrant.searchText(hintVec, config.beamSize);
			initialIds = results.map((r) => r.id);

			// Cache descriptions + blake3 from search results
			for (const r of results) {
				const desc = (r.payload.description as string) ?? '';
				const blake3 = (r.payload.blake3 as string) ?? '';
				this.candidateCache.set(r.id, { description: desc, blake3 });
			}
		} else {
			// Random sampling via scroll
			const results = await qdrant.scroll(config.beamSize);
			initialIds = results.map((r) => r.id);

			for (const r of results) {
				const desc = (r.payload.description as string) ?? '';
				const blake3 = (r.payload.blake3 as string) ?? '';
				this.candidateCache.set(r.id, { description: desc, blake3 });
			}
		}

		// Initialize beam with uniform probabilities
		const beam = new Beam(config.beamSize);
		const uniformProb = 1 / initialIds.length;
		for (const id of initialIds) {
			beam.set(id, uniformProb);
		}

		this.session = new SearchSession(config, beam);
	}

	/**
	 * Execute one round of the search loop.
	 * Returns the question to ask the user, or null if terminated.
	 */
	async nextQuestion(options: SearchOptions): Promise<ParsedQuestion | null> {
		if (!this.session) {
			throw new Error('Session not initialized');
		}

		if (this.session.terminated) {
			return null;
		}

		const { llm, embedding, qdrant } = this.deps;
		const config = this.session.config;

		// Start new round
		this.session.startRound();

		// Get top candidates for question generation
		const topCandidates = this.session.beam.topK(50);
		const candidateInfos: CandidateInfo[] = topCandidates.map((item) => {
			const cached = this.candidateCache.get(item.id);
			return {
				id: item.id,
				description: cached?.description ?? `Image ${item.id}`,
				probability: item.prob,
			};
		});

		// Check candidate diversity
		const vectors = await qdrant.retrieveVectors(topCandidates.map((c) => c.id));
		const textVectors = vectors.map((v) => v.text);
		const diversity = candidateDiversity(textVectors);

		if (diversity < 0.1 && this.session.canTerminateByIG()) {
			this.session.terminate('homogeneous');
			return null;
		}

		// Generate questions via LLM
		const questionHistory: QuestionHistoryEntry[] = this.session.history.map((h) => ({
			question: h.question.question,
			answer: h.answer,
		}));

		const questions = await generateQuestions({
			llm,
			candidates: candidateInfos,
			history: questionHistory,
			showThumbnails: options.showThumbnails ?? false,
		});

		if (questions.length === 0) {
			this.session.terminate('low_ig');
			return null;
		}

		// Compute expected information gain for each question
		const questionIGs: Array<{
			question: ParsedQuestion;
			ig: number;
			scores: Map<number, number>;
		}> = [];

		for (const q of questions) {
			// Skip if this question was already asked and answered "unknown"
			if (this.session.skippedQuestions.includes(q.question)) {
				continue;
			}

			// Embed the question
			const qVecs = await embedding.embedText([q.question]);
			const qVec = qVecs[0];
			if (!qVec) {
				throw new Error(`Failed to embed question: ${q.question}`);
			}

			// Compute scores for all candidates in beam
			const beamIds = this.session.beam.ids();
			const beamVectors = await qdrant.retrieveVectors(beamIds);

			const scoresMap = new Map<number, number>();
			for (let i = 0; i < beamIds.length; i++) {
				const beamId = beamIds[i];
				const beamVector = beamVectors[i];
				if (beamId === undefined || beamVector === undefined) {
					continue;
				}
				const textSim = cosineSim01(qVec, beamVector.text);
				const visualSim = cosineSim01(qVec, beamVector.visual);
				const score = config.alpha * textSim + (1 - config.alpha) * visualSim;
				scoresMap.set(beamId, score);
			}

			// Compute expected information gain
			const probs = new Map<number, number>();
			for (const item of this.session.beam.topK(Infinity)) {
				probs.set(item.id, item.prob);
			}

			let { infoGain } = expectedInfoGain(probs, scoresMap, DEFAULT_BINS, config.lambda);

			// Apply IG penalty for questions similar to previously skipped "unknown" questions
			if (this.session.skippedQuestions.length > 0) {
				const skippedVecs = await embedding.embedText(this.session.skippedQuestions);
				let maxSim = 0;
				for (const skippedVec of skippedVecs) {
					if (skippedVec) {
						const sim = cosineSim01(qVec, skippedVec);
						maxSim = Math.max(maxSim, sim);
					}
				}
				// Penalize IG for questions similar to skipped ones (×0.3)
				if (maxSim > 0.7) {
					infoGain *= 0.3;
				}
			}

			questionIGs.push({ question: q, ig: infoGain, scores: scoresMap });
		}

		if (questionIGs.length === 0) {
			this.session.terminate('low_ig');
			return null;
		}

		// Select question with highest IG
		questionIGs.sort((a, b) => b.ig - a.ig);
		const bestQuestion = questionIGs[0];

		if (!bestQuestion) {
			this.session.terminate('low_ig');
			return null;
		}

		// Check if IG is too low
		if (bestQuestion.ig < config.igThreshold && this.session.canTerminateByIG()) {
			this.session.terminate('low_ig');
			return null;
		}

		// Notify callback
		if (options.onQuestion) {
			const results = this.getResults(5);
			options.onQuestion(bestQuestion.question, results);
		}

		// Store scores for later update
		(this as any)._lastScores = bestQuestion.scores;
		(this as any)._lastBeamIds = this.session.beam.ids();

		return bestQuestion.question;
	}

	/**
	 * Process user's answer and update the beam.
	 */
	async processAnswer(question: ParsedQuestion, answer: number | 'unknown'): Promise<void> {
		if (!this.session) {
			throw new Error('Session not initialized');
		}

		// Record the answer
		this.session.recordAnswer(question, answer);

		if (answer === 'unknown') {
			// Don't update probabilities, just continue
			return;
		}

		// Bayesian update
		const scores = (this as any)._lastScores as Map<number, number>;
		const beamIds = (this as any)._lastBeamIds as number[];

		if (!scores || !beamIds) {
			throw new Error('No scores available for update');
		}

		const probs = new Map<number, number>();
		for (let i = 0; i < beamIds.length; i++) {
			const id = beamIds[i];
			if (id !== undefined) {
				probs.set(id, this.session.beam.get(id) ?? 0);
			}
		}

		const updatedProbs = bayesianUpdate(probs, scores, answer, this.session.config.lambda);
		const normalizedProbs = normalize(updatedProbs);

		// Check for beam collapse
		const maxProb = Math.max(...normalizedProbs.values());
		if (maxProb < 0.01) {
			// Beam collapsed — resample 500 candidates from prior
			const allCandidates = await this.deps.qdrant.scroll(this.session.config.beamSize);
			const newBeam = new Beam(this.session.config.beamSize);
			const uniformProb = 1 / allCandidates.length;
			for (const candidate of allCandidates) {
				newBeam.set(candidate.id, uniformProb);
				// Ensure candidate is in cache
				if (!this.candidateCache.has(candidate.id)) {
					const desc = (candidate.payload.description as string) ?? '';
					const blake3 = (candidate.payload.blake3 as string) ?? '';
					this.candidateCache.set(candidate.id, { description: desc, blake3 });
				}
			}
			this.session.updateBeam(newBeam);
		} else {
			// Normal update
			const newBeam = new Beam(this.session.config.beamSize);
			for (const [id, prob] of normalizedProbs) {
				newBeam.set(id, prob);
			}
			newBeam.prune();
			this.session.updateBeam(newBeam);
		}

		// Check termination conditions
		const currentMaxProb = this.session.beam.maxProb();
		const confidenceThreshold = 0.9; // Could be configurable

		if (currentMaxProb >= confidenceThreshold) {
			this.session.terminate('confidence');
		} else if (this.session.isMaxRounds()) {
			// Check if target is likely not in library
			if (currentMaxProb < 0.5) {
				this.session.terminate('not_in_library');
			} else {
				this.session.terminate('max_rounds');
			}
		}
	}

	/**
	 * Get final search results.
	 */
	getResults(topK: number = 5): SearchResultWithDescription[] {
		if (!this.session) {
			throw new Error('Session not initialized');
		}

		const topItems = this.session.beam.topK(topK);
		return topItems.map((item) => {
			const cached = this.candidateCache.get(item.id);
			const result: SearchResultWithDescription = {
				id: item.id,
				description: cached?.description ?? `Image ${item.id}`,
				probability: item.prob,
			};
			if (cached?.blake3) {
				const sourcePath = this.resolveSourcePath(cached.blake3);
				if (sourcePath) result.sourcePath = sourcePath;
			}
			return result;
		});
	}

	/**
	 * Check if the search is terminated.
	 */
	isTerminated(): boolean {
		return this.session?.terminated ?? false;
	}

	/**
	 * Get termination reason.
	 */
	getTerminationReason(): string | undefined {
		return this.session?.terminationReason;
	}

	/**
	 * Get current round number.
	 */
	getRound(): number {
		return this.session?.round ?? 0;
	}
}
