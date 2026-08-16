import {
	openFileIndexDb,
	FileIndexRepo,
	getFileIndexDbPath,
	blake3HexFile,
	fileUrlToPath,
	classifyUrl,
	mimeFromUrl,
} from '@llm-image/file-index';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

let repo: FileIndexRepo | null = null;

export function getFileIndexRepo(): FileIndexRepo {
	if (!repo) {
		repo = new FileIndexRepo(openFileIndexDb(getFileIndexDbPath(process.env.IMGDATA_DIR)));
	}
	return repo;
}

/** For testing: inject an in-memory repo. */
export function setFileIndexRepo(r: FileIndexRepo | null): void {
	repo = r;
}

/**
 * Register a local file's link in the file-index after a successful valuation.
 * Best-effort: failures are logged but not propagated.
 */
export async function registerLinkForFile(url: string, filePath: string): Promise<void> {
	try {
		if (classifyUrl(url).protocol !== 'file') return;
		const blake3 = await blake3HexFile(filePath);
		const { size } = await stat(filePath);
		getFileIndexRepo().register({ url, blake3, size: BigInt(size), status: 3 });
	} catch (e) {
		console.error(`[warn] file-index 注册失败: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * After a file is moved (rename):
 * - the old URL link is invalidated (status 0)
 * - the new URL is registered with a freshly computed hash (status 3)
 */
export async function updateLinksForMove(oldUrl: string, newUrl: string): Promise<void> {
try {
			const r = getFileIndexRepo();
			// The moved file now occupies newUrl; any old link at newUrl is outdated.
			if (r.findByUrl(newUrl)) {
				r.updateStatus(newUrl, 0);
			}
			r.updateStatus(oldUrl, 0);

			await registerLinkForFile(newUrl, fileUrlToPath(newUrl));
		} catch (e) {
		console.error(`[warn] file-index 移动更新失败: ${e instanceof Error ? e.message : String(e)}`);
	}
}