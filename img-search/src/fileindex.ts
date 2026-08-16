import { openFileIndexDb, FileIndexRepo, getFileIndexDbPath } from '@llm-image/file-index';

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