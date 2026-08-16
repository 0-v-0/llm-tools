import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default DB path: <IMGDATA_DIR>/file-index.db, falling back to ~/.img-data/file-index.db. */
export function getFileIndexDbPath(baseDir?: string): string {
	const dir = baseDir ?? join(homedir(), '.img-data');
	return join(dir, 'file-index.db');
}