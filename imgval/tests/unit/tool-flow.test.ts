import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
	LLMProvider,
	CompleteRequest,
	CompleteResponse,
	LLMMessage,
} from '../../src/llm/provider.js';
import { setDb, closeDb } from '../../src/storage/db.js';
import * as valuationRepo from '../../src/storage/repository.valuation.js';
import { runToolFlow } from '../../src/valuation/tool-flow.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function createTestDb() {
	const db = new DatabaseSync(':memory:');
	const sql = readFileSync(
		join(import.meta.dirname, '..', '..', 'src', 'storage', 'migrations', '001_init.sql'),
		'utf-8',
	);
	db.exec(sql);
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
			corruption: 'ok',
			minValue: 50,
			maxValue: 200,
			uncertainty: 150,
			currency: 'CNY',
			standardName: 'default-photo',
			standardVersion: '1.0.0',
			llmProvider: 'openai',
			llmModel: 'gpt-4o',
			description: 'seed record',
			notes: [],
			toolUsed: false,
			toolFallback: false,
			inputTokens: 0,
			outputTokens: 0,
			rawLlmText: null,
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
});
