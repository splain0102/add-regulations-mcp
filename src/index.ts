import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const ALIO_BASE = "https://www.alio.go.kr";

// 국방과학연구소 ALIO 기관 ID
const ADD_APBA_ID = "C0345";

const REGULATION_LIST_URL =
  `${ALIO_BASE}/item/itemOrganList.do` +
  `?apbaId=${ADD_APBA_ID}&reportFormRootNo=21110`;

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

async function fetchAlio(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 ADD-Regulations-MCP/1.0",
      "Accept":
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

function absoluteUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  if (url.startsWith("/")) {
    return `${ALIO_BASE}${url}`;
  }

  return `${ALIO_BASE}/${url}`;
}

type RegulationItem = {
  title: string;
  detailUrl: string;
  category?: string;
  revisionDate?: string;
  updatedDate?: string;
};

function parseRegulations(html: string): RegulationItem[] {
  const results: RegulationItem[] = [];
  const seen = new Set<string>();

  // ALIO 내부규정 상세 페이지 링크 추출
  const linkRegex =
    /href=["']([^"']*itemBoard21110\.do[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const detailUrl = absoluteUrl(
      match[1].replace(/&amp;/g, "&")
    );

    const title = cleanHtml(match[2]);

    if (!title || seen.has(detailUrl)) {
      continue;
    }

    seen.add(detailUrl);

    // 해당 링크 주변의 텍스트를 같이 살펴본다.
    const start = Math.max(0, match.index - 500);
    const end = Math.min(
      html.length,
      match.index + match[0].length + 1000
    );

    const surrounding = cleanHtml(
      html.slice(start, end)
    );

    const updated =
      surrounding.match(
        /최종\s*수정일\s*([0-9]{4}[.\-][0-9]{2}[.\-][0-9]{2})/
      )?.[1];

    const revision =
      surrounding.match(
        /제[·ㆍ]?\s*개정일\s*([0-9]{4}[.\-][0-9]{2}[.\-][0-9]{2})/
      )?.[1];

    results.push({
      title,
      detailUrl,
      revisionDate: revision,
      updatedDate: updated,
    });
  }

  return results;
}

async function listRegulations(): Promise<RegulationItem[]> {
  const html = await fetchAlio(REGULATION_LIST_URL);

  const items = parseRegulations(html);

  // ALIO HTML 구조가 달라졌을 때 원인을 알 수 있도록 처리
  if (items.length === 0) {
    throw new Error(
      "ALIO 페이지는 열렸지만 규정 상세 링크를 찾지 못했습니다. " +
      "ALIO 페이지 구조가 변경되었을 수 있습니다."
    );
  }

  return items;
}

async function getRegulationDetail(url: string) {
  const html = await fetchAlio(url);

  const plain = cleanHtml(html);

  const title =
    plain.match(/제목\s+(.+?)\s+(?:파일|제[·ㆍ]?개정일)/)?.[1] ??
    "제목 확인 필요";

  const category =
    plain.match(/구분\s+(.+?)\s+제목/)?.[1];

  const revisionDate =
    plain.match(
      /제[·ㆍ]?개정일\s+([0-9]{4}[.\-][0-9]{2}[.\-][0-9]{2})/
    )?.[1];

  const updatedDate =
    plain.match(
      /최종\s*수정일\s+([0-9]{4}[.\-][0-9]{2}[.\-][0-9]{2})/
    )?.[1];

  // 첨부파일 다운로드 주소 추출
  const files: Array<{
    name: string;
    url: string;
  }> = [];

  const fileRegex =
    /(?:href|onclick)=["'][^"']*(?:rulefiledown|filedown)[^"']*fileNo[=:'",()\s]+(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;

  let fileMatch: RegExpExecArray | null;

  while ((fileMatch = fileRegex.exec(html)) !== null) {
    const fileNo = fileMatch[1];
    const name = cleanHtml(fileMatch[2]);

    files.push({
      name: name || `첨부파일 ${fileNo}`,
      url: `${ALIO_BASE}/download/rulefiledown.json?fileNo=${fileNo}`,
    });
  }

  // 위 패턴에서 못 잡는 경우 HTML 전체에서 fileNo 탐색
  if (files.length === 0) {
    const ids = [
      ...html.matchAll(
        /rulefiledown\.json\?fileNo=(\d+)/gi
      ),
    ];

    const uniqueIds = [
      ...new Set(ids.map((m) => m[1])),
    ];

    for (const fileNo of uniqueIds) {
      files.push({
        name: `첨부파일 ${fileNo}`,
        url: `${ALIO_BASE}/download/rulefiledown.json?fileNo=${fileNo}`,
      });
    }
  }

  return {
    title,
    category,
    revisionDate,
    updatedDate,
    sourceUrl: url,
    attachments: files,
    pageText: plain.slice(0, 12000),
  };
}

function createServer() {
  const server = new McpServer({
    name: "ADD Regulations MCP",
    version: "1.1.0",
  });

  // 1. 연결 확인
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
            `ALIO 기관 ID: ${ADD_APBA_ID}`,
        },
      ],
    })
  );

  // 2. 전체 규정 목록
  server.registerTool(
    "list_regulations",
    {
      description:
        "ALIO에서 국방과학연구소의 내부규정 목록을 조회합니다.",
      inputSchema: {},
    },
    async () => {
      try {
        const items = await listRegulations();

        const text = items
          .map(
            (x, i) =>
              `${i + 1}. ${x.title}` +
              `${x.revisionDate ? `\n   제·개정일: ${x.revisionDate}` : ""}` +
              `${x.updatedDate ? `\n   최종 수정일: ${x.updatedDate}` : ""}` +
              `\n   ${x.detailUrl}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text:
                `국방과학연구소 ALIO 내부규정\n` +
                `조회 건수: ${items.length}\n\n${text}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                `규정 목록 조회 실패\n` +
                `${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 3. 규정 검색
  server.registerTool(
    "search_regulations",
    {
      description:
        "국방과학연구소 내부규정을 규정명으로 검색합니다. 예: 휴가, 취업, 육아휴직, 보수",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("검색할 규정명 또는 키워드"),
      },
    },
    async ({ query }) => {
      try {
        const items = await listRegulations();

        const q = query
          .replace(/\s+/g, "")
          .toLowerCase();

        const matches = items.filter((item) =>
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
                  `"${query}"에 해당하는 국방과학연구소 규정을 ` +
                  `ALIO 목록에서 찾지 못했습니다.`,
              },
            ],
          };
        }

        const text = matches
          .map(
            (x, i) =>
              `${i + 1}. ${x.title}` +
              `${x.revisionDate ? `\n   제·개정일: ${x.revisionDate}` : ""}` +
              `${x.updatedDate ? `\n   최종 수정일: ${x.updatedDate}` : ""}` +
              `\n   상세: ${x.detailUrl}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text:
                `"${query}" 검색 결과 ${matches.length}건\n\n${text}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                `규정 검색 실패\n` +
                `${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // 4. 규정 상세 조회
  server.registerTool(
    "get_regulation",
    {
      description:
        "규정명으로 국방과학연구소 ALIO 내부규정을 찾아 상세정보와 첨부파일을 조회합니다.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("규정명 또는 규정명 일부"),
      },
    },
    async ({ name }) => {
      try {
        const items = await listRegulations();

        const q = name
          .replace(/\s+/g, "")
          .toLowerCase();

        const match = items.find((item) =>
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
                text: `"${name}" 규정을 찾지 못했습니다.`,
              },
            ],
          };
        }

        const detail = await getRegulationDetail(
          match.detailUrl
        );

        const attachments =
          detail.attachments.length > 0
            ? detail.attachments
                .map(
                  (file, i) =>
                    `${i + 1}. ${file.name}\n   ${file.url}`
                )
                .join("\n")
            : "첨부파일 주소를 자동으로 추출하지 못했습니다.";

        return {
          content: [
            {
              type: "text",
              text:
                `규정명: ${detail.title}\n` +
                `분야: ${detail.category ?? "확인 필요"}\n` +
                `제·개정일: ${detail.revisionDate ?? match.revisionDate ?? "확인 필요"}\n` +
                `최종 수정일: ${detail.updatedDate ?? match.updatedDate ?? "확인 필요"}\n` +
                `ALIO: ${detail.sourceUrl}\n\n` +
                `첨부파일\n${attachments}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                `규정 상세조회 실패\n` +
                `${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
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
        organization: "국방과학연구소",
        alioId: ADD_APBA_ID,
        mcpEndpoint: "/mcp",
      });
    }

    if (url.pathname === "/mcp") {
      return createMcpHandler(createServer)(
        request,
        env,
        ctx
      );
    }

    return new Response("Not found", {
      status: 404,
    });
  },
};
