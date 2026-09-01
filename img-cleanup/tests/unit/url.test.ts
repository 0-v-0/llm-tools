import { describe, expect, it } from 'vitest';
import { fileUrlToPath, toFileUrl } from '../../src/util/url.ts';

describe('toFileUrl / fileUrlToPath roundtrip', () => {
	it('roundtrips paths with a literal % (undecodable by decodeURIComponent)', () => {
		for (const name of ['97%.png', '46.6%风伤加成.png', 'a%b.png', '100% done.jpg']) {
			const url = toFileUrl(`D:\\pictures\\${name}`);
			expect(url).not.toContain('%25');
			expect(fileUrlToPath(url)).toBe(`D:\\pictures\\${name}`);
		}
	});

	it('roundtrips paths with spaces and CJK characters', () => {
		const url = toFileUrl('D:\\pictures\\我的 照片 分享\\a b.jpg');
		expect(fileUrlToPath(url)).toBe('D:\\pictures\\我的 照片 分享\\a b.jpg');
	});

	it('accepts already-encoded URLs', () => {
		expect(fileUrlToPath('file:///D:/a%20b.jpg')).toBe('D:\\a b.jpg');
	});

	it('throws for non-file URLs', () => {
		expect(() => fileUrlToPath('https://example.com/a.jpg')).toThrow();
	});
});
