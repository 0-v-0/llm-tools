import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	countByStatus,
	countTotal,
	getByBlake3,
	getByHash,
	getById,
	insert,
	updateStatus,
} from "../../src/storage/repository.image.ts";
import { closeDb, getDb } from "../../src/storage/db.ts";

const origImgDataDir = process.env.IMGDATA_DIR;
let dir: string;

beforeAll(() => {
	// getDb() 单例在首次调用时从 IMGDATA_DIR 推导 DB 路径，必须在首次访问前设置
	dir = mkdtempSync(join(tmpdir(), "img-search-repository-"));
	process.env.IMGDATA_DIR = dir;
	// 触发建库与迁移（001_init.sql）
	getDb();
});

afterAll(() => {
	closeDb();
	rmSync(dir, { recursive: true, force: true });
	if (origImgDataDir === undefined) {
		delete process.env.IMGDATA_DIR;
	} else {
		process.env.IMGDATA_DIR = origImgDataDir;
	}
});

/** 每个测试使用唯一的 blake3/hash，共享同一 DB 实例互不干扰。 */
function uniquePair(prefix: string): { blake3: string; hash: string } {
	return {
		blake3: `${prefix}-blake3-${randomUUID()}`,
		hash: `${prefix}-hash-${randomUUID()}`,
	};
}

describe("image repository", () => {
	it("insert 返回正 rowid，并持久化 blake3/hash/status='processing'", () => {
		const { blake3, hash } = uniquePair("insert");
		const id = insert({ blake3, hash, status: "processing" });
		expect(Number.isInteger(id)).toBe(true);
		expect(id).toBeGreaterThan(0);

		const row = getById(id);
		expect(row).not.toBeNull();
		expect(row!.blake3).toBe(blake3);
		expect(row!.hash).toBe(hash);
		expect(row!.status).toBe("processing");
		// 未处理字段为空
		expect(row!.qdrantPointId).toBeNull();
		expect(row!.textDescription).toBeNull();
		expect(row!.descriptionModel).toBeNull();
		expect(row!.error).toBeNull();
		// 时间戳：imported_at 非空，processed_at 为空
		expect(row!.importedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		expect(row!.processedAt).toBeNull();
	});

	it("重复 hash 插入被忽略：返回 0 且不产生第二行", () => {
		const { blake3, hash } = uniquePair("dup");
		const id = insert({ blake3, hash, status: "pending" });
		expect(id).toBeGreaterThan(0);

		// 相同 hash、不同 blake3 的重复插入：changes !== 1 → 返回 0
		const dupId = insert({ blake3: `${blake3}-other`, hash, status: "pending" });
		expect(dupId).toBe(0);

		// 仍只有第一行
		expect(getByHash(hash)!.id).toBe(id);
		expect(getByBlake3(`${blake3}-other`)).toBeNull();
	});

	it("getByHash / getByBlake3 / getById 往返一致，缺失返回 null", () => {
		const { blake3, hash } = uniquePair("roundtrip");
		const id = insert({ blake3, hash, status: "indexed" });

		const byId = getById(id);
		expect(byId).not.toBeNull();
		expect(getByHash(hash)).toEqual(byId);
		expect(getByBlake3(blake3)).toEqual(byId);

		expect(getById(-1)).toBeNull();
		expect(getByHash(`missing-hash-${randomUUID()}`)).toBeNull();
		expect(getByBlake3(`missing-blake3-${randomUUID()}`)).toBeNull();
	});

	it("仅 EXIF 不同的两张图（同 hash 不同 blake3）通过 getByHash 解析到同一行", () => {
		const hash = `exif-hash-${randomUUID()}`;
		const firstId = insert({ blake3: `exif-blake3-a-${randomUUID()}`, hash, status: "processing" });
		expect(firstId).toBeGreaterThan(0);

		// 第二张图（不同 blake3，相同视觉 hash）：去重，仅存储首个 blake3
		const secondId = insert({ blake3: `exif-blake3-b-${randomUUID()}`, hash, status: "processing" });
		expect(secondId).toBe(0);

		const row = getByHash(hash);
		expect(row).not.toBeNull();
		expect(row!.id).toBe(firstId);
		expect(row!.blake3).toMatch(/^exif-blake3-a-/);
		expect(getByBlake3("exif-blake3-b")).toBeNull();
	});

	it("updateStatus 不带 extra：设置 status 与 processed_at", () => {
		const { blake3, hash } = uniquePair("status");
		const id = insert({ blake3, hash, status: "processing" });

		updateStatus(id, "indexed");

		const row = getById(id)!;
		expect(row.status).toBe("indexed");
		expect(row.processedAt).not.toBeNull();
		expect(row.processedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		// 未提供 extra 字段保持为空
		expect(row.qdrantPointId).toBeNull();
		expect(row.textDescription).toBeNull();
		expect(row.descriptionModel).toBeNull();
		expect(row.error).toBeNull();
	});

	it("updateStatus 带 extra：qdrantPointId/textDescription/descriptionModel/error 全部持久化", () => {
		const { blake3, hash } = uniquePair("extra");
		const id = insert({ blake3, hash, status: "processing" });

		updateStatus(id, "failed", {
			qdrantPointId: "qdrant-point-1",
			textDescription: "a red apple on a wooden table",
			descriptionModel: "test-model",
			error: "embedding failed",
		});

		const row = getById(id)!;
		expect(row.status).toBe("failed");
		expect(row.processedAt).not.toBeNull();
		expect(row.qdrantPointId).toBe("qdrant-point-1");
		expect(row.textDescription).toBe("a red apple on a wooden table");
		expect(row.descriptionModel).toBe("test-model");
		expect(row.error).toBe("embedding failed");
	});

	it("countByStatus/countTotal 反映插入与状态迁移", () => {
		const before = { byStatus: countByStatus(), total: countTotal() };

		const pendingIds: number[] = [];
		for (let i = 0; i < 2; i++) {
			const { blake3, hash } = uniquePair("count-pending");
			pendingIds.push(insert({ blake3, hash, status: "pending" }));
		}
		const { blake3: failBlake3, hash: failHash } = uniquePair("count-failed");
		const failedId = insert({ blake3: failBlake3, hash: failHash, status: "failed" });
		expect(failedId).toBeGreaterThan(0);

		// 总数 +3
		expect(countTotal()).toBe(before.total + 3);

		// 按状态计数：pending +2、failed +1，其余不变
		const after = countByStatus();
		expect(after.pending).toBe(before.byStatus.pending + 2);
		expect(after.failed).toBe(before.byStatus.failed + 1);
		expect(after.processing).toBe(before.byStatus.processing);
		expect(after.embedded).toBe(before.byStatus.embedded);
		expect(after.indexed).toBe(before.byStatus.indexed);

		// updateStatus 迁移状态：failed -1，embedded +1，总数不变
		updateStatus(failedId, "embedded");
		const moved = countByStatus();
		expect(moved.failed).toBe(before.byStatus.failed);
		expect(moved.embedded).toBe(before.byStatus.embedded + 1);
		expect(countTotal()).toBe(before.total + 3);
	});
});
