import { describe, it, expect } from 'vitest';
import { buildBatchPrompt, labelFor } from '../../src/llm/prompt.js';
import type { ImageEntry } from '../../src/storage/types.js';
import type { ProcessedImage } from '@llm-image/shared';

function makeEntry(url: string): ImageEntry {
	return {
		url: 'file:///test/' + url,
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

function makeProcessed(url: string): ProcessedImage {
	return {
		url: 'file:///test/' + url,
		hash: 'hash-' + url,
		base64: 'data:image/jpeg;base64,dGVzdA==',
		format: 'jpeg',
		width: 1000,
		height: 800,
		channels: 3,
		sizeBytes: 100000,
		undecodablePixels: 0,
		notes: [],
	};
}

describe('labelFor', () => {
	it('returns A-Z for indices 0-25', () => {
		expect(labelFor(0)).toBe('A');
		expect(labelFor(1)).toBe('B');
		expect(labelFor(25)).toBe('Z');
	});

	it('returns IMGn for indices beyond Z', () => {
		expect(labelFor(26)).toBe('IMG27');
		expect(labelFor(100)).toBe('IMG101');
	});
});

describe('buildBatchPrompt', () => {
	it('builds system and user messages', () => {
		const prepared = [
			{ entry: makeEntry('a.jpg'), processed: makeProcessed('a.jpg'), label: 'A' },
			{ entry: makeEntry('b.jpg'), processed: makeProcessed('b.jpg'), label: 'B' },
		];

		const { systemPrompt, userMessages } = buildBatchPrompt(prepared);

		expect(systemPrompt).toContain('图片质量评审员');
		expect(systemPrompt).toContain('不要考虑图片的货币价值');

		expect(userMessages).toHaveLength(1);
		const content = userMessages[0]!.content;
		expect(Array.isArray(content)).toBe(true);

		const blocks = content as Array<{ type: string }>;
		// 1 text block + 2 image blocks
		expect(blocks).toHaveLength(3);
		expect(blocks[0]!.type).toBe('text');
		expect(blocks[1]!.type).toBe('image_url');
		expect(blocks[2]!.type).toBe('image_url');
	});

	it('includes technical metadata in text block', () => {
		const entry = makeEntry('a.jpg');
		entry.width = 4000;
		entry.height = 3000;
		entry.sizeBytes = 2500000;
		const prepared = [
			{ entry, processed: makeProcessed('a.jpg'), label: 'A' },
			{ entry: makeEntry('b.jpg'), processed: makeProcessed('b.jpg'), label: 'B' },
		];

		const { userMessages } = buildBatchPrompt(prepared);
		const textBlock = (userMessages[0]!.content as Array<{ type: string; text?: string }>).find(
			(b) => b.type === 'text',
		);
		expect(textBlock?.text).toContain('4000x3000');
		expect(textBlock?.text).toContain('2441.4 KB'); // 2500000 / 1024 ≈ 2441.4
		expect(textBlock?.text).toContain('JPEG');
	});

	it('does NOT include valuation info in text block', () => {
		const entry = makeEntry('a.jpg');
		entry.maxValue = 12345;
		entry.minValue = 6789;
		const prepared = [
			{ entry, processed: makeProcessed('a.jpg'), label: 'A' },
			{ entry: makeEntry('b.jpg'), processed: makeProcessed('b.jpg'), label: 'B' },
		];

		const { userMessages } = buildBatchPrompt(prepared);
		const textBlock = (userMessages[0]!.content as Array<{ type: string; text?: string }>).find(
			(b) => b.type === 'text',
		);
		const text = textBlock?.text ?? '';
		// Must NOT contain any valuation-specific values
		expect(text).not.toContain('12345');
		expect(text).not.toContain('6789');
		expect(text).not.toContain('min_value');
		expect(text).not.toContain('max_value');
		expect(text).not.toContain('confidence');
		expect(text).not.toContain('description');
	});
});
