/** Base error for all file-index failures. */
export class FileIndexError extends Error {
	readonly code: string;

	constructor(message: string, options?: { code?: string; cause?: unknown }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'FileIndexError';
		this.code = options?.code ?? 'FILE_INDEX_ERROR';
	}
}

/** Invalid or unsupported URL. */
export class UrlError extends FileIndexError {
	constructor(message: string, cause?: unknown) {
		super(message, { code: 'INVALID_URL', cause });
		this.name = 'UrlError';
	}
}

/** SQLite storage failures. */
export class StorageError extends FileIndexError {
	constructor(message: string, cause?: unknown) {
		super(message, { code: 'STORAGE_ERROR', cause });
		this.name = 'StorageError';
	}
}

/** File/data hashing or verification failures. */
export class VerifyError extends FileIndexError {
	constructor(message: string, cause?: unknown) {
		super(message, { code: 'VERIFY_ERROR', cause });
		this.name = 'VerifyError';
	}
}