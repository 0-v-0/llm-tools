CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE CHECK (length(url) <= 8000),
  blake3      TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT -1,
  status      INTEGER NOT NULL DEFAULT 1 CHECK (status IN (0, 1, 2, 3)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_blake3 ON links (blake3);
CREATE INDEX IF NOT EXISTS idx_links_status ON links (status);