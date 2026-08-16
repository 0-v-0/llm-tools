import { describe, it, expect } from 'vitest';
import type { ProcessedImage } from '@llm-image/shared';
import type { Standard } from '../../src/standards/parser.js';
import { buildPrompt } from '../../src/llm/prompt.js';

describe('prompt', () => {
	const mockStandard: Standard = {
		frontmatter: {
			name: 'test-standard',
			description: 'Test standard',
			version: '1.0.0',
			currency: 'CNY',
		},
		body: '# Test Standard\n\nContent here.',
		contentHash: 'a'.repeat(64),
		source: 'builtin',
	};

	const mockImageNormal: ProcessedImage = {
		url: 'file:///test/image.jpg',
		hash: 'abc123',
		base64: 'data:image/jpeg;base64,test',
		format: 'jpeg',
		width: 1920,
		height: 1080,
		channels: 3,
		sizeBytes: 102400,
		undecodablePixels: 0,
		notes: [],
	};

	const mockImageCorrupted: ProcessedImage = {
		...mockImageNormal,
		undecodablePixels: 40000,
		notes: ['image corrupted, 40000 undecodable pixels near bottom'],
	};

	const mockImageUnknownChannels: ProcessedImage = {
		...mockImageNormal,
		channels: null,
	};

	it('should not include corruption info when image is normal', () => {
		const result = buildPrompt(mockStandard, mockImageNormal, false);

		// System prompt should not mention damage rule
		expect(result.systemPrompt).not.toContain('损坏或部分解码');

		// User message should not mention corruption status
		const userText = result.userMessages[0].content[0];
		expect(userText).toBeDefined();
		expect(userText.type).toBe('text');
		if (userText.type === 'text') {
			expect(userText.text).not.toContain('损坏状态');
		}
	});

	it('should include corruption info when image is corrupted', () => {
		const result = buildPrompt(mockStandard, mockImageCorrupted, false);

		// System prompt should mention damage rule
		expect(result.systemPrompt).toContain('损坏或部分解码');

		// User message should mention corruption status
		const userText = result.userMessages[0].content[0];
		expect(userText).toBeDefined();
		expect(userText.type).toBe('text');
		if (userText.type === 'text') {
			expect(userText.text).toContain('损坏状态');
		}
	});

	it('should not include channel info when channels is null', () => {
		const result = buildPrompt(mockStandard, mockImageUnknownChannels, false);

		const userText = result.userMessages[0].content[0];
		expect(userText).toBeDefined();
		expect(userText.type).toBe('text');
		if (userText.type === 'text') {
			expect(userText.text).not.toContain('通道数');
		}
	});

	it('should include channel info when channels is known', () => {
		const result = buildPrompt(mockStandard, mockImageNormal, false);

		const userText = result.userMessages[0].content[0];
		expect(userText).toBeDefined();
		expect(userText.type).toBe('text');
		if (userText.type === 'text') {
			expect(userText.text).toContain('通道数: 3');
		}
	});

	it('should not include tool rule when tools are disabled', () => {
		const result = buildPrompt(mockStandard, mockImageNormal, false);

		expect(result.systemPrompt).not.toContain('search_valuations');
		expect(result.systemPrompt).not.toContain('2. 本次不提供搜索工具');
		expect(result.systemPrompt).not.toContain('get_exif');
	});

	it('should include both get_exif and search_valuations when both are enabled', () => {
		const result = buildPrompt(mockStandard, mockImageNormal, true, true);

		expect(result.systemPrompt).toContain('search_valuations');
		expect(result.systemPrompt).toContain('可调用 search_valuations 工具');
		expect(result.systemPrompt).toContain('get_exif');
	});

	it('should include get_exif but not search_valuations when only tools are enabled', () => {
		const result = buildPrompt(mockStandard, mockImageNormal, true, false);

		expect(result.systemPrompt).not.toContain('search_valuations');
		expect(result.systemPrompt).toContain('get_exif');
	});

	it('should include tool rule when tools are enabled (default search enabled)', () => {
		const result = buildPrompt(mockStandard, mockImageNormal, true);

		expect(result.systemPrompt).toContain('search_valuations');
		expect(result.systemPrompt).toContain('可调用 search_valuations 工具');
	});

	it('should not include notes when empty', () => {
		const result = buildPrompt(mockStandard, mockImageNormal, false);

		const userText = result.userMessages[0].content[0];
		expect(userText).toBeDefined();
		expect(userText.type).toBe('text');
		if (userText.type === 'text') {
			expect(userText.text).not.toContain('备注:');
		}
	});

	it('should include notes when present', () => {
		const result = buildPrompt(mockStandard, mockImageCorrupted, false);

		const userText = result.userMessages[0].content[0];
		expect(userText).toBeDefined();
		expect(userText.type).toBe('text');
		if (userText.type === 'text') {
			expect(userText.text).toContain('备注:');
		}
	});
});
