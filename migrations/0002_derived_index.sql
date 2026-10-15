-- D1 as a derived copy of the R2 catalog (docs/d1-derived-index.md).
-- R2 stays the source of truth and serves search; D1 is for listing,
-- statistics and external use. No FTS: every row here costs one write.

DROP TRIGGER IF EXISTS sections_ai;
DROP TRIGGER IF EXISTS sections_ad;
DROP TRIGGER IF EXISTS sections_au;
DROP TRIGGER IF EXISTS table_rows_ai;
DROP TRIGGER IF EXISTS table_rows_ad;
DROP TRIGGER IF EXISTS table_rows_au;
DROP TABLE IF EXISTS body_fts;
DROP TABLE IF EXISTS table_fts;
DROP TABLE IF EXISTS table_rows;
DROP TABLE IF EXISTS table_definitions;
DROP TABLE IF EXISTS sections;
DROP TABLE IF EXISTS catalog_entries;
DROP TABLE IF EXISTS catalog_snapshots;
DROP TABLE IF EXISTS service_state;
DROP TABLE IF EXISTS sync_failures;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS regulations;
DROP TABLE IF EXISTS sync_runs;
DROP TABLE IF EXISTS publication_guard;
DROP TABLE IF EXISTS sync_lease;
-- sync_usage (daily rows-written ledger used by the write budget) is kept.

-- One regulation = one ALIO entry (idx). generation points at the rows of
-- units/approvals that belong to the current version.
CREATE TABLE regulations (
  reg_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active','repealed')),
  missing_count INTEGER NOT NULL DEFAULT 0,
  current_file_no TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revised_at TEXT,
  updated_at TEXT,
  extension TEXT NOT NULL,
  alio_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  body_units INTEGER NOT NULL,
  table_units INTEGER NOT NULL,
  approval_rows INTEGER NOT NULL,
  first_seen TEXT,
  last_seen TEXT,
  repealed_at TEXT,
  generation TEXT NOT NULL,
  loaded_at TEXT NOT NULL
) WITHOUT ROWID;

-- Every attachment version that was ever current; rows are never deleted.
CREATE TABLE versions (
  reg_id TEXT NOT NULL,
  file_no TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revised_at TEXT,
  updated_at TEXT,
  filename TEXT,
  extension TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  first_loaded_at TEXT NOT NULL,
  PRIMARY KEY (reg_id, file_no)
) WITHOUT ROWID;

-- One article (body) or one whole table per row.
CREATE TABLE units (
  reg_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  unit_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('body','table')),
  label TEXT NOT NULL,
  article_no TEXT,
  table_id TEXT,
  text TEXT NOT NULL,
  rows_json TEXT,
  PRIMARY KEY (reg_id, generation, ordinal)
) WITHOUT ROWID;

-- One delegation-table row (위임전결) per row, for approval statistics.
CREATE TABLE approvals (
  reg_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  table_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  category TEXT,
  task TEXT,
  condition_text TEXT,
  approver TEXT,
  approvers_json TEXT NOT NULL DEFAULT '[]',
  multi_approver INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT,
  PRIMARY KEY (reg_id, generation, ordinal)
) WITHOUT ROWID;

CREATE TABLE sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  catalog_sha TEXT,
  parser_version TEXT,
  loaded_at TEXT,
  status TEXT,
  message TEXT,
  regulations INTEGER,
  units INTEGER,
  approvals INTEGER
);

-- Current rows only: what statistics and exports should read.
CREATE VIEW current_units AS
  SELECT u.* FROM units u JOIN regulations r ON r.reg_id = u.reg_id AND r.generation = u.generation;
CREATE VIEW current_approvals AS
  SELECT a.*, r.name AS regulation_name FROM approvals a JOIN regulations r ON r.reg_id = a.reg_id AND r.generation = a.generation;
