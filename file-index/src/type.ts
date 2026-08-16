const EXT_MIME: Record<string, string> = {
	// Images
	avif: 'image/avif',
	bmp: 'image/bmp',
	gif: 'image/gif',
	heic: 'image/heic',
	heif: 'image/heif',
	ico: 'image/x-icon',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	jxl: 'image/jxl',
	png: 'image/png',
	svg: 'image/svg+xml',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	webp: 'image/webp',
	// Documents / text
	csv: 'text/csv',
	json: 'application/json',
	md: 'text/markdown',
	pdf: 'application/pdf',
	toml: 'application/toml',
	txt: 'text/plain',
	xml: 'application/xml',
	yaml: 'text/yaml',
	yml: 'text/yaml',
	// Video
	mp4: 'video/mp4',
	webm: 'video/webm',
};

/** Guess MIME type from a file extension (without leading dot). */
export function mimeFromExtension(ext: string): string {
	const lower = ext.toLowerCase();
	return EXT_MIME[lower] ?? '';
}

/** Extract the file extension from a URL pathname and return the guessed MIME type. */
export function mimeFromUrl(url: string): string {
	if (url.startsWith('data:')) return mimeFromDataUri(url);

	try {
		const u = new URL(url);
		const pathname = u.pathname;
		const dot = pathname.lastIndexOf('.');
		if (dot === -1) return '';
		return mimeFromExtension(pathname.slice(dot + 1));
	} catch {
		// Not a valid URL — treat as a local path
		const dot = url.lastIndexOf('.');
		if (dot === -1) return '';
		return mimeFromExtension(url.slice(dot + 1));
	}
}

/** Extract the MIME type from a data: URI (returns '' for the default `text/plain` case). */
export function mimeFromDataUri(url: string): string {
	if (!url.startsWith('data:')) return '';
	const rest = url.slice(5);
	const semi = rest.indexOf(';');
	const comma = rest.indexOf(',');
	if (comma === -1) return '';

	const end = semi !== -1 && semi < comma ? semi : comma;
	return rest.slice(0, end) || '';
}