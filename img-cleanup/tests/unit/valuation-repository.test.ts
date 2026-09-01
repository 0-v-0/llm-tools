import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '@llm-image/shared';
import { getAllImages, setDb, toFileUrl } from '../../src/api.ts';

const schema = `
	CREATE TABLE valuation (
		id               INTEGER PRIMARY KEY AUTOINCREMENT,
		image_hash       TEXT    NOT NULL,
		url              TEXT    NOT NULL,
		image_format     TEXT    NOT NULL,
		width            INTEGER NOT NULL,
		height           INTEGER NOT NULL,
		channels         INTEGER,
		size_bytes       INTEGER NOT NULL,
		undecodable_pixels INTEGER NOT NULL DEFAULT 0,
		min_value        REAL    NOT NULL,
		max_value        REAL    NOT NULL,
		standard_name    TEXT    NOT NULL,
		description      TEXT    NOT NULL DEFAULT ''
	);
`;

function insert(
	db: ReturnType<typeof openSqlite>,
	url: string,
	maxValue: number,
	standardName: string,
) {
	db.prepare(
		`INSERT INTO valuation (image_hash, url, image_format, width, height, size_bytes, min_value, max_value, standard_name)
		 VALUES (?, ?, 'png', 8, 8, 100, ?, ?, ?)`,
	).run(`hash-${url}`, url, Math.max(0, maxValue - 5), maxValue, standardName);
}

describe('getAllImages', () => {
	let cleanup: () => void;

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'icw-repo-'));
		const db = openSqlite(':memory:', join(dir, 'no-migrations'));
		db.exec(schema);
		// 同一 url 多条估值 → 取 max_value 最高的一条
		insert(db, 'file:///D:/a.png', 30, 'personal-images');
		insert(db, 'file:///D:/a.png', 80, 'personal-images');
		// 同一 url 跨标准取最高
		insert(db, 'file:///D:/b.png', 90, 'recovery-value');
		insert(db, 'file:///D:/b.png', 40, 'personal-images');
		// 文件名含字面 '%'（存储的规范形式是已解码 URL）
		insert(db, toFileUrl('D:\\GPU6_97%.png'), 50, 'personal-images');
		setDb(db);
		cleanup = () => setDb(null);
	});
	afterAll(() => cleanup());

	it('keeps the highest max_value row per url', () => {
		const all = getAllImages();
		const a = all.find((e) => e.url === 'file:///D:/a.png');
		expect(a?.maxValue).toBe(80);
		const b = all.find((e) => e.url === 'file:///D:/b.png');
		expect(b?.maxValue).toBe(90);
		expect(b?.standardName).toBe('recovery-value');
	});

	it('returns one entry per url (no join duplicates)', () => {
		const urls = getAllImages().map((e) => e.url);
		expect(new Set(urls).size).toBe(urls.length);
	});

	it('filters by standard before picking the best row', () => {
		const imgs = getAllImages(undefined, 'personal-images');
		expect(imgs.find((e) => e.url === 'file:///D:/b.png')?.maxValue).toBe(40);
	});

	it('matches path globs against urls containing a literal %', () => {
		const imgs = getAllImages(['D:/GPU6_**']);
		expect(imgs.map((e) => e.url)).toContain(toFileUrl('D:\\GPU6_97%.png'));
	});

	it('sorts by standard name then max value ascending', () => {
		const imgs = getAllImages();
		const keys = imgs.map((e) => `${e.standardName}:${e.maxValue}`);
		expect(keys).toEqual([...keys].sort());
	});
});
