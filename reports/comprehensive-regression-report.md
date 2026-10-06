# Comprehensive MCP Regression Report

## Final validation baseline

Validated branch: `comprehensive-mcp-fixes`

Functional baseline before final cleanup: `217c3d8bb6ec9a2e3680dcf2745ea9d2a84a578d`

## Result

- Comprehensive acceptance/regression: **16/16 PASS**
- table-structure-sample workflow: **PASS** — run 37440006536
- pdf-layout-table-sample workflow: **PASS** — run 37440006716
- Wrangler deploy dry-run: **PASS**
- Production deployment: **not performed**
- Site Publish: **not performed**

## Before / after

| Area | Before | After |
| --- | --- | --- |
| Attachment selection | Tools could select different historical attachments | Unified latest attachment selection; 위임전결규정 fileNo 239154 and 직제규정 fileNo 209393 |
| PDF merged task ownership | Child rows could inherit the previous numbered task | Vertically centred merged task ownership handled; 사업기구별 분기계획 승인 maps to 8) 공무국외출장 |
| Text approvers | Text-only approvers could be null | 직상위자 and other defined text approvers are recognized with approver_type=text |
| Multi approvers | Same row could be emitted as multiple results | One row with approvers[] and multi_approver=true |
| Footnotes | Marks/notes could be separated from rows | HWP footnote marks and table notes are preserved/linked |
| General tables | compact values could be null and data could pollute headers | values map is emitted and header detection is constrained |
| Text search errors | Intermittent upstream failures were opaque | Retry/error cause semantics added |
| Pagination semantics | truncation and more-results semantics could be conflated | has_more and truncated are separated |

## Acceptance highlights

1. All core tools select 위임전결규정 fileNo 239154.
2. All core tools select 직제규정 fileNo 209393.
3. 계약 승인 5) and 5-2) return the required approval stages without ghost rows.
4. 국정감사 ownership resolves correctly.
5. 귀국보고 and 겸직허가 추천 resolve 직상위자 as text approver.
6. 병가 is grouped as one multi-approver result.
7. 계약원가계산 및 협약 thresholds resolve correctly.
8. 직제규정 and 시작품 general-table values/columns pass.
9. Nonexistent table search returns an empty result without error.
10. Domestic-trip text uses the latest HWP.
11. Compact table payload stays within the acceptance limit.
12. Historical PDF centred merged ownership passes.
13. Footnote-safe and related-regulation behavior passes.

## Release gate

Repository-level validation is complete. Keep PR #7 as Draft until the validated changes are integrated into the existing `add-regulations-portal` Site draft and the Site-hosted MCP is tested. Publish only after those live Site-hosted regression checks pass.
