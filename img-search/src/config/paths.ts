import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getHomeDir(): string {
	return join(homedir(), '.imgsearch');
}

export function getDbPath(envDbDir?: string): string {
	const dir = envDbDir ?? getHomeDir();
	return join(dir, 'imgsearch.db');
}

export function bootstrap(envDbDir?: string): void {
	const dbDir = envDbDir ?? getHomeDir();
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}
}
