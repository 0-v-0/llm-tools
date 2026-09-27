import { createReadStream, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { fileUrlToPath } from 'img-cleanup/api';
import { HttpError } from './errors.ts';

export const MIN_THUMB_WIDTH = 64;
export const MAX_THUMB_WIDTH = 2048;

const MIME_BY_EXT: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.svg': 'image/svg+xml',
};

/**
 * 生成本地图片的 webp 缩略图。
 * url 必须是已登记在当前会话图片集合中的 file URL（调用方校验），
 * 防止任意文件读取。
 */
export async function makeThumbnail(url: string, width: number): Promise<Buffer> {
	const localPath = fileUrlToPath(url); // 非 file:// 抛错
	if (!existsSync(localPath)) {
		throw new HttpError(404, `文件不存在（可能已被移动）: ${localPath}`);
	}
	const w = Math.min(Math.max(Math.trunc(width) || 512, MIN_THUMB_WIDTH), MAX_THUMB_WIDTH);
	return sharp(localPath)
		.rotate()
		.resize({ width: w, withoutEnlargement: true })
		.webp({ quality: 80 })
		.toBuffer();
}

/** 以流方式返回原图（raw=1 查看）。url 必须在会话白名单内（调用方校验）。 */
export function openOriginal(url: string): ReadableStream<Uint8Array> {
	const localPath = fileUrlToPath(url); // 非 file:// 抛错
	if (!existsSync(localPath)) {
		throw new HttpError(404, `文件不存在（可能已被移动）: ${localPath}`);
	}
	return Readable.toWeb(createReadStream(localPath)) as ReadableStream<Uint8Array>;
}

export function mimeOf(url: string): string {
	const ext = extname(fileUrlToPath(url)).toLowerCase();
	return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
