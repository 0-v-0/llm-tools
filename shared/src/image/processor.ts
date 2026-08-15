import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { ImageFormat } from './types.js';
import { ImageError } from '../util/errors.js';
import { hashBuffer } from './hash.js';

type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
type SharpOptions = NonNullable<Parameters<typeof sharp>[1]>;

export interface ProcessedImage {
	url: string;
	hash: string;
	base64: string;
	format: ImageFormat;
	width: number;
	height: number;
	channels: number | null;
	sizeBytes: number;
	/**
	 * Number of pixels that could not be decoded (bottom rows filled with a
	 * constant padding color). 0 when the image decodes cleanly.
	 */
	undecodablePixels: number;
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

interface RawPixels {
	data: Buffer;
	width: number;
	height: number;
}

async function decodeRawPixels(
	bytes: Buffer,
	options: SharpOptions,
): Promise<RawPixels | null> {
	try {
		const { data, info } = await sharp(bytes, options)
			.rotate()
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		return { data, width: info.width, height: info.height };
	} catch {
		return null;
	}
}

/**
 * Counts rows at the bottom of the image that are filled with a single
 * constant color (the padding decoders add for truncated data).
 */
function countBottomFilledRows(data: Buffer, width: number, height: number): number {
	const channels = 4;
	let filled = 0;
	for (let y = height - 1; y >= 0; y--) {
		const rowStart = y * width * channels;
		const r = data[rowStart];
		const g = data[rowStart + 1];
		const b = data[rowStart + 2];
		const a = data[rowStart + 3];
		let uniform = true;
		for (let x = 1; x < width; x++) {
			const i = rowStart + x * channels;
			if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a) {
				uniform = false;
				break;
			}
		}
		if (!uniform) break;
		filled++;
	}
	return filled;
}

/**
 * Detect truncated/corrupted images: strict raw decode fails → re-decode with
 * `failOn: 'none'` and count undecodable (constant-color padding) pixels
 * near the bottom. Pixels on the padding rows are counted as undecodable.
 */
async function detectUndecodablePixels(rawBytes: Buffer): Promise<number> {
	const strict = await decodeRawPixels(rawBytes, {});
	if (strict) return 0;

	const lax = await decodeRawPixels(rawBytes, { failOn: 'none' });
	if (!lax) throw new ImageError('图片完全不可读，无法解码');
	const filledRows = countBottomFilledRows(lax.data, lax.width, lax.height);
	return filledRows * lax.width;
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
			if (partialMeta) metadata = partialMeta;
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

	// Detect truncated/corrupted data by attempting a strict raw decode.
	let undecodablePixels: number;
	try {
		undecodablePixels = await detectUndecodablePixels(rawBytes);
	} catch (e) {
		throw new ImageError(`图片完全不可读，无法解码: ${url}`, e);
	}
	if (undecodablePixels > 0) {
		notes.push(`image corrupted, ${undecodablePixels} undecodable pixels near bottom`);
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
		undecodablePixels,
		notes,
	};
}
