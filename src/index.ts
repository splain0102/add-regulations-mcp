import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { unzipSync, strFromU8 } from "fflate";
import { hwpToText } from "@ssabrojs/hwpxjs/browser";
import { handleAccessRequest, type Env } from "./access-handler";

const ALIO_BASE = "https://www.alio.go.kr";
const ADD_APBA_ID = "C0345";

const REGULATION_LIST_URL =
  `${ALIO_BASE}/item/itemOrganList.do` +
  `?apbaId=${ADD_APBA_ID}&reportFormRootNo=21110`;

const REGULATION_LIST_MOBILE_URL =
  `${ALIO_BASE}/mobile/item/itemOrganListSusi.do` +
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
  extension?: string;
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

function decodeXml(value: string): string {
  return value
    .replace(/<hp:tab[^>]*\/>/gi, "\t")
    .replace(/<hp:lineBreak[^>]*\/>/gi, "\n")
    .replace(/<\/hp:p>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function absoluteUrl(url: string): string {
  const decoded = url.replace(/&amp;/g, "&");

  if (
    decoded.startsWith("https://") ||
    decoded.startsWith("http://")
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
      `ALIO 요청 실패: HTTP ${response.status}`
    );
  }

  return await response.text();
}

function normalizeDate(value?: string): string {
  if (!value) return "";

  const match = value.match(
    /(20\d{2})\D{0,4}(\d{1,2})\D{0,4}(\d{1,2})/
  );

  if (!match) return "";

  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function extractDateFromFilename(name: string): string {
  const patterns = [
    /(20\d{2})\s*[.\-_년]\s*(\d{1,2})\s*[.\-_월]\s*(\d{1,2})/,
    /(20\d{2})(\d{2})(\d{2})/,
  ];

  for (const pattern of patterns) {
    const match = name.match(pattern);

    if (match) {
      return (
        `${match[1]}-` +
        `${match[2].padStart(2, "0")}-` +
        `${match[3].padStart(2, "0")}`
      );
    }
  }

  return "";
}

function getExtension(name: string): string {
  const match = name
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);

  return match?.[1] ?? "";
}

function parseRegulations(
  html: string
): RegulationItem[] {
  const results: RegulationItem[] = [];
  const seen = new Set<string>();

  const regex =
    /href=["']([^"']*itemBoard21110\.do[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const title = cleanHtml(match[2]);
    const detailUrl = absoluteUrl(match[1]);

    if (!title || seen.has(detailUrl)) {
      continue;
    }

    seen.add(detailUrl);

    const start = Math.max(0, match.index - 900);
    const end = Math.min(
      html.length,
      match.index + match[0].length + 1300
    );

    const around = cleanHtml(
      html.slice(start, end)
    );

    const revisionDate =
      around.match(
        /제[·ㆍ]?\s*개정일\s*([0-9]{4}[.\-][0-9]{1,2}[.\-][0-9]{1,2})/
      )?.[1];

    const updatedDate =
      around.match(
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
  const map = new Map<string, RegulationItem>();

  for (const item of items) {
    const key = item.title
      .replace(/\s+/g, "")
      .toLowerCase();

    const old = map.get(key);

    if (!old) {
      map.set(key, item);
      continue;
    }

    const newDate =
      normalizeDate(item.revisionDate) ||
      normalizeDate(item.updatedDate);

    const oldDate =
      normalizeDate(old.revisionDate) ||
      normalizeDate(old.updatedDate);

    if (newDate > oldDate) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

type AlioRegulationRow = {
  title?: string;
  apbaId?: string;
  reportFormNo?: string;
  tableName?: string;
  idxName?: string;
  idx?: string | number;
  reportGbn?: string;
  bidType?: string;
  stDate?: string;
  idate?: string;
  [key: string]: unknown;
};

function buildRegulationDetailUrl(
  row: AlioRegulationRow
): string {
  const params = new URLSearchParams({
    disclosureNo: "",
    apbaId:
      String(row.apbaId ?? ADD_APBA_ID),
    nowcode:
      String(row.reportFormNo ?? "21110"),
    reportFormNo:
      String(row.reportFormNo ?? "21110"),
    table_name:
      String(row.tableName ?? ""),
    idx_name:
      String(row.idxName ?? ""),
    idx:
      String(row.idx ?? ""),
    reportGbn:
      String(row.reportGbn ?? "N"),
    bid_type:
      String(row.bidType ?? ""),
  });

  return (
    `${ALIO_BASE}/item/itemBoard21110.do?` +
    params.toString()
  );
}

async function fetchRegulationListPage(
  pageNo: number
): Promise<{
  rows: AlioRegulationRow[];
  totalPages: number;
  totalCount: number;
}> {
  const endpoint =
    `${ALIO_BASE}/item/itemReportListSusi.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type":
        "application/json;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept:
        "application/json, text/plain, */*",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "User-Agent":
        "Mozilla/5.0 ADD-Regulations-MCP/1.0",
      Referer: REGULATION_LIST_URL,
      Origin: ALIO_BASE,
    },
    body: JSON.stringify({
      pageNo: String(pageNo),
      apbaId: ADD_APBA_ID,
      apbaType: "A2005",
      reportFormRootNo: "21110",
      search_word: "",
      search_flag: "title",
      bid_type: "",
      enfc_istt: "",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `ALIO 목록 API 요청 실패: HTTP ${response.status}`
    );
  }

  const json = await response.json() as any;
  const root = json?.data ?? json ?? {};
  const rows =
    Array.isArray(root.result)
      ? root.result
      : Array.isArray(root.rows)
        ? root.rows
        : Array.isArray(root.list)
          ? root.list
          : [];

  return {
    rows,
    totalPages:
      Number(root?.page?.totalPage ?? 1) || 1,
    totalCount:
      Number(root?.page?.totalCount ?? rows.length) ||
      rows.length,
  };
}

async function listRegulations() {
  const first =
    await fetchRegulationListPage(1);

  const rows = [...first.rows];

  for (
    let pageNo = 2;
    pageNo <= first.totalPages;
    pageNo++
  ) {
    const page =
      await fetchRegulationListPage(pageNo);
    rows.push(...page.rows);
  }

  const mapped: RegulationItem[] =
    rows
      .map((row) => {
        const title =
          typeof row.title === "string"
            ? row.title.trim()
            : "";

        if (!title) return null;

        return {
          title,
          detailUrl:
            buildRegulationDetailUrl(row),
          revisionDate:
            typeof row.stDate === "string"
              ? row.stDate
              : undefined,
          updatedDate:
            typeof row.idate === "string"
              ? row.idate
              : undefined,
        } satisfies RegulationItem;
      })
      .filter(
        (item): item is RegulationItem =>
          item !== null
      );

  const items =
    dedupeLatestRegulations(mapped);

  if (items.length === 0) {
    console.error(
      "ALIO list JSON API returned no regulations",
      {
        endpoint:
          `${ALIO_BASE}/item/itemReportListSusi.json`,
        apbaId: ADD_APBA_ID,
        apbaType: "A2005",
        totalPages: first.totalPages,
        totalCount: first.totalCount,
        firstRowKeys:
          first.rows[0]
            ? Object.keys(first.rows[0])
            : [],
      }
    );

    throw new Error(
      "ALIO 목록 API에서 국방과학연구소 규정을 찾지 못했습니다."
    );
  }

  console.log(
    "ALIO regulation list loaded",
    {
      source: "itemReportListSusi.json",
      count: items.length,
      totalCount: first.totalCount,
    }
  );

  return items;
}

function extractAttachments(
  html: string
): Attachment[] {
  const attachments: Attachment[] = [];
  const seen = new Set<string>();

  /*
   * 첨부파일명이 들어 있는 링크/블록을 탐색합니다.
   */
  const fileRegex =
    /([\w가-힣().,\-_+\s]+?\.(?:hwpx|hwp|pdf|docx|doc|zip))[\s\S]{0,800}?(?:rulefiledown\.json\?fileNo=|fileNo\s*[:=,(\'"\s]+)(\d+)/gi;

  let match: RegExpExecArray | null;

  while ((match = fileRegex.exec(html)) !== null) {
    const name = cleanHtml(match[1]);
    const fileNo = match[2];

    if (seen.has(fileNo)) continue;

    seen.add(fileNo);

    attachments.push({
      name,
      fileNo,
      extension: getExtension(name),
      detectedDate:
        extractDateFromFilename(name),
      url:
        `${ALIO_BASE}/download/` +
        `rulefiledown.json?fileNo=${fileNo}`,
    });
  }

  /*
   * 순서가 반대인 HTML도 탐색합니다.
   */
  const reverseRegex =
    /(?:rulefiledown\.json\?fileNo=|fileNo\s*[:=,(\'"\s]+)(\d+)[\s\S]{0,800}?([\w가-힣().,\-_+\s]+?\.(?:hwpx|hwp|pdf|docx|doc|zip))/gi;

  while ((match = reverseRegex.exec(html)) !== null) {
    const fileNo = match[1];
    const name = cleanHtml(match[2]);

    if (seen.has(fileNo)) continue;

    seen.add(fileNo);

    attachments.push({
      name,
      fileNo,
      extension: getExtension(name),
      detectedDate:
        extractDateFromFilename(name),
      url:
        `${ALIO_BASE}/download/` +
        `rulefiledown.json?fileNo=${fileNo}`,
    });
  }

  /*
   * 파일명 연결에 실패해도 fileNo 자체는 확보합니다.
   */
  for (
    const match of html.matchAll(
      /rulefiledown\.json\?fileNo=(\d+)/gi
    )
  ) {
    const fileNo = match[1];

    if (seen.has(fileNo)) continue;

    seen.add(fileNo);

    attachments.push({
      name: `첨부파일-${fileNo}`,
      fileNo,
      extension: "",
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

  const officialDate =
    normalizeDate(revisionDate);

  /*
   * 1순위: 공식 제·개정일과 파일명 날짜 일치
   */
  if (officialDate) {
    const exact = attachments.find(
      (file) =>
        file.detectedDate === officialDate
    );

    if (exact) return exact;
  }

  /*
   * 2순위: 파일명 날짜가 가장 최근
   */
  const dated = attachments
    .filter((file) => file.detectedDate)
    .sort((a, b) =>
      (b.detectedDate ?? "").localeCompare(
        a.detectedDate ?? ""
      )
    );

  if (dated.length) {
    return dated[0];
  }

  /*
   * 3순위: ALIO HTML에 가장 나중에 등장한 파일
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
    latestAttachment,
    totalAttachmentCount:
      attachments.length,
  };
}

async function downloadLatestFile(
  attachment: Attachment
) {
  const response = await fetch(
    attachment.url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 ADD-Regulations-MCP/1.0",
      },
      redirect: "follow",
    }
  );

  if (!response.ok) {
    throw new Error(
      `첨부파일 다운로드 실패: HTTP ${response.status}`
    );
  }

  const disposition =
    response.headers.get(
      "content-disposition"
    ) ?? "";

  const contentType =
    response.headers.get(
      "content-type"
    ) ?? "";

  let filename = attachment.name;

  const encoded =
    disposition.match(
      /filename\*=UTF-8''([^;]+)/i
    )?.[1];

  if (encoded) {
    try {
      filename =
        decodeURIComponent(encoded);
    } catch {
      filename = encoded;
    }
  } else {
    const normal =
      disposition.match(
        /filename="?([^";]+)"?/i
      )?.[1];

    if (normal) {
      filename = normal;
    }
  }

  const bytes =
    new Uint8Array(
      await response.arrayBuffer()
    );

  return {
    bytes,
    filename,
    extension:
      getExtension(filename) ||
      attachment.extension ||
      "",
    contentType,
  };
}

function extractHwpxText(
  bytes: Uint8Array
): string {
  const zip = unzipSync(bytes);

  const sectionNames =
    Object.keys(zip)
      .filter((name) =>
        /^Contents\/section\d+\.xml$/i.test(
          name
        )
      )
      .sort((a, b) => {
        const an =
          Number(
            a.match(
              /section(\d+)\.xml/i
            )?.[1] ?? 0
          );

        const bn =
          Number(
            b.match(
              /section(\d+)\.xml/i
            )?.[1] ?? 0
          );

        return an - bn;
      });

  if (sectionNames.length === 0) {
    throw new Error(
      "HWPX 파일 안에서 본문 section XML을 찾지 못했습니다."
    );
  }

  const texts: string[] = [];

  for (const name of sectionNames) {
    const xml =
      strFromU8(zip[name]);

    const text =
      decodeXml(xml);

    if (text) {
      texts.push(text);
    }
  }

  return texts.join("\n\n");
}

async function getLatestRegulationByName(
  name: string
) {
  const items =
    await listRegulations();

  const query = name
    .replace(/\s+/g, "")
    .toLowerCase();

  const exact =
    items.find(
      (item) =>
        item.title
          .replace(/\s+/g, "")
          .toLowerCase() === query
    );

  const partial =
    items.find(
      (item) =>
        item.title
          .replace(/\s+/g, "")
          .toLowerCase()
          .includes(query)
    );

  const match = exact ?? partial;

  if (!match) {
    throw new Error(
      `"${name}"에 해당하는 규정을 찾지 못했습니다.`
    );
  }

  const detail =
    await getRegulationDetail(
      match.detailUrl
    );

  return {
    match,
    detail,
  };
}

async function getLatestRegulationText(
  name: string
) {
  const { match, detail } =
    await getLatestRegulationByName(
      name
    );

  const attachment =
    detail.latestAttachment;

  if (!attachment) {
    throw new Error(
      "최신 첨부파일을 찾지 못했습니다."
    );
  }

  const file =
    await downloadLatestFile(
      attachment
    );

  const extension =
    file.extension.toLowerCase();

  let text: string;

  if (extension === "hwpx") {
    text =
      extractHwpxText(
        file.bytes
      );
  } else if (extension === "hwp") {
    try {
      text =
        await hwpToText(
          file.bytes
        );
    } catch (error) {
      throw new Error(
        [
          "HWP 본문 추출에 실패했습니다.",
          `파일명: ${file.filename}`,
          `오류: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
          `원문: ${detail.sourceUrl}`,
        ].join("\n")
      );
    }
  } else {
    throw new Error(
      [
        `최신 규정 파일은 ${file.extension || "알 수 없는 형식"}입니다.`,
        `파일명: ${file.filename}`,
        "",
        "현재 MCP는 HWP와 HWPX 본문을 직접 읽을 수 있습니다.",
        "PDF/DOCX 등은 아직 직접 본문 추출 대상이 아닙니다.",
        `원문: ${detail.sourceUrl}`,
      ].join("\n")
    );
  }

  return {
    regulationName:
      detail.title !==
      "제목 확인 필요"
        ? detail.title
        : match.title,

    revisionDate:
      detail.revisionDate ??
      match.revisionDate,

    updatedDate:
      detail.updatedDate ??
      match.updatedDate,

    sourceUrl:
      detail.sourceUrl,

    filename:
      file.filename,

    extension:
      file.extension,

    text,
  };
}

function createServer() {
  const server = new McpServer({
    name: "ADD Regulations MCP",
    version: "1.4.0",
  });

  server.registerTool(
    "hello",
    {
      description:
        "국방과학연구소 규정 MCP 연결상태를 확인합니다.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text:
            "국방과학연구소 규정 MCP 정상 작동\n" +
            "최신 규정 우선: ON\n" +
            "HWPX 본문 읽기: ON",
        },
      ],
    })
  );

  server.registerTool(
    "diagnose_alio_list",
    {
      description:
        "ALIO 내부규정 목록 페이지의 현재 HTML 구조를 진단합니다. 문제 해결용 임시 도구입니다.",
      inputSchema: {},
    },
    async () => {
      try {
        const html = await fetchAlio(
          REGULATION_LIST_URL
        );

        const markers = {
          htmlLength: html.length,
          itemBoard21110:
            (html.match(/itemBoard21110\.do/gi) ?? []).length,
          ruleDtl:
            (html.match(/ruleDtl\.do/gi) ?? []).length,
          ruleNo:
            (html.match(/RULE_NO/gi) ?? []).length,
          addName:
            (html.match(/국방과학연구소/g) ?? []).length,
          accessDenied:
            (html.match(/access denied|forbidden|차단/gi) ?? []).length,
        };

        const interesting: string[] = [];
        const pattern =
          /[^\n]{0,220}(?:itemBoard21110\.do|ruleDtl\.do|RULE_NO|국방과학연구소)[^\n]{0,500}/gi;

        for (const match of html.matchAll(pattern)) {
          interesting.push(
            match[0]
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 700)
          );
          if (interesting.length >= 20) break;
        }

        return {
          content: [
            {
              type: "text",
              text: [
                "ALIO 목록 진단",
                `URL: ${REGULATION_LIST_URL}`,
                `HTML 길이: ${markers.htmlLength}`,
                `itemBoard21110.do: ${markers.itemBoard21110}`,
                `ruleDtl.do: ${markers.ruleDtl}`,
                `RULE_NO: ${markers.ruleNo}`,
                `국방과학연구소: ${markers.addName}`,
                `차단 문구: ${markers.accessDenied}`,
                "",
                "----- 관련 HTML 조각 -----",
                ...(interesting.length
                  ? interesting
                  : [
                      cleanHtml(html)
                        .slice(0, 4000),
                    ]),
              ].join("\n"),
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
                error instanceof Error
                  ? error.message
                  : String(error),
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "list_regulations",
    {
      description:
        "국방과학연구소의 최신 내부규정 목록을 조회합니다.",
      inputSchema: {},
    },
    async () => {
      try {
        const items =
          await listRegulations();

        const text =
          items.map(
            (item, index) =>
              `${index + 1}. ${item.title}` +
              `\n   제·개정일: ${item.revisionDate ?? "확인 필요"}` +
              `\n   최종수정일: ${item.updatedDate ?? "확인 필요"}`
          ).join("\n\n");

        return {
          content: [
            {
              type: "text",
              text:
                `국방과학연구소 최신 내부규정 ${items.length}건\n\n${text}`,
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
                error instanceof Error
                  ? error.message
                  : String(error),
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
        query:
          z.string().min(1),
      },
    },
    async ({ query }) => {
      try {
        const items =
          await listRegulations();

        const q = query
          .replace(/\s+/g, "")
          .toLowerCase();

        const matches =
          items.filter((item) =>
            item.title
              .replace(/\s+/g, "")
              .toLowerCase()
              .includes(q)
          );

        const text =
          matches.length
            ? matches
                .map(
                  (item, index) =>
                    `${index + 1}. ${item.title}` +
                    `\n   제·개정일: ${item.revisionDate ?? "확인 필요"}`
                )
                .join("\n\n")
            : "검색 결과 없음";

        return {
          content: [
            {
              type: "text",
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
                error instanceof Error
                  ? error.message
                  : String(error),
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
        "규정의 최신 첨부파일 정보만 조회합니다. 과거 개정본은 제외합니다.",
      inputSchema: {
        name:
          z.string().min(1),
      },
    },
    async ({ name }) => {
      try {
        const { match, detail } =
          await getLatestRegulationByName(
            name
          );

        const latest =
          detail.latestAttachment;

        return {
          content: [
            {
              type: "text",
              text: [
                `규정명: ${match.title}`,
                `제·개정일: ${detail.revisionDate ?? match.revisionDate ?? "확인 필요"}`,
                `최종수정일: ${detail.updatedDate ?? match.updatedDate ?? "확인 필요"}`,
                `최신파일: ${latest?.name ?? "확인 실패"}`,
                `파일형식: ${latest?.extension || "확인 필요"}`,
                `ALIO: ${detail.sourceUrl}`,
                "",
                "과거 개정본은 조회 대상에서 제외했습니다.",
              ].join("\n"),
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
                error instanceof Error
                  ? error.message
                  : String(error),
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "get_regulation_text",
    {
      description:
        "최신 HWPX 규정의 실제 본문을 읽습니다.",
      inputSchema: {
        name:
          z.string().min(1),
      },
    },
    async ({ name }) => {
      try {
        const result =
          await getLatestRegulationText(
            name
          );

        /*
         * 너무 긴 MCP 응답 방지.
         */
        const maxLength = 40000;

        const text =
          result.text.length >
          maxLength
            ? result.text.slice(
                0,
                maxLength
              ) +
              "\n\n[본문이 길어 일부 생략됨]"
            : result.text;

        return {
          content: [
            {
              type: "text",
              text: [
                `규정명: ${result.regulationName}`,
                `제·개정일: ${result.revisionDate ?? "확인 필요"}`,
                `최신파일: ${result.filename}`,
                `ALIO: ${result.sourceUrl}`,
                "",
                "----- 최신 규정 본문 -----",
                text,
              ].join("\n"),
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
                error instanceof Error
                  ? error.message
                  : String(error),
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "search_regulation_text",
    {
      description:
        "최신 HWPX 규정 본문에서 키워드 또는 조문을 검색합니다.",
      inputSchema: {
        name:
          z.string().min(1),

        query:
          z.string().min(1),
      },
    },
    async ({
      name,
      query,
    }) => {
      try {
        const result =
          await getLatestRegulationText(
            name
          );

        const text =
          result.text;

        const lowered =
          text.toLowerCase();

        const q =
          query.toLowerCase();

        const matches:
          string[] = [];

        let start = 0;

        while (
          matches.length < 10
        ) {
          const index =
            lowered.indexOf(
              q,
              start
            );

          if (index < 0) break;

          const from =
            Math.max(
              0,
              index - 300
            );

          const to =
            Math.min(
              text.length,
              index +
                query.length +
                500
            );

          matches.push(
            text
              .slice(from, to)
              .trim()
          );

          start =
            index +
            query.length;
        }

        if (
          matches.length === 0
        ) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `규정명: ${result.regulationName}`,
                  `제·개정일: ${result.revisionDate ?? "확인 필요"}`,
                  `검색어: ${query}`,
                  "",
                  "최신 규정 본문에서 해당 내용을 찾지 못했습니다.",
                ].join("\n"),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `규정명: ${result.regulationName}`,
                `제·개정일: ${result.revisionDate ?? "확인 필요"}`,
                `최신파일: ${result.filename}`,
                `검색어: ${query}`,
                `검색결과: ${matches.length}건`,
                `ALIO: ${result.sourceUrl}`,
                "",
                ...matches.map(
                  (match, index) =>
                    `----- 결과 ${index + 1} -----\n${match}`
                ),
              ].join("\n\n"),
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
                error instanceof Error
                  ? error.message
                  : String(error),
            },
          ],
        };
      }
    }
  );

  return server;
}

const MCP_RESOURCE =
  "https://add-regulations-mcp.splain0102.workers.dev/mcp";

const AUTHORIZATION_SERVER =
  "https://add-regulations-mcp.splain0102.workers.dev";

const mcpHandler = createMcpHandler(createServer);

const protectedMcpHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) {
    let rpcMethod = "unknown";
    let rpcId: string | number | null = null;
    let protocolVersion: string | undefined;

    try {
      const body = await request.clone().json() as any;
      rpcMethod =
        typeof body?.method === "string"
          ? body.method
          : "unknown";
      rpcId =
        typeof body?.id === "string" ||
        typeof body?.id === "number"
          ? body.id
          : null;
      protocolVersion =
        typeof body?.params?.protocolVersion === "string"
          ? body.params.protocolVersion
          : undefined;
    } catch {
      // Some MCP requests may not contain a JSON body.
    }

    console.log("MCP request", {
      method: request.method,
      rpcMethod,
      rpcId,
      protocolVersion,
      contentType: request.headers.get("content-type"),
      accept: request.headers.get("accept"),
      hasAuthorization:
        request.headers.has("authorization"),
    });

    try {
      const response =
        await mcpHandler(request, env, ctx);

      const responseText =
        await response.clone().text();

      console.log("MCP response", {
        rpcMethod,
        rpcId,
        status: response.status,
        contentType:
          response.headers.get("content-type"),
        sessionId:
          response.headers.get("mcp-session-id"),
        bodyPreview:
          responseText.slice(0, 4000),
      });

      return response;
    } catch (error) {
      console.error("MCP handler exception", {
        rpcMethod,
        rpcId,
        error:
          error instanceof Error
            ? error.stack ?? error.message
            : String(error),
      });
      throw error;
    }
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: protectedMcpHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",

  scopesSupported: ["mcp:read"],

  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [AUTHORIZATION_SERVER],
    scopes_supported: ["mcp:read"],
    bearer_methods_supported: ["header"],
    resource_name: "ADD Regulations MCP",
  },

  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/register",

  defaultHandler: {
    fetch: handleAccessRequest,
  },
});
