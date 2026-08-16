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

export interface SearchSessionState {
	beam: Beam;
	round: number;
	history: QuestionRecord[];
	skippedQuestions: string[];
	terminated: boolean;
	terminationReason?: 'confidence' | 'max_rounds' | 'not_in_library' | 'low_ig' | 'homogeneous';
}

export interface SessionConfig {
	beamSize: number;
	maxRounds: number;
	minRounds: number;
	igThreshold: number;
	alpha: number;
	lambda: number;
	candidateQuestions: number;
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

	get terminationReason(): string | undefined {
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
	terminate(
		reason: 'confidence' | 'max_rounds' | 'not_in_library' | 'low_ig' | 'homogeneous',
	): void {
		this.state.terminated = true;
		this.state.terminationReason = reason;
	}

	/** Check if we can terminate due to IG threshold */
	canTerminateByIG(): boolean {
		return this.state.round >= this.config.minRounds;
	}

	/** Check if we've reached max rounds */
	isMaxRounds(): boolean {
		return this.state.round >= this.config.maxRounds;
	}

	/** Get results sorted by probability */
	getResults(topK: number = 5): SearchResult[] {
		const topItems = this.state.beam.topK(topK);
		return topItems.map((item) => ({
			id: item.id,
			description: '',
			probability: item.prob,
		}));
	}
}
