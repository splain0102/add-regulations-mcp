import { searchLatestRegulationTable, listRegulations as coreListRegulations, getLatestRegulationText as coreGetLatestRegulationText } from "./regulation-core/regulations";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { unzipSync, strFromU8 } from "fflate";
import { HwpxReader, hwpToMarkdown, hwpToText, parseHwp } from "@ssabrojs/hwpxjs/browser";
import { extractText, extractTextItems, getDocumentProxy } from "unpdf";
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
    .replace(/[\s,]+/g, "");
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
    .replace(/\s+/g, " ")
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
              .replace(/\s+/g, " ")
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
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractTablesFromRenderedHtml(
  html: string
): StructuredTable[] {
  const tables: StructuredTable[] = [];

  for (const tableMatch of html.matchAll(
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi
  )) {
    const body = tableMatch[1] ?? "";
    const cells: StructuredTableCell[] = [];
    const occupied = new Set<string>();
    let rowIndex = 0;
    let maxCol = 0;

    for (const rowMatch of body.matchAll(
      /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    )) {
      const rowHtml = rowMatch[1] ?? "";
      let colIndex = 0;

      for (const cellMatch of rowHtml.matchAll(
        /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi
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
                /rowspan=["']?(\d+)/i
              )?.[1] ?? 1
            )
          );
        const colSpan =
          Math.max(
            1,
            Number(
              attrs.match(
                /colspan=["']?(\d+)/i
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
  row: number;
  mode: "cell" | "row";
}[] {
  const q = normalizeTableSearch(query);

  if (!q) return [];

  const results: {
    table: StructuredTable;
    cell: StructuredTableCell;
    row: number;
    mode: "cell" | "row";
  }[] = [];

  const seen = new Set<string>();

  for (const table of tables) {
    for (const cell of table.cells) {
      if (
        normalizeTableSearch(cell.text)
          .includes(q)
      ) {
        const key =
          `${table.index}:cell:${cell.row}:${cell.col}`;

        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            table,
            cell,
            row: cell.row,
            mode: "cell",
          });
        }

        if (results.length >= limit) {
          return results;
        }
      }
    }
  }

  const tokens = query
    .normalize("NFKC")
    .split(/[\s,;/]+/)
    .map((token) =>
      normalizeTableSearch(token)
    )
    .filter(Boolean);

  if (tokens.length >= 2) {
    for (const table of tables) {
      for (let row = 0; row < table.rowCount; row++) {
        const rowCells =
          tableCellsForRow(table, row);
        const rowText =
          normalizeTableSearch(
            rowCells
              .map((cell) => cell.text)
              .join(" ")
          );

        if (
          tokens.every((token) =>
            rowText.includes(token)
          )
        ) {
          const anchor =
            rowCells.find((cell) =>
              cell.text.trim()
            );

          if (!anchor) continue;

          const key =
            `${table.index}:row:${row}`;

          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              table,
              cell: anchor,
              row,
              mode: "row",
            });
          }

          if (results.length >= limit) {
            return results;
          }
        }
      }
    }
  }

  return results;
}

function renderStructuredTableMatch(
  table: StructuredTable,
  cell: StructuredTableCell,
  row: number,
  mode: "cell" | "row"
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
        Math.max(0, row - 1),
        row,
        Math.min(
          table.rowCount - 1,
          row + 1
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

  const matchInfo =
    mode === "row"
      ? [
          "일치 방식: 같은 행의 여러 셀 복합 일치",
          `기준 행: r${row}`,
        ]
      : [
          "일치 방식: 셀 일치",
          `일치 셀: r${cell.row}${cell.rowSpan > 1 ? `-r${endRow}` : ""}, c${cell.col}${cell.colSpan > 1 ? `-c${endCol}` : ""}`,
          `일치 내용: ${cell.text || "(빈칸)"}`,
        ];

  return [
    `표 ${table.index + 1} (${table.rowCount}행 × ${table.colCount}열)`,
    ...matchInfo,
    "행·열 문맥:",
    ...rows.map(
      (targetRow) => renderTableRow(
        table,
        targetRow
      )
    ),
  ].join("\n");
}

type PdfPositionedItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
};

type PdfLayoutSegment = {
  x: number;
  xEnd: number;
  text: string;
  fontSize: number;
  sourceItems: PdfPositionedItem[];
};

type PdfLayoutRow = {
  page: number;
  row: number;
  y: number;
  fontMedian: number;
  segments: PdfLayoutSegment[];
  text: string;
};

type PdfHeaderColumn = {
  name: string;
  x: number;
  xEnd: number;
  xCenter: number;
  text: string;
  rowOffsets: number[];
  parts: {
    rowOffset: number;
    x: number;
    xEnd: number;
    text: string;
  }[];
};

type PdfHeaderCandidate = {
  start: number;
  count: number;
  matched: number;
  order: string[];
  multilineCount: number;
  columns: PdfHeaderColumn[];
  score: number;
};

type PdfSymbolCoordinate = {
  symbol: "◎" | "★" | "☆";
  x0: number;
  x1: number;
  xCenter: number;
  y: number;
  suffix: string | null;
  coordinateType: "pdf_point";
  precision: "raw-item-exact" | "glyph-width-estimate";
};

type PdfLayoutPage = {
  page: number;
  rows: PdfLayoutRow[];
};

const MAX_PDF_LAYOUT_PAGES = 80;

function medianNumber(
  values: number[]
): number {
  const sorted =
    values
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  if (sorted.length === 0) {
    return 0;
  }

  const middle =
    Math.floor(
      sorted.length / 2
    );

  return sorted.length % 2
    ? sorted[middle]
    : (
        sorted[middle - 1] +
        sorted[middle]
      ) / 2;
}

function groupPdfLayoutRows(
  items: any[],
  page: number
): PdfLayoutRow[] {
  const usable =
    items
      .filter(
        (item) =>
          typeof item?.str === "string" &&
          item.str.trim()
      )
      .map((item) => ({
        ...item,
        str:
          item.str
            .replace(/\s+/g, " ")
            .trim(),
        x: Number(item.x) || 0,
        y: Number(item.y) || 0,
        width: Number(item.width) || 0,
        fontSize: Number(item.fontSize) || 0,
      }))
      .sort(
        (a, b) =>
          b.y - a.y ||
          a.x - b.x
      );

  if (usable.length === 0) {
    return [];
  }

  const fontMedian =
    medianNumber(
      usable.map(
        (item) =>
          Number(item.fontSize) || 0
      )
    ) || 10;

  const yTolerance =
    Math.max(
      1.5,
      Math.min(
        4,
        fontMedian * 0.28
      )
    );

  const grouped: {
    y: number;
    items: any[];
  }[] = [];

  for (const item of usable) {
    let best:
      | {
          y: number;
          items: any[];
        }
      | undefined;

    let bestDistance =
      Number.POSITIVE_INFINITY;

    for (
      let index =
        Math.max(
          0,
          grouped.length - 4
        );
      index < grouped.length;
      index++
    ) {
      const candidate =
        grouped[index];

      const distance =
        Math.abs(
          candidate.y - item.y
        );

      if (
        distance <= yTolerance &&
        distance < bestDistance
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }

    if (!best) {
      best = {
        y: item.y,
        items: [],
      };

      grouped.push(best);
    }

    best.items.push(item);
    best.y =
      best.items.reduce(
        (sum, value) =>
          sum + value.y,
        0
      ) /
      best.items.length;
  }

  return grouped
    .sort(
      (a, b) =>
        b.y - a.y
    )
    .map(
      (group, rowIndex) => {
        const rowItems =
          [...group.items]
            .sort(
              (a, b) =>
                a.x - b.x
            );

        const positiveGaps:
          number[] = [];

        for (
          let index = 1;
          index < rowItems.length;
          index++
        ) {
          const previous =
            rowItems[index - 1];

          const current =
            rowItems[index];

          const gap =
            current.x -
            (
              previous.x +
              previous.width
            );

          if (gap > 0) {
            positiveGaps.push(
              gap
            );
          }
        }

        const gapMedian =
          medianNumber(
            positiveGaps
          ) ||
          fontMedian * 0.3;

        const splitThreshold =
          Math.max(
            fontMedian * 1.1,
            gapMedian * 3,
            10
          );

        const segments:
          PdfLayoutSegment[] = [];

        let current:
          | PdfLayoutSegment
          | undefined;

        for (
          const item of rowItems
        ) {
          const x =
            Number(item.x) || 0;

          const xEnd =
            x +
            (
              Number(
                item.width
              ) || 0
            );

          if (!current) {
            current = {
              x,
              xEnd,
              text: item.str,
              fontSize:
                Number(item.fontSize) ||
                fontMedian,
              sourceItems: [
                {
                  str: item.str,
                  x,
                  y: Number(item.y) || group.y,
                  width: Number(item.width) || 0,
                  fontSize:
                    Number(item.fontSize) ||
                    fontMedian,
                },
              ],
            };
            continue;
          }

          const gap =
            x -
            current.xEnd;

          if (
            gap >
            splitThreshold
          ) {
            segments.push(
              current
            );

            current = {
              x,
              xEnd,
              text: item.str,
              fontSize:
                Number(item.fontSize) ||
                fontMedian,
              sourceItems: [
                {
                  str: item.str,
                  x,
                  y: Number(item.y) || group.y,
                  width: Number(item.width) || 0,
                  fontSize:
                    Number(item.fontSize) ||
                    fontMedian,
                },
              ],
            };

            continue;
          }

          current.text +=
            gap >
            fontMedian * 0.15
              ? ` ${item.str}`
              : item.str;

          current.xEnd =
            Math.max(
              current.xEnd,
              xEnd
            );

          current.sourceItems.push({
            str: item.str,
            x,
            y: Number(item.y) || group.y,
            width: Number(item.width) || 0,
            fontSize:
              Number(item.fontSize) ||
              fontMedian,
          });
        }

        if (current) {
          segments.push(
            current
          );
        }

        return {
          page,
          row: rowIndex,
          y: group.y,
          fontMedian,
          segments,
          text:
            segments
              .map(
                (segment) =>
                  segment.text
              )
              .join(" | "),
        };
      }
    );
}

const PDF_DELEGATION_HEADERS = [
  "사책/과책",
  "운영",
  "실장",
  "부(센터)장",
  "원장/기술센터장",
  "부소장",
  "소장",
] as const;

const PDF_LEGACY_DELEGATION_HEADERS = [
  "사책/과책",
  "운영",
  "실장",
] as const;

function normalizePdfHeader(
  value: string
): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,]+/g, "")
    .replace(/[\/()·ㆍ.\-]/g, "");
}

function pdfHorizontalOverlap(
  a: { x: number; xEnd: number },
  b: { x: number; xEnd: number }
): number {
  return Math.max(
    0,
    Math.min(a.xEnd, b.xEnd) -
      Math.max(a.x, b.x)
  );
}

function pdfCenter(
  value: { x: number; xEnd: number }
): number {
  return (value.x + value.xEnd) / 2;
}

function rawPdfItemsInRow(
  row: PdfLayoutRow
): PdfPositionedItem[] {
  return row.segments
    .flatMap(
      (segment) =>
        segment.sourceItems?.length
          ? segment.sourceItems
          : [
              {
                str: segment.text,
                x: segment.x,
                y: row.y,
                width:
                  segment.xEnd -
                  segment.x,
                fontSize:
                  segment.fontSize ||
                  row.fontMedian,
              },
            ]
    )
    .filter(
      (item) =>
        item.str.trim().length > 0
    )
    .sort(
      (a, b) =>
        a.x - b.x
    );
}

function clusterPdfHeaderSegments(
  rows: PdfLayoutRow[],
  start: number,
  count: number,
  expectedHeaders: readonly string[]
): {
  x: number;
  xEnd: number;
  xCenter: number;
  text: string;
  normalized: string;
  rowOffsets: number[];
  parts: {
    rowOffset: number;
    x: number;
    xEnd: number;
    text: string;
  }[];
}[] {
  const nodes: {
    x: number;
    xEnd: number;
    text: string;
    rowOffset: number;
    fontSize: number;
  }[] = [];

  for (
    let offset = 0;
    offset < count;
    offset++
  ) {
    const row =
      rows[start + offset];

    if (!row) continue;

    for (
      const item of
      rawPdfItemsInRow(row)
    ) {
      nodes.push({
        x: item.x,
        xEnd:
          item.x +
          item.width,
        text: item.str,
        rowOffset: offset,
        fontSize:
          item.fontSize ||
          row.fontMedian ||
          9,
      });
    }
  }

  const expected =
    expectedHeaders.map(
      (name) => ({
        name,
        normalized:
          normalizePdfHeader(
            name
          ),
      })
    );

  const expectedSet =
    new Set(
      expected.map(
        (item) =>
          item.normalized
      )
    );

  const ordered =
    [...nodes].sort(
      (a, b) =>
        a.rowOffset -
          b.rowOffset ||
        a.x - b.x
    );

  const related = (
    a: typeof ordered[number],
    b: typeof ordered[number]
  ): boolean => {
    const widthA =
      Math.max(
        1,
        a.xEnd - a.x
      );

    const widthB =
      Math.max(
        1,
        b.xEnd - b.x
      );

    if (
      a.rowOffset ===
      b.rowOffset
    ) {
      const left =
        a.x <= b.x
          ? a
          : b;

      const right =
        left === a
          ? b
          : a;

      const gap =
        Math.max(
          0,
          right.x -
            left.xEnd
        );

      const font =
        Math.max(
          1,
          Math.min(
            a.fontSize,
            b.fontSize
          )
        );

      return (
        gap <=
        Math.max(
          8,
          font * 1.8
        )
      );
    }

    const overlap =
      pdfHorizontalOverlap(
        a,
        b
      );

    const overlapRatio =
      overlap /
      Math.min(
        widthA,
        widthB
      );

    const centerDistance =
      Math.abs(
        pdfCenter(a) -
          pdfCenter(b)
      );

    return (
      overlapRatio >= 0.18 ||
      centerDistance <=
        Math.max(
          6,
          Math.min(
            widthA,
            widthB
          ) * 0.6
        )
    );
  };

  const connected = (
    combo:
      typeof ordered
  ): boolean => {
    if (
      combo.length <= 1
    ) {
      return true;
    }

    const visited =
      new Set<number>([0]);

    let changed = true;

    while (changed) {
      changed = false;

      for (
        let i = 0;
        i < combo.length;
        i++
      ) {
        if (
          !visited.has(i)
        ) {
          continue;
        }

        for (
          let j = 0;
          j < combo.length;
          j++
        ) {
          if (
            visited.has(j)
          ) {
            continue;
          }

          if (
            related(
              combo[i],
              combo[j]
            )
          ) {
            visited.add(j);
            changed = true;
          }
        }
      }
    }

    return (
      visited.size ===
      combo.length
    );
  };

  const build = (
    combo:
      typeof ordered
  ) => {
    const comboOrdered =
      [...combo].sort(
        (a, b) =>
          a.rowOffset -
            b.rowOffset ||
          a.x - b.x
      );

    const text =
      comboOrdered
        .map(
          (node) =>
            node.text
        )
        .join(" ");

    const x =
      Math.min(
        ...comboOrdered.map(
          (node) =>
            node.x
        )
      );

    const xEnd =
      Math.max(
        ...comboOrdered.map(
          (node) =>
            node.xEnd
        )
      );

    return {
      x,
      xEnd,
      xCenter:
        (x + xEnd) / 2,
      text,
      normalized:
        normalizePdfHeader(
          text
        ),
      rowOffsets:
        Array.from(
          new Set(
            comboOrdered.map(
              (node) =>
                node.rowOffset
            )
          )
        ),
      parts:
        comboOrdered.map(
          (node) => ({
            rowOffset:
              node.rowOffset,
            x: node.x,
            xEnd:
              node.xEnd,
            text:
              node.text,
          })
        ),
    };
  };

  const candidates:
    ReturnType<
      typeof build
    >[] = [];

  for (
    let i = 0;
    i < ordered.length;
    i++
  ) {
    const one =
      build([
        ordered[i],
      ]);

    if (
      expectedSet.has(
        one.normalized
      )
    ) {
      candidates.push(one);
    }

    for (
      let j = i + 1;
      j < ordered.length;
      j++
    ) {
      const pair = [
        ordered[i],
        ordered[j],
      ];

      if (
        !connected(pair)
      ) {
        continue;
      }

      const pairCandidate =
        build(pair);

      if (
        expectedSet.has(
          pairCandidate.normalized
        )
      ) {
        candidates.push(
          pairCandidate
        );
      }

      for (
        let k = j + 1;
        k < ordered.length;
        k++
      ) {
        const triple = [
          ordered[i],
          ordered[j],
          ordered[k],
        ];

        if (
          !connected(triple)
        ) {
          continue;
        }

        const tripleCandidate =
          build(triple);

        if (
          expectedSet.has(
            tripleCandidate.normalized
          )
        ) {
          candidates.push(
            tripleCandidate
          );
        }
      }
    }
  }

  return expected
    .map((target) => {
      const matches =
        candidates
          .filter(
            (candidate) =>
              candidate.normalized ===
              target.normalized
          )
          .sort(
            (a, b) => {
              if (
                a.rowOffsets.length !==
                b.rowOffsets.length
              ) {
                return (
                  b.rowOffsets.length -
                  a.rowOffsets.length
                );
              }

              const widthA =
                a.xEnd -
                a.x;

              const widthB =
                b.xEnd -
                b.x;

              if (
                widthA !==
                widthB
              ) {
                return (
                  widthA -
                  widthB
                );
              }

              return (
                a.x -
                b.x
              );
            }
          );

      return matches[0];
    })
    .filter(
      (
        candidate
      ): candidate is
        NonNullable<
          typeof candidate
        > =>
        Boolean(
          candidate
        )
    );
}

function detectPdfHeaderCandidate(
  rows: PdfLayoutRow[],
  expectedHeaders:
    readonly string[]
): PdfHeaderCandidate | null {
  let best:
    PdfHeaderCandidate |
    null = null;

  for (
    let start = 0;
    start < rows.length;
    start++
  ) {
    for (
      const count of [
        1,
        2,
        3,
      ]
    ) {
      if (
        start + count >
        rows.length
      ) {
        continue;
      }

      const clusters =
        clusterPdfHeaderSegments(
          rows,
          start,
          count,
          expectedHeaders
        );

      const columns:
        PdfHeaderColumn[] =
        expectedHeaders
          .map(
            (name) => {
              const normalized =
                normalizePdfHeader(
                  name
                );

              const hit =
                clusters.find(
                  (cluster) =>
                    cluster.normalized ===
                    normalized
                );

              if (!hit) {
                return null;
              }

              return {
                name,
                x:
                  hit.x,
                xEnd:
                  hit.xEnd,
                xCenter:
                  hit.xCenter,
                text:
                  hit.text,
                rowOffsets:
                  hit.rowOffsets,
                parts:
                  hit.parts,
              };
            }
          )
          .filter(
            (
              column
            ): column is
              PdfHeaderColumn =>
              Boolean(
                column
              )
          )
          .sort(
            (a, b) =>
              a.xCenter -
              b.xCenter
          );

      const order =
        columns.map(
          (column) =>
            column.name
        );

      const exactOrderPrefix =
        order.every(
          (
            name,
            index
          ) =>
            name ===
            expectedHeaders[
              index
            ]
        );

      const multilineCount =
        columns.filter(
          (column) =>
            column.rowOffsets
              .length > 1
        ).length;

      const score =
        columns.length *
          100 +
        (
          exactOrderPrefix
            ? 20
            : 0
        ) +
        multilineCount *
          2 -
        count;

      if (
        !best ||
        score >
          best.score
      ) {
        best = {
          start,
          count,
          matched:
            columns.length,
          order,
          multilineCount,
          columns,
          score,
        };
      }
    }
  }

  return best;
}

function detectKnownPdfHeader(
  rows: PdfLayoutRow[]
): PdfHeaderCandidate | null {
  const candidates =
    [
      PDF_DELEGATION_HEADERS,
      PDF_LEGACY_DELEGATION_HEADERS,
    ]
      .map(
        (headers) => ({
          headers,
          candidate:
            detectPdfHeaderCandidate(
              rows,
              headers
            ),
        })
      )
      .filter(
        (
          item
        ): item is {
          headers:
            readonly string[];
          candidate:
            PdfHeaderCandidate;
        } =>
          Boolean(
            item.candidate
          )
      );

  const complete =
    candidates
      .filter(
        ({ headers, candidate }) =>
          candidate.matched ===
            headers.length &&
          candidate.order.every(
            (
              name,
              index
            ) =>
              name ===
              headers[
                index
              ]
          )
      )
      .sort(
        (a, b) =>
          b.headers.length -
          a.headers.length
      );

  if (
    complete[0]
  ) {
    return (
      complete[0]
        .candidate
    );
  }

  return (
    candidates
      .sort(
        (a, b) =>
          b.candidate
            .score -
          a.candidate
            .score
      )[0]
      ?.candidate ??
    null
  );
}

function extractPdfSymbols(
  row: PdfLayoutRow
): PdfSymbolCoordinate[] {
  const raw =
    rawPdfItemsInRow(
      row
    );

  const results:
    PdfSymbolCoordinate[] =
    [];

  for (
    let itemIndex = 0;
    itemIndex < raw.length;
    itemIndex++
  ) {
    const item =
      raw[itemIndex];

    const chars =
      Array.from(
        item.str
      );

    for (
      let charIndex = 0;
      charIndex <
      chars.length;
      charIndex++
    ) {
      const char =
        chars[
          charIndex
        ];

      if (
        char !== "◎" &&
        char !== "★" &&
        char !== "☆"
      ) {
        continue;
      }

      const unit =
        Math.max(
          0.001,
          item.width
        ) /
        Math.max(
          1,
          chars.length
        );

      const x0 =
        item.x +
        unit *
          charIndex;

      const x1 =
        item.x +
        unit *
          (
            charIndex +
            1
          );

      const sameItemSuffix =
        chars
          .slice(
            charIndex +
              1
          )
          .join("")
          .trim()
          .match(
            /^\(([^)]+)\)/
          );

      let suffix =
        sameItemSuffix?.[
          1
        ] ??
        null;

      if (
        !suffix &&
        chars.length === 1
      ) {
        const next =
          raw[
            itemIndex +
              1
          ];

        if (
          next &&
          Math.abs(
            next.y -
              item.y
          ) <= 2.5 &&
          next.x -
            (
              item.x +
              item.width
            ) <=
            Math.max(
              3,
              item.fontSize *
                0.5
            )
        ) {
          suffix =
            next.str.match(
              /^\(([^)]+)\)/
            )?.[1] ??
            null;
        }
      }

      results.push({
        symbol: char,
        x0,
        x1,
        xCenter:
          (x0 + x1) /
          2,
        y: item.y,
        suffix,
        coordinateType:
          "pdf_point",
        precision:
          chars.length ===
          1
            ? "raw-item-exact"
            : "glyph-width-estimate",
      });
    }
  }

  return results;
}

function makePdfHeaderBoundaries(
  columns:
    PdfHeaderColumn[]
): (
  PdfHeaderColumn & {
    left: number;
    right: number;
  }
)[] {
  const sorted =
    [...columns].sort(
      (a, b) =>
        a.xCenter -
        b.xCenter
    );

  if (
    sorted.length === 0
  ) {
    return [];
  }

  const boundaries:
    number[] = [];

  for (
    let index = 0;
    index <
    sorted.length - 1;
    index++
  ) {
    boundaries.push(
      (
        sorted[index]
          .xCenter +
        sorted[
          index + 1
        ].xCenter
      ) /
        2
    );
  }

  const firstGap =
    sorted.length > 1
      ? sorted[1]
          .xCenter -
        sorted[0]
          .xCenter
      : 20;

  const lastGap =
    sorted.length > 1
      ? sorted[
          sorted.length -
            1
        ].xCenter -
        sorted[
          sorted.length -
            2
        ].xCenter
      : 20;

  return sorted.map(
    (
      column,
      index
    ) => ({
      ...column,
      left:
        index === 0
          ? column.xCenter -
            firstGap /
              2
          : boundaries[
              index -
                1
            ],
      right:
        index ===
        sorted.length -
          1
          ? column.xCenter +
            lastGap /
              2
          : boundaries[
              index
            ],
    })
  );
}

function mapPdfSymbolToHeader(
  symbol:
    PdfSymbolCoordinate,
  columns:
    ReturnType<
      typeof makePdfHeaderBoundaries
    >
): string | null {
  const direct =
    columns.find(
      (column) =>
        symbol.xCenter >=
          column.left &&
        symbol.xCenter <
          column.right
    );

  if (direct) {
    return direct.name;
  }

  return (
    [...columns]
      .map(
        (column) => ({
          name:
            column.name,
          distance:
            Math.abs(
              column.xCenter -
                symbol.xCenter
            ),
        })
      )
      .sort(
        (a, b) =>
          a.distance -
          b.distance
      )[0]
      ?.name ??
    null
  );
}

function findPdfInheritedTask(
  page: PdfLayoutPage,
  rowIndex: number,
  header:
    PdfHeaderCandidate |
    null
): string | null {
  if (!header) {
    return null;
  }

  const firstHeaderX =
    Math.min(
      ...header.columns.map(
        (column) =>
          column.x
      )
    );

  const lowerBound =
    Math.max(
      header.start +
        header.count,
      rowIndex - 8
    );

  for (
    let index = rowIndex;
    index >= lowerBound;
    index--
  ) {
    const row =
      page.rows[
        index
      ];

    for (
      const item of
      rawPdfItemsInRow(
        row
      )
    ) {
      const center =
        item.x +
        item.width /
          2;

      if (
        center >=
        firstHeaderX
      ) {
        continue;
      }

      if (
        /^\s*\d+(?:-\d+)?\)\s*\S+/.test(
          item.str
        )
      ) {
        return item.str;
      }
    }
  }

  return null;
}

async function extractPdfRichContent(
  bytes: Uint8Array
): Promise<{
  text: string;
  totalPages: number;
  pages: PdfLayoutPage[];
  layoutSkippedReason?: string;
}> {
  const pdf =
    await getDocumentProxy(
      bytes.slice()
    );

  try {
    let pages:
      PdfLayoutPage[] = [];

    let layoutSkippedReason:
      string | undefined;

    if (
      pdf.numPages <=
      MAX_PDF_LAYOUT_PAGES
    ) {
      const positioned =
        await extractTextItems(
          pdf
        );

      pages =
        positioned.items.map(
          (
            pageItems,
            index
          ) => ({
            page: index + 1,
            rows:
              groupPdfLayoutRows(
                pageItems,
                index + 1
              ),
          })
        );
    } else {
      layoutSkippedReason =
        `PDF가 ${pdf.numPages}쪽으로 길어 좌표 기반 표 분석은 생략했습니다. 현재 한도는 ${MAX_PDF_LAYOUT_PAGES}쪽입니다.`;
    }

    const extracted =
      await extractText(
        pdf,
        {
          mergePages: true,
        }
      );

    const text =
      Array.isArray(
        extracted.text
      )
        ? extracted.text.join(
            "\n\n"
          )
        : extracted.text;

    return {
      text,
      totalPages:
        extracted.totalPages,
      pages,
      layoutSkippedReason,
    };
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // PDF.js resource cleanup is best-effort.
    }
  }
}

function searchPdfLayoutRows(
  pages: PdfLayoutPage[],
  query: string,
  limit = 8
): {
  page: PdfLayoutPage;
  row: PdfLayoutRow;
  mode:
    | "row"
    | "tokens"
    | "fill-down";
}[] {
  const normalizedQuery =
    normalizeTableSearch(
      query
    );

  if (!normalizedQuery) {
    return [];
  }

  const tokens =
    query
      .normalize("NFKC")
      .split(
        /[\s,;/]+/
      )
      .map(
        (token) =>
          normalizeTableSearch(
            token
          )
      )
      .filter(Boolean);

  const results: {
    page: PdfLayoutPage;
    row: PdfLayoutRow;
    mode:
      | "row"
      | "tokens"
      | "fill-down";
  }[] = [];

  const seen =
    new Set<string>();

  for (const page of pages) {
    const detectedHeader =
      detectKnownPdfHeader(
        page.rows
      );

    const header =
      detectedHeader &&
      detectedHeader.matched >= 2
        ? detectedHeader
        : null;

    for (const row of page.rows) {
      const rawRowText =
        normalizeTableSearch(
          row.text
        );

      const inheritedTask =
        findPdfInheritedTask(
          page,
          row.row,
          header
        );

      const combinedText =
        inheritedTask
          ? `${row.text} ${inheritedTask}`
          : row.text;

      const normalizedCombined =
        normalizeTableSearch(
          combinedText
        );

      const directMatch =
        rawRowText.includes(
          normalizedQuery
        );

      const combinedMatch =
        normalizedCombined.includes(
          normalizedQuery
        );

      const tokenMatch =
        tokens.length >= 2 &&
        tokens.every(
          (token) =>
            normalizedCombined.includes(
              token
            )
        );

      if (
        !directMatch &&
        !combinedMatch &&
        !tokenMatch
      ) {
        continue;
      }

      const key =
        `${page.page}:${row.row}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      results.push({
        page,
        row,
        mode:
          directMatch
            ? "row"
            : inheritedTask
              ? "fill-down"
              : "tokens",
      });

      if (
        results.length >=
        limit
      ) {
        return results;
      }
    }
  }

  return results;
}



type PdfStructuredMatch = {
  sourceType: "pdf";
  page: number;
  row: number;
  task: string | null;
  condition: string | null;
  approver: string | null;
  symbol: "◎" | "★" | "☆" | null;
  suffix: string | null;
  coordinate: {
    x0: number;
    x1: number;
    xCenter: number;
    y: number;
    coordinateType: "pdf_point";
    precision: "raw-item-exact" | "glyph-width-estimate";
  } | null;
  headerEvidence: {
    columns: string[];
    multiline: string[];
    mappingMethod: "header_midpoints";
  } | null;
  needsReview: boolean;
  reviewReasons: string[];
};

function extractPdfCondition(
  row: PdfLayoutRow
): string | null {
  const match =
    row.text.match(
      /(\d+(?:\.\d+)?\s*(?:억|천|백|십)?\s*원\s*(?:이상|이하|미만|초과))/u
    );

  return (
    match?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ??
    null
  );
}

function buildPdfStructuredMatches(
  page: PdfLayoutPage,
  row: PdfLayoutRow
): PdfStructuredMatch[] {
  const detectedHeader =
    detectKnownPdfHeader(
      page.rows
    );

  const header =
    detectedHeader &&
    detectedHeader.matched >= 2
      ? detectedHeader
      : null;

  const task =
    findPdfInheritedTask(
      page,
      row.row,
      header
    );

  const condition =
    extractPdfCondition(
      row
    );

  const boundaries =
    header
      ? makePdfHeaderBoundaries(
          header.columns
        )
      : [];

  const symbols =
    extractPdfSymbols(
      row
    );

  const multiline =
    header?.columns
      .filter(
        (column) =>
          column.rowOffsets
            .length > 1
      )
      .map(
        (column) =>
          column.name
      ) ??
    [];

  if (
    symbols.length === 0
  ) {
    return [
      {
        sourceType: "pdf",
        page: page.page,
        row: row.row,
        task,
        condition,
        approver: null,
        symbol: null,
        suffix: null,
        coordinate: null,
        headerEvidence:
          header
            ? {
                columns:
                  header.order,
                multiline,
                mappingMethod:
                  "header_midpoints",
              }
            : null,
        needsReview: true,
        reviewReasons: [
          "검색 행에 전결 기호가 없어 전결권자를 확정할 수 없음",
          ...(!header
            ? [
                "전결 헤더를 충분히 복원하지 못함",
              ]
            : []),
        ],
      },
    ];
  }

  return symbols.map(
    (symbol) => {
      const approver =
        boundaries.length
          ? mapPdfSymbolToHeader(
              symbol,
              boundaries
            )
          : null;

      const reviewReasons:
        string[] = [];

      if (!header) {
        reviewReasons.push(
          "전결 헤더를 충분히 복원하지 못함"
        );
      }

      if (!approver) {
        reviewReasons.push(
          "기호를 전결권자 열에 매핑하지 못함"
        );
      }

      if (
        symbol.precision ===
        "glyph-width-estimate"
      ) {
        reviewReasons.push(
          "기호 x좌표가 glyph-width 추정값임"
        );
      }

      return {
        sourceType:
          "pdf" as const,
        page:
          page.page,
        row:
          row.row,
        task,
        condition,
        approver,
        symbol:
          symbol.symbol,
        suffix:
          symbol.suffix,
        coordinate: {
          x0:
            symbol.x0,
          x1:
            symbol.x1,
          xCenter:
            symbol.xCenter,
          y:
            symbol.y,
          coordinateType:
            symbol.coordinateType,
          precision:
            symbol.precision,
        },
        headerEvidence:
          header
            ? {
                columns:
                  header.order,
                multiline,
                mappingMethod:
                  "header_midpoints" as const,
              }
            : null,
        needsReview:
          reviewReasons.length >
          0,
        reviewReasons,
      };
    }
  );
}

function renderPdfStructuredMatch(
  match: PdfStructuredMatch
): string {
  return [
    `source_type: ${match.sourceType}`,
    `page: ${match.page}`,
    `row: ${match.row}`,
    `task: ${match.task ?? "(확인 필요)"}`,
    `condition: ${match.condition ?? "(없음/확인 필요)"}`,
    `approver: ${match.approver ?? "(확인 필요)"}`,
    `symbol: ${match.symbol ?? "(없음)"}`,
    `suffix: ${match.suffix ?? "(없음)"}`,
    ...(match.coordinate
      ? [
          `coordinate: x0=${match.coordinate.x0.toFixed(2)}, x1=${match.coordinate.x1.toFixed(2)}, x_center=${match.coordinate.xCenter.toFixed(2)}, y=${match.coordinate.y.toFixed(2)}, coordinate_type=${match.coordinate.coordinateType}, precision=${match.coordinate.precision}`,
        ]
      : []),
    ...(match.headerEvidence
      ? [
          `header_evidence: ${match.headerEvidence.columns.join(" | ")}`,
          ...(match.headerEvidence.multiline.length
            ? [
                `header_multiline: ${match.headerEvidence.multiline.join(" | ")}`,
              ]
            : []),
          `header_mapping: ${match.headerEvidence.mappingMethod}`,
        ]
      : [
          "header_evidence: (확인 필요)",
        ]),
    `needs_review: ${match.needsReview ? "true" : "false"}`,
    ...(match.reviewReasons.length
      ? [
          `review_reasons: ${match.reviewReasons.join(" / ")}`,
        ]
      : []),
  ].join("\n");
}



function renderPdfLayoutRow(
  row: PdfLayoutRow,
  header:
    PdfHeaderCandidate |
    null = null
): string {
  const segmentText =
    row.segments
      .map(
        (segment) => {
          const x =
            segment.x
              .toFixed(1);

          const xEnd =
            segment.xEnd
              .toFixed(1);

          const text =
            segment.text.length >
            260
              ? segment.text.slice(
                  0,
                  260
                ) + "…"
              : segment.text;

          return (
            `[x=${x}-${xEnd}] ` +
            text
          );
        }
      )
      .join(" | ");

  const boundaries =
    header
      ? makePdfHeaderBoundaries(
          header.columns
        )
      : [];

  const symbolText =
    extractPdfSymbols(
      row
    )
      .map(
        (symbol) => {
          const approver =
            boundaries.length
              ? mapPdfSymbolToHeader(
                  symbol,
                  boundaries
                )
              : null;

          return [
            symbol.symbol,
            `x0=${symbol.x0.toFixed(2)}`,
            `x1=${symbol.x1.toFixed(2)}`,
            `x_center=${symbol.xCenter.toFixed(2)}`,
            `y=${symbol.y.toFixed(2)}`,
            "coordinate_type=pdf_point",
            `precision=${symbol.precision}`,
            ...(symbol.suffix
              ? [
                  `suffix=${symbol.suffix}`,
                ]
              : []),
            ...(approver
              ? [
                  `approver=${approver}`,
                ]
              : []),
          ].join(", ");
        }
      );

  return [
    `행 ${row.row} (y=${row.y.toFixed(1)}): ${segmentText}`,
    ...(symbolText.length
      ? symbolText.map(
          (text) =>
            `  기호 좌표: ${text}`
        )
      : []),
  ].join("\n");
}

function renderPdfLayoutMatch(
  page: PdfLayoutPage,
  row: PdfLayoutRow,
  mode:
    | "row"
    | "tokens"
    | "fill-down"
): string {
  const detectedHeader =
    detectKnownPdfHeader(
      page.rows
    );

  const header =
    detectedHeader &&
    detectedHeader.matched >= 2
      ? detectedHeader
      : null;

  const inheritedTask =
    findPdfInheritedTask(
      page,
      row.row,
      header
    );

  const from =
    Math.max(
      0,
      row.row - 2
    );

  const to =
    Math.min(
      page.rows.length - 1,
      row.row + 2
    );

  const context:
    string[] = [];

  for (
    let index = from;
    index <= to;
    index++
  ) {
    context.push(
      renderPdfLayoutRow(
        page.rows[index],
        header
      )
    );
  }

  const multilineHeaders =
    header?.columns
      .filter(
        (column) =>
          column.rowOffsets
            .length > 1
      )
      .map(
        (column) =>
          column.name
      ) ??
    [];

  return [
    `PDF ${page.page}쪽`,
    mode === "fill-down"
      ? "일치 방식: PDF fill-down 문맥 + 현재 행 복합 일치"
      : mode === "tokens"
        ? "일치 방식: 같은 PDF 행의 복합 검색어 일치"
        : "일치 방식: PDF 행 일치",
    `기준 행: ${row.row}, y=${row.y.toFixed(1)}`,
    `기준 내용: ${row.text}`,
    ...(header
      ? [
          `전결 헤더 추정: ${header.order.join(" | ")}`,
          ...(multilineHeaders.length
            ? [
                `다줄 헤더 병합: ${multilineHeaders.join(" | ")}`,
              ]
            : []),
        ]
      : [
          "전결 헤더 추정: 충분한 헤더 증거 없음",
        ]),
    ...(inheritedTask &&
    !normalizeTableSearch(
      row.text
    ).includes(
      normalizeTableSearch(
        inheritedTask
      )
    )
      ? [
          `fill-down 업무 문맥: ${inheritedTask}`,
        ]
      : []),
    "좌표 기반 주변 행 문맥:",
    ...context,
    "",
    "※ PDF 기호 좌표는 pdf_point 단위입니다. 원시 positioned text item이 단일 기호이면 실제 item x범위를 사용하고, 한 item에 여러 기호가 있으면 glyph-width 추정으로 개별 x좌표를 분리합니다.",
    "※ 헤더 열 판정은 다줄 헤더를 병합한 뒤 열 중심점의 중간값(header_midpoints)을 경계로 사용합니다. 괘선 정보가 없는 PDF에서는 이 결과가 추정치일 수 있습니다.",
  ].join("\n");
}



async function getLatestRegulationByName(
  name: string
) {
  const items =
    await coreListRegulations();

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
  let pdfLayout: PdfLayoutPage[] = [];
  let pdfTotalPages: number | undefined;
  let pdfLayoutSkippedReason: string | undefined;

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
        ].join("\n")
      );
    }
  } else if (extension === "pdf") {
    try {
      const rich =
        await extractPdfRichContent(
          file.bytes
        );

      text = rich.text;
      pdfLayout = rich.pages;
      pdfTotalPages =
        rich.totalPages;
      pdfLayoutSkippedReason =
        rich.layoutSkippedReason;

      if (!text.trim()) {
        throw new Error(
          "PDF에 추출 가능한 텍스트가 없습니다. 스캔 이미지 PDF일 수 있습니다."
        );
      }
    } catch (error) {
      throw new Error(
        [
          "PDF 본문/레이아웃 추출에 실패했습니다.",
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
        "현재 MCP는 HWP, HWPX, 텍스트형 PDF 본문을 직접 읽을 수 있습니다.",
        "스캔 PDF나 DOCX 등은 아직 직접 본문 추출 대상이 아닙니다.",
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
    markdown,
    tables,
    pdfLayout,
    pdfTotalPages,
    pdfLayoutSkippedReason,
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

async function loadTextWithToolRetry(name:string){
  let last:unknown;
  for(let attempt=1;attempt<=2;attempt++){
    try{return await coreGetLatestRegulationText(name);}catch(error){last=error;if(attempt<2)await sleep(250*attempt);}
  }
  throw last;
}
function publicErrorCode(error:unknown):'timeout'|'parse_error'|'upstream_error'{
  const raw=error&&typeof error==='object'&&'code' in error?String((error as any).code):'';
  const message=error instanceof Error?error.message:String(error);
  if(raw==='timeout'||/timeout|aborted/i.test(message))return 'timeout';
  if(raw==='parse_error'||raw==='no_text_layer'||raw==='layout_error')return 'parse_error';
  return 'upstream_error';
}

function createServer() {
  const server = new McpServer({
    name: "ADD Regulations MCP",
    version: "1.9.0",
  });

  server.registerTool(
    "hello",
    {
      description:
        "국방과학연구소 규정 MCP 연결상태를 확인합니다.",
      inputSchema: {},
    },
    async () => {
      const data={status:"ready",runtime:"Cloudflare Workers",version:"1.9.0",tableStructure:true,pdfLayout:true,symbolCoordinates:true,columnMapping:true,fillDown:true,versionCheck:true,generalTables:true,documentCache:"fileNo+idate",coordinateLimits:{hwp:"logical-cell-address",hwpx:"logical-cell-address",pdf:"pdf-points-bottom-left"}};
      return {structuredContent:data,content:[{type:"text" as const,text:JSON.stringify(data,null,2)}]};
    }
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
          await coreListRegulations();

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
          await coreListRegulations();

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
        const result = await coreGetLatestRegulationText(name);
        const data={regulationName:result.regulationName,revisionDate:result.revisionDate,updatedDate:result.updatedDate,
          filename:result.filename,extension:result.extension,fileNo:result.fileNo,version_check:result.version_check,
          selection_reason:result.selection_reason,other_attachments:result.other_attachments,sourceUrl:result.sourceUrl};
        return {structuredContent:data,content:[{type:"text" as const,text:JSON.stringify(data,null,2)}]};
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
        "최신 HWP/HWPX/PDF 규정의 실제 본문을 읽습니다. HWP/HWPX는 표 구조를 보존하고, PDF는 텍스트 x/y 좌표를 이용해 표의 행·열 문맥을 추정합니다.",
      inputSchema: {
        name:
          z.string().min(1),
      },
    },
    async ({ name }) => {
      try {
        const result =
          await loadTextWithToolRetry(
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

        const pdfLayoutNotice =
          result.extension
            .toLowerCase() === "pdf"
            ? [
                `PDF 페이지: ${result.pdfTotalPages ?? "확인 필요"}쪽`,
                result.pdfLayout.length > 0
                  ? `좌표 기반 행 분석: ${result.pdfLayout.length}쪽`
                  : "좌표 기반 행 분석: 사용 안 함",
                ...(result.pdfLayoutSkippedReason
                  ? [
                      result.pdfLayoutSkippedReason,
                    ]
                  : []),
                "※ PDF는 표 셀/병합 구조가 파일에 명시되지 않는 경우가 많아 x/y 좌표를 이용해 표 문맥을 추정합니다.",
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
                `파일형식: ${result.extension}`,
                `fileNo: ${result.fileNo}`,
                `version_check: ${JSON.stringify(result.version_check)}`,
                `selection_reason: ${result.selection_reason}`,
                `other_attachments: ${JSON.stringify(result.other_attachments)}`,
                `ALIO: ${result.sourceUrl}`,
                ...tableNotice,
                ...pdfLayoutNotice,
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
        "최신 HWP/HWPX/PDF 규정 본문에서 키워드 또는 조문을 검색합니다. HWP/HWPX는 셀·병합 구조를, PDF는 x/y 좌표 기반 행·열 문맥을 함께 검색하며 공백·쉼표 차이와 같은 행의 복합 검색어를 지원합니다.",
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
          await loadTextWithToolRetry(
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

        const pdfLayoutMatches =
          searchPdfLayoutRows(
            result.pdfLayout,
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
          tableMatches.length === 0 &&
          pdfLayoutMatches.length === 0
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
                `파일형식: ${result.extension}`,
                `fileNo: ${result.fileNo}`,
                `version_check: ${JSON.stringify(result.version_check)}`,
                `selection_reason: ${result.selection_reason}`,
                `other_attachments: ${JSON.stringify(result.other_attachments)}`,
                `검색어: ${query}`,
                `본문 검색결과: ${matches.length}건`,
                `HWP/HWPX 표 구조 검색결과: ${tableMatches.length}건`,
                `PDF 좌표 행 검색결과: ${pdfLayoutMatches.length}건`,
                `ALIO: ${result.sourceUrl}`,
                "",
                ...tableMatches.map(
                  ({ table, cell, row, mode }, index) =>
                    [
                      `===== 표 구조 결과 ${index + 1} =====`,
                      renderStructuredTableMatch(
                        table,
                        cell,
                        row,
                        mode
                      ),
                    ].join("\n")
                ),
                ...(tableMatches.length
                  ? [""]
                  : []),
                ...pdfLayoutMatches.map(
                  ({ page, row, mode }, index) => {
                    const structured =
                      buildPdfStructuredMatches(
                        page,
                        row
                      );

                    return [
                      `===== PDF 구조화 결과 ${index + 1} =====`,
                      ...structured.map(
                        (match, structuredIndex) =>
                          [
                            `--- 구조화 행 ${structuredIndex + 1} ---`,
                            renderPdfStructuredMatch(
                              match
                            ),
                          ].join("\n")
                      ),
                      "",
                      "원시 좌표 문맥:",
                      renderPdfLayoutMatch(
                        page,
                        row,
                        mode
                      ),
                    ].join("\n");
                  }
                ),
                ...(pdfLayoutMatches.length
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
        const data={error:{code:publicErrorCode(error),message:error instanceof Error?error.message:String(error)}};
        return {isError:true,structuredContent:data,content:[{type:"text" as const,text:JSON.stringify(data)}]};
      }
    }
  );

  server.registerTool(
    "search_regulation_table",
    {
      description: "최신 규정의 일반 표와 위임전결표를 검색합니다. HWP/HWPX 실제 셀·병합·다단 헤더와 PDF point 좌표를 반환합니다. 일반 표의 전결권자는 추정하지 않으며 증거가 부족한 PDF는 needs_review로 표시합니다.",
      inputSchema: {
        name: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        includeRegion: z.boolean().optional(),
        compact: z.boolean().optional(),
        include_text_box: z.boolean().optional(),
      },
    },
    async ({ name, query, limit, includeRegion, compact, include_text_box }) => {
      try {
        const result = await searchLatestRegulationTable(name, query);
        const { rows, ...meta } = result;
        const requested=limit ?? 30;
        const eligible=include_text_box?rows:rows.filter(row=>row.analysis_type!=='text_box');
        let visible=eligible.slice(0,requested);
        if(compact) visible=visible.map((row:any)=>({source_type:row.source_type,analysis_type:row.analysis_type,table_id:row.table_id,row:row.row,
          task:row.task??null,condition:row.condition??null,approver:row.approver??null,approver_type:row.approver_type??null,
          approvers:row.approvers??undefined,multi_approver:row.multi_approver??false,symbol:row.symbol??null,suffix:row.suffix??null,
          values:row.values??{},columns:row.columns??[],footnotes:row.footnotes??[],related_regulations:row.related_regulations??[],
          needs_review:row.needs_review,review_reasons:row.review_reasons??[]}));
        const has_more=eligible.length>visible.length;
        let data:any={...meta,query,totalMatches:eligible.length,totalStructuredRows:eligible.length,has_more,truncated:false,rows:visible,
          ...(includeRegion?{regions:visible.map((row:any)=>({page:row.page,bounding_box:row.bounding_box,coordinate_space:row.coordinate_space,table_id:row.table_id,image:null}))}:{})};
        let serialized=JSON.stringify(data,null,2);
        if(compact&&serialized.length>14500){
          while(data.rows.length>1&&serialized.length>14500){data.rows.pop();data.truncated=true;serialized=JSON.stringify(data,null,2);}
        }
        return {structuredContent:data,content:[{type:"text" as const,text:serialized}]};
      } catch (error) {
        const code=error&&typeof error==="object"&&"code" in error?String(error.code):"parse_error";
        const data={error:{code,message:error instanceof Error?error.message:String(error)}};
        return {isError:true,structuredContent:data,content:[{type:"text" as const,text:JSON.stringify(data)}]};
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

