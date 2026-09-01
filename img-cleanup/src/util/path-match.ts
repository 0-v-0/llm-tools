/** Convert a glob pattern to a RegExp whose source is anchored (^...$). */
function globToRe(glob: string): RegExp {
	const re = '/' === glob ? '/' : glob.split('/').map(segmentToRe).join('/');
	return new RegExp(`^${re}$`);
}

function segmentToRe(segment: string): string {
	let out = '';
	for (let i = 0; i < segment.length; i++) {
		const c = segment[i]!;
		if (c === '*') {
			if (segment[i + 1] === '*') {
				out += '.*';
				i++;
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else {
			out += escapeRegExp(c);
		}
	}
	return out;
}

function escapeRegExp(c: string): string {
	return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Match a filesystem path against a glob pattern (supports `*`, `**`, `?`).
 * Both arguments are normalized to forward slashes before matching, so it
 * works identically on Windows (`D:\a\b.jpg`) and POSIX paths.
 */
export function matchesGlobPath(path: string, glob: string): boolean {
	const normPath = path.replace(/\\/g, '/');
	const normGlob = glob.replace(/\\/g, '/');
	return globToRe(normGlob).test(normPath);
}

/** True when path matches any of the globs; matches nothing when the list is non-empty but none match. */
export function matchesAnyGlob(path: string, globs: string[] | undefined): boolean {
	if (!globs || globs.length === 0) return true;
	return globs.some((g) => matchesGlobPath(path, g));
}
