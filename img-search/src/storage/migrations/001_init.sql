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
