CREATE TABLE image_import (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','embedded','indexed','failed')),
  qdrant_point_id TEXT,
  text_description TEXT,
  description_model TEXT,
  error TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX idx_import_status ON image_import(status);
CREATE INDEX idx_import_hash ON image_import(hash);
