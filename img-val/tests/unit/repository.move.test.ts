import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ValuationInsert } from '../../src/storage/types.js';
import { setDb, closeDb } from '../../src/storage/db.js';
import * as valuationRepo from '../../src/storage/repository.valuation.js';
import { findLowValueFiles, updateRecordUrl, getMaxValueByUrl } from '../../src/storage/repository.move.js';

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

function makeInsert(overrides: Partial<ValuationInsert> = {}): ValuationInsert {
	return {
		imageHash: 'abc123',
		url: 'file:///test/image.jpg',
		imageFormat: 'jpeg',
		width: 1920,
		height: 1080,
		channels: 3,
		sizeBytes: 245678,
		undecodablePixels: 0,
		minValue: 100,
		maxValue: 500,
		currency: 'CNY',
		standardName: 'default-photo',
		standardVersion: '1.0.0',
		llmModel: 'openai/gpt-4o',
		description: '一张风景照片',
		notes: [],
		toolUsed: false,
		toolFallback: false,
		inputTokens: 1000,
		outputTokens: 50,
		minLogprob: null,
		maxLogprob: null,
		samplesMin: 1,
		samplesMax: 1,
		rawLlmText: null,
		confidence: null,
		...overrides,
	};
}

describe('repository.move', () => {
	beforeEach(() => {
		setDb(createTestDb());
	});

	afterEach(() => {
		closeDb();
	});

	it('finds distinct files whose highest valuation is below the threshold', () => {
		valuationRepo.insert(makeInsert({ url: 'file:///a.jpg', maxValue: 50 }));
		valuationRepo.insert(makeInsert({ url: 'file:///a.jpg', maxValue: 90 }));
		valuationRepo.insert(makeInsert({ url: 'file:///b.jpg', maxValue: 500 }));
		valuationRepo.insert(makeInsert({ url: 'file:///c.jpg', maxValue: 20 }));

		const files = findLowValueFiles(100);
		expect(files).toHaveLength(2);
		expect(files.map((f) => f.url).sort()).toEqual(['file:///a.jpg', 'file:///c.jpg']);
		expect(files.find((f) => f.url === 'file:///a.jpg')?.maxValue).toBe(90);
	});

	it('orders results by max value ascending', () => {
		valuationRepo.insert(makeInsert({ url: 'file:///a.jpg', maxValue: 80 }));
		valuationRepo.insert(makeInsert({ url: 'file:///b.jpg', maxValue: 10 }));
		valuationRepo.insert(makeInsert({ url: 'file:///c.jpg', maxValue: 30 }));

		const files = findLowValueFiles(100);
		expect(files.map((f) => f.url)).toEqual([
			'file:///b.jpg',
			'file:///c.jpg',
			'file:///a.jpg',
		]);
	});

	it('excludes files with any valuation at or above the threshold', () => {
		valuationRepo.insert(makeInsert({ url: 'file:///a.jpg', maxValue: 100 }));
		valuationRepo.insert(makeInsert({ url: 'file:///a.jpg', maxValue: 200 }));
		valuationRepo.insert(makeInsert({ url: 'file:///b.jpg', maxValue: 50 }));

		const files = findLowValueFiles(100);
		expect(files).toHaveLength(1);
		expect(files[0]?.url).toBe('file:///b.jpg');
	});

	it('returns empty array when nothing is below the threshold', () => {
		valuationRepo.insert(makeInsert({ url: 'file:///a.jpg', maxValue: 500 }));

		expect(findLowValueFiles(100)).toEqual([]);
	});

	it('updates url for all records referencing the old location', () => {
		valuationRepo.insert(makeInsert({ url: 'file:///old.jpg', imageHash: 'h1' }));
		valuationRepo.insert(makeInsert({ url: 'file:///old.jpg', imageHash: 'h2' }));
		valuationRepo.insert(makeInsert({ url: 'file:///other.jpg', imageHash: 'h3' }));

		const changes = updateRecordUrl('file:///old.jpg', 'file:///new.jpg');
		expect(changes).toBe(2);

		const records = valuationRepo.getByHash('h1');
		expect(records[0]?.url).toBe('file:///new.jpg');
		expect(valuationRepo.getByHash('h3')[0]?.url).toBe('file:///other.jpg');
	});

	it('returns the highest max_value for a url', () => {
		valuationRepo.insert(makeInsert({ url: 'file:///a.jpg', maxValue: 40 }));
		valuationRepo.insert(makeInsert({ url: 'file:///a.jpg', maxValue: 90 }));

		expect(getMaxValueByUrl('file:///a.jpg')).toBe(90);
		expect(getMaxValueByUrl('file:///missing.jpg')).toBeNull();
	});
});
