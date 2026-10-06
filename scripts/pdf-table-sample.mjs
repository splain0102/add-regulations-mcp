import { extractText, extractTextItems, getDocumentProxy } from "unpdf";

const PDF_URL =
  "https://www.alio.go.kr/download/rulefiledown.json?fileNo=166852";

const EXPECTED_HEADERS = [
  "사책/과책",
  "운영",
  "실장",
  "부장(센터장)",
  "사업기구장",
  "부소장",
  "소장",
];

async function fetchWithRetry(url, init = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return response;
      }
      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError ?? new Error("fetch failed");
}

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,]+/g, "");
}

function normalizeHeader(value) {
  return normalize(value).replace(/[\/()·ㆍ.\-]/g, "");
}

function horizontalOverlap(a, b) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.xEnd, b.xEnd);
  return Math.max(0, right - left);
}

function centerOf(seg) {
  return (seg.x + seg.xEnd) / 2;
}

function groupRows(items, page) {
  const usable = items
    .filter((item) => item?.str && item.str.trim())
    .map((item) => ({
      ...item,
      str: item.str.replace(/\s+/g, " ").trim(),
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      width: Number(item.width) || 0,
      fontSize: Number(item.fontSize) || 0,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const fontMedian = median(usable.map((x) => x.fontSize)) || 10;
  const yTolerance = Math.max(1.5, Math.min(4, fontMedian * 0.28));

  const grouped = [];
  for (const item of usable) {
    let best;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = Math.max(0, grouped.length - 5); i < grouped.length; i++) {
      const candidate = grouped[i];
      const distance = Math.abs(candidate.y - item.y);
      if (distance <= yTolerance && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (!best) {
      best = { y: item.y, items: [] };
      grouped.push(best);
    }
    best.items.push(item);
    best.y = best.items.reduce((s, x) => s + x.y, 0) / best.items.length;
  }

  return grouped
    .sort((a, b) => b.y - a.y)
    .map((group, rowIndex) => {
      const rowItems = [...group.items].sort((a, b) => a.x - b.x);
      const gaps = [];
      for (let i = 1; i < rowItems.length; i++) {
        const previous = rowItems[i - 1];
        const current = rowItems[i];
        const gap = current.x - (previous.x + previous.width);
        if (gap > 0) gaps.push(gap);
      }
      const gapMedian = median(gaps) || fontMedian * 0.3;
      const splitThreshold = Math.max(fontMedian * 1.1, gapMedian * 3, 10);

      const segments = [];
      let current;
      for (const item of rowItems) {
        const xEnd = item.x + item.width;
        if (!current) {
          current = {
            x: item.x,
            xEnd,
            text: item.str,
            fontSize: item.fontSize || fontMedian,
            sourceItems: [item],
          };
          continue;
        }

        const gap = item.x - current.xEnd;
        if (gap > splitThreshold) {
          segments.push(current);
          current = {
            x: item.x,
            xEnd,
            text: item.str,
            fontSize: item.fontSize || fontMedian,
            sourceItems: [item],
          };
        } else {
          current.text += gap > fontMedian * 0.15 ? " " + item.str : item.str;
          current.xEnd = Math.max(current.xEnd, xEnd);
          current.sourceItems.push(item);
        }
      }
      if (current) segments.push(current);

      return {
        page,
        row: rowIndex,
        y: group.y,
        fontMedian,
        segments,
        text: segments.map((s) => s.text).join(" | "),
      };
    });
}

function clusterHeaderSegments(rows, start, count) {
  const nodes = [];

  for (let offset = 0; offset < count; offset++) {
    const row = rows[start + offset];
    if (!row) continue;

    for (const segment of row.segments) {
      const sourceItems =
        Array.isArray(segment.sourceItems) && segment.sourceItems.length
          ? segment.sourceItems
          : [
              {
                str: segment.text,
                x: segment.x,
                width: segment.xEnd - segment.x,
                fontSize: segment.fontSize,
              },
            ];

      for (const item of sourceItems) {
        const text = String(item.str ?? "").replace(/\s+/g, " ").trim();
        if (!text) continue;

        const x = Number(item.x);
        const width = Number(item.width);
        if (!Number.isFinite(x)) continue;

        nodes.push({
          x,
          xEnd: x + (Number.isFinite(width) ? width : 0),
          text,
          rowOffset: offset,
          y: row.y,
          fontSize: Number(item.fontSize) || row.fontMedian || 9,
        });
      }
    }
  }

  const expected = EXPECTED_HEADERS.map((name) => ({
    name,
    normalized: normalizeHeader(name),
  }));
  const expectedSet = new Set(expected.map((x) => x.normalized));

  const orderedNodes = [...nodes].sort(
    (a, b) => a.rowOffset - b.rowOffset || a.x - b.x
  );

  function relation(a, b) {
    const widthA = Math.max(1, a.xEnd - a.x);
    const widthB = Math.max(1, b.xEnd - b.x);

    if (a.rowOffset === b.rowOffset) {
      const left = a.x <= b.x ? a : b;
      const right = left === a ? b : a;
      const gap = Math.max(0, right.x - left.xEnd);
      const font = Math.max(1, Math.min(a.fontSize, b.fontSize));
      return gap <= Math.max(8, font * 1.8);
    }

    const overlap = horizontalOverlap(a, b);
    const overlapRatio = overlap / Math.min(widthA, widthB);
    const centerDistance = Math.abs(centerOf(a) - centerOf(b));
    return (
      overlapRatio >= 0.18 ||
      centerDistance <= Math.max(6, Math.min(widthA, widthB) * 0.55)
    );
  }

  function connected(combo) {
    if (combo.length <= 1) return true;

    const visited = new Set([0]);
    let changed = true;

    while (changed) {
      changed = false;
      for (let i = 0; i < combo.length; i++) {
        if (!visited.has(i)) continue;
        for (let j = 0; j < combo.length; j++) {
          if (visited.has(j)) continue;
          if (relation(combo[i], combo[j])) {
            visited.add(j);
            changed = true;
          }
        }
      }
    }

    return visited.size === combo.length;
  }

  function candidateFromNodes(combo) {
    const ordered = [...combo].sort(
      (a, b) => a.rowOffset - b.rowOffset || a.x - b.x
    );
    const text = ordered.map((n) => n.text).join(" ");
    const normalized = normalizeHeader(text);
    const x = Math.min(...ordered.map((n) => n.x));
    const xEnd = Math.max(...ordered.map((n) => n.xEnd));

    return {
      x,
      xEnd,
      xCenter: (x + xEnd) / 2,
      text,
      normalized,
      rowOffsets: [...new Set(ordered.map((n) => n.rowOffset))],
      parts: ordered.map((n) => ({
        rowOffset: n.rowOffset,
        x: n.x,
        xEnd: n.xEnd,
        text: n.text,
      })),
    };
  }

  const candidates = [];

  for (let i = 0; i < orderedNodes.length; i++) {
    const one = candidateFromNodes([orderedNodes[i]]);
    if (expectedSet.has(one.normalized)) candidates.push(one);

    for (let j = i + 1; j < orderedNodes.length; j++) {
      const pairNodes = [orderedNodes[i], orderedNodes[j]];
      if (!connected(pairNodes)) continue;

      const pair = candidateFromNodes(pairNodes);
      if (expectedSet.has(pair.normalized)) candidates.push(pair);

      for (let k = j + 1; k < orderedNodes.length; k++) {
        const tripleNodes = [
          orderedNodes[i],
          orderedNodes[j],
          orderedNodes[k],
        ];
        if (!connected(tripleNodes)) continue;

        const triple = candidateFromNodes(tripleNodes);
        if (expectedSet.has(triple.normalized)) candidates.push(triple);
      }
    }
  }

  const deduped = [];
  for (const target of expected) {
    const matches = candidates
      .filter((candidate) => candidate.normalized === target.normalized)
      .sort((a, b) => {
        const rowsA = a.rowOffsets.length;
        const rowsB = b.rowOffsets.length;
        if (rowsA !== rowsB) return rowsB - rowsA;

        const widthA = a.xEnd - a.x;
        const widthB = b.xEnd - b.x;
        if (widthA !== widthB) return widthA - widthB;

        return a.x - b.x;
      });

    if (matches[0]) deduped.push(matches[0]);
  }

  return deduped;
}

function detectHeaderCandidate(rows) {
  const expected = EXPECTED_HEADERS.map((name) => ({
    name,
    normalized: normalizeHeader(name),
  }));

  let best = null;

  for (let start = 0; start < rows.length; start++) {
    for (const count of [1, 2, 3]) {
      if (start + count > rows.length) continue;
      const clusters = clusterHeaderSegments(rows, start, count);
      const matches = [];

      for (const target of expected) {
        const hit = clusters.find((cluster) => cluster.normalized === target.normalized);
        if (hit) {
          matches.push({
            name: target.name,
            x: hit.x,
            xEnd: hit.xEnd,
            xCenter: hit.xCenter,
            text: hit.text,
            rowOffsets: hit.rowOffsets,
            parts: hit.parts,
          });
        }
      }

      const sorted = [...matches].sort((a, b) => a.xCenter - b.xCenter);
      const order = sorted.map((x) => x.name);
      const exactOrderPrefix = order.every(
        (name, index) => name === EXPECTED_HEADERS[index]
      );

      const multilineCount = sorted.filter((x) => x.rowOffsets.length > 1).length;
      const score =
        matches.length * 100 +
        (exactOrderPrefix ? 20 : 0) +
        multilineCount * 2 -
        count;

      if (!best || score > best.score) {
        best = {
          score,
          start,
          count,
          matched: matches.length,
          order,
          exactOrderPrefix,
          multilineCount,
          columns: sorted,
          rows: rows.slice(start, start + count).map((row) => ({
            row: row.row,
            y: row.y,
            text: row.text,
            segments: row.segments,
          })),
          clusters,
        };
      }
    }
  }

  return best;
}

function splitSymbolsFromSegment(segment) {
  const chars = Array.from(segment.text);
  if (!chars.length) return [];

  const width = Math.max(0.001, segment.xEnd - segment.x);
  const unit = width / chars.length;
  const result = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!"◎★☆".includes(ch)) continue;

    const x0 = segment.x + unit * i;
    const x1 = segment.x + unit * (i + 1);
    const suffixText = chars.slice(i + 1).join("").trim();
    const suffixMatch = suffixText.match(/^\(([^)]+)\)/);

    result.push({
      symbol: ch,
      x0,
      x1,
      xCenter: (x0 + x1) / 2,
      suffix: suffixMatch?.[1] ?? null,
      sourceText: segment.text,
      coordinatePrecision: chars.length === 1 ? "segment" : "glyph-width-estimate",
    });
  }

  return result;
}

function symbolsInRow(row) {
  return row.segments.flatMap(splitSymbolsFromSegment);
}

function makeColumnBoundaries(columns) {
  const sorted = [...columns].sort((a, b) => a.xCenter - b.xCenter);
  const boundaries = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    boundaries.push((sorted[i].xCenter + sorted[i + 1].xCenter) / 2);
  }

  const firstGap =
    sorted.length > 1 ? sorted[1].xCenter - sorted[0].xCenter : 20;
  const lastGap =
    sorted.length > 1
      ? sorted[sorted.length - 1].xCenter - sorted[sorted.length - 2].xCenter
      : 20;

  return sorted.map((column, index) => ({
    ...column,
    left: index === 0 ? column.xCenter - firstGap / 2 : boundaries[index - 1],
    right:
      index === sorted.length - 1
        ? column.xCenter + lastGap / 2
        : boundaries[index],
  }));
}

function mapSymbolToColumn(symbol, columns) {
  const hit = columns.find(
    (column) => symbol.xCenter >= column.left && symbol.xCenter < column.right
  );
  if (hit) return hit;

  return [...columns]
    .map((column) => ({
      column,
      distance: Math.abs(column.xCenter - symbol.xCenter),
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.column;
}

function compactRow(row) {
  return {
    page: row.page,
    row: row.row,
    y: Number(row.y.toFixed(2)),
    text: row.text,
    segments: row.segments.map((s) => ({
      x: Number(s.x.toFixed(2)),
      xEnd: Number(s.xEnd.toFixed(2)),
      text: s.text,
    })),
    symbols: symbolsInRow(row).map((s) => ({
      ...s,
      x0: Number(s.x0.toFixed(2)),
      x1: Number(s.x1.toFixed(2)),
      xCenter: Number(s.xCenter.toFixed(2)),
    })),
  };
}

const response = await fetchWithRetry(PDF_URL, {
  headers: {
    "User-Agent": "Mozilla/5.0 ADD-Regulations-MCP-PDF-Structured-Test/2.0",
    "Accept-Language": "ko-KR,ko;q=0.9",
  },
});
if (!response.ok) throw new Error("pdf HTTP " + response.status);

const bytes = new Uint8Array(await response.arrayBuffer());
const downloadedBytes = bytes.byteLength;
const pdf = await getDocumentProxy(bytes);
const { totalPages, items } = await extractTextItems(pdf);
const plain = await extractText(pdf, { mergePages: true });

const pages = items.map((pageItems, pageIndex) => ({
  page: pageIndex + 1,
  rows: groupRows(pageItems, pageIndex + 1),
}));

console.log("PDF_LAYOUT_META_START");
console.log(
  JSON.stringify(
    {
      fileNo: "166852",
      bytes: downloadedBytes,
      totalPages,
      totalItems: items.reduce((sum, pageItems) => sum + pageItems.length, 0),
      plainTextLength: Array.isArray(plain.text)
        ? plain.text.join("\n").length
        : plain.text.length,
    },
    null,
    2
  )
);
console.log("PDF_LAYOUT_META_END");

const page34Debug = pages.find((page) => page.page === 34);
if (page34Debug) {
  console.log("PDF_PAGE34_HEADER_ZONE_START");
  console.log(
    JSON.stringify(
      page34Debug.rows.slice(11, 24).map((row) => ({
        row: row.row,
        y: row.y,
        text: row.text,
        rawItems: row.segments.flatMap((segment) =>
          (segment.sourceItems ?? []).map((item) => ({
            str: item.str,
            x: item.x,
            xEnd: Number(item.x) + Number(item.width || 0),
            y: item.y,
            width: item.width,
          }))
        ),
      })),
      null,
      2
    )
  );
  console.log("PDF_PAGE34_HEADER_ZONE_END");
}

const pageCandidates = pages
  .map((page) => ({
    page: page.page,
    candidate: detectHeaderCandidate(page.rows),
  }))
  .sort((a, b) => (b.candidate?.score ?? -1) - (a.candidate?.score ?? -1));

console.log("PDF_HEADER_CANDIDATES_START");
console.log(
  JSON.stringify(
    pageCandidates.slice(0, 12).map((x) => ({
      page: x.page,
      score: x.candidate?.score,
      matched: x.candidate?.matched,
      count: x.candidate?.count,
      multilineCount: x.candidate?.multilineCount,
      order: x.candidate?.order,
      rows: x.candidate?.rows,
      columns: x.candidate?.columns,
    })),
    null,
    2
  )
);
console.log("PDF_HEADER_CANDIDATES_END");

const exactHeaders = pageCandidates.filter(
  (x) =>
    x.candidate?.matched === EXPECTED_HEADERS.length &&
    JSON.stringify(x.candidate?.order) === JSON.stringify(EXPECTED_HEADERS)
);

if (!exactHeaders.length) {
  throw new Error("7-column approval header reconstruction failed");
}

const primary = exactHeaders.find((x) => x.page === 34) ?? exactHeaders[0];
const header = primary.candidate;
const columns = makeColumnBoundaries(header.columns);

console.log("PDF_7COL_HEADER_START");
console.log(
  JSON.stringify(
    {
      page: primary.page,
      headerRows: header.rows,
      rowsUsed: header.count,
      multilineCount: header.multilineCount,
      columns,
    },
    null,
    2
  )
);
console.log("PDF_7COL_HEADER_END");

if (header.count < 2 && header.multilineCount < 1) {
  throw new Error("multi-line header merge was not exercised");
}

const allSymbols = [];
for (const page of pages) {
  for (const row of page.rows) {
    for (const symbol of symbolsInRow(row)) {
      allSymbols.push({
        page: page.page,
        row: row.row,
        y: row.y,
        ...symbol,
      });
    }
  }
}

const symbolSummary = {
  total: allSymbols.length,
  byType: Object.fromEntries(
    ["◎", "★", "☆"].map((symbol) => [
      symbol,
      allSymbols.filter((x) => x.symbol === symbol).length,
    ])
  ),
  glyphWidthEstimated: allSymbols.filter(
    (x) => x.coordinatePrecision === "glyph-width-estimate"
  ).length,
};

console.log("PDF_SYMBOL_SUMMARY_START");
console.log(JSON.stringify(symbolSummary, null, 2));
console.log("PDF_SYMBOL_SUMMARY_END");

for (const symbol of ["◎", "★", "☆"]) {
  if (!allSymbols.some((x) => x.symbol === symbol)) {
    throw new Error("symbol coordinate extraction missed " + symbol);
  }
}

const targetPage = pages.find((page) => page.page === primary.page);
const headerEndRow = header.start + header.count - 1;
const firstColumnLeft = columns[0].left;

let currentTask = null;
let currentCondition = null;
let targetRegression = null;
const mappedRows = [];

for (let i = headerEndRow + 1; i < targetPage.rows.length; i++) {
  const row = targetPage.rows[i];
  const leftSegments = row.segments.filter(
    (segment) => (segment.x + segment.xEnd) / 2 < firstColumnLeft
  );
  const leftText = leftSegments.map((s) => s.text).join(" / ");

  if (/계약\s*및\s*협약\s*승인/.test(leftText)) {
    currentTask = "계약 및 협약 승인";
  }

  const conditionMatch = leftText.match(
    /(\d+(?:\.\d+)?\s*억\s*원(?:\s*이상)?(?:\s*\d+(?:\.\d+)?\s*억\s*원)?\s*(?:미만|이하|초과|이상))/
  );
  if (conditionMatch) {
    currentCondition = conditionMatch[1].replace(/\s+/g, " ").trim();
  }

  const symbols = symbolsInRow(row);
  if (!symbols.length) continue;

  const mapped = symbols.map((symbol) => {
    const column = mapSymbolToColumn(symbol, columns);
    return {
      symbol: symbol.symbol,
      suffix: symbol.suffix,
      x0: Number(symbol.x0.toFixed(2)),
      x1: Number(symbol.x1.toFixed(2)),
      xCenter: Number(symbol.xCenter.toFixed(2)),
      coordinatePrecision: symbol.coordinatePrecision,
      approver: column?.name ?? null,
      columnCenter: column ? Number(column.xCenter.toFixed(2)) : null,
    };
  });

  const entry = {
    page: row.page,
    row: row.row,
    y: Number(row.y.toFixed(2)),
    leftText,
    filledTask: currentTask,
    filledCondition: currentCondition,
    mapped,
    raw: compactRow(row),
  };
  mappedRows.push(entry);

  if (
    currentTask === "계약 및 협약 승인" &&
    normalize(currentCondition).includes(normalize("30억원미만")) &&
    mapped.some((x) => x.symbol === "◎" && x.approver === "실장")
  ) {
    targetRegression = entry;
  }
}

console.log("PDF_PAGE34_MAPPED_ROWS_START");
console.log(JSON.stringify(mappedRows, null, 2));
console.log("PDF_PAGE34_MAPPED_ROWS_END");

const nearbyKeywordRows = targetPage.rows
  .filter(
    (row) =>
      /계약|협약|30\s*억|◎|★|☆/.test(row.text)
  )
  .map(compactRow);

console.log("PDF_PAGE34_KEYWORD_ROWS_START");
console.log(JSON.stringify(nearbyKeywordRows, null, 2));
console.log("PDF_PAGE34_KEYWORD_ROWS_END");

if (!targetRegression) {
  throw new Error(
    "fill-down regression failed: 계약 및 협약 승인 / 30억원 미만 / 실장 ◎ was not reconstructed"
  );
}

console.log("PDF_FILL_DOWN_ASSERT_START");
console.log(JSON.stringify(targetRegression, null, 2));
console.log("PDF_FILL_DOWN_ASSERT_END");

const multiSymbolRows = pages.flatMap((page) =>
  page.rows
    .map((row) => ({ page: page.page, row, symbols: symbolsInRow(row) }))
    .filter((x) => x.symbols.length >= 2)
    .map((x) => ({
      page: x.page,
      row: x.row.row,
      text: x.row.text,
      symbols: x.symbols.map((s) => ({
        symbol: s.symbol,
        xCenter: Number(s.xCenter.toFixed(2)),
        sourceText: s.sourceText,
      })),
    }))
);

console.log("PDF_MULTI_SYMBOL_ROWS_START");
console.log(JSON.stringify(multiSymbolRows.slice(0, 40), null, 2));
console.log("PDF_MULTI_SYMBOL_ROWS_END");

for (const row of multiSymbolRows) {
  const centers = row.symbols.map((s) => s.xCenter);
  if (new Set(centers).size !== centers.length) {
    throw new Error("multiple symbols in one row did not receive individual x coordinates");
  }
}

console.log("PDF_STRUCTURED_REGRESSION_PASS");
