import { describe, it, expect } from 'vitest';
import { createBatches, needsLlm } from '../../src/grouping/batching.js';
import type { ImageEntry } from '../../src/storage/types.js';

function makeEntry(url: string): ImageEntry {
	return {
		url,
		imageHash: 'hash-' + url,
		maxValue: 100,
		minValue: 50,
		standardName: 'default-photo',
		imageFormat: 'jpeg',
		width: 1000,
		height: 800,
		channels: 3,
		sizeBytes: 100000,
		undecodablePixels: 0,
	};
}

describe('createBatches', () => {
	it('creates batches of size n', () => {
		const images = [makeEntry('a.jpg'), makeEntry('b.jpg'), makeEntry('c.jpg'), makeEntry('d.jpg')];
		const batches = createBatches(images, 2);
		expect(batches).toHaveLength(2);
		expect(batches[0]?.images).toHaveLength(2);
		expect(batches[1]?.images).toHaveLength(2);
	});

	it('last batch may have fewer than n', () => {
		const images = [makeEntry('a.jpg'), makeEntry('b.jpg'), makeEntry('c.jpg')];
		const batches = createBatches(images, 2);
		expect(batches).toHaveLength(2);
		expect(batches[0]?.images).toHaveLength(2);
		expect(batches[1]?.images).toHaveLength(1);
	});

	it('handles batch size 3', () => {
		const images = [makeEntry('a.jpg'), makeEntry('b.jpg'), makeEntry('c.jpg'), makeEntry('d.jpg'), makeEntry('e.jpg')];
		const batches = createBatches(images, 3);
		expect(batches).toHaveLength(2);
		expect(batches[0]?.images).toHaveLength(3);
		expect(batches[1]?.images).toHaveLength(2);
	});

	it('handles single image', () => {
		const images = [makeEntry('a.jpg')];
		const batches = createBatches(images, 2);
		expect(batches).toHaveLength(1);
		expect(batches[0]?.images).toHaveLength(1);
	});

	it('handles empty list', () => {
		const batches = createBatches([], 2);
		expect(batches).toHaveLength(0);
	});
});

describe('needsLlm', () => {
	it('returns true for batches with ≥2 images', () => {
		expect(needsLlm({ images: [makeEntry('a'), makeEntry('b')] })).toBe(true);
		expect(needsLlm({ images: [makeEntry('a'), makeEntry('b'), makeEntry('c')] })).toBe(true);
	});

	it('returns false for single-image batches', () => {
		expect(needsLlm({ images: [makeEntry('a')] })).toBe(false);
	});
});
