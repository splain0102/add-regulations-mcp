# ADD Regulations MCP

국방과학연구소(ADD)의 ALIO 내부규정을 조회하고, 최신 첨부파일의 본문까지 검색할 수 있도록 만든 Remote MCP 서버입니다.

- 기관: 국방과학연구소
- ALIO 기관 ID: `C0345`
- MCP endpoint: `https://add-regulations-mcp.splain0102.workers.dev/mcp`
- 실행 환경: Cloudflare Workers
- 인증: OAuth 2.1 + Cloudflare Access
- 기본 원칙: 같은 규정명이 여러 번 존재할 경우 최신 제·개정본을 우선

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

### 표 구조 인식

HWP/HWPX는 본문 텍스트와 별도로 표 구조를 인식합니다.

- HWP: `row`, `col`, `rowSpan`, `colSpan`과 셀 텍스트를 직접 추출
- HWPX: HTML 변환 결과의 `rowspan`/`colspan`을 이용해 셀 위치와 병합 구조 복원
- `get_regulation_text`: HWP/HWPX 본문을 가능한 경우 Markdown으로 표현
- `search_regulation_text`: 표 셀 검색 결과에 표 크기, 셀 좌표, 병합정보와 주변 행 문맥을 함께 반환
- 검색 시 공백과 쉼표 차이를 정규화하여 `1억원`과 `1억 원`처럼 표기가 다른 경우도 찾을 수 있음
- 두 개 이상의 검색어를 공백으로 나누어 입력하면 같은 논리 행의 여러 셀을 함께 검색할 수 있음. 예: `구매 1억원`

Markdown은 병합셀 표현에 한계가 있으므로 복잡한 표의 판단에는 구조화된 행·열 문맥을 우선 사용합니다.

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
