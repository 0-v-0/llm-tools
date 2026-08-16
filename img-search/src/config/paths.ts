import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认数据目录 ~/.img-data（未设置 IMGDATA_DIR 时使用）。 */
export function getDefaultDataDir(): string {
	return join(homedir(), '.img-data');
}

/** 解析数据目录：未显式指定时回退到默认目录 ~/.img-data。 */
function resolveDataDir(baseDir?: string): string {
	return baseDir ?? getDefaultDataDir();
}

export function getDbPath(baseDir?: string): string {
	return join(resolveDataDir(baseDir), 'imgsearch.db');
}

export function getConfigPath(baseDir?: string): string {
	return join(resolveDataDir(baseDir), 'imgsearch.toml');
}

/** 确保数据目录存在。 */
export function bootstrap(baseDir?: string): void {
	const dbDir = resolveDataDir(baseDir);
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}
}
