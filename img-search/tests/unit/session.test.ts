import { describe, it, expect } from 'vitest';
import { Beam } from '../../src/search/beam.ts';
import { SearchSession, type SessionConfig } from '../../src/search/session.ts';
import type { ParsedQuestion } from '../../src/search/question-parser.ts';

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
	return {
		beamSize: 4,
		maxRounds: 3,
		minRounds: 2,
		igThreshold: 0,
		alpha: 1,
		lambda: 8,
		candidateQuestions: 5,
		topKQuestions: 4,
		...overrides,
	};
}

function makeQuestion(text: string): ParsedQuestion {
	return { question: text, rationale: `rationale for ${text}` };
}

function makeBeam(size = 4): Beam {
	const beam = new Beam(size);
	for (let i = 1; i <= size; i++) {
		beam.set(i, 1 / size);
	}
	return beam;
}

describe('SearchSession', () => {
	it('starts in a fresh state (round 0, empty history, not terminated)', () => {
		const config = makeConfig();
		const beam = makeBeam();
		const session = new SearchSession(config, beam);

		expect(session.config).toBe(config);
		expect(session.beam).toBe(beam);
		expect(session.round).toBe(0);
		expect(session.history).toHaveLength(0);
		expect(session.skippedQuestions).toHaveLength(0);
		expect(session.terminated).toBe(false);
		expect(session.terminationReason).toBeUndefined();
	});

	it('startRound increments the round counter', () => {
		const session = new SearchSession(makeConfig(), makeBeam());
		expect(session.round).toBe(0);

		session.startRound();
		expect(session.round).toBe(1);

		session.startRound();
		expect(session.round).toBe(2);
	});

	describe('recordAnswer', () => {
		it('records a numeric answer with the current round number', () => {
			const session = new SearchSession(makeConfig(), makeBeam());
			session.startRound();
			const q = makeQuestion('Is it a cat?');

			session.recordAnswer(q, 0.5);

			expect(session.history).toHaveLength(1);
			expect(session.history[0]!.question).toBe(q);
			expect(session.history[0]!.answer).toBe(0.5);
			expect(session.history[0]!.round).toBe(1);
			// numeric answers must not be treated as skipped
			expect(session.skippedQuestions).toHaveLength(0);
		});

		it('captures the round at record time, not a live reference', () => {
			const session = new SearchSession(makeConfig(), makeBeam());
			session.startRound();
			session.recordAnswer(makeQuestion('q1'), 0);

			session.startRound();
			session.recordAnswer(makeQuestion('q2'), 1);

			expect(session.history[0]!.round).toBe(1);
			expect(session.history[1]!.round).toBe(2);
		});

		it("pushes 'unknown' answers onto skippedQuestions", () => {
			const session = new SearchSession(makeConfig(), makeBeam());
			session.startRound();
			const q = makeQuestion('Is it outdoors?');

			session.recordAnswer(q, 'unknown');

			expect(session.history).toHaveLength(1);
			expect(session.history[0]!.answer).toBe('unknown');
			expect(session.skippedQuestions).toEqual(['Is it outdoors?']);
		});
	});

	it('updateBeam replaces the beam object', () => {
		const session = new SearchSession(makeConfig(), makeBeam());
		const oldBeam = session.beam;

		const newBeam = new Beam(4);
		newBeam.set(7, 0.9);
		newBeam.set(8, 0.1);
		session.updateBeam(newBeam);

		expect(session.beam).toBe(newBeam);
		expect(session.beam.get(7)).toBe(0.9);
		// the old beam object is untouched
		expect(oldBeam.get(7)).toBeUndefined();
	});

	it('terminate sets terminated and the reason, and can be overridden', () => {
		const session = new SearchSession(makeConfig(), makeBeam());

		session.terminate('confidence');
		expect(session.terminated).toBe(true);
		expect(session.terminationReason).toBe('confidence');

		// a second terminate overrides the reason (defensive behavior pin)
		session.terminate('max_rounds');
		expect(session.terminated).toBe(true);
		expect(session.terminationReason).toBe('max_rounds');
	});

	describe('canTerminateByIG (strict round > minRounds boundary)', () => {
		it('is false while round <= minRounds', () => {
			const session = new SearchSession(makeConfig({ minRounds: 2 }), makeBeam());
			// round 0
			expect(session.canTerminateByIG()).toBe(false);
			session.startRound();
			expect(session.canTerminateByIG()).toBe(false);
			session.startRound();
			// round === minRounds → still false (strict >)
			expect(session.round).toBe(2);
			expect(session.canTerminateByIG()).toBe(false);
		});

		it('is true once round > minRounds', () => {
			const session = new SearchSession(makeConfig({ minRounds: 2 }), makeBeam());
			session.startRound();
			session.startRound();
			session.startRound();
			expect(session.round).toBe(3);
			expect(session.canTerminateByIG()).toBe(true);
		});
	});

	describe('isMaxRounds (round >= maxRounds boundary)', () => {
		it('is false below maxRounds', () => {
			const session = new SearchSession(makeConfig({ maxRounds: 3 }), makeBeam());
			expect(session.isMaxRounds()).toBe(false);
			session.startRound();
			session.startRound();
			expect(session.round).toBe(2);
			expect(session.isMaxRounds()).toBe(false);
		});

		it('is true at and above maxRounds', () => {
			const session = new SearchSession(makeConfig({ maxRounds: 3 }), makeBeam());
			session.startRound();
			session.startRound();
			session.startRound();
			expect(session.round).toBe(3);
			expect(session.isMaxRounds()).toBe(true);

			session.startRound();
			expect(session.isMaxRounds()).toBe(true);
		});
	});
});
