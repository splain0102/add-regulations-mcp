# D1 파생 색인 설계 (C안, 초안)

R2가 정본이고, D1은 R2의 현재 카탈로그에서 언제든 다시 만들 수 있는 가벼운 복사본이다. 검색(본문·표·전체 검색)은 계속 R2가 맡는다. D1은 목록·메타데이터 조회, 통계, 외부 연동, SQL 분석에 쓴다.

## 1. 원칙

1. **원본은 R2**: D1 적재기는 ALIO를 호출하지 않는다. R2 `r2-index/active.json`이 가리키는 검증된 카탈로그와 그 증거 객체만 읽는다.
2. **무료 한도 안에서 하루 한 번에 끝낸다**: 무료 D1은 하루 10만 행 쓰기가 한도이고, 적재기는 8만 행에서 스스로 멈춘다. 전체 재적재를 포함해 한 번에 이 범위 안에 들어오도록 설계한다.
3. **찾아보기 색인(FTS)은 만들지 않는다**: 행 쓰기를 몇 배로 늘리는 FTS5 2글자 색인을 빼고, 기본 키와 꼭 필요한 색인 하나만 둔다.
4. **표는 표 단위로 묶는다**: 표의 각 행을 따로 저장하지 않고, 표 하나를 한 행(JSON)으로 저장한다.
5. **언제든 재생성**: D1을 지우고 다시 만들어도 같은 결과가 나온다. 단위 ID는 결정적으로 만든다.

## 2. 표 구조

| 표 | 한 행의 의미 | 예상 행 수 |
|---|---|---|
| `regulations` | 규정 1건(ALIO idx = `reg_id`) | 약 213 (폐지 포함 시 증가) |
| `versions` | 규정의 첨부 버전 1건(`reg_id` + `file_no`) | 약 213 (이력 보관 시 증가) |
| `units` | 조문 1개 또는 표 1개 | 약 1.5만 (조문 약 1.1만 + 표 약 3천, 추정) |
| `sync_state` | 적재 상태 1행 | 1 |

```sql
CREATE TABLE regulations (
  reg_id TEXT PRIMARY KEY,            -- ALIO idx
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active','repealed')),
  current_file_no TEXT NOT NULL,
  revised_at TEXT, updated_at TEXT,   -- stDate, idate
  alio_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,         -- 원본 sha256
  unit_count INTEGER NOT NULL,
  first_seen TEXT, last_seen TEXT, repealed_at TEXT,
  generation TEXT NOT NULL
);
CREATE TABLE versions (
  reg_id TEXT NOT NULL, file_no TEXT NOT NULL,
  revised_at TEXT, filename TEXT, extension TEXT,
  sha256 TEXT NOT NULL, parser_version TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  PRIMARY KEY (reg_id, file_no)
);
CREATE TABLE units (
  unit_id TEXT PRIMARY KEY,           -- {reg_id}:body:{순번} / {reg_id}:table:{table_id}
  reg_id TEXT NOT NULL, file_no TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('body','table')),
  ordinal INTEGER NOT NULL,
  label TEXT NOT NULL,                -- "제12조(…)", "부칙(2026.9.28.) 제2조(…)"
  article_no TEXT, table_id TEXT,
  text TEXT NOT NULL,                 -- 조문 원문 / 표의 행 텍스트 이어붙임
  rows_json TEXT,                     -- 표: 행별 category·task·condition·approver·원본 셀 증거
  generation TEXT NOT NULL
);
CREATE INDEX units_reg ON units(reg_id, ordinal);
CREATE TABLE sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation TEXT, catalog_sha TEXT, loaded_at TEXT, status TEXT, message TEXT
);
```

- `units`는 지금 R2 검색 요약(`SearchRecord`)과 증거 청크에서 바로 만든다. 문서 파싱은 다시 하지 않는다.
- 표 하나가 2MB를 넘으면(D1 한 행 상한 근처) `table_id#1`, `#2`처럼 나누어 저장한다.

## 3. 적재 흐름 (GitHub Actions, Node)

1. R2에서 `active.json`과 카탈로그를 읽는다. `sync_state.catalog_sha`와 같으면 아무것도 쓰지 않고 끝낸다.
2. 바뀐 규정만 고른다. 첫 적재나 파서 변경 시에는 전체를 고른다.
3. 새 세대(generation) 값을 정하고, 고른 규정의 `regulations`·`versions`·`units`를 새 세대로 쓴다. 규정 하나는 D1 batch 한 번(트랜잭션)으로 쓴다.
4. 모두 쓰면 `sync_state.generation`을 새 값으로 바꾼다. 조회는 이 값을 기준으로 하므로 중간 상태가 보이지 않는다.
5. 이전 세대 행을 지운다.
6. 8만 행 한도나 시간 한도에 걸리면 그 자리에서 멈춘다. `sync_state`는 바꾸지 않고, 다음 실행에서 이어서 쓴다.

**실행 시점(제안)**: R2 동기화가 실제로 새 카탈로그를 게시했을 때만 이어서 실행한다(변경 없음 fast path에서는 실행하지 않음). 추가로 하루 1회 점검한다.

## 4. 한도 계산(추정)

| 작업 | 행 쓰기(색인 포함 추정) |
|---|---|
| 전체 첫 적재: 단위 약 1.5만 × (본 행 + 색인 2) | 약 4.5만 |
| 전체 재적재(새 세대 쓰기 + 이전 세대 삭제) | 약 9만 → 이틀에 나눠 끝날 수 있음 |
| 평소 갱신(규정 1~2건 변경) | 수백 |

- 기존 설계는 FTS 색인 때문에 위임전결규정 한 건에서만 검색 조각이 약 3만 개 나왔다. 새 설계에서는 위임전결규정이 조문 33행 + 표 3행 수준이다.
- 정확한 수치는 첫 구현에서 실제 카탈로그로 측정해 보고한다.

## 5. 쓰지 않는 것과 한계

- D1 안의 단어 검색은 `instr()`로 전체 단위를 훑는 방식만 가능하다. 무료 한도는 하루 500만 행 읽기이므로 검색 용도로 쓰지 않는다. 검색은 R2 MCP를 쓴다.
- 기존 D1 표(FTS 포함)는 새 마이그레이션에서 삭제한다. 기존 D1 MCP 서버(`src/d1-worker.ts`)는 새 구조에 맞춰 조회 도구만 남기거나 정리한다.

## 6. 검증 계획

- 로컬 workerd D1에서 실제 HWP 3건으로 적재 → 행 수·바이트 측정 → R2 응답과 비교(규정 목록, 조문 원문, 표 행의 전결 정보)
- 중단 후 재개, 같은 카탈로그 재실행 시 쓰기 0, 규정 1건 변경 시 그 규정만 교체, 세대 전환 전 조회가 이전 데이터를 보는지 확인
- CI에 포함하고, 운영 D1 첫 적재 후 실제 쓰기 행 수를 보고
