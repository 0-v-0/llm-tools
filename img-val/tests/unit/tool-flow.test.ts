import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
	LLMProvider,
	CompleteRequest,
	CompleteResponse,
	LLMMessage,
} from '../../src/llm/provider.js';
import { setDb, closeDb } from '../../src/storage/db.js';
import * as valuationRepo from '../../src/storage/repository.valuation.js';
import { executeToolCall } from '../../src/valuation/tools.js';
import { runToolFlow } from '../../src/valuation/tool-flow.js';
import { extractExif } from '../../src/valuation/exif.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function createTestDb() {
	const db = new DatabaseSync(':memory:');
	const migrationsDir = join(import.meta.dirname, '..', '..', 'src', 'storage', 'migrations');
	for (const file of ['001_init.sql', '002_logprobs.sql']) {
		db.exec(readFileSync(join(migrationsDir, file), 'utf-8'));
	}
	return db;
}

/** A fake provider that returns scripted responses */
class FakeProvider implements LLMProvider {
	readonly model = 'fake-model';
	private responses: CompleteResponse[];
	private callCount = 0;
	private includeToolsInCalls: boolean[] = [];

	constructor(responses: CompleteResponse[]) {
		this.responses = responses;
	}

	async complete(req: CompleteRequest): Promise<CompleteResponse> {
		this.includeToolsInCalls.push(req.tools !== undefined);
		const resp = this.responses[this.callCount];
		this.callCount++;
		if (!resp) {
			throw new Error('No more scripted responses');
		}
		return resp;
	}

	get callCountValue() {
		return this.callCount;
	}
	get toolsIncluded() {
		return this.includeToolsInCalls;
	}
}

describe('tool-flow', () => {
	beforeEach(() => {
		setDb(createTestDb());
	});

	afterEach(() => {
		closeDb();
	});

	it('completes without tools when enableTools=false', async () => {
		const fakeProvider = new FakeProvider([
			{
				stopReason: 'stop',
				text: JSON.stringify({
					min_value: 100,
					max_value: 500,
					rationale: 'test',
					confidence: 'medium',
				}),
				toolCalls: [],
			},
		]);

		const result = await runToolFlow({
			provider: fakeProvider,
			systemPrompt: 'test system',
			userMessages: [{ role: 'user', content: 'test' }] as LLMMessage[],
			enableTools: false,
			maxRounds: 4,
		});

		expect(result.toolUsed).toBe(false);
		expect(result.toolFallback).toBe(false);
		expect(fakeProvider.callCountValue).toBe(1);
		expect(fakeProvider.toolsIncluded[0]).toBe(false);
	});

	it('handles tool_use then stop in two rounds', async () => {
		// Seed a historical valuation for the tool to find
		valuationRepo.insert({
			imageHash: 'seed123',
			url: 'file:///seed.jpg',
			imageFormat: 'jpeg',
			width: 100,
			height: 100,
			channels: 3,
			sizeBytes: 1000,
			undecodablePixels: 0,
			minValue: 50,
			maxValue: 200,
			currency: 'CNY',
			standardName: 'default-photo',
			standardVersion: '1.0.0',
			llmModel: 'openai/gpt-4o',
			description: 'seed record',
			notes: [],
			toolUsed: false,
			toolFallback: false,
			inputTokens: 0,
			outputTokens: 0,
			minLogprob: null,
			maxLogprob: null,
			samplesMin: 1,
			samplesMax: 1,
			rawLlmText: null,
			confidence: null,
		});

		const fakeProvider = new FakeProvider([
			{
				stopReason: 'tool_use',
				text: '',
				toolCalls: [
					{
						id: 'call1',
						name: 'search_valuations',
						arguments: JSON.stringify({ format: 'jpeg', limit: 5 }),
					},
				],
			},
			{
				stopReason: 'stop',
				text: JSON.stringify({
					min_value: 200,
					max_value: 800,
					rationale: '参考历史估值',
					confidence: 'medium',
				}),
				toolCalls: [],
			},
		]);

		const result = await runToolFlow({
			provider: fakeProvider,
			systemPrompt: 'test system',
			userMessages: [{ role: 'user', content: 'test' }] as LLMMessage[],
			enableTools: true,
			maxRounds: 4,
		});

		expect(result.toolUsed).toBe(true);
		expect(result.toolFallback).toBe(false);
		expect(fakeProvider.callCountValue).toBe(2);
		expect(fakeProvider.toolsIncluded[0]).toBe(true);
	});

	it('falls back to no-tools on provider error', async () => {
		const failingProvider: LLMProvider = {
			model: 'failing-model',
			complete: async () => {
				throw new Error('API error');
			},
		};

		const fallbackProvider = new FakeProvider([
			{
				stopReason: 'stop',
				text: JSON.stringify({
					min_value: 100,
					max_value: 300,
					rationale: 'fallback',
					confidence: 'low',
				}),
				toolCalls: [],
			},
		]);

		// First call fails, second call (fallback) succeeds
		let callCount = 0;
		const hybridProvider: LLMProvider = {
			model: 'hybrid-model',
			complete: async (req) => {
				callCount++;
				if (callCount === 1) {
					throw new Error('API error');
				}
				return fallbackProvider.complete(req);
			},
		};

		const result = await runToolFlow({
			provider: hybridProvider,
			systemPrompt: 'test system',
			userMessages: [{ role: 'user', content: 'test' }] as LLMMessage[],
			enableTools: true,
			maxRounds: 4,
		});

		expect(result.toolFallback).toBe(true);
		expect(result.toolUsed).toBe(false);
	});

	it('executes get_exif tool and returns EXIF data', async () => {
		const fixturePath = pathToFileURL(
			join(dirname(import.meta.url), '..', 'fixtures', 'images', 'with-exif.jpg'),
		).href;

		const fakeProvider = new FakeProvider([
			{
				stopReason: 'tool_use',
				text: '',
				toolCalls: [
					{ id: 'call1', name: 'get_exif', arguments: JSON.stringify({}) },
				],
			},
			{
				stopReason: 'stop',
				text: JSON.stringify({
					min_value: 100,
					max_value: 300,
					rationale: '参考EXIF信息',
					confidence: 'high',
				}),
				toolCalls: [],
			},
		]);

		const result = await runToolFlow({
			provider: fakeProvider,
			systemPrompt: 'test system',
			userMessages: [{ role: 'user', content: 'test' }] as LLMMessage[],
			enableTools: true,
			imageUrl: fixturePath,
			maxRounds: 4,
		});

		expect(result.toolUsed).toBe(true);
		expect(fakeProvider.callCountValue).toBe(2);
	});

	it('search_valuations filters by current standard from context', async () => {
		valuationRepo.insert({
			imageHash: 'seed-a',
			url: 'file:///a.jpg',
			imageFormat: 'jpeg',
			width: 100,
			height: 100,
			channels: 3,
			sizeBytes: 1000,
			undecodablePixels: 0,
			minValue: 10,
			maxValue: 20,
			currency: 'CNY',
			standardName: 'photo',
			standardVersion: '1.0.0',
			llmModel: 'openai/gpt-4o',
			description: 'photo val',
			notes: [],
			toolUsed: false,
			toolFallback: false,
			inputTokens: 0,
			outputTokens: 0,
			minLogprob: null,
			maxLogprob: null,
			samplesMin: 1,
			samplesMax: 1,
			rawLlmText: null,
			confidence: null,
		});
		valuationRepo.insert({
			imageHash: 'seed-b',
			url: 'file:///b.jpg',
			imageFormat: 'jpeg',
			width: 100,
			height: 100,
			channels: 3,
			sizeBytes: 1000,
			undecodablePixels: 0,
			minValue: 100,
			maxValue: 200,
			currency: 'CNY',
			standardName: 'art',
			standardVersion: '1.0.0',
			llmModel: 'openai/gpt-4o',
			description: 'art val',
			notes: [],
			toolUsed: false,
			toolFallback: false,
			inputTokens: 0,
			outputTokens: 0,
			minLogprob: null,
			maxLogprob: null,
			samplesMin: 1,
			samplesMax: 1,
			rawLlmText: null,
			confidence: null,
		});

		const result = await executeToolCall(
			'search_valuations',
			{ format: ['jpeg'], limit: 10 },
			{ standardName: 'photo' },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const records = result.result as Array<{ standard: string }>;
		expect(records).toHaveLength(1);
		expect(records[0]?.standard).toBe('photo');
	});

	it('search_valuations without standard context returns all standards', async () => {
		const result = await executeToolCall('search_valuations', { format: ['jpeg'], limit: 10 });
		expect(result.ok).toBe(true);
	});

	it('get_exif without imageUrl returns an error', async () => {
		const result = await executeToolCall('get_exif', {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('缺少当前图片路径上下文');
		}
	});

	it('extractExif returns empty object for image without EXIF', async () => {
		const noExifPath = join(
			fileURLToPath(dirname(import.meta.url)),
			'..',
			'fixtures',
			'images',
			'sample.jpg',
		);
		const exif = await extractExif(noExifPath);
		expect(Object.keys(exif).length).toBe(0);
	});

	it('extractExif returns filtered EXIF keys from with-exif.jpg', async () => {
		const fixturePath = join(
			fileURLToPath(dirname(import.meta.url)),
			'..',
			'fixtures',
			'images',
			'with-exif.jpg',
		);
		const exif = await extractExif(fixturePath);
		expect(exif.make).toBe('TestCamera');
		expect(exif.model).toBe('TestModel');
		expect(exif.software).toBe('SharpTest');
		expect(exif.iso).toBe(400);
		expect(exif.focalLength).toBe(50);
		expect(exif.lens).toBe('TestLens');
		expect(exif.gps).toBeUndefined();
	});
});
