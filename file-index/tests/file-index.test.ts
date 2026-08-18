import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileIndexDb, type DB } from '../src/db.js';
import { FileIndexRepo } from '../src/repository.links.js';
import { blake3Hex, blake3HexFile, blake3HexDataUri, blake3HexString } from '../src/fingerprint.js';
import { nowTicks, ticksToDate } from '../src/time.js';
import { classifyUrl, normalizeUrl, toFileUrl } from '../src/url.js';
import { verifyLink } from '../src/verify.js';

function openTempDb(): DB {
	const dir = mkdtempSync(join(tmpdir(), 'file-index-test-'));
	const db = openFileIndexDb(join(dir, 'test.db'));
	return db;
}

describe('blake3 fingerprint', () => {
	it('produces 64-char hex', () => {
		const hex = blake3Hex(Buffer.from('hello world'));
		expect(hex).toHaveLength(64);
	});

	it('known test vector', () => {
		// BLAKE3-256 of "hello" (no newline)
		expect(blake3HexString('hello')).toBe(
			'ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f',
		);
	});

	it('data URI: base64 and plain', () => {
		const plain = 'aGVsbG8=';
		expect(blake3HexDataUri(`data:text/plain;base64,${plain}`)).toBe(blake3HexString('hello'));
		expect(blake3HexDataUri('data:text/plain,hello')).toBe(blake3HexString('hello'));
	});

	it('file hashing matches buffer hashing', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'file-index-test-'));
		const file = join(dir, 'a.txt');
		writeFileSync(file, 'hello file');
		const hex = await blake3HexFile(file);
		expect(hex).toBe(blake3Hex(Buffer.from('hello file')));
		rmSync(dir, { recursive: true, force: true });
	});
});

describe('time ticks', () => {
	it('nowTicks is epoch-based 100ns ticks', () => {
		const t = nowTicks();
		const ms = Number(t / 10_000n);
		expect(Date.now() - ms).toBeLessThan(1000);
	});

	it('ticksToDate round-trips', () => {
		const t = nowTicks();
		const d = ticksToDate(t);
		expect(Math.abs(d.getTime() - Date.now())).toBeLessThan(1000);
	});
});

describe('url utilities', () => {
	it('classifies protocols', () => {
		expect(classifyUrl('http://x/').protocol).toBe('http');
		expect(classifyUrl('https://x/').protocol).toBe('https');
		expect(classifyUrl('data:text/plain,hi').protocol).toBe('data');
		expect(classifyUrl('file:///D:/a b.jpg').protocol).toBe('file');
		expect(classifyUrl('gopher://x').protocol).toBe('other');
	});

	it('normalize file URLs avoids double-encoding', () => {
		expect(normalizeUrl('file:///D:/a%20b.jpg')).toBe('file:///D:/a b.jpg');
		expect(normalizeUrl('file:///D:/a b.jpg')).toBe('file:///D:/a b.jpg');
	});

	it('toFileUrl produces canonical form', () => {
		expect(toFileUrl('D:\\a b.jpg')).toBe('file:///D:/a b.jpg');
	});

	it('data/https urls pass through normalize', () => {
		expect(normalizeUrl('data:text/plain,hi')).toBe('data:text/plain,hi');
		expect(normalizeUrl('  https://example.com/x ')).toBe('https://example.com/x');
	});
});

describe('FileIndexRepo', () => {
	it('register inserts and re-reads with bigint fields intact', () => {
		const db = openTempDb();
		const repo = new FileIndexRepo(db);
		const now = nowTicks();
		const r = repo.register({
			url: 'file:///D:/x.bin',
			blake3: 'a'.repeat(64),
			type: 'application/octet-stream',
			size: 9007199254753337n,
			status: 3,
		});
		expect(r.size).toBe(9007199254753337n);
		expect(r.createdAt).toBeGreaterThan(now - 1000_000n); // within ~10ms
		expect(r.status).toBe(3);

		const found = repo.findByUrl('file:///D:/x.bin');
		expect(found?.size).toBe(9007199254753337n);
		db.close();
	});

	it('register upserts on duplicate url', () => {
		const db = openTempDb();
		const repo = new FileIndexRepo(db);
		repo.register({ url: 'https://a.com/x', blake3: 'b'.repeat(64), status: 1 });
		const r2 = repo.register({ url: 'https://a.com/x', blake3: 'c'.repeat(64), status: 3 });
		expect(r2.blake3).toBe('c'.repeat(64));
		expect(repo.stats().total).toBe(1);
		expect(repo.findByStatus([3]).length).toBe(1);
		db.close();
	});

	it('resolveBestUrl prefers higher status then protocol order', () => {
		const db = openTempDb();
		const repo = new FileIndexRepo(db);
		const hash = 'd'.repeat(64);
		// https (lower priority) but status 3
		repo.register({ url: 'https://cdn.com/a.jpg', blake3: hash, status: 3 });
		// data (highest priority) but status 2
		repo.register({ url: 'data:image/jpeg;base64,AAAA', blake3: hash, status: 2 });
		// file, status 1
		repo.register({ url: 'file:///D:/a.jpg', blake3: hash, status: 1 });

		const best = repo.resolveBestUrl(hash);
		expect(best?.url).toBe('https://cdn.com/a.jpg');

		// filter to file protocol only
		const fileBest = repo.resolveBestUrl(hash, 'file');
		expect(fileBest?.url).toBe('file:///D:/a.jpg');
		db.close();
	});

	it('prune removes invalid rows', () => {
		const db = openTempDb();
		const repo = new FileIndexRepo(db);
		repo.register({ url: 'https://dead.com/1', blake3: 'e'.repeat(64), status: 0 });
		repo.register({ url: 'https://alive.com/1', blake3: 'f'.repeat(64), status: 3 });
		const deleted = repo.prune({ onlyInvalid: true });
		expect(deleted).toBe(1);
		expect(repo.stats().total).toBe(1);
		db.close();
	});
});

describe('verify', () => {
	it('verifies a file link to status 3', async () => {
		const db = openTempDb();
		const repo = new FileIndexRepo(db);
		const dir = mkdtempSync(join(tmpdir(), 'file-index-test-'));
		const file = join(dir, 'pic.jpg');
		writeFileSync(file, 'jpeg-ish bytes');

		// register with hash offline, then verify
		const hash = await blake3HexFile(file);
		repo.register({ url: toFileUrl(file), blake3: hash, status: 1 });

		const res = await verifyLink(repo, toFileUrl(file));
		expect(res.status).toBe(3);
		expect(res.size).toBe(BigInt('jpeg-ish bytes'.length));
		expect(res.matched).toBe(true);
		db.close();
	});

	it('marks mismatched hash as invalid', async () => {
		const db = openTempDb();
		const repo = new FileIndexRepo(db);
		const dir = mkdtempSync(join(tmpdir(), 'file-index-test-'));
		const file = join(dir, 'pic.jpg');
		writeFileSync(file, 'original');

		repo.register({ url: toFileUrl(file), blake3: '0'.repeat(64), status: 1 });

		const res = await verifyLink(repo, toFileUrl(file));
		expect(res.status).toBe(0);
		expect(res.matched).toBe(false);
		db.close();
	});

	it('marks missing file as invalid', async () => {
		const db = openTempDb();
		const repo = new FileIndexRepo(db);
		const res = await verifyLink(repo, 'file:///D:/does-not-exist-12345.jpg');
		expect(res.status).toBe(0);
		db.close();
	});

	it('data uri verifies to status 3', async () => {
		const db = openTempDb();
		const repo = new FileIndexRepo(db);
		const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
		const hash = blake3HexDataUri(dataUrl);
		repo.register({ url: dataUrl, blake3: hash, status: 1 });

		const res = await verifyLink(repo, dataUrl);
		expect(res.status).toBe(3);
		expect(res.matched).toBe(true);
		db.close();
	});
});