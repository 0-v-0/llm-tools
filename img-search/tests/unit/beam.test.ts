import { describe, it, expect } from 'vitest';
import { Beam } from '../../src/search/beam.js';

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
		expect(beam.has(1)).toBe(true);
		expect(beam.has(3)).toBe(false);
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
		expect(beam.has(2)).toBe(true);
		expect(beam.has(4)).toBe(true);
		expect(beam.has(3)).toBe(true);
		expect(beam.has(1)).toBe(false);
		expect(beam.has(5)).toBe(false);
	});

	it('does not prune if under maxSize', () => {
		const beam = new Beam(10);
		beam.set(1, 0.5);
		beam.set(2, 0.3);
		beam.prune();
		expect(beam.size()).toBe(2);
	});

	it('maxProb returns highest probability', () => {
		const beam = new Beam(500);
		beam.set(1, 0.1);
		beam.set(2, 0.7);
		beam.set(3, 0.3);
		expect(beam.maxProb()).toBe(0.7);
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

	it('serialize and deserialize round-trip', () => {
		const beam = new Beam(500);
		beam.set(1, 0.5);
		beam.set(2, 0.3);
		beam.set(3, 0.2);
		const serialized = beam.serialize();
		expect(serialized).toHaveLength(3);
		// Sorted by prob descending
		expect(serialized[0]!.id).toBe(1);
		expect(serialized[0]!.prob).toBe(0.5);

		const restored = Beam.deserialize(serialized, 500);
		expect(restored.size()).toBe(3);
		expect(restored.get(1)).toBe(0.5);
		expect(restored.get(2)).toBe(0.3);
		expect(restored.get(3)).toBe(0.2);
	});

	it('delete removes a candidate', () => {
		const beam = new Beam(500);
		beam.set(1, 0.5);
		beam.set(2, 0.3);
		expect(beam.delete(1)).toBe(true);
		expect(beam.has(1)).toBe(false);
		expect(beam.size()).toBe(1);
		expect(beam.delete(99)).toBe(false);
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

	it('setAll replaces all candidates', () => {
		const beam = new Beam(500);
		beam.set(1, 0.5);
		beam.setAll(
			new Map([
				[2, 0.3],
				[3, 0.7],
			]),
		);
		expect(beam.size()).toBe(2);
		expect(beam.has(1)).toBe(false);
		expect(beam.has(2)).toBe(true);
		expect(beam.has(3)).toBe(true);
	});
});
