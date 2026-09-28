import type { LLMProvider } from '@llm-image/shared';
import { fileUrlToPath, type FileIndexRepo } from '@llm-image/file-index';
import type { EmbeddingProvider } from '../embedding/provider.ts';
import type { QdrantHit, QdrantStore, RetrievedVectors } from '../storage/qdrant.ts';
import { getFileIndexRepo } from '../fileindex.ts';
import type { ParsedQuestion } from './question-parser.ts';
import type { CandidateInfo, QuestionHistoryEntry } from './question-prompt.ts';
import {
	cosineSim01,
	scoreCandidate,
	bayesianUpdate,
	normalize,
	expectedInfoGain,
	candidateDiversity,
	DEFAULT_BINS,
} from './bayes.ts';
import { Beam } from './beam.ts';
import { generateQuestions } from './question-flow.ts';
import { SearchSession, type SessionConfig, type SearchResult } from './session.ts';

export interface SearchAlgorithmDeps {
	llm: LLMProvider;
	embedding: EmbeddingProvider;
	qdrant: QdrantStore;
	/** Optional injected file-index repo (for testing). Defaults to the shared singleton. */
	fileIndexRepo?: FileIndexRepo;
}

export interface SearchOptions {
	hint?: string;
	onQuestion?: (question: ParsedQuestion, candidates: SearchResult[]) => void;
	onRoundStart?: (round: number, candidateCount: number) => void;
}

export interface SearchResultWithDescription extends SearchResult {
	description: string;
	sourcePath?: string;
}

/** 置信度终止阈值（could be configurable） */
const CONFIDENCE_THRESHOLD = 0.9;
/** 达到最大轮数时，最大概率低于此值判定目标不在图库中 */
const NOT_IN_LIBRARY_THRESHOLD = 0.5;
/** 候选集多样性低于此值视为同质（无法继续区分） */
const HOMOGENEOUS_DIVERSITY_THRESHOLD = 0.1;
/**
 * 与已跳过问题相似度高于此值的问题视为重复提问。
 * 注意：applySkippedPenalty 比较的是 cosineSim01 的输出（映射到 [0,1]，即
 * (cos+1)/2），而 0.7 是按原始余弦值标定的阈值——换算到映射尺度即 (0.7+1)/2。
 */
const SKIPPED_SIMILARITY_THRESHOLD = (0.7 + 1) / 2;
/** 缺失向量候选的中性评分（与 cosineSim01 对零向量的中性输出一致） */
const NEUTRAL_SCORE = 0.5;
/** 命中重复提问时对信息增益施加的惩罚系数 */
const SKIPPED_SIMILARITY_PENALTY = 0.3;

/** 单个候选问题及其期望信息增益与候选评分（供贝叶斯更新复用） */
interface ScoredQuestion {
	question: ParsedQuestion;
	ig: number;
	scores: Map<number, number>;
}

/**
 * Core search algorithm — orchestrates the beam search + Bayesian update loop.
 */
export class SearchAlgorithm {
	private readonly deps: SearchAlgorithmDeps;
	private readonly fileIndexRepo: FileIndexRepo;
	private session: SearchSession | null = null;
	/** blake3 → 候选描述缓存（从 Qdrant payload 提取） */
	private candidateCache = new Map<number, { description: string; blake3: string }>();
	/** 下一轮 processAnswer 消耗的评分数据（由 nextQuestion 写入，读取后即清空） */
	private lastScores: Map<number, number> | null = null;
	/** 已跳过问题的向量缓存（问题文本 → 向量），避免每轮重复 embed */
	private skippedVecCache = new Map<string, Float32Array>();

	constructor(deps: SearchAlgorithmDeps) {
		this.deps = deps;
		this.fileIndexRepo = deps.fileIndexRepo ?? getFileIndexRepo();
	}

	/** 断言会话已初始化并返回它 */
	private requireSession(): SearchSession {
		if (!this.session) {
			throw new Error('Session not initialized');
		}
		return this.session;
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
	 * Cache description + blake3 extracted from Qdrant result payloads.
	 */
	private cacheFromPayload(results: Array<{ id: number; payload: Record<string, unknown> }>): void {
		for (const r of results) {
			const desc = (r.payload.description as string) ?? '';
			const blake3 = (r.payload.blake3 as string) ?? '';
			this.candidateCache.set(r.id, { description: desc, blake3 });
		}
	}

	/** 候选描述（缓存缺失时回退到占位文本） */
	private candidateDescription(id: number): string {
		return this.candidateCache.get(id)?.description ?? `Image ${id}`;
	}

	/** 由 Qdrant 结果构建均匀概率 beam，并将候选写入缓存 */
	private uniformBeamFrom(
		results: Array<{ id: number; payload: Record<string, unknown> }>,
		beamSize: number,
	): Beam {
		this.cacheFromPayload(results);
		const beam = new Beam(beamSize);
		const uniformProb = 1 / results.length;
		for (const r of results) {
			beam.set(r.id, uniformProb);
		}
		return beam;
	}

	/**
	 * Embed the hint text and search Qdrant for the closest points.
	 */
	private async searchByHint(hint: string, limit: number): Promise<QdrantHit[]> {
		const hintVecs = await this.deps.embedding.embedText([hint]);
		const hintVec = hintVecs[0];
		if (!hintVec) throw new Error('Embedding returned empty result for hint');
		return this.deps.qdrant.searchText(hintVec, limit);
	}

	/**
	 * Initialize the search session.
	 * If hint is provided, use Qdrant search to bootstrap the beam.
	 * Otherwise, deterministically take the first beamSize points via Qdrant scroll
	 * (not random): a hint-free session always bootstraps with the same initial beam.
	 */
	async initialize(config: SessionConfig, options: SearchOptions): Promise<void> {
		const initialResults = options.hint
			? await this.searchByHint(options.hint, config.beamSize)
			: await this.deps.qdrant.scroll(config.beamSize);

		if (initialResults.length === 0) {
			throw new Error('图库为空：请先使用 import 命令导入图片');
		}

		this.session = new SearchSession(config, this.uniformBeamFrom(initialResults, config.beamSize));
	}

	/** 构建 LLM 问题生成所需的候选信息 */
	private buildCandidateInfos(topCandidates: Array<{ id: number; prob: number }>): CandidateInfo[] {
		return topCandidates.map((item) => ({
			id: item.id,
			description: this.candidateDescription(item.id),
			probability: item.prob,
		}));
	}

	/**
	 * Execute one round of the search loop.
	 * Returns the question to ask the user, or null if terminated.
	 */
	async nextQuestion(options: SearchOptions): Promise<ParsedQuestion | null> {
		const session = this.requireSession();
		if (session.terminated) {
			return null;
		}

		// Start new round
		session.startRound();

		// PERF: beam vectors are identical for the whole round — retrieve the
		// full beam's vectors ONCE per round and reuse the id → vector Map for
		// both the homogeneity check (subset of top candidates) and question
		// scoring (previously two Qdrant retrieve round trips per round).
		// Both text and visual vectors are fetched: scoreCandidate blends them
		// with alpha, so restricting to ['text'] would change scoring semantics.
		// Qdrant retrieve does not guarantee input order and omits missing ids,
		// so build an id → vector Map and look up each id.
		const beamIds = session.beam.ids();
		const beamVectorList = await this.deps.qdrant.retrieveVectors(beamIds);
		const beamVectorsById = new Map<number, RetrievedVectors>(
			beamVectorList.map((v) => [v.id, v]),
		);

		// Get top candidates for question generation
		const topCandidates = session.beam.topK(session.config.topKQuestions);

		if (this.terminateIfHomogeneous(session, topCandidates, beamVectorsById)) {
			return null;
		}

		const bestQuestion = await this.generateBestQuestion(
			session,
			topCandidates,
			beamIds,
			beamVectorsById,
		);

		if (!bestQuestion) {
			session.terminate('no_questions');
			return null;
		}

		// Check if IG is too low
		if (bestQuestion.ig < session.config.igThreshold && session.canTerminateByIG()) {
			session.terminate('low_ig');
			return null;
		}

		// Notify callback
		options.onQuestion?.(bestQuestion.question, this.getResults(5));

		// Store scores for processAnswer to consume (cleared after use)
		this.lastScores = bestQuestion.scores;

		return bestQuestion.question;
	}

	/**
	 * Terminate with reason 'homogeneous' when the top candidates are too alike
	 * to tell apart (and the minimum number of rounds has been played).
	 * Returns true if the session was terminated.
	 */
	private terminateIfHomogeneous(
		session: SearchSession,
		topCandidates: Array<{ id: number; prob: number }>,
		beamVectorsById: Map<number, RetrievedVectors>,
	): boolean {
		// Qdrant retrieve silently omits missing ids — only trust the diversity
		// check when every requested vector came back. Otherwise a data problem
		// (0/1 vectors) would masquerade as a "homogeneous" candidate set and
		// falsely terminate the session.
		const vectors: Float32Array[] = [];
		let missing = 0;
		for (const c of topCandidates) {
			const v = beamVectorsById.get(c.id);
			if (!v) {
				missing++;
				continue;
			}
			vectors.push(v.text);
		}
		if (missing > 0) {
			console.warn(
				`同质性检查跳过：${missing}/${topCandidates.length} 个候选向量缺失，Qdrant 数据可能不完整`,
			);
			return false;
		}

		const diversity = candidateDiversity(vectors);

		if (diversity < HOMOGENEOUS_DIVERSITY_THRESHOLD && session.canTerminateByIG()) {
			session.terminate('homogeneous');
			return true;
		}
		return false;
	}

	/**
	 * Generate candidate questions via the LLM and pick the most informative one.
	 * Returns null when the LLM produced no questions or all were skipped before.
	 */
	private async generateBestQuestion(
		session: SearchSession,
		topCandidates: Array<{ id: number; prob: number }>,
		beamIds: number[],
		beamVectorsById: Map<number, RetrievedVectors>,
	): Promise<ScoredQuestion | null> {
		const questionHistory: QuestionHistoryEntry[] = session.history.map((h) => ({
			question: h.question.question,
			answer: h.answer,
		}));

		const questions = await generateQuestions({
			llm: this.deps.llm,
			candidates: this.buildCandidateInfos(topCandidates),
			history: questionHistory,
			maxQuestions: session.config.candidateQuestions,
		});

		if (questions.length === 0) {
			return null;
		}

		return this.selectBestQuestion(questions, beamIds, beamVectorsById);
	}

	/**
	 * Score each candidate question by expected information gain and return the
	 * highest-scoring one. Returns null if every question was already skipped
	 * (previously answered "unknown").
	 */
	private async selectBestQuestion(
		questions: ParsedQuestion[],
		beamIds: number[],
		beamVectorsById: Map<number, RetrievedVectors>,
	): Promise<ScoredQuestion | null> {
		const session = this.requireSession();
		const config = session.config;

		const skipped = new Set(session.skippedQuestions);
		const pendingQuestions = questions.filter((q) => !skipped.has(q.question));
		if (pendingQuestions.length === 0) {
			return null;
		}

		// PERF: embed all non-skipped candidate questions in one batch call
		// (the provider batches internally) instead of one serial call each.
		const questionVectors = await this.embedQuestions(pendingQuestions);

		// PERF: skipped questions are embedded once and cached across rounds —
		// each round only embeds the ones not yet in the cache.
		const skippedVecs = await this.getSkippedVectors(session.skippedQuestions);

		// Current beam probabilities (unchanged while scoring, so snapshot once)
		const probs = session.beam.probabilities();

		let best: ScoredQuestion | null = null;
		for (const q of pendingQuestions) {
			// embedQuestions guarantees an entry for every question text
			const qVec = questionVectors.get(q.question)!;

			// Compute scores for all candidates in beam. Ids missing from the
			// Qdrant retrieve result get a neutral score (matching cosineSim01's
			// zero-vector neutrality) so they are scored and updated like everyone
			// else — leaving them unscored would relatively boost them every round
			// (bayesianUpdate keeps unscored probabilities unchanged).
			const scores = new Map<number, number>();
			for (const beamId of beamIds) {
				const beamVector = beamVectorsById.get(beamId);
				if (!beamVector) {
					scores.set(beamId, NEUTRAL_SCORE);
					continue;
				}
				scores.set(beamId, scoreCandidate(qVec, beamVector.text, beamVector.visual, config.alpha));
			}

			// Compute expected information gain
			let { infoGain } = expectedInfoGain(probs, scores, DEFAULT_BINS, config.lambda);

			// Apply IG penalty for questions similar to previously skipped "unknown" questions
			infoGain = this.applySkippedPenalty(infoGain, qVec, skippedVecs);

			// Keep the highest-IG question (first wins on ties, matching the
			// previous stable sort-by-IG behavior)
			if (!best || infoGain > best.ig) {
				best = { question: q, ig: infoGain, scores };
			}
		}

		return best;
	}

	/**
	 * Batch-embed question texts, returning a question → vector Map.
	 * Throws if the provider returns fewer vectors than questions.
	 */
	private async embedQuestions(questions: ParsedQuestion[]): Promise<Map<string, Float32Array>> {
		const vectors = new Map<string, Float32Array>();
		if (questions.length === 0) return vectors;

		const qVecs = await this.deps.embedding.embedText(questions.map((q) => q.question));
		for (let i = 0; i < questions.length; i++) {
			const q = questions[i]!;
			const qVec = qVecs[i];
			if (!qVec) {
				throw new Error(`Failed to embed question: ${q.question}`);
			}
			vectors.set(q.question, qVec);
		}
		return vectors;
	}

	/**
	 * 获取已跳过问题的向量（带跨轮缓存）。
	 * 每轮只 embed 尚未缓存的问题，命中缓存的问题不重复消耗 embedding 调用。
	 */
	private async getSkippedVectors(skippedQuestions: string[]): Promise<Float32Array[]> {
		const uncached = skippedQuestions.filter((q) => !this.skippedVecCache.has(q));
		if (uncached.length > 0) {
			const vecs = await this.deps.embedding.embedText(uncached);
			for (let i = 0; i < uncached.length; i++) {
				const vec = vecs[i];
				if (!vec) {
					throw new Error(`Failed to embed skipped question: ${uncached[i]}`);
				}
				this.skippedVecCache.set(uncached[i]!, vec);
			}
		}
		return skippedQuestions.map((q) => this.skippedVecCache.get(q)!);
	}

	/** 对与已跳过问题相似的新问题惩罚 IG（×0.3） */
	private applySkippedPenalty(
		infoGain: number,
		qVec: Float32Array,
		skippedVecs: Float32Array[],
	): number {
		let maxSim = 0;
		for (const skippedVec of skippedVecs) {
			maxSim = Math.max(maxSim, cosineSim01(qVec, skippedVec));
		}
		if (maxSim > SKIPPED_SIMILARITY_THRESHOLD) {
			return infoGain * SKIPPED_SIMILARITY_PENALTY;
		}
		return infoGain;
	}

	/**
	 * Process user's answer and update the beam.
	 */
	async processAnswer(question: ParsedQuestion, answer: number | 'unknown'): Promise<void> {
		const session = this.requireSession();

		// Record the answer
		session.recordAnswer(question, answer);

		if (answer === 'unknown') {
			// Don't update probabilities, just continue — but still enforce the
			// round limit so repeated "unknown" answers terminate the session.
			if (session.isMaxRounds()) {
				session.terminate('max_rounds');
			}
			return;
		}

		// Consume the scores stored by nextQuestion (cleared after reading).
		// The beam is unchanged since nextQuestion, so its current probabilities
		// are the priors the scores were computed against.
		const scores = this.lastScores;
		this.lastScores = null;

		if (!scores) {
			throw new Error('No scores available for update');
		}

		const probs = session.beam.probabilities();

		const updatedProbs = normalize(bayesianUpdate(probs, scores, answer, session.config.lambda));

		const newBeam = new Beam(session.config.beamSize);
		for (const [id, prob] of updatedProbs) {
			newBeam.set(id, prob);
		}
		newBeam.prune();

		// Check for beam collapse with a beam-size-relative threshold: collapsed
		// iff the max probability is still essentially uniform (≈ 1/beamSize).
		// An absolute threshold (e.g. 0.01) false-positives at the default
		// beamSize=500, where a uniform max prob is ≈ 0.002.
		if (newBeam.isCollapsed(1.5 / session.config.beamSize)) {
			await this.resetToUniformBeam(session);
		} else {
			// Normal update
			session.updateBeam(newBeam);
		}

		this.terminateIfNeeded(session);
	}

	/**
	 * Beam collapsed — reset to a uniform beam of the first beamSize candidates
	 * (scroll order, deterministic: re-selects the same first-N points as the
	 * initial bootstrap).
	 */
	private async resetToUniformBeam(session: SearchSession): Promise<void> {
		const allCandidates = await this.deps.qdrant.scroll(session.config.beamSize);
		session.updateBeam(this.uniformBeamFrom(allCandidates, session.config.beamSize));
	}

	/** 根据当前 beam 最大概率判定终止条件 */
	private terminateIfNeeded(session: SearchSession): void {
		const currentMaxProb = session.beam.maxProb();

		if (currentMaxProb >= CONFIDENCE_THRESHOLD) {
			session.terminate('confidence');
		} else if (session.isMaxRounds()) {
			// Check if target is likely not in library
			if (currentMaxProb < NOT_IN_LIBRARY_THRESHOLD) {
				session.terminate('not_in_library');
			} else {
				session.terminate('max_rounds');
			}
		}
	}

	/**
	 * Get final search results.
	 */
	getResults(topK: number = 5): SearchResultWithDescription[] {
		const session = this.requireSession();

		return session.beam.topK(topK).map((item) => {
			const result: SearchResultWithDescription = {
				id: item.id,
				description: this.candidateDescription(item.id),
				probability: item.prob,
			};
			const cached = this.candidateCache.get(item.id);
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
