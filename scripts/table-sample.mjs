import { parseHwp, hwpToMarkdown } from "@ssabrojs/hwpxjs";

const URL =
  "https://www.alio.go.kr/download/rulefiledown.json?fileNo=239154";

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

const response = await fetch(URL, {
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
