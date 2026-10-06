import { HwpxReader, hwpToHwpx, parseHwp, hwpToMarkdown } from "@ssabrojs/hwpxjs";

const URL =
  "https://www.alio.go.kr/download/rulefiledown.json?fileNo=239154";

const TECHNICAL_SERVICE_URL =
  "https://www.alio.go.kr/download/rulefiledown.json?fileNo=228379";


async function fetchWithRetry(url, init, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}


function paragraphText(p) {
  const runText = Array.isArray(p.runs)
    ? p.runs.map((r) => r.text ?? "").join("")
    : "";
  return (runText || p.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(cell) {
  return (cell.paragraphs ?? [])
    .map(paragraphText)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}


function findKeywordContexts(tables, keyword) {
  const results = [];
  for (const [tableIndex, item] of tables.entries()) {
    const matches = item.table.cells.filter((cell) =>
      cellText(cell).includes(keyword)
    );
    for (const cell of matches.slice(0, 8)) {
      const nearby = item.table.cells
        .filter((candidate) =>
          candidate.row >= Math.max(0, cell.row - 1) &&
          candidate.row <= Math.min(item.table.rowCount - 1, cell.row + 1)
        )
        .map((candidate) => ({
          row: candidate.row,
          col: candidate.col,
          rowSpan: candidate.rowSpan,
          colSpan: candidate.colSpan,
          text: cellText(candidate).slice(0, 220),
        }));
      results.push({
        tableIndex,
        rowCount: item.table.rowCount,
        colCount: item.table.colCount,
        matchedCell: {
          row: cell.row,
          col: cell.col,
          rowSpan: cell.rowSpan,
          colSpan: cell.colSpan,
          text: cellText(cell),
        },
        nearby,
      });
    }
  }
  return results;
}

const response = await fetchWithRetry(URL, {
  headers: {
    "User-Agent": "Mozilla/5.0 ADD-Regulations-MCP-Table-Test/1.0",
  },
});

if (!response.ok) {
  throw new Error(`download failed: HTTP ${response.status}`);
}

const bytes = new Uint8Array(await response.arrayBuffer());
console.log("downloaded bytes:", bytes.byteLength);

const doc = parseHwp(bytes);
const tables = [];

for (const [sectionIndex, section] of doc.sections.entries()) {
  for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
    for (const control of paragraph.controls ?? []) {
      if (control.kind === "table") {
        tables.push({
          sectionIndex,
          paragraphIndex,
          table: control,
        });
      }
    }
  }
}

console.log("table count:", tables.length);

const summary = tables.slice(0, 8).map((item, index) => ({
  index,
  sectionIndex: item.sectionIndex,
  paragraphIndex: item.paragraphIndex,
  rowCount: item.table.rowCount,
  colCount: item.table.colCount,
  cells: item.table.cells.slice(0, 24).map((cell) => ({
    row: cell.row,
    col: cell.col,
    rowSpan: cell.rowSpan,
    colSpan: cell.colSpan,
    text: cellText(cell).slice(0, 180),
  })),
}));

console.log("STRUCTURED_TABLE_SAMPLE_START");
console.log(JSON.stringify(summary, null, 2));
console.log("STRUCTURED_TABLE_SAMPLE_END");

const markdown = await hwpToMarkdown(bytes);
const lines = markdown.split("\n");
const tableLineIndexes = [];

for (let i = 0; i < lines.length; i++) {
  if (/^\| .* \|$/.test(lines[i])) tableLineIndexes.push(i);
}

console.log("markdown table line count:", tableLineIndexes.length);

if (tableLineIndexes.length > 0) {
  const start = Math.max(0, tableLineIndexes[0] - 2);
  const end = Math.min(lines.length, tableLineIndexes[0] + 18);
  console.log("MARKDOWN_TABLE_SAMPLE_START");
  console.log(lines.slice(start, end).join("\n"));
  console.log("MARKDOWN_TABLE_SAMPLE_END");
}

for (const keyword of ["기술용역", "계약", "1억원", "5천만원"]) {
  const contexts = findKeywordContexts(tables, keyword);
  console.log(`KEYWORD_CONTEXT_${keyword}_START`);
  console.log(JSON.stringify(contexts.slice(0, 5), null, 2));
  console.log(`KEYWORD_CONTEXT_${keyword}_END`);
}


function normalizeTableSearch(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,]+/g, "");
}

const normalizedOneHundredMillion = normalizeTableSearch("1억원");
const normalizedMatches = tables.flatMap((item, tableIndex) =>
  item.table.cells
    .filter((cell) =>
      normalizeTableSearch(cellText(cell)).includes(normalizedOneHundredMillion)
    )
    .map((cell) => ({
      tableIndex,
      row: cell.row,
      col: cell.col,
      text: cellText(cell),
    }))
);

console.log("NORMALIZED_1EOK_MATCHES_START");
console.log(JSON.stringify(normalizedMatches.slice(0, 20), null, 2));
console.log("NORMALIZED_1EOK_MATCHES_END");

if (normalizedMatches.length === 0) {
  throw new Error("normalized search failed: 1억원 should match 1억 원");
}


function rowCells(table, row) {
  return table.cells
    .filter((cell) =>
      cell.row <= row &&
      row < cell.row + cell.rowSpan
    )
    .sort((a, b) => a.col - b.col);
}

const compoundTokens = ["구매", "1억원"].map(normalizeTableSearch);
const compoundMatches = [];

for (const [tableIndex, item] of tables.entries()) {
  for (let row = 0; row < item.table.rowCount; row++) {
    const rowText = normalizeTableSearch(
      rowCells(item.table, row)
        .map((cell) => cellText(cell))
        .join(" ")
    );
    if (compoundTokens.every((token) => rowText.includes(token))) {
      compoundMatches.push({
        tableIndex,
        row,
        cells: rowCells(item.table, row)
          .filter((cell) => cellText(cell))
          .map((cell) => ({
            col: cell.col,
            rowSpan: cell.rowSpan,
            colSpan: cell.colSpan,
            text: cellText(cell),
          })),
      });
    }
  }
}

console.log("COMPOUND_ROW_MATCHES_START");
console.log(JSON.stringify(compoundMatches.slice(0, 10), null, 2));
console.log("COMPOUND_ROW_MATCHES_END");

if (compoundMatches.length === 0) {
  throw new Error("compound row search failed: 구매 + 1억원");
}

const hwpxBytes = await hwpToHwpx(bytes, {
  title: "위임전결규정 표 구조 테스트",
  creator: "ADD Regulations MCP CI",
});

const reader = new HwpxReader();
const hwpxArrayBuffer = hwpxBytes.buffer.slice(
  hwpxBytes.byteOffset,
  hwpxBytes.byteOffset + hwpxBytes.byteLength
);
await reader.loadFromArrayBuffer(hwpxArrayBuffer);

const hwpxHtml = await reader.extractHtml({
  renderImages: false,
  renderTables: true,
  renderStyles: false,
});
const hwpxMarkdown = await reader.extractMarkdown({
  embedImages: false,
});

const hwpxTableCount = (hwpxHtml.match(/<table\b/gi) ?? []).length;
const hwpxRowSpanCount = (hwpxHtml.match(/rowspan=/gi) ?? []).length;
const hwpxColSpanCount = (hwpxHtml.match(/colspan=/gi) ?? []).length;

console.log("HWPX_ROUNDTRIP_START");
console.log(JSON.stringify({
  bytes: hwpxBytes.byteLength,
  tableCount: hwpxTableCount,
  rowSpanCount: hwpxRowSpanCount,
  colSpanCount: hwpxColSpanCount,
  markdownHasDelegation: hwpxMarkdown.includes("위임전결"),
  markdownHasTechnicalService: hwpxMarkdown.includes("기술용역"),
}, null, 2));
console.log("HWPX_ROUNDTRIP_END");

if (hwpxTableCount < 3) {
  throw new Error(`HWPX roundtrip table count too small: ${hwpxTableCount}`);
}
if (hwpxRowSpanCount === 0 || hwpxColSpanCount === 0) {
  throw new Error("HWPX roundtrip lost merged-cell structure");
}
if (!hwpxMarkdown.includes("기술용역")) {
  throw new Error("HWPX markdown lost expected table text");
}


async function runGeneralTableRegression() {
  const response = await fetchWithRetry(TECHNICAL_SERVICE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 ADD-Regulations-MCP-General-Table-Test/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`technical service download failed: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const doc = parseHwp(bytes);
  const tables = [];

  for (const section of doc.sections ?? []) {
    for (const paragraph of section.paragraphs ?? []) {
      for (const control of paragraph.controls ?? []) {
        if (control.kind === "table") tables.push(control);
      }
    }
  }

  const businessTable = tables.find((table) => {
    const all = table.cells.map(cellText).join(" ");
    return all.includes("사업 구분") &&
      all.includes("사업관리부서") &&
      all.includes("예산관리부서") &&
      all.includes("연구용역") &&
      all.includes("군지원 기술용역");
  });

  if (!businessTable) {
    throw new Error("general table regression failed: 업무유형별 담당부서 표를 찾지 못함");
  }

  const rowSnapshots = [];
  for (let row = 0; row < businessTable.rowCount; row++) {
    const cells = rowCells(businessTable, row)
      .filter((cell) => cellText(cell))
      .map((cell) => ({
        col: cell.col,
        rowSpan: cell.rowSpan,
        colSpan: cell.colSpan,
        text: cellText(cell),
      }));
    if (cells.length) rowSnapshots.push({ row, cells });
  }

  const flat = rowSnapshots
    .flatMap((entry) => entry.cells.map((cell) => cell.text))
    .join(" ");

  for (const expected of [
    "사업 구분",
    "사업관리부서",
    "예산관리부서",
    "연구용역",
    "군지원 기술용역",
    "군수용 기술용역",
    "민수용 기술용역",
    "민군기술협력 담당부서",
  ]) {
    if (!flat.includes(expected)) {
      throw new Error(`general table regression lost expected text: ${expected}`);
    }
  }

  const hasMergedCell = businessTable.cells.some(
    (cell) => Number(cell.rowSpan ?? 1) > 1 || Number(cell.colSpan ?? 1) > 1
  );
  if (!hasMergedCell) {
    throw new Error("general table regression failed: merged-cell evidence missing");
  }

  console.log("GENERAL_TABLE_REGRESSION_PASS", JSON.stringify({
    fileNo: "228379",
    tableShape: {
      rows: businessTable.rowCount,
      cols: businessTable.colCount,
    },
    headers: ["사업 구분", "사업관리부서", "예산관리부서"],
    cases: [
      "연구용역",
      "군지원 기술용역",
      "군수용 기술용역",
      "민수용 기술용역",
      "민군기술협력 담당부서",
    ],
    hasMergedCell,
    rowSnapshots,
  }));
}

await runGeneralTableRegression();
