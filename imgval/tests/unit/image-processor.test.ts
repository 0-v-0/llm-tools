import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { processImage } from '../../src/image/processor.js';
import { ImageError } from '../../src/util/errors.js';

describe('image-processor', () => {
	it('processes a valid JPEG', async () => {
		const url = pathToFileURL('tests/fixtures/images/sample.jpg').href;
		const result = await processImage(url);
		expect(result.format).toBe('jpeg');
		expect(result.width).toBe(200);
		expect(result.height).toBe(150);
		expect(result.corruption).toBe('ok');
		expect(result.base64).toMatch(/^data:image\/jpeg;base64,/);
		expect(result.url).toBe(url);
		expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('processes a valid PNG', async () => {
		const url = pathToFileURL('tests/fixtures/images/sample.png').href;
		const result = await processImage(url);
		expect(result.format).toBe('png');
		expect(result.width).toBe(300);
		expect(result.height).toBe(200);
		expect(result.corruption).toBe('ok');
	});

	it('processes a valid WebP', async () => {
		const url = pathToFileURL('tests/fixtures/images/sample.webp').href;
		const result = await processImage(url);
		expect(result.format).toBe('webp');
		expect(result.width).toBe(250);
		expect(result.height).toBe(180);
		expect(result.corruption).toBe('ok');
	});

	it('throws ImageError on garbage file', async () => {
		const url = pathToFileURL('tests/fixtures/images/garbage.jpg').href;
		await expect(processImage(url)).rejects.toThrow(ImageError);
	});

	it('throws ImageError on non-existent file', async () => {
		const url = pathToFileURL('tests/fixtures/images/nonexistent.jpg').href;
		await expect(processImage(url)).rejects.toThrow(ImageError);
	});
});
