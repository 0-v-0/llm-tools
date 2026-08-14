import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { ImageFormat, Corruption } from './types.js';
import { ImageError } from '../util/errors.js';
import { hashBuffer } from './hash.js';

type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;

export interface ProcessedImage {
	url: string;
	hash: string;
	base64: string;
	format: ImageFormat;
	width: number;
	height: number;
	channels: number | null;
	sizeBytes: number;
	corruption: Corruption;
	notes: string[];
}

const FORMAT_MAP: Record<string, ImageFormat> = {
	jpeg: 'jpeg',
	jpg: 'jpeg',
	png: 'png',
	webp: 'webp',
};

function toImageFormat(format: string | undefined): ImageFormat {
	if (!format) return 'jpeg';
	const normalized = format.toLowerCase();
	return FORMAT_MAP[normalized] ?? 'jpeg';
}

/**
 * Process an image file: decode, extract metadata, resize for LLM, encode as base64.
 * For corrupted images, attempts partial decode with `failOnError: false`.
 * Completely unreadable images throw ImageError.
 */
export async function processImage(url: string, maxDimension = 1568): Promise<ProcessedImage> {
	const filePath = fileURLToPath(url);

	let sizeBytes: number;
	try {
		sizeBytes = (await stat(filePath)).size;
	} catch (e) {
		throw new ImageError(`无法访问文件: ${url}`, e);
	}

	// Read raw bytes for initial probe
	let rawBytes: Buffer;
	try {
		rawBytes = await readFile(filePath);
	} catch (e) {
		throw new ImageError(`无法读取文件: ${url}`, e);
	}

	const notes: string[] = [];
	let corruption: Corruption = 'ok';

	// Try to get metadata first (strict mode — will fail on corrupted images)
	let metadata: SharpMetadata | null = null;
	try {
		metadata = await sharp(rawBytes).metadata();
	} catch {
		// Metadata failed — try partial decode
		metadata = null;
	}

	// If strict metadata failed, try with failOnError: false
	if (!metadata) {
		try {
			const partialMeta = await sharp(rawBytes, { failOn: 'none' }).metadata();
			if (partialMeta) {
				metadata = partialMeta;
				corruption = 'partial';
				notes.push('image corrupted, partially decodable region shown');
			}
		} catch {
			// completely unreadable
		}
	}

	if (!metadata) {
		throw new ImageError(`图片完全不可读，无法解码: ${url}`);
	}

	const format = toImageFormat(metadata.format);
	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;
	const channels = metadata.channels ?? null;

	if (width === 0 || height === 0) {
		throw new ImageError(`图片尺寸无效 (${width}x${height}): ${url}`);
	}

	// Resize if exceeds max dimension, convert to JPEG for consistent LLM input
	let processedBuffer: Buffer;
	try {
		const pipeline = sharp(rawBytes, { failOn: 'none' })
			.rotate() // auto-orient based on EXIF
			.resize({
				width: maxDimension,
				height: maxDimension,
				fit: 'inside',
				withoutEnlargement: true,
			})
			.jpeg({ quality: 85 });

		processedBuffer = await pipeline.toBuffer();
	} catch (e) {
		throw new ImageError(`图片处理/转换失败: ${url}`, e);
	}

	const hash = hashBuffer(processedBuffer);
	const base64 = `data:image/jpeg;base64,${processedBuffer.toString('base64')}`;

	return {
		url,
		hash,
		base64,
		format,
		width,
		height,
		channels,
		sizeBytes,
		corruption,
		notes,
	};
}
