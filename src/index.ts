import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { unzipSync, strFromU8 } from "fflate";
import { HwpxReader, hwpToMarkdown, hwpToText, parseHwp } from "@ssabrojs/hwpxjs/browser";
import { extractText } from "unpdf";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  maxAttempts = 3
): Promise<Response> {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      const response =
        await fetch(url, init);

      const retryable =
        response.status === 429 ||
        response.status >= 500;

      if (
        !retryable ||
        attempt === maxAttempts
      ) {
        return response;
      }

      console.warn(
        "ALIO transient HTTP error; retrying",
        {
          url,
          status: response.status,
          attempt,
          maxAttempts,
        }
      );
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) {
        throw error;
      }

      console.warn(
        "ALIO fetch exception; retrying",
        {
          url,
          attempt,
          maxAttempts,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }

    await sleep(400 * attempt);
  }

  throw (
    lastError instanceof Error
      ? lastError
      : new Error("ALIO 요청 재시도 실패")
  );
}

async function fetchAlio(url: string): Promise<string> {
  const response = await fetchWithRetry(url, {
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

  const response = await fetchWithRetry(endpoint, {
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
  const response = await fetchWithRetry(
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


type StructuredTableCell = {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
};

type StructuredTable = {
  index: number;
  rowCount: number;
  colCount: number;
  cells: StructuredTableCell[];
};

function normalizeTableSearch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\\s,]+/g, "");
}

function paragraphPlainText(paragraph: any): string {
  const runText =
    Array.isArray(paragraph?.runs)
      ? paragraph.runs
          .map((run: any) =>
            typeof run?.text === "string"
              ? run.text
              : ""
          )
          .join("")
      : "";

  const direct =
    typeof paragraph?.text === "string"
      ? paragraph.text
      : "";

  const nested: string[] = [];

  for (const control of paragraph?.controls ?? []) {
    if (control?.kind === "table") {
      for (const cell of control.cells ?? []) {
        const text = (cell.paragraphs ?? [])
          .map((p: any) => paragraphPlainText(p))
          .filter(Boolean)
          .join(" ");
        if (text) nested.push(text);
      }
    }
  }

  return [runText || direct, ...nested]
    .filter(Boolean)
    .join(" ")
    .replace(/\\s+/g, " ")
    .trim();
}

function extractHwpTables(
  bytes: Uint8Array
): StructuredTable[] {
  const doc = parseHwp(bytes);
  const tables: StructuredTable[] = [];

  for (const section of doc.sections ?? []) {
    for (const paragraph of section.paragraphs ?? []) {
      for (const control of paragraph.controls ?? []) {
        if (control?.kind !== "table") continue;

        const cells: StructuredTableCell[] =
          (control.cells ?? []).map((cell: any) => ({
            row: Number(cell.row ?? 0),
            col: Number(cell.col ?? 0),
            rowSpan: Math.max(1, Number(cell.rowSpan ?? 1)),
            colSpan: Math.max(1, Number(cell.colSpan ?? 1)),
            text: (cell.paragraphs ?? [])
              .map((p: any) => paragraphPlainText(p))
              .filter(Boolean)
              .join(" ")
              .replace(/\\s+/g, " ")
              .trim(),
          }));

        tables.push({
          index: tables.length,
          rowCount: Number(control.rowCount ?? 0),
          colCount: Number(control.colCount ?? 0),
          cells,
        });
      }
    }
  }

  return tables;
}

function htmlEntityDecode(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function htmlCellText(value: string): string {
  return htmlEntityDecode(
    value
      .replace(/<br\\s*\\/?\\s*>/gi, "\\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\\s+/g, " ")
    .trim();
}

function extractTablesFromRenderedHtml(
  html: string
): StructuredTable[] {
  const tables: StructuredTable[] = [];

  for (const tableMatch of html.matchAll(
    /<table\\b[^>]*>([\\s\\S]*?)<\\/table>/gi
  )) {
    const body = tableMatch[1] ?? "";
    const cells: StructuredTableCell[] = [];
    const occupied = new Set<string>();
    let rowIndex = 0;
    let maxCol = 0;

    for (const rowMatch of body.matchAll(
      /<tr\\b[^>]*>([\\s\\S]*?)<\\/tr>/gi
    )) {
      const rowHtml = rowMatch[1] ?? "";
      let colIndex = 0;

      for (const cellMatch of rowHtml.matchAll(
        /<t[dh]\\b([^>]*)>([\\s\\S]*?)<\\/t[dh]>/gi
      )) {
        while (occupied.has(`${rowIndex}:${colIndex}`)) {
          colIndex++;
        }

        const attrs = cellMatch[1] ?? "";
        const text = htmlCellText(cellMatch[2] ?? "");
        const rowSpan =
          Math.max(
            1,
            Number(
              attrs.match(
                /rowspan=["']?(\\d+)/i
              )?.[1] ?? 1
            )
          );
        const colSpan =
          Math.max(
            1,
            Number(
              attrs.match(
                /colspan=["']?(\\d+)/i
              )?.[1] ?? 1
            )
          );

        cells.push({
          row: rowIndex,
          col: colIndex,
          rowSpan,
          colSpan,
          text,
        });

        for (let r = 0; r < rowSpan; r++) {
          for (let col = 0; col < colSpan; col++) {
            occupied.add(
              `${rowIndex + r}:${colIndex + col}`
            );
          }
        }

        maxCol = Math.max(
          maxCol,
          colIndex + colSpan
        );
        colIndex += colSpan;
      }

      rowIndex++;
    }

    tables.push({
      index: tables.length,
      rowCount: rowIndex,
      colCount: maxCol,
      cells,
    });
  }

  return tables;
}

function toArrayBuffer(
  bytes: Uint8Array
): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

async function extractHwpxRichContent(
  bytes: Uint8Array
): Promise<{
  markdown: string;
  tables: StructuredTable[];
}> {
  const reader = new HwpxReader();
  await reader.loadFromArrayBuffer(
    toArrayBuffer(bytes)
  );

  const [markdown, html] =
    await Promise.all([
      reader.extractMarkdown({
        embedImages: false,
      }),
      reader.extractHtml({
        renderImages: false,
        renderTables: true,
        renderStyles: false,
        tableHeaderFirstRow: false,
      }),
    ]);

  return {
    markdown,
    tables:
      extractTablesFromRenderedHtml(html),
  };
}

function tableCellsForRow(
  table: StructuredTable,
  row: number
): StructuredTableCell[] {
  return table.cells
    .filter(
      (cell) =>
        cell.row <= row &&
        row < cell.row + cell.rowSpan
    )
    .sort((a, b) => a.col - b.col);
}

function compactCell(
  cell: StructuredTableCell
): string {
  const endCol =
    cell.col + cell.colSpan - 1;
  const coord =
    cell.colSpan > 1
      ? `c${cell.col}-c${endCol}`
      : `c${cell.col}`;

  const span =
    [
      cell.rowSpan > 1
        ? `rowSpan=${cell.rowSpan}`
        : "",
      cell.colSpan > 1
        ? `colSpan=${cell.colSpan}`
        : "",
    ]
      .filter(Boolean)
      .join(",");

  return (
    `[${coord}${span ? `; ${span}` : ""}] ` +
    (cell.text || "(빈칸)")
  );
}

function renderTableRow(
  table: StructuredTable,
  row: number
): string {
  const cells =
    tableCellsForRow(table, row);

  return (
    `행 ${row}: ` +
    cells.map(compactCell).join(" | ")
  );
}

function searchStructuredTables(
  tables: StructuredTable[],
  query: string,
  limit = 8
): {
  table: StructuredTable;
  cell: StructuredTableCell;
}[] {
  const q = normalizeTableSearch(query);

  if (!q) return [];

  const results: {
    table: StructuredTable;
    cell: StructuredTableCell;
  }[] = [];

  for (const table of tables) {
    for (const cell of table.cells) {
      if (
        normalizeTableSearch(cell.text)
          .includes(q)
      ) {
        results.push({
          table,
          cell,
        });

        if (results.length >= limit) {
          return results;
        }
      }
    }
  }

  return results;
}

function renderStructuredTableMatch(
  table: StructuredTable,
  cell: StructuredTableCell
): string {
  const headerRows =
    Array.from(
      new Set(
        table.cells
          .filter(
            (candidate) =>
              candidate.row <= 2 &&
              candidate.text
          )
          .map((candidate) => candidate.row)
      )
    )
      .sort((a, b) => a - b)
      .slice(0, 3);

  const nearbyRows =
    Array.from(
      new Set([
        Math.max(0, cell.row - 1),
        cell.row,
        Math.min(
          table.rowCount - 1,
          cell.row + 1
        ),
      ])
    ).sort((a, b) => a - b);

  const rows =
    Array.from(
      new Set([
        ...headerRows,
        ...nearbyRows,
      ])
    ).sort((a, b) => a - b);

  const endRow =
    cell.row + cell.rowSpan - 1;
  const endCol =
    cell.col + cell.colSpan - 1;

  return [
    `표 ${table.index + 1} (${table.rowCount}행 × ${table.colCount}열)`,
    `일치 셀: r${cell.row}${cell.rowSpan > 1 ? `-r${endRow}` : ""}, c${cell.col}${cell.colSpan > 1 ? `-c${endCol}` : ""}`,
    `일치 내용: ${cell.text || "(빈칸)"}`,
    "행·열 문맥:",
    ...rows.map(
      (row) => renderTableRow(
        table,
        row
      )
    ),
  ].join("\\n");
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
  let markdown: string | undefined;
  let tables: StructuredTable[] = [];

  if (extension === "hwpx") {
    text =
      extractHwpxText(
        file.bytes
      );

    try {
      const rich =
        await extractHwpxRichContent(
          file.bytes
        );
      markdown = rich.markdown;
      tables = rich.tables;
    } catch (error) {
      console.warn(
        "HWPX rich extraction failed; plain text fallback used",
        {
          filename: file.filename,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    }
  } else if (extension === "hwp") {
    try {
      text =
        await hwpToText(
          file.bytes
        );

      const [mdResult, tableResult] =
        await Promise.allSettled([
          hwpToMarkdown(
            file.bytes
          ),
          Promise.resolve(
            extractHwpTables(
              file.bytes
            )
          ),
        ]);

      if (
        mdResult.status === "fulfilled"
      ) {
        markdown =
          mdResult.value;
      }

      if (
        tableResult.status === "fulfilled"
      ) {
        tables =
          tableResult.value;
      }
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
        ].join("\\n")
      );
    }
  } else if (extension === "pdf") {
    try {
      const extracted =
        await extractText(
          file.bytes,
          { mergePages: true }
        );

      text =
        Array.isArray(extracted.text)
          ? extracted.text.join("\\n\\n")
          : extracted.text;

      if (!text.trim()) {
        throw new Error(
          "PDF에 추출 가능한 텍스트가 없습니다. 스캔 이미지 PDF일 수 있습니다."
        );
      }
    } catch (error) {
      throw new Error(
        [
          "PDF 본문 추출에 실패했습니다.",
          `파일명: ${file.filename}`,
          `오류: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
          `원문: ${detail.sourceUrl}`,
        ].join("\\n")
      );
    }
  } else {
    throw new Error(
      [
        `최신 규정 파일은 ${file.extension || "알 수 없는 형식"}입니다.`,
        `파일명: ${file.filename}`,
        "",
        "현재 MCP는 HWP, HWPX, 텍스트형 PDF 본문을 직접 읽을 수 있습니다.",
        "스캔 PDF나 DOCX 등은 아직 직접 본문 추출 대상이 아닙니다.",
        `원문: ${detail.sourceUrl}`,
      ].join("\\n")
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
    markdown,
    tables,
  };
}

function extractArticleSnippet(
  text: string,
  matchIndex: number,
  queryLength: number
): {
  label: string;
  snippet: string;
} {
  const articleRegex =
    /(?:^|\n)\s*(제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?)/g;

  const headings: {
    index: number;
    label: string;
  }[] = [];

  for (const match of text.matchAll(articleRegex)) {
    if (
      typeof match.index === "number" &&
      match[1]
    ) {
      headings.push({
        index: match.index,
        label:
          match[1]
            .replace(/\s+/g, " ")
            .trim(),
      });
    }
  }

  let current:
    | { index: number; label: string }
    | undefined;

  let nextIndex = text.length;

  for (const heading of headings) {
    if (heading.index <= matchIndex) {
      current = heading;
      continue;
    }

    nextIndex = heading.index;
    break;
  }

  let from =
    current?.index ??
    text.lastIndexOf("\n", matchIndex);

  if (from < 0) {
    from = Math.max(0, matchIndex - 250);
  }

  let to =
    current
      ? nextIndex
      : text.indexOf("\n\n", matchIndex + queryLength);

  if (to < 0) {
    to = Math.min(
      text.length,
      matchIndex + queryLength + 600
    );
  }

  const maxSnippetLength = 2200;

  if (to - from > maxSnippetLength) {
    const aroundFrom = Math.max(
      from,
      matchIndex - 500
    );
    const aroundTo = Math.min(
      to,
      matchIndex + queryLength + 1200
    );

    from = aroundFrom;
    to = aroundTo;
  }

  return {
    label:
      current?.label ??
      "관련 본문",
    snippet:
      text
        .slice(from, to)
        .trim(),
  };
}

function createServer() {
  const server = new McpServer({
    name: "ADD Regulations MCP",
    version: "1.7.0",
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
            "HWP/HWPX/PDF 본문 읽기: ON\n" +
            "HWP/HWPX 표 구조 인식: ON",
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
        "최신 HWP/HWPX/PDF 규정의 실제 본문을 읽습니다. HWP/HWPX는 표를 Markdown으로 표현하고 표 구조를 별도로 인식합니다.",
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

        const preferredText =
          result.markdown?.trim()
            ? result.markdown
            : result.text;

        const text =
          preferredText.length >
          maxLength
            ? preferredText.slice(
                0,
                maxLength
              ) +
              "\n\n[본문이 길어 일부 생략됨]"
            : preferredText;

        const tableNotice =
          result.tables.length > 0
            ? [
                `구조 인식 표: ${result.tables.length}개`,
                "※ HWP/HWPX 표의 행·열·병합셀 구조를 별도로 인식했습니다.",
                "※ 복잡한 표는 search_regulation_text에서 검색어와 같은 셀의 행·열 문맥을 함께 반환합니다.",
              ]
            : [];

        return {
          content: [
            {
              type: "text",
              text: [
                `규정명: ${result.regulationName}`,
                `제·개정일: ${result.revisionDate ?? "확인 필요"}`,
                `최신파일: ${result.filename}`,
                `ALIO: ${result.sourceUrl}`,
                ...tableNotice,
                "",
                `----- 최신 규정 본문${result.markdown ? " (Markdown)" : ""} -----`,
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
        "최신 HWP/HWPX/PDF 규정 본문에서 키워드 또는 조문을 검색합니다. HWP/HWPX 표에서는 공백·쉼표 차이를 무시하고 셀 및 병합셀의 행·열 문맥도 함께 검색합니다.",
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

        const tableMatches =
          searchStructuredTables(
            result.tables,
            query,
            8
          );

        const lowered =
          text.toLowerCase();

        const q =
          query.toLowerCase();

        const matches: {
          label: string;
          snippet: string;
        }[] = [];

        const seenSnippets =
          new Set<string>();

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

          const resultSnippet =
            extractArticleSnippet(
              text,
              index,
              query.length
            );

          const dedupeKey =
            `${resultSnippet.label}::${resultSnippet.snippet}`;

          if (
            !seenSnippets.has(dedupeKey)
          ) {
            seenSnippets.add(
              dedupeKey
            );
            matches.push(
              resultSnippet
            );
          }

          start =
            index +
            Math.max(
              query.length,
              1
            );
        }

        if (
          matches.length === 0 &&
          tableMatches.length === 0
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
                `본문 검색결과: ${matches.length}건`,
                `표 구조 검색결과: ${tableMatches.length}건`,
                `ALIO: ${result.sourceUrl}`,
                "",
                ...tableMatches.map(
                  ({ table, cell }, index) =>
                    [
                      `===== 표 구조 결과 ${index + 1} =====`,
                      renderStructuredTableMatch(
                        table,
                        cell
                      ),
                    ].join("\n")
                ),
                ...(tableMatches.length
                  ? [""]
                  : []),
                ...matches.map(
                  (match, index) =>
                    [
                      `----- 본문 결과 ${index + 1}: ${match.label} -----`,
                      match.snippet,
                    ].join("\n")
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
