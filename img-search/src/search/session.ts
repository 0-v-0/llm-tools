import type { ParsedQuestion } from './question-parser.js';
import { Beam } from './beam.js';

export interface QuestionRecord {
	question: ParsedQuestion;
	answer: number | 'unknown';
	round: number;
}

export interface SearchResult {
	id: number;
	description: string;
	probability: number;
	sourcePath?: string;
}

/** 会话终止原因 */
export type TerminationReason =
	| 'confidence'
	| 'max_rounds'
	| 'not_in_library'
	| 'no_questions'
	| 'low_ig'
	| 'homogeneous';

export interface SearchSessionState {
	beam: Beam;
	round: number;
	history: QuestionRecord[];
	skippedQuestions: string[];
	terminated: boolean;
	terminationReason?: TerminationReason;
}

export interface SessionConfig {
	beamSize: number;
	maxRounds: number;
	minRounds: number;
	igThreshold: number;
	alpha: number;
	lambda: number;
	candidateQuestions: number;
	topKQuestions: number;
}

/**
 * Search session — manages state across rounds of the interactive search loop.
 */
export class SearchSession {
	readonly config: SessionConfig;
	private state: SearchSessionState;

	constructor(config: SessionConfig, initialBeam: Beam) {
		this.config = config;
		this.state = {
			beam: initialBeam,
			round: 0,
			history: [],
			skippedQuestions: [],
			terminated: false,
		};
	}

	get beam(): Beam {
		return this.state.beam;
	}

	get round(): number {
		return this.state.round;
	}

	get history(): QuestionRecord[] {
		return this.state.history;
	}

	get skippedQuestions(): string[] {
		return this.state.skippedQuestions;
	}

	get terminated(): boolean {
		return this.state.terminated;
	}

	get terminationReason(): SearchSessionState['terminationReason'] {
		return this.state.terminationReason;
	}

	/** Start a new round */
	startRound(): void {
		this.state.round++;
	}

	/** Record a question-answer pair */
	recordAnswer(question: ParsedQuestion, answer: number | 'unknown'): void {
		this.state.history.push({
			question,
			answer,
			round: this.state.round,
		});
		if (answer === 'unknown') {
			this.state.skippedQuestions.push(question.question);
		}
	}

	/** Update beam after Bayesian update */
	updateBeam(newBeam: Beam): void {
		this.state.beam = newBeam;
	}

	/** Terminate the session */
	terminate(reason: TerminationReason): void {
		this.state.terminated = true;
		this.state.terminationReason = reason;
	}

	/**
	 * Check if we can terminate due to IG threshold.
	 * 严格大于：本检查在 startRound() 之后、本轮问题尚未提出/回答之前调用，
	 * `round > minRounds` 保证至少 minRounds 个问题已被提出且回答后才能终止。
	 */
	canTerminateByIG(): boolean {
		return this.state.round > this.config.minRounds;
	}

	/** Check if we've reached max rounds */
	isMaxRounds(): boolean {
		return this.state.round >= this.config.maxRounds;
	}
}
