CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS valuation (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  image_hash       TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  image_format     TEXT    NOT NULL,
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  channels         INTEGER,
  size_bytes       INTEGER NOT NULL,
  undecodable_pixels INTEGER NOT NULL DEFAULT 0,
  min_value        REAL    NOT NULL,
  max_value        REAL    NOT NULL,
  currency         TEXT    NOT NULL DEFAULT 'CNY',
  standard_name    TEXT    NOT NULL,
  standard_version TEXT,
  llm_model        TEXT    NOT NULL,
  description      TEXT    NOT NULL,
  notes            TEXT    NOT NULL DEFAULT '[]',
  tool_used        INTEGER NOT NULL DEFAULT 0,
  tool_fallback    INTEGER NOT NULL DEFAULT 0,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  valued_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  raw_llm_text     TEXT
);

CREATE INDEX IF NOT EXISTS idx_valuation_hash      ON valuation(image_hash);
CREATE INDEX IF NOT EXISTS idx_valuation_min       ON valuation(min_value);
CREATE INDEX IF NOT EXISTS idx_valuation_max       ON valuation(max_value);
CREATE INDEX IF NOT EXISTS idx_valuation_standard  ON valuation(standard_name);
CREATE INDEX IF NOT EXISTS idx_valuation_format    ON valuation(image_format);
CREATE INDEX IF NOT EXISTS idx_valuation_valued_at ON valuation(valued_at);

CREATE VIRTUAL TABLE IF NOT EXISTS valuation_fts USING fts5(
  description,
  content='valuation',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS valuation_ai AFTER INSERT ON valuation BEGIN
  INSERT INTO valuation_fts(rowid, description) VALUES (new.id, new.description);
END;

CREATE TRIGGER IF NOT EXISTS valuation_ad AFTER DELETE ON valuation BEGIN
  INSERT INTO valuation_fts(valuation_fts, rowid, description) VALUES('delete', old.id, old.description);
END;

CREATE TRIGGER IF NOT EXISTS valuation_au AFTER UPDATE ON valuation BEGIN
  INSERT INTO valuation_fts(valuation_fts, rowid, description) VALUES('delete', old.id, old.description);
  INSERT INTO valuation_fts(rowid, description) VALUES (new.id, new.description);
END;
