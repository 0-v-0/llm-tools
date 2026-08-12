import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ValuationInsert } from '../../src/storage/types.js';
import { setDb, closeDb } from '../../src/storage/db.js';
import * as searchRepo from '../../src/storage/repository.search.js';
import * as valuationRepo from '../../src/storage/repository.valuation.js';

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

function makeInsert(overrides: Partial<ValuationInsert> = {}): ValuationInsert {
	return {
		imageHash: 'abc123',
		url: 'file:///test/image.jpg',
		imageFormat: 'jpeg',
		width: 1920,
		height: 1080,
		channels: 3,
		sizeBytes: 245678,
		corruption: 'ok',
		minValue: 100,
		maxValue: 500,
		uncertainty: 400,
		currency: 'CNY',
		standardName: 'default-photo',
		standardVersion: '1.0.0',
		llmProvider: 'openai',
		llmModel: 'gpt-4o',
		description: '一张风景照片',
		notes: [],
		toolUsed: false,
		toolFallback: false,
		inputTokens: 1000,
		outputTokens: 50,
		rawLlmText: null,
		...overrides,
	};
}

describe('storage-repository', () => {
	beforeEach(() => {
		setDb(createTestDb());
	});

	afterEach(() => {
		closeDb();
	});

	it('inserts and retrieves by id', () => {
		const id = valuationRepo.insert(makeInsert());
		expect(id).toBeGreaterThan(0);

		const record = valuationRepo.getById(id);
		expect(record).not.toBeNull();
		expect(record?.imageHash).toBe('abc123');
		expect(record?.minValue).toBe(100);
		expect(record?.maxValue).toBe(500);
		expect(record?.description).toBe('一张风景照片');
	});

	it('retrieves by hash', () => {
		valuationRepo.insert(makeInsert({ imageHash: 'hash1', minValue: 50 }));
		valuationRepo.insert(makeInsert({ imageHash: 'hash1', minValue: 100 }));
		valuationRepo.insert(makeInsert({ imageHash: 'hash2', minValue: 200 }));

		const records = valuationRepo.getByHash('hash1');
		expect(records).toHaveLength(2);
		expect(records.every((r) => r.imageHash === 'hash1')).toBe(true);
	});

	it('searches by value range', () => {
		valuationRepo.insert(makeInsert({ minValue: 50, maxValue: 100, description: 'cheap' }));
		valuationRepo.insert(makeInsert({ minValue: 200, maxValue: 800, description: 'medium' }));
		valuationRepo.insert(makeInsert({ minValue: 2000, maxValue: 5000, description: 'expensive' }));

		const results = searchRepo.search({ minValue: 100, maxValue: 1000 });
		expect(results).toHaveLength(1);
		expect(results[0]?.description).toBe('medium');
	});

	it('searches by standard name', () => {
		valuationRepo.insert(makeInsert({ standardName: 'photo', description: 'photo val' }));
		valuationRepo.insert(makeInsert({ standardName: 'art', description: 'art val' }));

		const results = searchRepo.search({ standardName: 'photo' });
		expect(results).toHaveLength(1);
		expect(results[0]?.standardName).toBe('photo');
	});

	it('searches by format', () => {
		valuationRepo.insert(makeInsert({ imageFormat: 'jpeg', description: 'jpg' }));
		valuationRepo.insert(makeInsert({ imageFormat: 'png', description: 'png' }));

		const results = searchRepo.search({ format: 'png' });
		expect(results).toHaveLength(1);
		expect(results[0]?.imageFormat).toBe('png');
	});

	it('searches by free text via FTS5', () => {
		valuationRepo.insert(makeInsert({ description: 'beautiful landscape photo' }));
		valuationRepo.insert(makeInsert({ description: 'city architecture building' }));

		const results = searchRepo.searchByText('landscape');
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results.some((r) => r.description.includes('landscape'))).toBe(true);
	});

	it('respects limit', () => {
		for (let i = 0; i < 10; i++) {
			valuationRepo.insert(makeInsert({ imageHash: `hash${i}`, minValue: i * 10 }));
		}

		const results = searchRepo.search({ limit: 3 });
		expect(results).toHaveLength(3);
	});
});
