-- 文件元信息（source_path）改由 @llm-image/file-index 管理。
-- image_import 仅保留索引状态，以两个指纹为键：
--   - blake3 (NOT NULL, 非UNIQUE)：原始文件 BLAKE3，作为 file-index 的关联键。
--     两张仅 EXIF 不同的图片 blake3 不同，但可共用同一行 image_import（视觉内容相同）。
--   - hash   (NOT NULL, UNIQUE)：处理后图片 SHA-256（sharp 缩放 + JPEG 重编码、EXIF 剥离后），
--     视觉内容去重键。仅 EXIF 不同的图片 hash 相同 → INSERT OR IGNORE 跳过第二张，
--     避免对同一视觉内容重复索引（节省 LLM 描述 + embedding + Qdrant 写入）。
--
-- 历史行无法迁移（legacy source_path 已不可靠），DROP 后重新 import
-- （file-index dedup + Qdrant upsert 幂等，已索引视觉内容会被 hash UNIQUE 跳过）。

DROP TABLE image_import;

CREATE TABLE image_import (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blake3 TEXT NOT NULL,
  hash   TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','embedded','indexed','failed')),
  qdrant_point_id TEXT,
  text_description TEXT,
  description_model TEXT,
  error TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX idx_import_status ON image_import(status);
CREATE INDEX idx_import_blake3 ON image_import(blake3);
CREATE INDEX idx_import_hash   ON image_import(hash);
