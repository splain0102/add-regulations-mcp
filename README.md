# R2 사전 색인 검색: 2.3.0

## 2.3.0 — 통합검색과 관련 조문 연결

- `search_all_regulations`가 규정명·조문·별표·표를 한 번에 검색합니다(입력은 그대로, 응답에 `related`·`coverage`·`intent`·`match_type`·`matched_terms` 추가).
  - **규정명 단어 라우팅**: 규정명에 들어 있는 단어(예: "직제 부소장"의 "직제")는 그 규정으로 좁히고, 나머지 단어만 조문에서 찾습니다.
  - **단어별 근거**: 한 조문에 모든 단어가 없으면(예: "모험연수 국외출장비") 단어마다 가장 강한 조문을 `match_type:"partial"`, `matched_terms`로 따로 보여 줍니다. 서로 다른 조문을 합치지 않습니다. 조문 제목·규정명에 나오거나 드문 단어일 때만 근거로 냅니다.
  - **항 단위 발췌**: 검색어가 가장 많이 든 항(①②…)을 `paragraph`와 함께 발췌합니다(예: 포상금 지급방침 제9조⑤).
  - **숫자·금액**: "300만원"과 "300만 원"처럼 띄어쓰기·쉼표 차이를 무시합니다. 어디에도 없는 복합어는 어간으로 다시 찾습니다(국외출장비 → 국외출장, `coverage.resolved`).
  - **의도어**: 승인권자·결재권자·전결권자는 검색어에서 빼고(`coverage.ignored`, `intent:"approver"`) 위임전결표 행을 우선하며, 표 결과에 업무·조건·전결권자를 함께 담습니다. 승인권자 질문에서 위임전결 행이 없으면 긴 복합어의 핵심 명사로 한 번 더 찾습니다(기술용역 → 용역). 다른 질문은 추가로 표를 읽지 않습니다. 승인권자 질문의 금액은 글자가 아니라 범위로 비교합니다: "기술용역 10억 승인권자"는 조건이 10억을 포함하는 행(용역비 5억 초과 → 소장)을 맨 앞에 두고(`amount_match:true`), 범위 밖 행(2억 미만 등)은 뒤로 보냅니다(`amount_match:false`).
  - **관련 조문(`related`, 최대 5건)**: 색인 단계에서 추출한 명시적 인용(「규정명」 [제N조])만 연결합니다. 조문까지 지정되면 `confidence:"high"`, 규정만 지정되면 `"medium"`이고, 인용한 쪽(`cited_by`)도 표시합니다. 단어가 같다는 이유만으로는 연결하지 않습니다.
- `search_regulations`는 규정명이 하나도 맞지 않을 때 본문 상위 조문 3건을 `body_suggestions`로 함께 반환합니다(예: "모험연수" → 포상금 지급방침 제9조).
- 다른 도구의 호출 방식과 응답은 바뀌지 않습니다. 검색 시점에 ALIO 다운로드·문서 파싱은 하지 않습니다(`alio_requests:0`).
- 색인: 카탈로그에 `search_format:2`(인용 목록, 표 행의 업무·조건·전결권자)가 추가되어 다음 동기화가 저장된 스냅숏으로 카탈로그를 다시 만듭니다(다운로드 없음).
- 검증: `npm run test:unified-search`, CI `search-benchmark`(실제 전체 규정에서 main과 동일 입력 비교: 정답 판정, 1회 호출 성공, cold/warm p50·p95, R2 읽기량, 응답 크기).


## D1 파생 사본 (통계·조회용)

R2가 원본이고 검색도 R2가 맡습니다. D1은 R2에서 언제든 다시 만들 수 있는 가벼운 사본입니다. 규정·버전 이력·조문/표·위임전결 행을 SQL로 세어 보는 용도입니다. 매시간 R2 동기화 뒤 `d1-mirror` 작업이 바뀐 규정만 옮겨 적고, 바뀐 게 없으면 쓰지 않습니다. FTS를 만들지 않아 무료 한도(하루 10만 행 쓰기, 안전한도 8만) 안에서 동작합니다. 구조·흐름·측정값은 [D1 파생 색인](docs/d1-derived-index.md)에 있습니다. 시험: `npm run test:d1-mirror`. 필요한 GitHub 설정: `vars.D1_DATABASE_ID`, `secrets.CLOUDFLARE_D1_TOKEN`(D1 편집 권한), 기존 R2 값.

## 2.2.0 — 6차 수정 (parser 1.11.0-parser.1)

- **위임전결표 병합 셀**: rowSpan으로 병합된 구분·업무 셀 텍스트를 덮는 모든 행의 검색 대상에 넣습니다(fill-down). 결과의 category·task는 그대로입니다. `search_regulation_table`에 `group_by:"task"`를 주면 일치한 업무의 하위 행을 모두 묶어 `groups`와 함께 반환합니다. 1.9.1의 "병합 조건 셀은 시작 행에서만" 규칙을 대체하므로 같은 질의의 결과 건수가 늘 수 있습니다.
- **글자 전결권자**: "직상위자 또는 PM"처럼 대안이 적힌 전결란을 전결권자 목록으로 인식합니다(이전에는 행이 빠졌습니다. 예: 8) 공무국외출장 세부과제책임자 출장).
- **다중 전결**: `multi_approver:true`인 행은 `needs_review:true`, `review_reason:"multiple_approvers"`입니다.
- **PDF**: 셀 근거가 없는 1열짜리 본문 줄은 표로 색인하지 않고 본문(조문 단위)으로만 검색됩니다. 전체 검색의 표 결과도 원문 띄어쓰기로 보여 주며 점수를 실제로 계산합니다. 모든 결과 점수가 같으면 `search_score_degenerate` 로그를 남깁니다.
- **어절 접두 일치**: 4음절 이상 검색어는 복합어 앞부분("전문가활용" → "전문가활용경비")도 낮은 가중치로 찾습니다. 2~3음절은 기존 N5 규칙대로 엄격합니다. 규정명에 검색어가 들어 있으면 가점이 붙습니다.
- **compact 응답(기본)**: 규정명·개정일·fileNo·URL·버전 경고·결과만 반환합니다. 색인·빌드 상태는 `hello`/`diagnose_alio_list`에서 확인하고, 색인이 stale일 때만 응답에 표시합니다. `compact:false`면 전체 메타데이터를 반환합니다.
- **get_regulation_text**: 본문은 `results`에 한 번만 담고, `format:"full"`일 때만 이어 붙인 `text`를 추가합니다.
- **부칙 라벨**: 부칙 블록은 "부칙(방침 제1012호, 2026.9.28.)", 그 안의 조문은 "부칙(2026.9.28.) 제2조(경과조치)"로 표시합니다. 날짜 머리가 없는 부칙은 시행일로 "부칙(시행 2017.9.16.)"처럼 구분합니다.
- **기타**: snippet은 줄 또는 어절 경계에서 시작합니다. revision_evidence는 부칙 블록만 담습니다(별표·별지·서식 제외).
- 파서 버전이 바뀌어 배포 직후 동기화가 전체 규정을 다시 색인합니다. 끝날 때까지 이전 색인으로 응답하며 `index_status:"stale"`로 표시됩니다.
- 검증: `npm run test:r2-sixth`(저장소의 실제 HWP 3건, CI), `npm run test:r2-sixth-live`(실제 ALIO 원본, CI).


## 2.1.0 — 규정 신설·명칭변경·폐지 대응

- **규정 식별자는 ALIO 고유번호(idx, 응답의 `reg_id`)입니다.** 이름이 같은 규정이 여러 개 있어도 각각 색인합니다. 이름으로 조회했을 때 후보가 여럿이면 `ambiguous_name`과 후보별 `reg_id`를 돌려주며, 이름 조회 도구에 선택 파라미터 `reg_id`를 함께 넘겨 지정합니다.
- **명칭변경**: 같은 idx의 이름이 바뀌면 이전 이름을 `aliases`에 보관합니다. `get_regulation`·`search_regulations`는 이전 이름으로도 찾습니다(`matched_alias`).
- **폐지**: ALIO 목록에서 한 번 빠진 규정은 계속 검색되며 `missing_count=1`, `source_latest_status=missing_from_source`로 표시됩니다. 두 번 연속 빠지면 `status=repealed`, `repealed_at`이 기록되고 삭제하지 않고 보관합니다. 폐지 규정은 기본 목록·전체 검색에서 빠지며 `include_repealed=true`로 포함합니다. 다시 나타나면 같은 idx로 복귀합니다.
- **안전장치**: ALIO 목록에서 활성 규정의 5%(최소 1건)를 넘게 빠지면 `list_shrink_guard`로 반영을 멈추고 기존 색인을 유지합니다. 실제 대량 폐지라면 Actions의 *R2 hourly regulation sync*를 수동 실행하면서 `allow_list_shrink`를 켭니다.
- `diagnose_alio_list`는 마지막 반영의 신설·개정·명칭변경·일시누락·폐지·복귀 내역(`last_changes`), 폐지·일시누락 규정 목록, 경고를 함께 반환합니다.
- 검증: `npm run test:r2-lifecycle`은 실제 `scripts/r2/sync.ts`를 가짜 ALIO 응답과 파일 기반 R2로 실행해 신설·명칭변경·명칭변경+개정·폐지·일시누락·목록 부분응답·목록 급감·동명규정 21개 항목을 확인합니다. R2 regression CI에서 함께 실행됩니다.


D1 자동 적재는 보류했습니다. R2 원본·파싱 결과와 사전 검색 파일을 먼저 사용합니다. 검색 요청은 R2 사전 색인을 조회하며 ALIO 다운로드·HWP/PDF 파싱을 실행하지 않습니다. 수집은 GitHub Actions에서 1시간마다 진행하고, 검증된 전체 색인만 원자적으로 교체합니다. 기존 Worker Cron과 KV 발행은 중지합니다. 신규 규정·개정·실패 복구·스케줄·검증 절차는 [R2 운영 설계](docs/r2-serving.md)를 참고하세요. 아래 D1 설명은 보류된 실험 경로입니다.

## 1.10.1 — second validation fixes (draft)

- Metadata lookup uses a bounded, cached supplementary-provision scan instead of the full document/table parser. Cache identity includes fileNo and idate. Probe failures are isolated as `parse_failed`.
- All table paths, including text-search table evidence, default to compact output. General rows keep values; delegation rows keep semantic/approval evidence. Columns appear once per table. Detailed cells, header paths, raw cells and bounding boxes require `compact:false`. No snake_case span keys are emitted.
- Display text preserves word spaces and collapses only isolated single-Hangul-character spacing. Search continues to ignore whitespace.
- Attachment selection reports each actual filename/revision/effective-date match in `selection_reason`. Historical filename dates support two-digit years and month precision; unknown dates are null.
- The 15 second-validation acceptance cases execute the actual registered callbacks and Zod defaults in Node with real ALIO documents. A separate ten-iteration metadata/table test checks stability, attachment failure isolation and probe cache invalidation. Existing comprehensive/PDF regressions and Wrangler dry-run remain enabled.

Production exception logs and authenticated production MCP calls require separate operational verification. No production deploy or Site Publish is performed by this draft.

## 1.10.0: 종합 개선 및 버전 표시 통일

- PR #7의 종합 개선(최신 첨부 선택, text/multi approver, PDF 병합 업무 귀속, 일반표 values, 각주 및 오류 처리)을 포함합니다.
- package.json, package-lock.json의 프로젝트 버전과 MCP 서버·hello의 버전을 1.10.0으로 통일했습니다.
- MCP 서버와 hello는 동일한 MCP_VERSION 상수를 사용합니다.
- 기존 Cloudflare MCP 주소와 OAuth/Access 설정은 유지합니다.

## 1.9.1: 병합 조건 귀속 및 응답 크기 수정

- 위임전결표의 조건 셀은 시작 행에서만 검색 결과를 생성합니다. 그 시작 행을 덮는 업무·구분 셀에 귀속하며, 병합 구간의 새 업무에 조건을 중복 귀속하지 않습니다.
- `analysis_type`은 표별로 한 번 판정합니다. 위임전결표에서 기호가 없으면 `approver=null`, `needs_review=true`이며 일반 표로 바꾸지 않습니다.
- `search_regulation_table`에 `compact`(기본 true), `offset`(기본 0)을 추가했습니다. compact 행에는 업무·조건·전결 결과와 식별자 및 분류만 포함합니다. 헤더는 최상위 `tables[table_id]`에 한 번 저장합니다.
- `compact=false`는 실제 셀과 좌표를 포함합니다. 행의 반복 헤더, `raw_cells`, 셀별 `header_path`, `row_span`/`col_span` 별칭, 빈 셀은 출력하지 않습니다. 실제 셀 병합 정보는 `rowSpan`/`colSpan`으로 유지합니다.
- JSON 텍스트와 structuredContent를 함께 포함한 MCP 응답에 50,000자 한도를 적용합니다. 잘린 결과는 `truncated=true`, `next_offset`을 반환합니다. 동일 질의를 그 offset으로 이어서 호출할 수 있습니다. 한 행 자체가 한도를 넘으면 `layout_error`로 compact 사용을 안내합니다.
- 자동 수용시험: `npm run test:delegation-response`. 실제 ALIO HWP fileNo 239154에서 국정감사, 원화·외화 계약 승인, 계약원가계산, ★ 범례 및 suffix를 확인합니다. 별도 합성 시험은 기호 누락과 페이지 처리 경계를 검증하며 실제 원본 시험과 구분합니다.

```json
{"name":"위임전결규정","query":"계약 승인","compact":true,"offset":0,"limit":30}
```

## 1.9.0: 범용 규정 표 검색

기존 Site `add-regulations-portal` 게시 버전 5의 표 검색 코어(소스 커밋 `793d45ca186867e0e1986a0468f272a5fdb9cc95`)를 Cloudflare 서버에 반영했습니다. OAuth 2.1, Cloudflare Access, 기존 목록·본문·조문 검색 도구는 유지합니다.

`search_regulation_table({name, query, limit?, includeRegion?})`는 위임전결표 외 일반 표도 검색합니다.

- HWP/HWPX: 실제 셀의 `row`, `col`, `rowSpan`, `colSpan`을 보존하고 병합셀 아래 행에도 같은 셀 증거를 유지합니다. 여러 검색어가 같은 논리 행의 다른 셀에 분산되어 있어도 검색됩니다.
- 다단 헤더: `header_evidence`와 각 셀의 `header_path`를 반환합니다. 일반 표에 전결권자를 강제로 배정하지 않습니다.
- 위임전결표: 실제 기호와 헤더로 판단하고 근거가 부족하면 `needs_review=true`를 반환합니다.
- PDF: `coordinate_type=pdf_point`로 실제 페이지 좌표를 반환하며 HWP의 `logical_cell`과 구분합니다. 과거 PDF fileNo 166852의 실제 헤더는 3열이고 최신 HWP의 7열로 보정하지 않습니다.
- 표 코어 문서 캐시는 `fileNo + idate`를 사용합니다. ALIO의 `stDate=제·개정일`, `idate=최종수정일`과 재시도를 유지합니다.

### 검증과 배포 상태

Site 게시 버전 5에서는 A–E 16개 실제 Site-hosted 호출을 검증했습니다. 이 사실은 별도 Cloudflare 서버 배포 성공을 의미하지 않습니다. 이 브랜치의 Cloudflare 런타임 번들은 `npm run build:check`로 확인하고, 코어는 `npm run test:tables`로 실제 ALIO 파일의 셀 구조와 A–F 회귀를 검사합니다. PDF F는 최신 답변에 대체 사용하지 않는 과거 개정본 회귀시험입니다.

1.9.0은 PR #4를 main에 병합한 뒤 연결된 Cloudflare production 자동 빌드에서 성공을 확인했습니다. GitHub push만으로 기존 Worker가 변경되었다고 간주하지 마십시오. 배포 확인 후 Claude의 인증된 `hello`와 검색 호출로 현재 버전을 확인해야 합니다. 수동 배포 환경에서는 다음 명령을 사용합니다.

```sh
npm ci
npm run build:check
npm run test:tables  # Node 24 이상; ALIO 접근 필요
npm run deploy
```

배포 후 `hello`는 `tableStructure`, `pdfLayout`, `symbolCoordinates`, `columnMapping`, `fillDown`, `versionCheck`, `generalTables`를 반환합니다. 이 값은 구현 상태이며 실제 Cloudflare 원격 회귀시험을 대신하지 않습니다. 기존 `wrangler.jsonc`의 Worker명, KV 및 OAuth/Access 설정과 비밀값은 유지합니다.

## 현재 확인된 기능

실제 Claude 연결을 통해 아래 기능을 순서대로 검증했습니다.

1. MCP 연결 확인
2. 국방과학연구소 내부규정 전체 목록 조회
3. 규정명 검색
4. 특정 규정의 최신 상세정보 조회
5. HWP/HWPX/PDF 본문 추출
6. 본문 키워드 및 조문 검색

현재 ALIO 기준 내부규정 목록은 약 200건 이상이며, 목록 데이터는 ALIO의 현재 AJAX/JSON API를 직접 호출해 가져옵니다.

## MCP 도구

### `hello`

MCP 서버 연결 상태를 확인합니다.

### `list_regulations`

국방과학연구소의 최신 내부규정 목록을 조회합니다.

반환 정보에는 규정명, 제·개정일, 최종수정일 등이 포함됩니다.

### `search_regulations`

규정명 일부 또는 전체를 기준으로 최신 내부규정을 검색합니다.

예:

```text
취업규정
순환보직
계약
```

### `get_regulation`

특정 규정의 최신 상세정보와 최신 첨부파일 정보를 조회합니다.

주요 반환 항목:

- 규정명
- 제·개정일
- 최종수정일
- 최신 첨부파일명
- 파일 형식
- ALIO 원문 URL

### `get_regulation_text`

최신 첨부파일을 내려받아 실제 본문을 추출합니다.

지원 형식:

- HWP 5.x
- HWPX
- 텍스트형 PDF

본문이 너무 긴 경우 MCP 응답 크기를 고려해 일부만 반환할 수 있습니다.

### `search_regulation_text`

최신 규정 본문에서 키워드나 조문을 검색합니다.

가능한 경우 단순 고정 글자수 대신 `제○조`, `부칙` 경계를 기준으로 결과를 잘라 반환합니다.

예:

```text
규정명: 취업규정
검색어: 출산전후휴가
```

## ALIO 데이터 처리 방식

ALIO의 내부규정 목록 페이지는 현재 클라이언트 렌더링 방식이라 정적 HTML만 파싱해서는 실제 규정 목록을 얻을 수 없습니다.

따라서 목록은 다음 JSON API를 직접 호출합니다.

```text
POST https://www.alio.go.kr/item/itemReportListSusi.json
```

주요 요청 값:

- `apbaId=C0345`
- `apbaType=A2005`
- `reportFormRootNo=21110`

상세정보는 각 규정의 `itemBoard21110.do` 페이지를 조회하고, 첨부파일은 ALIO의 `rulefiledown.json?fileNo=...` 경로를 사용합니다.

날짜 필드 매핑은 다음과 같습니다.

- `stDate` → 제·개정일
- `idate` → 최종수정일

## 문서 형식 처리

### HWP

`@ssabrojs/hwpxjs`를 사용해 HWP 5.x 문서의 본문을 추출합니다.

암호화 문서, 배포용 문서 또는 특수한 HWP 파일은 파싱이 실패할 수 있습니다.

### HWPX

ZIP 기반 HWPX 구조에서 `Contents/section*.xml`을 읽어 본문을 추출합니다.

### PDF

`unpdf`를 사용해 텍스트 레이어가 있는 PDF에서 본문을 추출합니다.

스캔 이미지 PDF에는 텍스트 레이어가 없을 수 있으므로 별도 OCR이 필요합니다.

### 표 구조 및 PDF 레이아웃 인식

HWP/HWPX는 본문 텍스트와 별도로 실제 표 구조를 인식합니다.

- HWP: `row`, `col`, `rowSpan`, `colSpan`과 셀 텍스트를 직접 추출
- HWPX: HTML 변환 결과의 `rowspan`/`colspan`을 이용해 셀 위치와 병합 구조 복원
- `get_regulation_text`: HWP/HWPX 본문을 가능한 경우 Markdown으로 표현
- `search_regulation_text`: 표 셀 검색 결과에 표 크기, 셀 좌표, 병합정보와 주변 행 문맥을 함께 반환
- 검색 시 공백과 쉼표 차이를 정규화하여 `1억원`과 `1억 원`처럼 표기가 다른 경우도 찾을 수 있음
- 두 개 이상의 검색어를 공백으로 나누어 입력하면 같은 논리 행의 여러 셀을 함께 검색할 수 있음. 예: `구매 1억원`

PDF는 HWP/HWPX와 달리 표의 행·열·병합셀 정보가 파일에 명시되지 않는 경우가 많습니다. 따라서 텍스트형 PDF는 `unpdf`의 좌표 정보(`x`, `y`, 너비, 글꼴 크기)를 이용해 다음과 같이 레이아웃을 복원합니다.

- 같은 세로 위치의 텍스트를 하나의 행으로 그룹화
- 큰 가로 간격을 기준으로 한 행 안의 열/셀 후보를 분리
- 검색어가 있는 PDF 페이지와 행 번호, `x/y` 좌표, 앞뒤 행을 함께 반환
- `기술용역 1억원`처럼 서로 떨어진 텍스트가 같은 행에 있는 경우 복합 검색어로 찾을 수 있음
- PDF가 80쪽을 초과하면 Worker 자원 사용을 제한하기 위해 좌표 기반 분석은 생략하고 기존 본문 검색으로 자동 전환

Markdown은 병합셀 표현에 한계가 있으므로 HWP/HWPX의 복잡한 표는 구조화된 행·열 문맥을 우선 사용합니다. PDF의 경우 좌표 기반 결과는 구조를 **추정**한 것이므로 중요한 판단은 원문 표와 함께 확인하는 것을 권장합니다.

## 인증 구조

전체 흐름은 다음과 같습니다.

```text
MCP Client
  ↓
Worker OAuth Provider
  ↓
Cloudflare Access
  ↓
허용된 사용자 인증
  ↓
MCP access token 발급
  ↓
/mcp 호출
```

Cloudflare Access 정책에서 허용된 사용자만 로그인할 수 있도록 구성할 수 있습니다.

## 필요한 Runtime variables and secrets

Cloudflare Worker의 **Runtime variables and secrets**에 아래 값이 필요합니다.

### Variables

- `ACCESS_CLIENT_ID`
- `ACCESS_TOKEN_URL`
- `ACCESS_AUTHORIZATION_URL`
- `ACCESS_JWKS_URL`

### Secrets

- `ACCESS_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`

Secret 값 자체는 GitHub 저장소에 커밋하지 않습니다.

## Cloudflare 리소스

OAuth state 저장을 위해 KV binding을 사용합니다.

```text
binding: OAUTH_KV
```

실제 namespace ID는 `wrangler.jsonc`에서 관리합니다.

## 배포

프로젝트는 Wrangler를 사용합니다.

```bash
npm install
npx wrangler deploy
```

GitHub와 Cloudflare Workers가 연결된 경우 `main` 브랜치 변경 시 자동 배포하도록 구성할 수 있습니다.

Dashboard에서 직접 설정한 Runtime 변수/Secret을 유지하기 위해 Wrangler 설정의 `keep_vars` 옵션을 사용합니다.

## Claude에서 연결

Remote MCP URL:

```text
https://add-regulations-mcp.splain0102.workers.dev/mcp
```

Claude의 Custom Connector에 위 URL을 등록하면 OAuth 승인 화면을 거쳐 Cloudflare Access 로그인으로 이동합니다.

연결 후 예시:

```text
list_regulations 도구를 실행해줘.

search_regulations 도구로 "취업규정"을 검색해줘.

get_regulation_text 도구로 "취업규정" 본문을 읽어줘.

search_regulation_text 도구로 "취업규정"에서 "출산전후휴가"를 검색해줘.
```

## 확인된 실제 사례

`취업규정`을 대상으로 다음 흐름이 실제로 확인되었습니다.

- 목록 조회 성공
- 규정명 검색 성공
- 상세정보 조회 성공
- 최신 HWP 다운로드 성공
- HWP 본문 추출 성공
- 본문 내 `출산전후휴가` 검색 성공
- 부칙 및 관련 개정 조문 검색 성공

ALIO 목록의 제·개정일과 첨부파일명에 적힌 날짜가 서로 다를 수 있으므로, 중요한 판단에는 본문 개정이력과 부칙을 함께 확인하는 것이 좋습니다.

## 알려진 제한사항

- ALIO의 HTML/JSON 구조가 변경되면 파서 수정이 필요할 수 있습니다.
- 스캔 PDF는 현재 OCR하지 않습니다.
- PDF 좌표 기반 표 인식은 텍스트 레이어가 있는 PDF에 한해 동작하며, HWP/HWPX처럼 정확한 병합셀 메타데이터를 보장하지 않습니다.
- HWP 암호화/배포용 문서는 처리하지 못할 수 있습니다.
- ALIO에 최신 개정일만 갱신되고 실제 최신 첨부파일이 올라오지 않은 경우, MCP는 ALIO에 게시된 파일 범위 안에서만 내용을 확인할 수 있습니다.
- 외부 서비스 일시 장애(예: 5xx/522)에 대비해 ALIO 요청은 자동 재시도합니다.

## 보안 주의사항

다음 값은 저장소, README, Issue, 채팅 등에 공개하지 마세요.

- `ACCESS_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`
- OAuth access token
- 기타 Cloudflare 인증용 비밀값

노출된 Secret은 즉시 재발급 또는 교체하는 것을 권장합니다.

## 개발 원칙

이 프로젝트는 ALIO 조회/문서 파싱 로직과 Cloudflare OAuth/배포 로직을 가능한 한 분리하는 방향으로 유지합니다.

향후 다른 MCP 호스팅 환경이나 ChatGPT Site-hosted MCP로 이식할 때도 ALIO 및 HWP/PDF 처리 로직을 최대한 재사용하는 것이 목표입니다.




## D1 preindexed search (v2.0.0, staged migration)

The D1 serving entrypoint is `src/d1-worker.ts`. It has no ALIO client or HWP/HWPX/PDF parser imports. OAuth continues using the existing provider and OAuth KV namespace. All nine MCP tool names are retained. Search results default to five records, with `limit`/`offset` pagination; `scope=body|table|pdf|all` filters the current-document catalog. Historical PDF attachments are excluded; requesting `include_history` reports an explicit partial/unavailable status until such attachments are separately indexed.

The producer runs in Node/GitHub Actions, checks ALIO every hour (`17 * * * *` UTC), and processes at most three documents concurrently. It uses the original latest-attachment selector and parsers. Unchanged metadata plus fileNo reuses immutable document records. A weekly/forced raw SHA verification detects silent file replacement and reuses prior parsed text when bytes match. Each publication verifies the ALIO list again. Public serving requests never perform collection or parsing.

D1 stores versioned metadata, article/annex/form sections, original table evidence and row records. Offline two-character grams feed separate FTS5 indexes. Candidates are verified against normalized content. A stored normalization-to-original offset map permits original-text snippets even when a query matches spaces/commas removed during normalization. Original cell row/col/spans, headers, footnotes and approval symbols remain in detailed evidence; merged display values do not create additional single-token origin-cell matches.

R2 stores immutable originals under `raw/<fileNo>/<SHA-256>/<filename>` and parsed snapshots under `parsed/<documentId>.json`. The producer verifies uploaded bytes. D1 loading uses bounded transactions and an `indexed_at` completion marker. Only fully loaded documents enter a validated catalog. A guarded publication transaction swaps one active snapshot pointer and retains the previous pointer. Failed or interrupted runs leave the preceding serving catalog intact. Unfinished immutable documents resume using unique-key inserts on retry; completed unpublished documents are reusable. Diagnostic tools return D1 sync state, not live ALIO HTML.

### Provision and configure

Cloudflare account authentication and real D1/R2 resources are required. They are not provisioned by a dry-run. The checked-in `wrangler.d1.jsonc` is a preview/local configuration with a deliberately invalid production database placeholder; existing `wrangler.jsonc` is kept on the current production entrypoint until remote acceptance is complete.

```sh
npx wrangler login
npx wrangler d1 create add-regulations
npx wrangler r2 bucket create add-regulations-archive
# Set D1_DATABASE_ID from the created database, then generate a preview config:
node scripts/d1/configure.mjs preview
npx wrangler d1 migrations apply REGULATIONS_DB --remote --config wrangler.d1.generated.jsonc
```

Configure GitHub Actions Variables: `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `R2_BUCKET`. Configure GitHub Secrets: `CLOUDFLARE_D1_TOKEN` (scoped D1 write access), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (the archive bucket only). Keep tokens outside source files and logs. The existing OAuth secrets remain in Wrangler secrets. Local sync reads the same environment variable names.

```sh
npm run sync:d1
FORCE_SHA=true npm run sync:d1
# Remote rollback to the retained previous catalog must be performed as a
# guarded D1 transaction by an authenticated operator, never by a public tool.
```

The Actions variable `D1_ENABLED=true` enables hourly D1 sync and disables the old KV refresh workflow. Do this only after resources/secrets and the initial catalog are validated. `workflow_dispatch` on main also allows initial/manual indexing while `D1_ENABLED` is unset; scheduled runs still require the flag. Every run checks required configuration names without printing values and applies pending D1 schema migrations before collection. A D1-only token is passed to Wrangler for migrations; no Worker deployment is performed by this workflow. Actions scheduling is approximate, not a guarantee of an exact hourly start. `D1_WRITE_BUDGET` defaults to 80,000 accounted writes/day for this producer; FTS and index writes count too. Quota failures are visible and preserve the active catalog. D1 REST calls are rate limited in the producer. An R2 inventory (including unfinished uploads) enforces a 1 GB bucket cap by default (`R2_BUCKET_BUDGET_BYTES` can lower it). A renewable D1 lease prevents overlapping scheduled/manual producers. Account-wide competing usage and old-version retention still require operational monitoring; this draft does not claim they were remotely verified.

### Verify and promote

```sh
npm run typecheck:d1
npm run build:d1
npm run test:d1
```

Tests load three fixed actual ALIO HWP fixtures (SHA verified) into local workerd D1, compare table/body queries for 기술용역 업무규정/여비규정/위임전결규정, test paging and transactional publication conflict, and call all nine tools through local OAuth PKCE. Fixture tests are deterministic parser/serving evidence; they do not prove current ALIO freshness or production CPU time. The evidence report is `reports/d1-regression.json`. Worker logs record elapsed time, query counts and rows read; Cloudflare event logs must provide actual CPU time for remote acceptance.

Before promotion, run a fresh remote sync, compare current selected attachments, verify authenticated preview MCP responses and p95/CPU on Cloudflare. Then `D1_VALIDATED_SNAPSHOT=true node scripts/d1/configure.mjs production` produces the candidate production config. Replace the production config only in a final reviewed promotion commit; merging main automatically deploys. Do not merge this draft or replace production config while resource IDs/secrets, freshness, limits or accuracy are unverified. To undo a serving deployment, restore the prior Worker deployment/config; OAuth KV and the old corpus are not deleted by this migration.

The fixed sample and fault tests account D1 rows written as well as query latency. The initial full corpus may require several quota-bounded runs/days; do not publish an incomplete first catalog. Stored-file capacity inspection for all 213 documents is available via `D1_FIXTURE_DIRECTORY=<raw-fixture-directory> node --import ./scripts/test-loader.mjs scripts/d1/capacity.ts`. Raw record JSON size is not a measurement of final D1/FTS storage. Mock remote-adapter checks run with `node --import ./scripts/test-loader.mjs scripts/d1/remote-regression.ts`; they never substitute for real D1/R2 credentials or remote acceptance.

Configure the preview Worker's OAuth/Access variables and secrets separately before remote OAuth testing; a newly named preview Worker does not automatically inherit the production Worker's secrets. Production promotion retains the existing production OAuth KV and secret configuration.

### Initial sync continuation

The producer stops starting new documents after 20 minutes (D1_RUN_BUDGET_MINUTES, maximum 30), finishes in-flight documents, saves a D1_SYNC_CHECKPOINTED record and releases its lease. A checkpoint exits successfully as a resumable batch, but its sync_runs status is failed with failure_count=0 and checkpoint_json.reason=time_budget; it is not a published catalog. Run the main workflow again to continue. Changes to the D1 producer, migrations or its workflow merged into main also start one sync batch automatically; this does not enable hourly scheduling or switch the serving Worker. D1_SYNC_STARTED logs existing ready documents; progress logs separately count reused/downloaded documents. A complete first catalog is never published in part.

During initial bootstrap, completed documents indexed within the preceding 24 hours are reused after current metadata and selected fileNo checks. Explicit FORCE_SHA still forces raw verification. The first published catalog establishes the weekly SHA baseline; subsequent scheduled SHA verification is unchanged. D1 inserts group table definitions and bound row batches (40 statements / 600KB target), retaining original row numbers and complete evidence. Interrupted partial documents remain unpublished and idempotently resume.
