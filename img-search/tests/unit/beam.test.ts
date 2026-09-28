import { describe, it, expect } from 'vitest';
import { Beam } from '../../src/search/beam.ts';

describe('Beam', () => {
	it('starts empty', () => {
		const beam = new Beam(500);
		expect(beam.size()).toBe(0);
		expect(beam.maxProb()).toBe(0);
	});

	it('sets and gets probabilities', () => {
		const beam = new Beam(500);
		beam.set(1, 0.5);
		beam.set(2, 0.3);
		expect(beam.get(1)).toBe(0.5);
		expect(beam.get(2)).toBe(0.3);
		expect(beam.get(3)).toBeUndefined();
	});

	it('returns topK sorted by probability', () => {
		const beam = new Beam(500);
		beam.set(1, 0.1);
		beam.set(2, 0.5);
		beam.set(3, 0.3);
		const top = beam.topK(2);
		expect(top).toHaveLength(2);
		expect(top[0]!.id).toBe(2);
		expect(top[0]!.prob).toBe(0.5);
		expect(top[1]!.id).toBe(3);
		expect(top[1]!.prob).toBe(0.3);
	});

	it('topK returns all if k > size', () => {
		const beam = new Beam(500);
		beam.set(1, 0.1);
		beam.set(2, 0.2);
		const top = beam.topK(10);
		expect(top).toHaveLength(2);
	});

	it('topK with k > size returns every entry sorted descending', () => {
		const beam = new Beam(500);
		beam.set(1, 0.2);
		beam.set(2, 0.9);
		beam.set(3, 0.5);
		const top = beam.topK(100);
		expect(top.map((c) => c.id)).toEqual([2, 3, 1]);
		expect(top.map((c) => c.prob)).toEqual([0.9, 0.5, 0.2]);
	});

	it('topK(0) returns an empty array', () => {
		const beam = new Beam(500);
		beam.set(1, 0.5);
		expect(beam.topK(0)).toEqual([]);
	});

	it('prunes to maxSize keeping highest probabilities', () => {
		const beam = new Beam(3);
		beam.set(1, 0.1);
		beam.set(2, 0.5);
		beam.set(3, 0.3);
		beam.set(4, 0.4);
		beam.set(5, 0.2);
		beam.prune();
		expect(beam.size()).toBe(3);
		// Should keep ids 2, 4, 3 (highest probs)
		expect(beam.get(2)).toBe(0.5);
		expect(beam.get(4)).toBe(0.4);
		expect(beam.get(3)).toBe(0.3);
		expect(beam.get(1)).toBeUndefined();
		expect(beam.get(5)).toBeUndefined();
	});

	it('does not prune if under maxSize', () => {
		const beam = new Beam(10);
		beam.set(1, 0.5);
		beam.set(2, 0.3);
		beam.prune();
		expect(beam.size()).toBe(2);
	});

	it('prune with tied boundary probabilities keeps the earliest-inserted candidate', () => {
		// Ids 2 and 3 share the boundary prob 0.4. topK sorts by prob desc with
		// Array.prototype.sort (stable), so among ties insertion order wins:
		// id 2 is kept and id 3 is dropped. Deterministic for this insertion order.
		const beam = new Beam(2);
		beam.set(1, 0.5);
		beam.set(2, 0.4);
		beam.set(3, 0.4);
		beam.prune();
		expect(beam.size()).toBe(2);
		expect(beam.get(1)).toBe(0.5);
		expect(beam.get(2)).toBe(0.4);
		expect(beam.get(3)).toBeUndefined();
	});

	it('probabilities returns a snapshot equal to the beam contents', () => {
		const beam = new Beam(500);
		beam.set(1, 0.5);
		beam.set(2, 0.3);
		expect(beam.probabilities()).toEqual(
			new Map([
				[1, 0.5],
				[2, 0.3],
			]),
		);
	});

	it('mutating the probabilities snapshot does not affect the beam', () => {
		const beam = new Beam(500);
		beam.set(1, 0.5);
		const snapshot = beam.probabilities();
		snapshot.set(1, 0.99);
		snapshot.set(2, 0.7);
		snapshot.delete(1);
		expect(beam.get(1)).toBe(0.5);
		expect(beam.get(2)).toBeUndefined();
		expect(beam.size()).toBe(1);
	});

	it('maxProb returns highest probability', () => {
		const beam = new Beam(500);
		beam.set(1, 0.1);
		beam.set(2, 0.7);
		beam.set(3, 0.3);
		expect(beam.maxProb()).toBe(0.7);
	});

	it('maxProb returns 0 for all-negative probabilities', () => {
		// Pinned: max starts at 0, so negative probabilities can never raise it —
		// the "max" is really "max(p, 0)".
		const beam = new Beam(500);
		beam.set(1, -0.5);
		beam.set(2, -0.1);
		expect(beam.maxProb()).toBe(0);
	});

	it('isCollapsed returns true when all probs below threshold', () => {
		const beam = new Beam(500);
		beam.set(1, 0.001);
		beam.set(2, 0.002);
		expect(beam.isCollapsed(0.01)).toBe(true);
	});

	it('isCollapsed returns false when any prob above threshold', () => {
		const beam = new Beam(500);
		beam.set(1, 0.001);
		beam.set(2, 0.5);
		expect(beam.isCollapsed(0.01)).toBe(false);
	});

	it('isCollapsed returns true for empty beam', () => {
		const beam = new Beam(500);
		expect(beam.isCollapsed(0.01)).toBe(true);
	});

	it('isCollapsed returns false when a prob exactly equals the threshold', () => {
		// Pinned boundary: the check is p >= threshold, so a prob equal to the
		// threshold counts as "not collapsed".
		const beam = new Beam(500);
		beam.set(1, 0.01);
		expect(beam.isCollapsed(0.01)).toBe(false);
	});

	it('isCollapsed returns true when the highest prob is just below the threshold', () => {
		const beam = new Beam(500);
		beam.set(1, 0.009999);
		expect(beam.isCollapsed(0.01)).toBe(true);
	});

	it('ids returns all candidate IDs', () => {
		const beam = new Beam(500);
		beam.set(1, 0.5);
		beam.set(2, 0.3);
		beam.set(3, 0.2);
		const ids = beam.ids();
		expect(ids).toHaveLength(3);
		expect(ids).toContain(1);
		expect(ids).toContain(2);
		expect(ids).toContain(3);
	});
});
