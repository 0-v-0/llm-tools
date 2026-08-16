import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getHomeDir(): string {
	return join(homedir(), '.imgval');
}

export function getDbPath(envDbDir?: string): string {
	const dir = envDbDir ?? getHomeDir();
	return join(dir, 'imgval.db');
}

export function getConfigPath(envDbDir?: string): string {
	const dir = envDbDir ?? getHomeDir();
	return join(dir, 'config.toml');
}

export function getStandardsDir(configuredDir?: string): string {
	return configuredDir ?? join(getHomeDir(), 'standards');
}

const BUILTIN_STANDARDS_DIR = join(import.meta.dirname, '..', 'standards', 'builtin');

/**
 * First-run bootstrap: creates ~/.imgval/ and ensure DB dir exists.
 * 内置标准不复制到用户目录，由 loader 直接从 builtin 目录解析。
 */
export function bootstrap(envDbDir?: string): void {
	const homeDir = getHomeDir();
	if (!existsSync(homeDir)) {
		mkdirSync(homeDir, { recursive: true });
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
