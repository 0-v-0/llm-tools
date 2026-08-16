import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getHomeDir(): string {
	return join(homedir(), '.img-data');
}

export function getDbPath(baseDir?: string): string {
	const dir = baseDir ?? getHomeDir();
	return join(dir, 'imgsearch.db');
}

export function getConfigPath(baseDir?: string): string {
	const dir = baseDir ?? getHomeDir();
	return join(dir, 'imgsearch.toml');
}

export function bootstrap(baseDir?: string): void {
	const dbDir = baseDir ?? getHomeDir();
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}
}
