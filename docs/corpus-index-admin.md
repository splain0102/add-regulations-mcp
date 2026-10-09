# Corpus index operations

Main merges automatically deploy this Worker. The Worker-execution/bootstrap release is 1.10.9.
`wrangler.jsonc` is the configuration file; there is no separate production `env`.
The Cron remains `*/5 * * * *` (UTC), using the same OAUTH_KV namespace.

Cron and manual batches use one SQLite Durable Object,
`CORPUS_INDEX_COORDINATOR` / `CorpusIndexCoordinator`. The migration provisions
this coordinator on deployment. ALIO fetches and parsing execute in the caller
Worker; the object only grants a 20-minute writer lease, validates commits and
stores run history. Expired writers cannot publish or roll back a snapshot. It serializes writers, rejects overlapping runs
with 409 and immediate repeat runs with 429, and stores run history without
adding heartbeat writes to the shared OAuth KV quota. Corpus documents, staging,
cursor and current-build errors remain in KV. Each batch processes at most two
documents with at most 36 external attempts, including retries and redirects.

## Refresh and retry policy

- Initial/new/changed documents continue in five-minute Cron batches.
- After a full list is verified, another collection starts after 60 minutes.
  Each event collects bounded pages; an in-progress collection resumes at its
  saved page, including when a later page fails. Partial lists never replace the
  committed complete list. List pages use one attempt each per event so an ALIO
  outage leaves invocation time for document work.
- A failed list fetch does not block document indexing from the last complete
  list. Its current-build error stays visible until a complete list is verified.
  List freshness expires after two hours; an outage cannot silently report ready.
- List and document failures persist independent cooldowns of 5, 10, 20, 40,
  then at most 60 minutes. They continue retrying across Cron runs. Successful
  progress resets consecutive failures; changed document metadata resets that
  document's obsolete retry state. Other pending titles continue during cooldown.
- Healthy documents are reselected/downloaded/hashed after 12 hours, before the
  existing 24-hour validity limit. This detects replacement fileNo or SHA even
  without stDate/idate changes. Administrator batches can recheck healthy
  documents early but still respect failed-document cooldowns.
- Search and administrator status expose last_list_verified_at,
  next_list_refresh_at and next_retry_at. Waiting batches can legitimately
  process zero documents; the saved error and next retry time explain why.

## Administrator token

Set a dedicated, high-entropy `INDEX_ADMIN_TOKEN` Cloudflare **secret** through
the account dashboard or `npx wrangler secret put INDEX_ADMIN_TOKEN`. Do not put
it in source control, URLs or shell command arguments. Without this secret the
admin routes return 503; absent or incorrect bearer tokens return 401. OAuth
access tokens do not grant administrator access.

## Manual batch and status

With `INDEX_ADMIN_TOKEN` supplied securely in the local environment:

```sh
node --use-env-proxy scripts/trigger-index.mjs
```

The default origin is the production workers.dev origin. Set `INDEX_ORIGIN` to
the intended environment if needed. The script POSTs `/admin/trigger-index` and
prints the run ID, build, start/finish, processed count, duration and subrequest
count. One invocation runs **one batch**, not the complete 213-document corpus.

`GET /admin/index-status` with the same bearer token returns status without
running a batch. Search responses expose `index_build_version`,
`last_cron_started_at`, `last_cron_finished_at`, `processed_in_last_run` and
`last_index_run` (including trigger `cron` or `manual`). `lastVerifiedAt` now
records a document-check batch; full ALIO list freshness is tracked separately.

On a build change, the next batch clears prior-build errors and resets the
verification sweep while preserving all committed documents and shard refs.
Until the new sweep completes, old documents remain searchable with
`partial:true`. Error samples are latest-first, at most three entries, and carry
`build_version` and `error_code`: no_attachment, fetch_failed, parse_failed,
subrequest_limit or timeout. A missing Cron finish with a persisted running
record identifies an interrupted run; the next run logs that interruption.

## Release acceptance

1. Confirm hello version 1.10.9 and its git SHA.
2. Invoke one administrator batch. Require processed > 0 and an advanced
   lastVerifiedAt; inspect `corpus_index_run_started/finished` logs.
3. Confirm error samples belong to that build and no old no_attachment samples
   remain. Inspect current HTTP/byte/subrequest diagnostics for any new failure.
4. Let Cron continue until all current documents are verified (roughly nine
   hours for a complete two-document/five-minute sweep; manual batches can
   advance it). Require >=200 indexed documents, a completion time and ultimately
   partial:false with all 213 documents.
5. Search 외국인 and confirm security regulation Article 8. Confirm 감사규정 is
   present with its freshly selected fileNo and no no_attachment error.

The repository configuration and local workerd tests cannot prove the account's
actual Cron registration, environment, administrator secret or production run
results. Check those through the account dashboard/logs after release.

## ALIO communication diagnosis

Authenticated `POST /admin/probe-alio` probes the same fixed public ALIO detail
URL through Worker and Durable Object, each with standard redirects and bounded
manual redirects. Results include execution scope, HTTP status, response bytes
(up to a bounded stream sample), CF-Ray, server, elapsed time and build SHA.
Errors saved by indexing now retain HTTP/network diagnostics. This comparison
helps distinguish execution location from redirect/transport behavior; a local
mock cannot establish the cause of a production 522.

## Initial full corpus bootstrap

After actual ALIO acceptance succeeds, CI exports
`reports/corpus-index-bootstrap.json` in the evidence artifact. The export uses
only the currently referenced corpus shards, never OAuth KV data. The list is
rechecked at acceptance completion. This is a trusted administrator import; the
receiving Worker validates the supplied snapshot rather than claiming to fetch
its entire source list again. The manifest must be no older than 30 minutes.

```sh
node scripts/bootstrap-index.mjs export
node --use-env-proxy scripts/bootstrap-index.mjs upload
```

Upload creates a 30-minute session, sends 16 immutable shards individually and
activates one manifest only after all checks succeed: complete title coverage,
ALIO-only detail URLs, metadata, parser identity, SHA-256 shard checksums, raw
file hash format (source bytes are checked in CI), fileNo, document age, 2 MB per shard and 16 MB corpus limits. Upload
and activation retries are idempotent. Cron and manual writers are excluded
during the session. Missing/corrupt shards or a failed final KV write preserve
the preceding manifest. OAuth keys are untouched. Abandoned staging keys remain
unreferenced; they can be removed by an administrator after session expiry.

After bootstrap, the existing hourly list comparison prioritizes new/changed
documents. The 12-hour file recheck also detects replacement attachments whose
list dates have not changed. Bootstrap does not change Cron registration,
parser_version, tool list, feature flags or production auto-deployment.

## Search performance (1.10.10)

Whole-corpus reads use four bounded concurrent KV shard reads, keeping the same
16 shards, freshness checks, fallback behavior and result ordering. Runtime run
status is read concurrently with search. Index writes prepare article boundaries
once; legacy documents without them still work. The parser version stays
1.10.5-parser.1; snippet sizes and tool schemas are unchanged.

CI compares the complete response against the 1.10.9 implementation on the actual
ALIO corpus, including missing-shard fallback and legacy records. The performance
report uses injected KV delay: it is not a production latency measurement.
Existing 2 MB shard / 16 MB corpus guards also include the boundary metadata.

## Fourth correction (1.10.11)

The 1.10.9 → 1.10.10 diff only accelerated reads and saved boundaries. It did
not add N5/N6 scoring or persistent cross-entry attachments. Scores are computed
at query time. The 15:05 KST old-build run preceded deployment; the 15:15 run
used 327e4f8. Existing run history survives deployments.

Fetch and scheduled share src/index.ts and BUILD_VERSION. The coordinator checks
the caller build before acquiring a writer lease and records build_mismatch
with the canonical hello build; no ALIO or corpus KV mutation follows mismatch.
The deployment script stamps once and deploys every configured environment with
the same source. wrangler.jsonc currently has one Worker and no named env.
Parallel deployments across multiple Workers are not an atomic platform transaction.

N5 uses lightweight word/suffix rules, with 0.3 inner-word weight and exclusion
of unrelated suffixes such as 사고방식. N6 caps each token at one scoring occurrence,
weights forms by 0.2 and omits deletion-only sections from search; original
document text is retained. Ranking takes the strongest section plus a bounded
three-section contribution. Article boundaries and document parser are unchanged.

Cron stores each detail-page attachment list with its successful document.
The same manifest also stores exact normalized cross-entry warnings and coverage.
Bootstrap rebuilds those warnings from the verified imported document attachments.
Production get_regulation reads the manifest once instead of fetching 213 pages.
Cross-index coverage/status is reported in version_check.cross_entry_index_status.
Old imports without attachments remain searchable but cannot supply cross warnings;
rebuild/import a complete current snapshot before release acceptance.
