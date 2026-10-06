# MCP 1.10.2 third-validation changes

## Fixes

- P0: remove document-wide numbered-line lookup. Definitions come only from native HWP/HWPX note controls or a consecutive note block immediately after the same table. Table cells are excluded. Resolve markers before text normalization; preserve raw runs in detailed cells. Never turn an ordinary leading task number into a note. Record superscript/font_size/unicode/position evidence and refuse definitions equal to table data.
- HWP raw PARA_CHAR_SHAPE positions include extended controls. Map shape changes against original UTF-16 words, not stripped text. Recover native fn controls and their actual note number/definition because hwpxjs 0.4.0 returns empty footnote paragraphs for this ALIO HWP. CharShape bit15 is superscript (Hancom HWP 5.0 revision1.3, table35).
- P1: text and table tools share searchLatestRegulationTable + tableToolResponse. Preserve successful components and add errors with stage/code/message. Log exception stacks per component. Historical PDF extraction is skipped unless include_history=true; opted-in history is explicitly labelled and never replaces the latest document. Preserve tool-level and ALIO retries.
- P2: has_more means more matches exist. truncated is set only when response size prevented adding a row. next_offset advances for either form of pagination.

## Real HWP debug evidence (fileNo 239154)

| Source | Body baseSize | Marker baseSize | Superscript evidence | Actual latest number |
|---|---:|---:|---|---|
| Domestic trip, row56 | 9pt | 9pt | native fn control rendered as note anchor | 4) |
| Domestic trip ※ | 9pt | 9pt | raw CharShape property 32768 (bit15) | ※ |
| Department internal move, row53 | 9pt | 9pt | native fn control | 2) |
| Deputy/director leave condition, row44 | 9pt | 9pt | native fn control | 1) |

The 85% threshold is unchanged. Native anchors are not literal small-font number runs in this HWP; their debug runs retain the actual 9pt baseSize and nativeControl:true rather than inventing a smaller rendered size. Numeric superscript:true on these runs comes from the native footnote control, not CharShape bit15. The latest HWP differs from old PDF numbering: do not relabel 2) as 3), or 1) as 2), or change the source label 부/실 내 이동 to 기술센터/부/실 내 이동.

Latest actual domestic-trip note 4): 단, 사업기구장 이상 및 소본부 부서별 최상위 부서장은 소장에게 보고 후 행정처리(본인전결)하고 PM은 각 사업기구장에게 보고 후 행정처리(본인전결) 한다.

Latest ※: 국·내외 출장 여비 발의 시, 결재선에 계정책임자(협조/검토/결재)를 반드시 포함하여야 한다.

## Verification boundary

Previously downloaded actual ALIO HWP: all three tables / 800 structured approval rows checked. 35 linked note occurrences; position fallback 0/35 (0%). Domestic/foreign contract four stages, audit, return report, sick leave and real source notes passed. Controlled tests cover font threshold, Unicode/position fallback, partial failure isolation, history opt-in and synthetic HWPX run metadata. Synthetic HWPX is not a real ALIO HWPX validation.

GitHub CI runs existing comprehensive 16 cases, previous acceptance 15 cases, previous metadata/table stability, new third-fix cases and ten consecutive text-handler calls; final results must be recorded on the PR after CI finishes. Node registered-callback tests using ALIO originals do not prove authenticated production MCP calls. Production OAuth access and actual Cloudflare exception logs remain unavailable in this session. No production deployment or Site Publish is part of this change until validation is finished and deployment is requested.
