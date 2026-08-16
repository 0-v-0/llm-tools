import { fileURLToPath, pathToFileURL } from 'node:url';

export type Protocol = 'data' | 'file' | 'https' | 'http' | 'other';

/** Priority order: lower index = higher priority. */
export const PROTOCOL_ORDER: Protocol[] = ['data', 'file', 'https', 'http'];

/** Extract the protocol scheme from a URL string. */
export function classifyUrl(url: string): { scheme: string; protocol: Protocol } {
	if (url.startsWith('data:')) return { scheme: 'data', protocol: 'data' };
	if (url.startsWith('file:')) return { scheme: 'file', protocol: 'file' };
	if (url.startsWith('https:')) return { scheme: 'https', protocol: 'https' };
	if (url.startsWith('http:')) return { scheme: 'http', protocol: 'http' };
	return { scheme: url.split(':')[0] ?? '', protocol: 'other' };
}

/** Higher priority → better. */
export function protocolPriority(protocol: Protocol): number {
	const idx = PROTOCOL_ORDER.indexOf(protocol);
	return idx === -1 ? 99 : idx;
}

/** Decode a (file) URL for storage/display, e.g. `file:///D:/a%20b.jpg` → `file:///D:/a b.jpg`. */
export function decodeUrl(url: string): string {
	try {
		return decodeURIComponent(url);
	} catch {
		return url;
	}
}

/** Build the decoded file URL for a local path (canonical stored form). */
export function toFileUrl(filePath: string): string {
	return decodeUrl(pathToFileURL(filePath).href);
}

/** Re-encode a (possibly decoded) file URL for use with fileURLToPath / fs operations. */
export function encodeFileUrl(url: string): string {
	try {
		return pathToFileURL(fileURLToPath(url)).href;
	} catch {
		return url;
	}
}

/** Convert a (possibly decoded) file URL back to a local path. */
export function fileUrlToPath(url: string): string {
	return fileURLToPath(encodeFileUrl(url));
}

/** Normalize a URL to its canonical form for storage. */
export function normalizeUrl(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith('file:')) return decodeUrl(trimmed);
	if (trimmed.startsWith('data:') || trimmed.startsWith('http:') || trimmed.startsWith('https:')) return trimmed;
	return toFileUrl(trimmed);
}