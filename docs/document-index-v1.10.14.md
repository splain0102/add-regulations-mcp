# v1.10.14 document search index

## Problem and change

The v1.10.13 individual document tools reselect ALIO attachments before every lookup and download/parse the selected document on an isolate-cache miss. Whole-corpus indexing did not cover these tools. The 1.10.12..1.10.13 diff did not change the individual document parser/search implementations. A production `search_regulation_table(위임전결규정, 전문가)` returned MCP -32603 in approximately 12 seconds; metadata and full text succeeded in approximately 12.2 and 16.9 seconds. No Cloudflare account logs/token are available in this execution environment, so exceededCpu is a hypothesis, not a confirmed cause of this individual request.

The Actions producer now stores losslessly compressed table evidence with each corpus document: original cells/spans/text runs, footnotes, delegation rows, PDF positioned rows and existing metadata. Its schema is independent of the unchanged HWP parser version. Identical fileNo and SHA-256 reuse the prepared evidence; metadata/date changes still trigger revalidation. Immutable shards and the existing single-manifest activation publish text and table evidence together. Bootstrap validates the compressed bound and document identity. A failed build keeps the committed snapshot.

Individual text/table tools use the existing coordinator Durable Object to read a manifest and the relevant shard. They never contact ALIO or parse HWP/HWPX/PDF. The existing query evaluator and serializers operate on stored evidence. No new storage service, external parser or dependency is added. One decoded document is cached by immutable shard ref. Missing evidence returns index_preparing; incompatible parser returns index_version_mismatch. Refresh failures, old build, old verification time or changed metadata mark old results partial/stale. Optional historical PDF lookup returns history_not_indexed with partial:true instead of silently fetching historical PDFs.

## Measurements completed before CI

These are local Node/workerd measurements, NOT Cloudflare production CPU/memory metrics:

- Actual downloaded file 239154: 201,728 bytes, SHA-256 ea918f7dd3a79dd189d2ffc5b5472fece218a858ddae2fcb0ef2ed7d230a74e2.
- 6,728 HWP cells, 800 structured delegation rows. Text extraction approximately 62 ms; structure preparation and compression approximately 837 ms in Node.
- Evidence: 2,335,954 raw bytes, 165,284 base64 characters. No lossy filtering of cells, spans, headers or notes.
- Workerd OAuth MCP first table request approximately 57 ms, repeat approximately 15 ms. Full text approximately 12 ms, text search approximately 17 ms. Two KV reads; zero ALIO requests; zero document parses.
- 213 stored original-file fixtures: all prepared successfully; approximately 9.55 MB total estimated corpus content; largest shard approximately 1.26 MB, below existing 16 MB aggregate/2 MB shard bounds. This is a capacity test, not proof of current ALIO freshness.
- Existing corpus 30-case suite and offline 13-case suite passed locally. OAuth/workerd regression passed. TypeScript and Wrangler dry-run passed after adding the missing browser-export types and a nullable PDF symbol guard.

CI must run fresh ALIO whole-corpus acceptance, existing regressions and OAuth MCP document tests before merge. The production version remains 1.10.13 until an explicit successful merge/deployment. Merging automatically deploys via Cloudflare; do not run a separate unverified deploy.

## Business evidence and limits

Live MCP returned expert expense policy file 242685, revised 2026-09-28. Article 13(2) requires prior approval from the delegated approval authority and available budget. Current file 239154 contains two expert-related rows (domestic/overseas expert invitation request; overseas expert invitation/utilization plan). The exact phrases 전문가활용경비/내부승인 and a KRW 3 million expert-fee threshold were not found in the extracted current document. A USD 3 million foreign-currency contract threshold is a different business item and must not be substituted. Per-person versus per-approval aggregation and the approver for the user's scenario remain unconfirmed; do not infer them.
