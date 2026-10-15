# R2-first serving (2.0.1)

D1 automatic collection is deferred. The R2 producer runs in Node on GitHub Actions; the serving Worker imports no ALIO client, HWP/HWPX parser or PDF extractor. It uses the existing OAuth and SQLite-backed Durable Object binding. That object only reads precomputed JSON and bounds concurrent searches; it does not store regulation rows in SQLite or D1.

## Storage and publication

- `raw/<fileNo>/<sha256>/<filename>`: original ALIO files.
- `parsed/<documentId>.json`: reusable parser output, including original table evidence.
- `r2-index/objects/<sha256>.json`: immutable bounded search/evidence chunks, body shards and catalog.
- `r2-index/active.json`: one conditional-write pointer to the validated catalog and its predecessor.
- `r2-index/checkpoint.json`: reusable completed documents and per-file raw verification times.
- `r2-index/status.json`: current collection status, pending titles, counts and errors.

Existing R2 originals/parsed snapshots are imported only after raw SHA verification. No D1 authentication or D1 query is used by `sync:r2`. An active catalog is published only after the complete current ALIO list has been collected twice consistently, current shared attachment selection agrees with the stored fileNo, every immutable artifact has been read back and its SHA verified, and representative metadata/table/global acceptance checks pass. The final pointer uses If-Match (or If-None-Match on first creation); a competing publisher cannot overwrite a newer catalog.

## New regulations and revisions

An hourly complete-list comparison detects added/removed regulations and changed stDate/idate. New or changed files use the existing attachment collector, selector and parsers. Unchanged files can reuse their parsed snapshot after metadata/fileNo confirmation. A seven-day per-file raw verification detects silent replacement when list dates do not change. A fully unchanged list with fresh raw proofs finishes without reading all backups or parsing/downloading documents.

New records and evidence are written separately. Failed ALIO requests, unsupported documents, checksum/validation failures, R2 capacity exhaustion or a conditional-write conflict leave the previous active catalog intact. Pending titles and stale/failed status are exposed; an unindexed new title returns index_preparing rather than a false normal not_found. A 20-minute collection budget stops starting new documents, saves progress and resumes at the next hourly/manual run. Partial initial catalogs are never published. Publication time is separate from latest list-verification time; an unchanged-list check is not presented as a fresh raw download.

The archive remains private and is accessed through a Worker binding. No public R2 access or new runtime API token is required. The producer uses the existing R2 GitHub Secrets. A 1 GB archive budget prevents uncontrolled growth; originals are not automatically deleted. Retention/garbage collection remains a separate operational task and capacity failures preserve the active search index.

## Serving and compatibility

All nine MCP names and existing input parameters remain. Named body/table queries read precomputed summaries and only selected evidence chunks. Default pages contain five matches. Table formatting and its response-size limit are reused; next_offset advances by the actual returned row count. Original cells/spans, header evidence, approval symbols and notes are stored unchanged. Full corpus body ranking reuses the existing N5/N6 rules; explicit table/all scope additionally searches stored table summaries. Historical PDF attachments are excluded by default; include_history reports explicit unavailability rather than using them as current evidence.

A request pins one active catalog; old immutable data is retained for concurrent requests and rollback. A bounded LRU caches immutable chunks, but active/status pointers are read afresh. Document parsing and external ALIO fetches are forbidden in serving tests. CPU-intensive JSON matching runs in the existing Durable Object rather than in the 10ms Worker frontend. No assumption of production CPU compliance is made from local elapsed-time tests.

## Deployment sequence

1. Build/test preparation on feat/r2-first-serving with main production untouched. D1 will have manual experimental opt-in only after promotion.
2. The named preparation branch may bootstrap the first unused R2 catalog using existing Variables/Secrets. After promotion, main runs R2 hourly regulation sync at minute 37 of each hour (approximate).
3. Confirm R2_SYNC_PUBLISHED, current regulation count, shared selected fileNo, representative searches and read-back SHA validation.
4. Run all CI/local OAuth R2/DO regressions and the read-only actual-R2 corpus acceptance job. Merge the complete production PR containing preparation and wrangler.r2.jsonc promotion together. main automatically deploys 2.0.1 once. Inspect actual Cloudflare limits separately.
5. Verify actual production MCP and Worker/DO logs. On failure restore the previous production config; old OAuth KV and corpus are retained.

Commands: npm run sync:r2; R2_FORCE_SHA=true npm run sync:r2; npm run test:r2; npm run typecheck:r2; npm run build:r2.

The local regression covers three fixed actual ALIO HWP samples, 21 table-query comparisons, body normalization, original evidence, new-rule addition, atomic revision replacement, failed upload/validation and stale-writer preservation, previous-catalog fallback, unchanged-list fast path and expired raw checks, and all nine OAuth MCP calls through local workerd/R2/DO. Synthetic changes do not establish that a real ALIO revision has occurred. Remote catalog publication and production MCP/CPU checks are separate evidence.

Global table search uses separately packed normalized row summaries. Per-shard Bloom filters only eliminate definite non-matches; real row predicates verify every positive candidate. Reads are bounded to four concurrent immutable objects. The legacy body ranking of search_all_regulations is retained, with default body+table searches and explicit scope=body preserving body-only searches. Named search_regulation_text continues to search body and table by default.

The named preparation branch feat/r2-first-serving may build the first R2 catalog before production promotion. It runs with R2_BOOTSTRAP_ONLY=true and refuses to replace any existing active catalog. Only main performs normal hourly updates; branch bootstrap cannot overwrite an operational catalog.
