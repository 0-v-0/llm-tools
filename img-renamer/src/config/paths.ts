import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export function getHomeDir(): string {
	return join(homedir(), '.img-data');
}

export function getConfigPath(baseDir?: string): string {
	const dir = baseDir ?? getHomeDir();
	return join(dir, 'imgrenamer.toml');
}

/** 确保统一数据目录存在（与 img-val / img-search 等共用 ~/.img-data）。 */
export function bootstrap(baseDir?: string): void {
	const dir = baseDir ?? getHomeDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
