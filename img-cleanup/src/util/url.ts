import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Convert a (possibly decoded) file URL back to a local path.
 *
 * The canonical stored form is percent-DECODED (see toFileUrl), so it can
 * contain a literal '%' (e.g. '97%.png') that breaks decodeURIComponent.
 * Re-escape bare '%' not followed by two hex digits before parsing; valid
 * escapes (%20 etc.) decode normally.
 */
export function fileUrlToPath(url: string): string {
	const normalized = url.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
	return fileURLToPath(normalized);
}
