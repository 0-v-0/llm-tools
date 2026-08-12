import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getHomeDir(): string {
	return join(homedir(), '.imgval');
}

export function getDbPath(envDbDir?: string): string {
	const dir = envDbDir ?? getHomeDir();
	return join(dir, 'imgval.db');
}

export function getStandardsDir(envStandardsDir?: string): string {
	return envStandardsDir ?? join(getHomeDir(), 'standards');
}

const BUILTIN_STANDARDS_DIR = join(import.meta.dirname, '..', 'standards', 'builtin');

/**
 * First-run bootstrap: creates ~/.imgval/ and ~/.imgval/standards/,
 * copies builtin standards into the standards dir if not already present.
 */
export function bootstrap(envDbDir?: string, envStandardsDir?: string): void {
	const homeDir = getHomeDir();
	if (!existsSync(homeDir)) {
		mkdirSync(homeDir, { recursive: true });
	}

	const standardsDir = getStandardsDir(envStandardsDir);
	if (!existsSync(standardsDir)) {
		mkdirSync(standardsDir, { recursive: true });
	}

	// Copy builtin standards if not already present
	if (existsSync(BUILTIN_STANDARDS_DIR)) {
		for (const file of readdirSync(BUILTIN_STANDARDS_DIR)) {
			if (!file.endsWith('.md')) continue;
			const dest = join(standardsDir, file);
			if (!existsSync(dest)) {
				copyFileSync(join(BUILTIN_STANDARDS_DIR, file), dest);
			}
		}
	}

	// Ensure db dir exists
	const dbDir = envDbDir ?? homeDir;
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}
}

export function getBuiltinStandardsDir(): string {
	return BUILTIN_STANDARDS_DIR;
}
