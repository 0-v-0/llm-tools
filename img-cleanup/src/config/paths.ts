import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Unified data directory (shared with img-val, img-search). */
export function getHomeDir(): string {
	return join(homedir(), '.img-data');
}

/** Path to imgval.db (created by img-val). */
export function getDbPath(baseDir?: string): string {
	const dir = baseDir ?? getHomeDir();
	return join(dir, 'imgval.db');
}

/** Path to imgcleanup.toml. */
export function getConfigPath(baseDir?: string): string {
	const dir = baseDir ?? getHomeDir();
	return join(dir, 'imgcleanup.toml');
}

/** Ensure the data dir exists. */
export function bootstrap(baseDir?: string): void {
	const homeDir = getHomeDir();
	if (!existsSync(homeDir)) {
		mkdirSync(homeDir, { recursive: true });
	}
	const dbDir = baseDir ?? homeDir;
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}
}
