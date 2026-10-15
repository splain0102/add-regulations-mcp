-- Approved D1 schema; immutable documents and atomic catalog publication.
PRAGMA foreign_keys = ON;

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY, build_sha TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','validated','published','failed')),
  expected_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE regulations (
  regulation_id TEXT PRIMARY KEY, alio_rule_no TEXT NOT NULL UNIQUE,
  detail_url TEXT NOT NULL
);
CREATE TABLE sync_failures (
  run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  regulation_id TEXT NOT NULL,
  stage TEXT NOT NULL, error_code TEXT NOT NULL,
  observed_metadata_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  PRIMARY KEY(run_id,regulation_id,stage)
);
CREATE TABLE documents (
  document_id TEXT PRIMARY KEY,
  regulation_id TEXT NOT NULL REFERENCES regulations(regulation_id),
  title TEXT NOT NULL, title_normalized TEXT NOT NULL,
  st_date TEXT, i_date TEXT, file_no TEXT NOT NULL,
  filename TEXT NOT NULL,
  extension TEXT NOT NULL CHECK(extension IN ('hwp','hwpx','pdf')),
  sha256 TEXT NOT NULL, metadata_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL, index_schema_version INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL, snapshot_r2_key TEXT NOT NULL,
  indexed_at TEXT, expected_sections INTEGER, expected_rows INTEGER,
  selection_evidence_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  UNIQUE(regulation_id,file_no,sha256,metadata_sha256,parser_version,index_schema_version)
);
CREATE INDEX documents_title ON documents(title_normalized);
CREATE TABLE catalog_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at TEXT NOT NULL, validated_at TEXT
);
CREATE TABLE catalog_entries (
  snapshot_id TEXT NOT NULL REFERENCES catalog_snapshots(snapshot_id),
  regulation_id TEXT NOT NULL REFERENCES regulations(regulation_id),
  document_id TEXT NOT NULL REFERENCES documents(document_id),
  is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
  verified_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,regulation_id,document_id)
);
CREATE UNIQUE INDEX one_current_document ON catalog_entries(snapshot_id,regulation_id)
  WHERE is_current=1;
CREATE INDEX catalog_document ON catalog_entries(snapshot_id,document_id,is_current);
CREATE TABLE service_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  active_snapshot_id TEXT REFERENCES catalog_snapshots(snapshot_id),
  previous_snapshot_id TEXT REFERENCES catalog_snapshots(snapshot_id),
  last_full_sha_check_at TEXT,
  last_success_at TEXT
);
INSERT INTO service_state(singleton) VALUES(1);

CREATE TABLE sections (
  section_id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(document_id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('article','annex','form','preamble','supplement')),
  section_label TEXT NOT NULL,
  article_number TEXT, part_number INTEGER NOT NULL DEFAULT 0,
  text_original TEXT NOT NULL, text_normalized TEXT NOT NULL,
  grams TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(document_id,ordinal,part_number)
);
CREATE INDEX sections_document ON sections(document_id,ordinal,part_number);
CREATE INDEX sections_article ON sections(document_id,article_number);
CREATE VIRTUAL TABLE body_fts USING fts5(
  grams, content='sections', content_rowid='section_id', tokenize='unicode61'
);

CREATE TABLE table_definitions (
  table_pk INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(document_id),
  table_key TEXT NOT NULL,
  analysis_type TEXT NOT NULL CHECK(analysis_type IN ('general_table','delegation_table','text_box')),
  coordinate_space TEXT NOT NULL, header_evidence_json TEXT NOT NULL,
  UNIQUE(document_id,table_key)
);
CREATE TABLE table_rows (
  row_id INTEGER PRIMARY KEY,
  table_pk INTEGER NOT NULL REFERENCES table_definitions(table_pk),
  record_number INTEGER NOT NULL,
  source_row_number INTEGER NOT NULL, page_number INTEGER,
  text_original TEXT NOT NULL, text_normalized TEXT NOT NULL,
  match_json TEXT NOT NULL DEFAULT '{}',
  grams TEXT NOT NULL,
  task TEXT, condition_text TEXT, amount_evidence_json TEXT,
  approval_evidence_json TEXT NOT NULL DEFAULT '[]',
  raw_cells_json TEXT NOT NULL,
  footnotes_json TEXT NOT NULL DEFAULT '[]',
  parser_result_json TEXT NOT NULL,
  needs_review INTEGER NOT NULL CHECK(needs_review IN (0,1)),
  UNIQUE(table_pk,record_number)
);
CREATE INDEX table_rows_table ON table_rows(table_pk,source_row_number,record_number);
CREATE VIRTUAL TABLE table_fts USING fts5(
  grams, content='table_rows', content_rowid='row_id', tokenize='unicode61'
);

-- External-content FTS is maintained in the same D1 transaction as each row.
CREATE TRIGGER sections_ai AFTER INSERT ON sections BEGIN
  INSERT INTO body_fts(rowid,grams) VALUES(new.section_id,new.grams);
END;
CREATE TRIGGER sections_ad AFTER DELETE ON sections BEGIN
  INSERT INTO body_fts(body_fts,rowid,grams) VALUES('delete',old.section_id,old.grams);
END;
CREATE TRIGGER sections_au AFTER UPDATE ON sections BEGIN
  INSERT INTO body_fts(body_fts,rowid,grams) VALUES('delete',old.section_id,old.grams);
  INSERT INTO body_fts(rowid,grams) VALUES(new.section_id,new.grams);
END;
CREATE TRIGGER table_rows_ai AFTER INSERT ON table_rows BEGIN
  INSERT INTO table_fts(rowid,grams) VALUES(new.row_id,new.grams);
END;
CREATE TRIGGER table_rows_ad AFTER DELETE ON table_rows BEGIN
  INSERT INTO table_fts(table_fts,rowid,grams) VALUES('delete',old.row_id,old.grams);
END;
CREATE TRIGGER table_rows_au AFTER UPDATE ON table_rows BEGIN
  INSERT INTO table_fts(table_fts,rowid,grams) VALUES('delete',old.row_id,old.grams);
  INSERT INTO table_fts(rowid,grams) VALUES(new.row_id,new.grams);
END;

-- Producer only: bounded staging batches; verify counts/evidence/R2 hashes.
-- Publish active_snapshot_id + sync_runs.status in ONE D1 batch transaction,
-- guarded by validated_at and the previous pointer (optimistic concurrency).
-- Reader pins ONE snapshot_id per tool call; it never mixes snapshots.
-- GC is producer-only, child-before-parent, and protects active/previous snapshots.

CREATE TABLE publication_guard(value INTEGER NOT NULL CHECK(value=1));
