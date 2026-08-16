import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getHomeDir(): string {
	return join(homedir(), '.img-data');
}

export function getDbPath(baseDir?: string): string {
	const dir = baseDir ?? getHomeDir();
	return join(dir, 'imgval.db');
}

export function getConfigPath(baseDir?: string): string {
	const dir = baseDir ?? getHomeDir();
	return join(dir, 'imgval.toml');
}

export function getStandardsDir(configuredDir?: string): string {
	return configuredDir ?? join(getHomeDir(), 'standards');
}

const BUILTIN_STANDARDS_DIR = join(import.meta.dirname, '..', 'standards', 'builtin');

/**
 * First-run bootstrap: creates ~/.img-data/ and ensure DB dir exists.
 * 内置标准不复制到用户目录，由 loader 直接从 builtin 目录解析。
 */
export function bootstrap(baseDir?: string): void {
	const homeDir = getHomeDir();
	if (!existsSync(homeDir)) {
		mkdirSync(homeDir, { recursive: true });
	}

	// Ensure db dir exists
	const dbDir = baseDir ?? homeDir;
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}
}

export function getBuiltinStandardsDir(): string {
	return BUILTIN_STANDARDS_DIR;
}
