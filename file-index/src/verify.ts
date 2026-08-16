import { existsSync } from 'node:fs';
import { blake3HexFile, blake3HexDataUri } from './fingerprint.js';
import { classifyUrl, fileUrlToPath, normalizeUrl } from './url.js';
import { mimeFromUrl } from './type.js';
import { FileIndexRepo, type LinkRecord, type LinkStatus } from './repository.links.js';
import { VerifyError } from './errors.js';

export interface VerifyResult {
	url: string;
	blake3: string;
	type: string;
	size: bigint;
	status: LinkStatus;
	matched: boolean;
}

/**
 * Verify a single link by reading its content (or probing remote).
 * Updates the database record in-place.
 */
export async function verifyLink(
	repo: FileIndexRepo,
	url: string,
): Promise<VerifyResult> {
	const normalized = normalizeUrl(url);
	const { protocol } = classifyUrl(normalized);

	const existing = repo.findByUrl(normalized);

	if (protocol === 'file') {
		return verifyFile(repo, normalized, existing);
	}
	if (protocol === 'data') {
		return verifyDataUri(repo, normalized, existing);
	}
	if (protocol === 'https' || protocol === 'http') {
		return verifyRemote(repo, normalized, existing);
	}
	// Unsupported protocol — mark as invalid
	repo.updateStatus(normalized, 0);
	return {
		url: normalized,
		blake3: existing?.blake3 ?? '',
		type: existing?.type ?? '',
		size: existing?.size ?? -1n,
		status: 0,
		matched: false,
	};
}

async function verifyFile(
	repo: FileIndexRepo,
	url: string,
	existing: LinkRecord | undefined,
): Promise<VerifyResult> {
	const filePath = fileUrlToPath(url);

	if (!existsSync(filePath)) {
		repo.updateStatus(url, 0);
		return {
			url,
			blake3: existing?.blake3 ?? '',
			type: existing?.type ?? '',
			size: existing?.size ?? -1n,
			status: 0,
			matched: false,
		};
	}

	try {
		const hash = await blake3HexFile(filePath);
		const { size } = await import('node:fs').then((fs) => fs.promises.stat(filePath));
		const type = mimeFromUrl(url);
		const matched = existing ? existing.blake3 === hash : true;
		const status: LinkStatus = matched ? 3 : 0;

		repo.register({ url, blake3: hash, type, size: BigInt(size), status });
		return { url, blake3: hash, type, size: BigInt(size), status, matched };
	} catch (e) {
		repo.updateStatus(url, 0);
		throw new VerifyError(`文件读取失败: ${filePath}`, e);
	}
}

async function verifyDataUri(
	repo: FileIndexRepo,
	url: string,
	existing: LinkRecord | undefined,
): Promise<VerifyResult> {
	try {
		const hash = blake3HexDataUri(url);
		const size = BigInt(url.length); // rough size of the URL itself
		const type = mimeFromUrl(url);
		const matched = existing ? existing.blake3 === hash : true;
		const status: LinkStatus = matched ? 3 : 0;

		repo.register({ url, blake3: hash, type, size, status });
		return { url, blake3: hash, type, size, status, matched };
	} catch (e) {
		repo.updateStatus(url, 0);
		throw new VerifyError(`data: URI 解析失败`, e);
	}
}

async function verifyRemote(
	repo: FileIndexRepo,
	url: string,
	existing: LinkRecord | undefined,
): Promise<VerifyResult> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);

		const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
		clearTimeout(timeout);

		if (!response.ok) {
			repo.updateStatus(url, 0);
			return {
				url,
				blake3: existing?.blake3 ?? '',
				type: existing?.type ?? '',
				size: existing?.size ?? -1n,
				status: 0,
				matched: false,
			};
		}

		const contentLength = response.headers.get('content-length');
		const remoteSize = contentLength ? BigInt(contentLength) : -1n;
		const type = existing?.type || mimeFromUrl(url) || (response.headers.get('content-type') ?? '');
		const sizeMatched =
			existing === undefined
				? true
				: existing.size === -1n || remoteSize === -1n || existing.size === remoteSize;

		const status: LinkStatus = sizeMatched ? 2 : 0;
		repo.register({ url, blake3: existing?.blake3 ?? '', type, size: remoteSize, status });
		return { url, blake3: existing?.blake3 ?? '', type, size: remoteSize, status, matched: sizeMatched };
	} catch (e) {
		repo.updateStatus(url, 0);
		throw new VerifyError(`远程请求失败: ${url}`, e);
	}
}

/**
 * Re-verify all links with status 1 (pending) or 2 (reachable but not hash-verified).
 * Resolves on each individually; errors are collected and returned.
 */
export async function verifyStale(repo: FileIndexRepo): Promise<VerifyResult[]> {
	const records = repo.findByStatus([1, 2]);
	const results: VerifyResult[] = [];
	const errors: Error[] = [];

	for (const record of records) {
		try {
			const result = await verifyLink(repo, record.url);
			results.push(result);
		} catch (e) {
			errors.push(e as Error);
		}
	}

	if (errors.length > 0) {
		throw new VerifyError(
			`${errors.length} of ${records.length} verifications failed`,
			errors.length === 1 ? errors[0] : undefined,
		);
	}

	return results;
}