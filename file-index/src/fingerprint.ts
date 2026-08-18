import { createReadStream } from 'node:fs';
import { hash as blake3Hash, createHash as blake3CreateHash } from 'blake3';

const CHUNK_SIZE = 1_048_576; // 1 MiB

/** Create a streaming BLAKE3 hasher. */
export function createBlake3Hasher(): ReturnType<typeof blake3CreateHash> {
	return blake3CreateHash();
}

/** Hash a buffer and return the 64-char hex string. */
export function blake3Hex(buf: Uint8Array): string {
	return blake3Hash(buf).toString('hex');
}

/** Hash a string (UTF-8) and return the 64-char hex string. */
export function blake3HexString(str: string): string {
	return blake3Hash(Buffer.from(str, 'utf-8')).toString('hex');
}

/** Decode a data: URI and hash the raw bytes. */
export function blake3HexDataUri(dataUrl: string): string {
	const comma = dataUrl.indexOf(',');
	if (comma < 0) throw new Error('Invalid data URI');
	const raw = dataUrl.slice(comma + 1);
	const meta = dataUrl.slice(5, comma);
	const isBase64 = meta.endsWith(';base64');

	if (isBase64) {
		return blake3Hex(Buffer.from(raw, 'base64'));
	}
	return blake3Hex(Buffer.from(decodeURIComponent(raw), 'utf-8'));
}

/** Hash a local file by streaming its contents. */
export function blake3HexFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hasher = createBlake3Hasher();
		const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
		stream.on('data', (chunk) => hasher.update(chunk as Buffer));
		stream.on('end', () => resolve(hasher.digest().toString('hex')));
		stream.on('error', reject);
	});
}