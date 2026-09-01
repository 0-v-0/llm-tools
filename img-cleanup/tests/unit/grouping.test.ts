import { describe, it, expect } from 'vitest';
import { bucketIndexFor, bucketLabel, groupImages } from '../../src/grouping/grouping.js';
import type { ImageEntry } from '../../src/storage/types.js';

const boundaries = [0, 30, 100, 500, 2000, 5000, 15000];

function makeEntry(url: string, maxValue: number, standardName = 'default-photo'): ImageEntry {
	return {
		url,
		imageHash: 'hash-' + url,
		maxValue,
		minValue: Math.max(0, maxValue - 50),
		standardName,
		imageFormat: 'jpeg',
		width: 1000,
		height: 800,
		channels: 3,
		sizeBytes: 100000,
		undecodablePixels: 0,
	};
}

describe('bucketIndexFor', () => {
	it('assigns to correct bucket', () => {
		expect(bucketIndexFor(5, boundaries)).toBe(0); // 0-30
		expect(bucketIndexFor(29.99, boundaries)).toBe(0); // 0-30
		expect(bucketIndexFor(30, boundaries)).toBe(1); // 30-100
		expect(bucketIndexFor(99, boundaries)).toBe(1); // 30-100
		expect(bucketIndexFor(100, boundaries)).toBe(2); // 100-500
		expect(bucketIndexFor(499, boundaries)).toBe(2); // 100-500
		expect(bucketIndexFor(500, boundaries)).toBe(3); // 500-2000
		expect(bucketIndexFor(2000, boundaries)).toBe(4); // 2000-5000
		expect(bucketIndexFor(5000, boundaries)).toBe(5); // 5000-15000
		expect(bucketIndexFor(15000, boundaries)).toBe(6); // 15000+
		expect(bucketIndexFor(99999, boundaries)).toBe(6); // 15000+
	});

	it('handles edge case at 0', () => {
		expect(bucketIndexFor(0, boundaries)).toBe(0);
	});
});

describe('bucketLabel', () => {
	it('formats finite ranges', () => {
		expect(bucketLabel(0, boundaries)).toBe('0-30');
		expect(bucketLabel(3, boundaries)).toBe('500-2000');
	});

	it('formats last bucket as open-ended', () => {
		expect(bucketLabel(6, boundaries)).toBe('15000+');
	});
});

describe('groupImages', () => {
	it('groups by standard and bucket', () => {
		const images = [
			makeEntry('a.jpg', 10, 'default-photo'),
			makeEntry('b.jpg', 50, 'default-photo'),
			makeEntry('c.jpg', 200, 'default-photo'),
			makeEntry('d.jpg', 10, 'personal-images'),
		];

		const groups = groupImages(images, boundaries);

		expect(groups).toHaveLength(4);

		// default-photo / 0-30
		const g1 = groups.find((g) => g.standardName === 'default-photo' && g.bucketLabel === '0-30');
		expect(g1?.images).toHaveLength(1);
		expect(g1?.images[0]?.url).toBe('a.jpg');

		// default-photo / 30-100
		const g2 = groups.find((g) => g.standardName === 'default-photo' && g.bucketLabel === '30-100');
		expect(g2?.images).toHaveLength(1);
		expect(g2?.images[0]?.url).toBe('b.jpg');

		// default-photo / 100-500
		const g3 = groups.find((g) => g.standardName === 'default-photo' && g.bucketLabel === '100-500');
		expect(g3?.images).toHaveLength(1);
		expect(g3?.images[0]?.url).toBe('c.jpg');

		// personal-images / 0-30
		const g4 = groups.find((g) => g.standardName === 'personal-images' && g.bucketLabel === '0-30');
		expect(g4?.images).toHaveLength(1);
		expect(g4?.images[0]?.url).toBe('d.jpg');
	});

	it('orders images by max_value ascending within group', () => {
		const images = [
			makeEntry('expensive.jpg', 400, 'default-photo'),
			makeEntry('cheap.jpg', 150, 'default-photo'),
			makeEntry('mid.jpg', 250, 'default-photo'),
		];

		const groups = groupImages(images, boundaries);
		const g = groups.find((g) => g.bucketLabel === '100-500');
		expect(g?.images.map((i) => i.url)).toEqual(['cheap.jpg', 'mid.jpg', 'expensive.jpg']);
	});

	it('returns empty for no images', () => {
		const groups = groupImages([], boundaries);
		expect(groups).toHaveLength(0);
	});
});
