# Corpus index operations

Main merges automatically deploy this Worker. The retry-policy release is 1.10.8.
`wrangler.jsonc` is the configuration file; there is no separate production `env`.
The Cron remains `*/5 * * * *` (UTC), using the same OAUTH_KV namespace.

Cron and manual batches use one SQLite Durable Object,
`CORPUS_INDEX_COORDINATOR` / `CorpusIndexCoordinator`. The migration provisions
this coordinator on deployment. It serializes writers, rejects overlapping runs
with 409 and immediate repeat runs with 429, and stores run history without
adding heartbeat writes to the shared OAuth KV quota. Corpus documents, staging,
cursor and current-build errors remain in KV. Each batch processes at most two
documents with at most 40 external attempts, including retries and redirects.

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

1. Confirm hello version 1.10.8 and its git SHA.
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
