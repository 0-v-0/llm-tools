import type { DB } from './db.js';
import { nowTicks } from './time.js';
import { normalizeUrl, classifyUrl, protocolPriority, type Protocol } from './url.js';
import { mimeFromUrl } from './type.js';

export type LinkStatus = 0 | 1 | 2 | 3;

export interface LinkRecord {
	id: number;
	url: string;
	blake3: string;
	type: string;
	size: bigint;
	status: LinkStatus;
	createdAt: bigint;
	updatedAt: bigint;
}

function rowToLink(row: Record<string, unknown>): LinkRecord {
	return {
		id: Number(row.id),
		url: row.url as string,
		blake3: row.blake3 as string,
		type: row.type as string,
		size: BigInt(row.size as string),
		status: Number(row.status) as LinkStatus,
		createdAt: BigInt(row.created_at as string),
		updatedAt: BigInt(row.updated_at as string),
	};
}

const SELECT_COLS = `id, url, blake3, type, CAST(size AS TEXT) AS size, status, CAST(created_at AS TEXT) AS created_at, CAST(updated_at AS TEXT) AS updated_at`;

export class FileIndexRepo {
	constructor(private db: DB) {}

	register(input: {
		url: string;
		blake3: string;
		type?: string;
		size?: bigint;
		status?: LinkStatus;
	}): LinkRecord {
		const url = normalizeUrl(input.url);
		const now = nowTicks();
		const type = input.type ?? mimeFromUrl(url);
		const size = input.size ?? -1n;
		const status = input.status ?? 1;

		const existing = this.findByUrl(url);
		if (existing) {
			const stmt = this.db.prepare(`
				UPDATE links
				SET blake3 = ?, type = ?, size = ?, status = ?, updated_at = ?
				WHERE url = ?
			`);
			stmt.run(input.blake3, type, size, status, now, url);
			return this.findByUrl(url)!;
		}

		const stmt = this.db.prepare(`
			INSERT INTO links (url, blake3, type, size, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(url, input.blake3, type, size, status, now, now);
		return this.findByUrl(url)!;
	}

	findByBlake3(blake3: string): LinkRecord[] {
		const stmt = this.db.prepare(`
			SELECT ${SELECT_COLS}
			FROM links
			WHERE blake3 = ?
			ORDER BY status DESC, updated_at DESC
		`);
		const rows = stmt.all(blake3) as Record<string, unknown>[];
		return rows.map(rowToLink);
	}

	findByUrl(url: string): LinkRecord | undefined {
		const normalized = normalizeUrl(url);
		const stmt = this.db.prepare(`
			SELECT ${SELECT_COLS}
			FROM links
			WHERE url = ?
		`);
		const row = stmt.get(normalized) as Record<string, unknown> | undefined;
		return row ? rowToLink(row) : undefined;
	}

	findByStatus(statuses: LinkStatus[]): LinkRecord[] {
		const placeholders = statuses.map(() => '?').join(',');
		const stmt = this.db.prepare(`
			SELECT ${SELECT_COLS}
			FROM links
			WHERE status IN (${placeholders})
			ORDER BY updated_at DESC
		`);
		const rows = stmt.all(...statuses) as Record<string, unknown>[];
		return rows.map(rowToLink);
	}

	findById(id: number): LinkRecord | undefined {
		const stmt = this.db.prepare(`
			SELECT ${SELECT_COLS}
			FROM links
			WHERE id = ?
		`);
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		return row ? rowToLink(row) : undefined;
	}

	updateStatus(url: string, status: LinkStatus, size?: bigint): LinkRecord | undefined {
		const normalized = normalizeUrl(url);
		const now = nowTicks();
		if (size !== undefined) {
			const stmt = this.db.prepare(`
				UPDATE links
				SET status = ?, size = ?, updated_at = ?
				WHERE url = ?
			`);
			stmt.run(status, size, now, normalized);
		} else {
			const stmt = this.db.prepare(`
				UPDATE links
				SET status = ?, updated_at = ?
				WHERE url = ?
			`);
			stmt.run(status, now, normalized);
		}
		return this.findByUrl(normalized);
	}

	touch(url: string): LinkRecord | undefined {
		const normalized = normalizeUrl(url);
		const now = nowTicks();
		const stmt = this.db.prepare(`
			UPDATE links
			SET updated_at = ?
			WHERE url = ?
		`);
		stmt.run(now, normalized);
		return this.findByUrl(normalized);
	}

	/**
	 * Resolve the best URL for a given blake3 hash.
	 * Sorts candidates by status (desc) → protocol priority → updated_at (desc).
	 * Optionally filter to a preferred protocol.
	 */
	resolveBestUrl(blake3: string, preferProtocol?: Protocol): LinkRecord | undefined {
		const candidates = this.findByBlake3(blake3);
		if (candidates.length === 0) return undefined;

		const filtered = preferProtocol
			? candidates.filter((c) => classifyUrl(c.url).protocol === preferProtocol)
			: candidates;

		if (filtered.length === 0) return candidates[0];

		filtered.sort((a, b) => {
			if (a.status !== b.status) return b.status - a.status;
			const pa = protocolPriority(classifyUrl(a.url).protocol);
			const pb = protocolPriority(classifyUrl(b.url).protocol);
			if (pa !== pb) return pa - pb;
			if (a.updatedAt > b.updatedAt) return -1;
			if (a.updatedAt < b.updatedAt) return 1;
			return 0;
		});

		return filtered[0];
	}

	/** Return count totals. */
	stats(): { total: number; byStatus: Record<number, number> } {
		const stmt = this.db.prepare(`
			SELECT status, COUNT(*) AS cnt
			FROM links
			GROUP BY status
		`);
		const rows = stmt.all() as { status: number; cnt: number }[];
		const byStatus: Record<number, number> = {};
		let total = 0;
		for (const r of rows) {
			byStatus[r.status] = r.cnt;
			total += r.cnt;
		}
		return { total, byStatus };
	}

	/** Delete rows matching criteria. */
	prune(opts?: { olderThanTicks?: bigint; onlyInvalid?: boolean }): number {
		const conditions: string[] = [];
		const params: (string | bigint | number)[] = [];

		if (opts?.onlyInvalid) {
			conditions.push('status = 0');
		}
		if (opts?.olderThanTicks) {
			conditions.push('updated_at < ?');
			params.push(opts.olderThanTicks);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
		const stmt = this.db.prepare(`DELETE FROM links ${where}`);
		const result = stmt.run(...params);
		return Number(result.changes);
	}
}