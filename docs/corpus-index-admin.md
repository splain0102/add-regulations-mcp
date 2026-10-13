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

## v1.10.12: CPU reduction and interrupted-run recovery

The Cloudflare event `outcome: exceededCpu` is a platform termination; `scriptVersion.id` is a deployment UUID, not an error code. A following scheduled event may be `ok` while the handler returns `409 index_busy`, because it skipped the still-leased run.

- Cron processes one document per invocation; administrator manual runs retain the two-document batch. List collection remains staged and bounded.
- Fresh downloaded bytes are still checked by SHA-256. For the same fileNo, hash and parser identity, the selector uses bounded cached revision text and the indexer reuses cached body text. Changed bytes use the normal shared selector and parser.
- An unchanged document keeps its immutable shard, search sections and attachment warnings. The manifest records the successful verification time. Failed attempts do not yield `partial:false`; missing/stale list evidence and pending changes remain visible.
- Cross-entry warnings are rebuilt only when document/catalog or list metadata changes. An invocation with no due work performs one manifest read and no corpus writes or outbound requests.
- Writer leases last five minutes, beyond the four-minute network deadline. A Durable Object alarm, status read or next writer recovers an expired/obsolete lease as `interrupted` / `execution_interrupted`; `last_interrupted_run` records it. Recovery cannot prove whether CPU, process interruption or another platform failure caused termination. Late publishers are rejected by the lease check; the committed corpus remains intact. Active runs are never revoked by an early alarm.
- No real amendment is required to verify latestness checks: record the successful complete ALIO list time, compare stDate/idate, and separately verify fileNo and fresh-byte SHA. New/changed metadata, same-metadata byte replacements, failed fetches and expired writers are tested with injected fixtures.

Local/CI elapsed times are not deployed CPU measurements. Verify Cloudflare CPU logs after deployment, including a due document run and complete list refresh. Parsing a genuinely changed large PDF/HWP may still exceed the Free plan's CPU budget; the change reduces unchanged-document work and bounds/recoveries, without claiming every newly changed document fits 10ms.

## v1.10.13: offline producer and lightweight Worker gateway

`exceededCpu` still occurred at 18ms on v1.10.12. The production scheduled handler now performs only an internal coordinator heartbeat. It performs no ALIO calls, PDF/HWP parsing, raw hashing, shard reconstruction or corpus GC. `/admin/trigger-index` still requires the administrator token, but returns **202 queued_external** and records a full-verification request for the next Actions run. It does not synchronously parse documents. For an immediate run, use **Run workflow** at https://github.com/splain0102/add-regulations-mcp/actions/workflows/corpus-refresh.yml.

The `Publish offline regulation index` workflow runs on each main push, hourly at minute 17, or workflow_dispatch. GitHub schedules are best effort and can be delayed; they are not a precise one-hour SLA. The runner waits for its exact deployed build, obtains the committed corpus (only `add:corpus:v2:` entries, never OAuth keys), retrieves a consistent fresh ALIO list, and loads only new/changed/pending/due documents. Unchanged metadata still receives periodic fresh-byte SHA verification at the existing 12-hour interval; changed bytes use the shared parser. Four independent loaders run in Node. List consistency, full coverage, audit inclusion and the security Article 8 search are checked before publication. A list/attachment/parse failure does not replace the previous committed snapshot.

### Authentication without a new long-lived token

Actions has `id-token: write`; the receiver verifies GitHub's RS256 signature using only `https://token.actions.githubusercontent.com/.well-known/jwks`. It pins issuer, audience, expiration, repository ID `1401470477`, owner ID `40254573`, `refs/heads/main`, `.github/workflows/corpus-refresh.yml`, and both source/workflow SHA to the deployed build. PRs, forks, other workflows and old builds cannot publish. The short-lived token is renewed when necessary and is never printed. OIDC verification and all corpus import validation execute inside the existing Durable Object; the Worker forwards raw requests/responses. No GitHub PAT or new Actions secret is required. Repo/owner transfers or renaming the publishing workflow require updating the explicit trust policy.

### Durable coordinator and atomic publication

The existing bootstrap validates all item metadata, fileNo, SHA-256, parser version, proof timestamps and all 16 shards before replacing the manifest. The signed workflow run is bound to its own bootstrap session. Identical, server-hashed committed shards are reused; a quiet hourly publication writes only the manifest. GC is bounded, protects active/fallback refs and the propagation grace period, and cleans abandoned uncommitted sessions. Full-index search and admin status computation also execute in the coordinator; ranking and response fields remain compatible. The HTTP Worker handles OAuth and bounded result serialization.

Status now includes `index_mode`, `index_refresh_status`, `index_refresh_error`, `offline_run_url`, `refresh_requested_at` and `last_offline_success_at`. The external run persists a phase, regulation/file identifiers, processing count and the Actions run URL. A failed refresh remains an error with `partial:true` until complete successful publication. A cancelled producer without a finish record is marked interrupted after 55 minutes. Existing documents remain searchable. These fields distinguish a successful lightweight Cron heartbeat from a successful index publication.

### Acceptance before production

CI checks actual GitHub OIDC issuance/claims/signature without publishing, signed policy-rejection fixtures, incremental/new/same-date byte replacement, failure preservation, 16-shard reuse, real workerd OIDC/atomic activation, OAuth key preservation, and actual ALIO corpus/Article 8 search. PR validation never publishes to production. After main merge, verify the first push producer's successful OIDC publication, `indexedRegulations == totalRegulations`, `partial:false`, and two lightweight Cron events without CPU exhaustion. CI's workerd tests do not impose the production Free-plan CPU quota. Monitor Actions minutes, KV quotas and schedule delays; a producer outage will eventually mark the committed index stale instead of silently claiming current coverage.
