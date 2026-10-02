import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const ALIO_BASE = "https://www.alio.go.kr";

// 현재 사용 중인 국방과학연구소 ALIO 기관 ID.
// 기존 Worker에서 정상 응답 중인 값 그대로 유지합니다.
const ADD_APBA_ID = "C0345";

const REGULATION_LIST_URL =
  `${ALIO_BASE}/item/itemOrganList.do` +
  `?apbaId=${ADD_APBA_ID}&reportFormRootNo=21110`;

type RegulationItem = {
  title: string;
  detailUrl: string;
  revisionDate?: string;
  updatedDate?: string;
};

type Attachment = {
  name: string;
  url: string;
  fileNo: string;
  detectedDate?: string;
};

function cleanHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(url: string): string {
  const decoded = url.replace(/&amp;/g, "&");

  if (
    decoded.startsWith("http://") ||
    decoded.startsWith("https://")
  ) {
    return decoded;
  }

  if (decoded.startsWith("/")) {
    return `${ALIO_BASE}${decoded}`;
  }

  return `${ALIO_BASE}/${decoded}`;
}

async function fetchAlio(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 ADD-Regulations-MCP/1.0",
      Accept:
        "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(
      `ALIO 요청 실패: HTTP ${response.status} ${response.statusText}`
    );
  }

  return await response.text();
}

function normalizeDate(value?: string): string {
  if (!value) return "";

  const m = value.match(
    /(20\d{2})\D{0,4}(\d{1,2})\D{0,4}(\d{1,2})/
  );

  if (!m) return "";

  return [
    m[1],
    m[2].padStart(2, "0"),
    m[3].padStart(2, "0"),
  ].join("-");
}

function extractDateFromFilename(name: string): string {
  const patterns = [
    /(20\d{2})년도?\s*(\d{1,2})월\s*(\d{1,2})일/,
    /(20\d{2})년도?\s*(\d{1,2})월/,
    /(20\d{2})[.\-_ ](\d{1,2})[.\-_ ](\d{1,2})/,
    /(20\d{2})(\d{2})(\d{2})/,
  ];

  for (const pattern of patterns) {
    const m = name.match(pattern);

    if (!m) continue;

    // 연월일이 모두 있는 경우
    if (m[3]) {
      return [
        m[1],
        m[2].padStart(2, "0"),
        m[3].padStart(2, "0"),
      ].join("-");
    }

    // 연월만 있는 경우
    return [
      m[1],
      m[2].padStart(2, "0"),
      "01",
    ].join("-");
  }

  return "";
}

function parseRegulations(html: string): RegulationItem[] {
  const results: RegulationItem[] = [];
  const seen = new Set<string>();

  const linkRegex =
    /href=["']([^"']*itemBoard21110\.do[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const title = cleanHtml(match[2]);
    const detailUrl = absoluteUrl(match[1]);

    if (!title || seen.has(detailUrl)) {
      continue;
    }

    seen.add(detailUrl);

    const start = Math.max(0, match.index - 800);
    const end = Math.min(
      html.length,
      match.index + match[0].length + 1200
    );

    const surrounding = cleanHtml(
      html.slice(start, end)
    );

    const revisionDate =
      surrounding.match(
        /제[·ㆍ]?\s*개정일\s*([0-9]{4}[.\-][0-9]{1,2}[.\-][0-9]{1,2})/
      )?.[1];

    const updatedDate =
      surrounding.match(
        /최종\s*수정일\s*([0-9]{4}[.\-][0-9]{1,2}[.\-][0-9]{1,2})/
      )?.[1];

    results.push({
      title,
      detailUrl,
      revisionDate,
      updatedDate,
    });
  }

  return results;
}

function dedupeLatestRegulations(
  items: RegulationItem[]
): RegulationItem[] {
  const byTitle = new Map<string, RegulationItem>();

  for (const item of items) {
    const key = item.title
      .replace(/\s+/g, "")
      .toLowerCase();

    const current = byTitle.get(key);

    if (!current) {
      byTitle.set(key, item);
      continue;
    }

    const itemRevision = normalizeDate(
      item.revisionDate
    );

    const currentRevision = normalizeDate(
      current.revisionDate
    );

    if (itemRevision > currentRevision) {
      byTitle.set(key, item);
      continue;
    }

    if (
      itemRevision === currentRevision &&
      normalizeDate(item.updatedDate) >
        normalizeDate(current.updatedDate)
    ) {
      byTitle.set(key, item);
    }
  }

  return [...byTitle.values()];
}

async function listRegulations(): Promise<
  RegulationItem[]
> {
  const html = await fetchAlio(REGULATION_LIST_URL);

  const parsed = parseRegulations(html);

  if (parsed.length === 0) {
    throw new Error(
      "ALIO 페이지는 열렸지만 규정 목록을 찾지 못했습니다. " +
        "ALIO 페이지 구조가 변경되었을 수 있습니다."
    );
  }

  return dedupeLatestRegulations(parsed);
}

function extractAttachments(
  html: string
): Attachment[] {
  const attachments: Attachment[] = [];
  const seen = new Set<string>();

  /*
   * 첨부파일명과 fileNo가 가까이 있는 HTML 블록을 우선 검색.
   */
  const blocks = html.match(
    /[\s\S]{0,1000}?(?:hwp|hwpx|pdf|zip|docx?)[\s\S]{0,1000}?/gi
  ) ?? [];

  for (const block of blocks) {
    const filename =
      cleanHtml(
        block.match(
          /([^<>="'()]+\.(?:hwp|hwpx|pdf|zip|doc|docx))/i
        )?.[1] ?? ""
      );

    const fileNo =
      block.match(
        /(?:rulefiledown\.json\?fileNo=|fileNo\s*[:=,(\'"\s]+)(\d+)/i
      )?.[1];

    if (!fileNo || seen.has(fileNo)) {
      continue;
    }

    seen.add(fileNo);

    attachments.push({
      fileNo,
      name:
        filename || `첨부파일 ${fileNo}`,
      url:
        `${ALIO_BASE}/download/` +
        `rulefiledown.json?fileNo=${fileNo}`,
      detectedDate:
        extractDateFromFilename(filename),
    });
  }

  /*
   * 위 방식에서 빠진 fileNo도 추가.
   */
  const allFileNos = [
    ...html.matchAll(
      /rulefiledown\.json\?fileNo=(\d+)/gi
    ),
  ].map((m) => m[1]);

  for (const fileNo of allFileNos) {
    if (seen.has(fileNo)) continue;

    seen.add(fileNo);

    attachments.push({
      fileNo,
      name: `첨부파일 ${fileNo}`,
      url:
        `${ALIO_BASE}/download/` +
        `rulefiledown.json?fileNo=${fileNo}`,
    });
  }

  return attachments;
}

function selectLatestAttachment(
  attachments: Attachment[],
  revisionDate?: string
): Attachment | null {
  if (attachments.length === 0) {
    return null;
  }

  const officialRevision =
    normalizeDate(revisionDate);

  /*
   * 1순위:
   * ALIO의 공식 제·개정일과 파일명 날짜가 정확히 일치.
   */
  if (officialRevision) {
    const exact = attachments.find(
      (file) =>
        file.detectedDate ===
        officialRevision
    );

    if (exact) {
      return exact;
    }
  }

  /*
   * 2순위:
   * 파일명에서 날짜가 확인되는 첨부파일 중 최신.
   */
  const dated = attachments
    .filter((file) => file.detectedDate)
    .sort((a, b) =>
      (b.detectedDate ?? "").localeCompare(
        a.detectedDate ?? ""
      )
    );

  if (dated.length > 0) {
    return dated[0];
  }

  /*
   * 3순위:
   * 날짜 확인 불가 시 ALIO HTML상 마지막 첨부파일.
   */
  return attachments[
    attachments.length - 1
  ];
}

async function getRegulationDetail(
  url: string
) {
  const html = await fetchAlio(url);
  const plain = cleanHtml(html);

  const title =
    plain.match(
      /제목\s+(.+?)\s+(?:파일|제[·ㆍ]?개정일)/
    )?.[1] ?? "제목 확인 필요";

  const category =
    plain.match(
      /구분\s+(.+?)\s+제목/
    )?.[1];

  const revisionDate =
    plain.match(
      /제[·ㆍ]?\s*개정일\s+([0-9]{4}[.\-][0-9]{1,2}[.\-][0-9]{1,2})/
    )?.[1];

  const updatedDate =
    plain.match(
      /최종\s*수정일\s+([0-9]{4}[.\-][0-9]{1,2}[.\-][0-9]{1,2})/
    )?.[1];

  const attachments =
    extractAttachments(html);

  const latestAttachment =
    selectLatestAttachment(
      attachments,
      revisionDate
    );

  return {
    title,
    category,
    revisionDate,
    updatedDate,
    sourceUrl: url,

    /*
     * 중요:
     * 실제 MCP 응답에서 사용할 것은 최신 파일 하나뿐입니다.
     */
    latestAttachment,

    totalAttachmentCount:
      attachments.length,
  };
}

function createServer() {
  const server = new McpServer({
    name: "ADD Regulations MCP",
    version: "1.2.0",
  });

  server.registerTool(
    "hello",
    {
      description:
        "국방과학연구소 ALIO 규정 MCP 연결 상태를 확인합니다.",
      inputSchema: {
        name: z.string().optional(),
      },
    },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text:
            `국방과학연구소 규정 MCP 정상 작동\n` +
            `요청: ${name ?? "연결 테스트"}\n` +
            `최신 규정 우선 모드: ON`,
        },
      ],
    })
  );

  server.registerTool(
    "list_regulations",
    {
      description:
        "ALIO에서 국방과학연구소 내부규정의 최신 목록만 조회합니다.",
      inputSchema: {},
    },
    async () => {
      try {
        const items =
          await listRegulations();

        const text = items
          .map(
            (item, index) =>
              `${index + 1}. ${item.title}\n` +
              `   제·개정일: ${
                item.revisionDate ??
                "확인 필요"
              }\n` +
              `   최종 수정일: ${
                item.updatedDate ??
                "확인 필요"
              }`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text:
                `국방과학연구소 최신 내부규정 목록\n` +
                `총 ${items.length}건\n\n` +
                text,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `규정 목록 조회 실패\n` +
                `${
                  error instanceof Error
                    ? error.message
                    : String(error)
                }`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "search_regulations",
    {
      description:
        "국방과학연구소 최신 내부규정을 규정명으로 검색합니다.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "검색어. 예: 휴가, 취업, 육아휴직, 보수"
          ),
      },
    },
    async ({ query }) => {
      try {
        const items =
          await listRegulations();

        const q = query
          .replace(/\s+/g, "")
          .toLowerCase();

        const matches = items.filter(
          (item) =>
            item.title
              .replace(/\s+/g, "")
              .toLowerCase()
              .includes(q)
        );

        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `"${query}"에 해당하는 최신 규정을 찾지 못했습니다.`,
              },
            ],
          };
        }

        const text = matches
          .map(
            (item, index) =>
              `${index + 1}. ${item.title}\n` +
              `   제·개정일: ${
                item.revisionDate ??
                "확인 필요"
              }\n` +
              `   최종 수정일: ${
                item.updatedDate ??
                "확인 필요"
              }`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text:
                `"${query}" 최신 규정 검색 결과\n\n${text}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `규정 검색 실패\n` +
                `${
                  error instanceof Error
                    ? error.message
                    : String(error)
                }`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_regulation",
    {
      description:
        "국방과학연구소 규정의 최신 개정본 첨부파일 하나만 조회합니다. 과거 개정본은 반환하지 않습니다.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(
            "규정명 또는 규정명의 일부"
          ),
      },
    },
    async ({ name }) => {
      try {
        const items =
          await listRegulations();

        const q = name
          .replace(/\s+/g, "")
          .toLowerCase();

        const match = items.find(
          (item) =>
            item.title
              .replace(/\s+/g, "")
              .toLowerCase()
              .includes(q)
        );

        if (!match) {
          return {
            content: [
              {
                type: "text",
                text:
                  `"${name}"에 해당하는 규정을 찾지 못했습니다.`,
              },
            ],
          };
        }

        const detail =
          await getRegulationDetail(
            match.detailUrl
          );

        const latest =
          detail.latestAttachment;

        const fileText = latest
          ? [
              `최신 첨부파일: ${latest.name}`,
              `다운로드 주소: ${latest.url}`,
              `선택 기준: 최신 제·개정일 우선`,
            ].join("\n")
          : "최신 첨부파일을 자동으로 확인하지 못했습니다.";

        return {
          content: [
            {
              type: "text",
              text:
                `규정명: ${detail.title}\n` +
                `분야: ${
                  detail.category ??
                  "확인 필요"
                }\n` +
                `현재 제·개정일: ${
                  detail.revisionDate ??
                  match.revisionDate ??
                  "확인 필요"
                }\n` +
                `ALIO 최종 수정일: ${
                  detail.updatedDate ??
                  match.updatedDate ??
                  "확인 필요"
                }\n` +
                `ALIO 원문: ${detail.sourceUrl}\n\n` +
                `${fileText}\n\n` +
                `ALIO에 등록된 첨부파일 수: ${detail.totalAttachmentCount}\n` +
                `과거 개정본은 MCP 응답에서 제외됩니다.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `규정 상세 조회 실패\n` +
                `${
                  error instanceof Error
                    ? error.message
                    : String(error)
                }`,
            },
          ],
        };
      }
    }
  );

  return server;
}

export default {
  async fetch(
    request: Request,
    env: unknown,
    ctx: ExecutionContext
  ) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        [
          "ADD Regulations MCP is running.",
          "",
          "Organization: 국방과학연구소",
          `ALIO ID: ${ADD_APBA_ID}`,
          "Mode: Latest regulation only",
          "MCP endpoint: /mcp",
          "",
          "Tools:",
          "- hello",
          "- list_regulations",
          "- search_regulations",
          "- get_regulation",
        ].join("\n"),
        {
          headers: {
            "content-type":
              "text/plain; charset=utf-8",
          },
        }
      );
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        organization:
          "국방과학연구소",
        alioId: ADD_APBA_ID,
        latestOnly: true,
        mcpEndpoint: "/mcp",
      });
    }

    if (url.pathname === "/mcp") {
      return createMcpHandler(
        createServer
      )(request, env, ctx);
    }

    return new Response(
      "Not found",
      {
        status: 404,
      }
    );
  },
};
