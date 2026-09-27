import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@llm-image/shared';
import type { LLMProvider } from '@llm-image/shared';
import type { FileIndexRepo } from '@llm-image/file-index';
import { setDb, setFileIndexRepo, toFileUrl } from 'img-cleanup/api';
import sharp from 'sharp';

export interface SeedImage {
	path: string;
	url: string;
	maxValue: number;
	standardName?: string;
}

export interface TestEnv {
	dir: string;
	dbPath: string;
	images: SeedImage[];
	cleanup: () => void;
}

/** 建临时目录 + 内存估值库 + 真实小图片文件。 */
export async function setupEnv(count = 4): Promise<TestEnv> {
	const dir = mkdtempSync(join(tmpdir(), 'icw-test-'));
	const imgDir = join(dir, 'imgs');
	mkdirSync(imgDir, { recursive: true });

	const images: SeedImage[] = [];
	for (let i = 0; i < count; i++) {
		const path = join(imgDir, `img-${i}.png`);
		await sharp({
			create: {
				width: 8,
				height: 8,
				channels: 3,
				background: { r: i * 60, g: 255 - i * 40, b: i * 30 },
			},
		})
			.png()
			.toFile(path);
		images.push({
			path,
			url: toFileUrl(path),
			maxValue: (i + 1) * 10,
		});
	}

	const db = openSqlite(':memory:', join(dir, 'no-migrations'));
	db.exec(`
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
	`);
	const stmt = db.prepare(
		`INSERT INTO valuation (image_hash, url, image_format, width, height, size_bytes, min_value, max_value, standard_name)
		 VALUES (?, ?, 'png', 8, 8, 100, ?, ?, ?)`,
	);
	for (const img of images) {
		stmt.run(`hash-${img.path}`, img.url, img.maxValue - 5, img.maxValue, 'default-photo');
	}
	setDb(db);

	const fakeRepo = {
		findByUrl: () => null,
		updateStatus: () => {},
		register: () => {},
	} as unknown as FileIndexRepo;
	setFileIndexRepo(fakeRepo);

	return {
		dir,
		dbPath: join(dir, 'imgval.db'),
		images,
		cleanup: () => {
			setFileIndexRepo(null);
		},
	};
}

/** 恒选标签 A（每批第一张）的假 LLM provider。 */
export const fakeProvider = {
	provider: 'fake',
	model: 'fake-model',
	complete: async () => ({
		text: JSON.stringify({ selected: 'A', reason: 'fake：保留第一张' }),
	}),
} as unknown as LLMProvider;

/** 同上，但记录 LLM 调用次数（重赛缓存复用断言用）。 */
export function createFakeProvider() {
	const calls: number[] = [];
	const provider = {
		provider: 'fake',
		model: 'fake-model',
		complete: async () => {
			calls.push(calls.length);
			return { text: JSON.stringify({ selected: 'A', reason: 'fake：保留第一张' }) };
		},
	} as unknown as LLMProvider;
	return { provider, calls };
}
