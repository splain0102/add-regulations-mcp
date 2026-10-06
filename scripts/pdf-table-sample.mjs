import { extractText, extractTextItems, getDocumentProxy } from "unpdf";

const PDF_URL =
  "https://www.alio.go.kr/download/rulefiledown.json?fileNo=166852";

const EXPECTED_HEADERS = [
  "사책/과책",
  "운영",
  "실장",
  "부(센터)장",
  "원장/기술센터장",
  "부소장",
  "소장",
];

const REAL_2023_HEADERS = [
  "사책/과책",
  "운영",
  "실장",
];

const PDF_SYMBOLS = new Set(["◎", "★", "☆"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchWithRetry(url, init = {}, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init);

      if (
        response.ok ||
        (response.status < 500 && response.status !== 429)
      ) {
        return response;
      }

      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, attempt * 1500)
      );
    }
  }

  throw lastError ?? new Error("fetch failed");
}

function median(values) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return 0;

  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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
  return Math.max(
    0,
    Math.min(a.xEnd, b.xEnd) - Math.max(a.x, b.x)
  );
}

function centerOf(value) {
  return (value.x + value.xEnd) / 2;
}

function makeItem(str, x, y, width, fontSize = 9) {
  return {
    str,
    x,
    y,
    width,
    height: fontSize,
    fontSize,
    fontFamily: "sans-serif",
    dir: "ltr",
    hasEOL: false,
  };
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

  if (!usable.length) return [];

  const fontMedian =
    median(usable.map((item) => item.fontSize)) || 10;

  const yTolerance = Math.max(
    1.5,
    Math.min(4, fontMedian * 0.28)
  );

  const grouped = [];

  for (const item of usable) {
    let best;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (
      let index = Math.max(0, grouped.length - 5);
      index < grouped.length;
      index++
    ) {
      const candidate = grouped[index];
      const distance = Math.abs(candidate.y - item.y);

      if (
        distance <= yTolerance &&
        distance < bestDistance
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }

    if (!best) {
      best = { y: item.y, items: [] };
      grouped.push(best);
    }

    best.items.push(item);
    best.y =
      best.items.reduce((sum, value) => sum + value.y, 0) /
      best.items.length;
  }

  return grouped
    .sort((a, b) => b.y - a.y)
    .map((group, rowIndex) => {
      const rowItems = [...group.items].sort(
        (a, b) => a.x - b.x
      );

      const positiveGaps = [];

      for (let index = 1; index < rowItems.length; index++) {
        const previous = rowItems[index - 1];
        const current = rowItems[index];
        const gap =
          current.x - (previous.x + previous.width);

        if (gap > 0) positiveGaps.push(gap);
      }

      const gapMedian =
        median(positiveGaps) || fontMedian * 0.3;

      const splitThreshold = Math.max(
        fontMedian * 1.1,
        gapMedian * 3,
        10
      );

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
          continue;
        }

        current.text +=
          gap > fontMedian * 0.15
            ? " " + item.str
            : item.str;

        current.xEnd = Math.max(current.xEnd, xEnd);
        current.sourceItems.push(item);
      }

      if (current) segments.push(current);

      return {
        page,
        row: rowIndex,
        y: group.y,
        fontMedian,
        segments,
        text: segments.map((segment) => segment.text).join(" | "),
      };
    });
}

function rawItemsInRow(row) {
  return row.segments
    .flatMap((segment) =>
      Array.isArray(segment.sourceItems) &&
      segment.sourceItems.length
        ? segment.sourceItems
        : [
            {
              str: segment.text,
              x: segment.x,
              y: row.y,
              width: segment.xEnd - segment.x,
              fontSize: segment.fontSize,
            },
          ]
    )
    .map((item) => ({
      ...item,
      str: String(item.str ?? "").replace(/\s+/g, " ").trim(),
      x: Number(item.x) || 0,
      y: Number(item.y) || row.y,
      width: Number(item.width) || 0,
      fontSize: Number(item.fontSize) || row.fontMedian || 9,
    }))
    .filter((item) => item.str)
    .sort((a, b) => a.x - b.x);
}

function clusterHeaderSegments(
  rows,
  start,
  count,
  expectedHeaders
) {
  const nodes = [];

  for (let offset = 0; offset < count; offset++) {
    const row = rows[start + offset];
    if (!row) continue;

    for (const item of rawItemsInRow(row)) {
      nodes.push({
        x: item.x,
        xEnd: item.x + item.width,
        text: item.str,
        rowOffset: offset,
        y: item.y,
        fontSize: item.fontSize,
      });
    }
  }

  const expected = expectedHeaders.map((name) => ({
    name,
    normalized: normalizeHeader(name),
  }));

  const expectedSet = new Set(
    expected.map((item) => item.normalized)
  );

  const orderedNodes = [...nodes].sort(
    (a, b) =>
      a.rowOffset - b.rowOffset ||
      a.x - b.x
  );

  function related(a, b) {
    const widthA = Math.max(1, a.xEnd - a.x);
    const widthB = Math.max(1, b.xEnd - b.x);

    if (a.rowOffset === b.rowOffset) {
      const left = a.x <= b.x ? a : b;
      const right = left === a ? b : a;
      const gap = Math.max(0, right.x - left.xEnd);
      const font = Math.max(
        1,
        Math.min(a.fontSize, b.fontSize)
      );

      return gap <= Math.max(8, font * 1.8);
    }

    const overlap = horizontalOverlap(a, b);
    const overlapRatio =
      overlap / Math.min(widthA, widthB);

    const centerDistance = Math.abs(
      centerOf(a) - centerOf(b)
    );

    return (
      overlapRatio >= 0.18 ||
      centerDistance <=
        Math.max(
          6,
          Math.min(widthA, widthB) * 0.6
        )
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

          if (related(combo[i], combo[j])) {
            visited.add(j);
            changed = true;
          }
        }
      }
    }

    return visited.size === combo.length;
  }

  function buildCandidate(combo) {
    const ordered = [...combo].sort(
      (a, b) =>
        a.rowOffset - b.rowOffset ||
        a.x - b.x
    );

    const text = ordered.map((node) => node.text).join(" ");
    const x = Math.min(...ordered.map((node) => node.x));
    const xEnd = Math.max(
      ...ordered.map((node) => node.xEnd)
    );

    return {
      x,
      xEnd,
      xCenter: (x + xEnd) / 2,
      text,
      normalized: normalizeHeader(text),
      rowOffsets: [
        ...new Set(
          ordered.map((node) => node.rowOffset)
        ),
      ],
      parts: ordered.map((node) => ({
        rowOffset: node.rowOffset,
        x: node.x,
        xEnd: node.xEnd,
        text: node.text,
      })),
    };
  }

  const candidates = [];

  for (let i = 0; i < orderedNodes.length; i++) {
    const one = buildCandidate([orderedNodes[i]]);

    if (expectedSet.has(one.normalized)) {
      candidates.push(one);
    }

    for (let j = i + 1; j < orderedNodes.length; j++) {
      const pairNodes = [
        orderedNodes[i],
        orderedNodes[j],
      ];

      if (!connected(pairNodes)) continue;

      const pair = buildCandidate(pairNodes);

      if (expectedSet.has(pair.normalized)) {
        candidates.push(pair);
      }

      for (
        let k = j + 1;
        k < orderedNodes.length;
        k++
      ) {
        const tripleNodes = [
          orderedNodes[i],
          orderedNodes[j],
          orderedNodes[k],
        ];

        if (!connected(tripleNodes)) continue;

        const triple = buildCandidate(tripleNodes);

        if (expectedSet.has(triple.normalized)) {
          candidates.push(triple);
        }
      }
    }
  }

  const deduped = [];

  for (const target of expected) {
    const matches = candidates
      .filter(
        (candidate) =>
          candidate.normalized === target.normalized
      )
      .sort((a, b) => {
        if (
          a.rowOffsets.length !== b.rowOffsets.length
        ) {
          return (
            b.rowOffsets.length -
            a.rowOffsets.length
          );
        }

        const widthA = a.xEnd - a.x;
        const widthB = b.xEnd - b.x;

        if (widthA !== widthB) {
          return widthA - widthB;
        }

        return a.x - b.x;
      });

    if (matches[0]) deduped.push(matches[0]);
  }

  return deduped;
}

function detectHeaderCandidate(
  rows,
  expectedHeaders = EXPECTED_HEADERS
) {
  const expected = expectedHeaders.map((name) => ({
    name,
    normalized: normalizeHeader(name),
  }));

  let best = null;

  for (let start = 0; start < rows.length; start++) {
    for (const count of [1, 2, 3]) {
      if (start + count > rows.length) continue;

      const clusters = clusterHeaderSegments(
        rows,
        start,
        count,
        expectedHeaders
      );

      const matches = [];

      for (const target of expected) {
        const hit = clusters.find(
          (cluster) =>
            cluster.normalized === target.normalized
        );

        if (!hit) continue;

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

      const sorted = [...matches].sort(
        (a, b) => a.xCenter - b.xCenter
      );

      const order = sorted.map((item) => item.name);

      const exactOrderPrefix = order.every(
        (name, index) =>
          name === expectedHeaders[index]
      );

      const multilineCount = sorted.filter(
        (item) => item.rowOffsets.length > 1
      ).length;

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
          rows: rows
            .slice(start, start + count)
            .map((row) => ({
              row: row.row,
              y: row.y,
              text: row.text,
            })),
        };
      }
    }
  }

  return best;
}

function symbolsInRow(row) {
  const raw = rawItemsInRow(row);
  const results = [];

  for (let itemIndex = 0; itemIndex < raw.length; itemIndex++) {
    const item = raw[itemIndex];
    const chars = Array.from(item.str);

    if (!chars.some((char) => PDF_SYMBOLS.has(char))) {
      continue;
    }

    const width = Math.max(0.001, item.width);
    const unit = width / Math.max(1, chars.length);

    for (
      let charIndex = 0;
      charIndex < chars.length;
      charIndex++
    ) {
      const symbol = chars[charIndex];

      if (!PDF_SYMBOLS.has(symbol)) continue;

      const x0 = item.x + unit * charIndex;
      const x1 = item.x + unit * (charIndex + 1);

      const sameItemSuffix = chars
        .slice(charIndex + 1)
        .join("")
        .trim()
        .match(/^\(([^)]+)\)/);

      let suffix = sameItemSuffix?.[1] ?? null;

      if (!suffix && chars.length === 1) {
        const next = raw[itemIndex + 1];

        if (
          next &&
          Math.abs(next.y - item.y) <= 2.5 &&
          next.x - (item.x + item.width) <=
            Math.max(3, item.fontSize * 0.5)
        ) {
          const match = next.str.match(/^\(([^)]+)\)/);
          suffix = match?.[1] ?? null;
        }
      }

      results.push({
        symbol,
        x0,
        x1,
        xCenter: (x0 + x1) / 2,
        y: item.y,
        suffix,
        sourceText: item.str,
        coordinate_type: "pdf_point",
        coordinatePrecision:
          chars.length === 1
            ? "raw-item-exact"
            : "glyph-width-estimate",
      });
    }
  }

  return results;
}

function makeColumnBoundaries(columns) {
  const sorted = [...columns].sort(
    (a, b) => a.xCenter - b.xCenter
  );

  assert(sorted.length > 0, "no header columns");

  const boundaries = [];

  for (let index = 0; index < sorted.length - 1; index++) {
    boundaries.push(
      (sorted[index].xCenter +
        sorted[index + 1].xCenter) /
        2
    );
  }

  const firstGap =
    sorted.length > 1
      ? sorted[1].xCenter - sorted[0].xCenter
      : 20;

  const lastGap =
    sorted.length > 1
      ? sorted[sorted.length - 1].xCenter -
        sorted[sorted.length - 2].xCenter
      : 20;

  return sorted.map((column, index) => ({
    ...column,
    left:
      index === 0
        ? column.xCenter - firstGap / 2
        : boundaries[index - 1],
    right:
      index === sorted.length - 1
        ? column.xCenter + lastGap / 2
        : boundaries[index],
  }));
}

function mapSymbolToColumn(symbol, columns) {
  const direct = columns.find(
    (column) =>
      symbol.xCenter >= column.left &&
      symbol.xCenter < column.right
  );

  if (direct) return direct;

  return [...columns]
    .map((column) => ({
      column,
      distance: Math.abs(
        column.xCenter - symbol.xCenter
      ),
    }))
    .sort((a, b) => a.distance - b.distance)[0]
    ?.column;
}

function fillDownRecords(records) {
  let state = {
    category: null,
    task: null,
    detail: null,
  };

  return records.map((record) => {
    if (record.newTable) {
      state = {
        category: null,
        task: null,
        detail: null,
      };
    }

    if (
      record.kind === "header" ||
      record.kind === "legend"
    ) {
      return {
        ...record,
        filledCategory: null,
        filledTask: null,
        filledDetail: null,
      };
    }

    if (record.category) state.category = record.category;
    if (record.task) state.task = record.task;
    if (record.detail) state.detail = record.detail;

    return {
      ...record,
      filledCategory: record.category || state.category,
      filledTask: record.task || state.task,
      filledDetail: record.detail || state.detail,
    };
  });
}

function runDeterministicRegressions() {
  const simpleRows = groupRows(
    [
      makeItem("운영", 500, 500, 18),
      makeItem("실장", 550, 500, 18),
    ],
    1
  );

  const simpleHeader = detectHeaderCandidate(
    simpleRows,
    ["운영", "실장"]
  );

  assert(
    simpleHeader?.matched === 2 &&
      JSON.stringify(simpleHeader.order) ===
        JSON.stringify(["운영", "실장"]),
    "simple 2-column header split failed"
  );

  const sevenHeaderItems = [
    makeItem("사책/", 450, 503, 22),
    makeItem("부", 600, 503, 9),
    makeItem("원장/", 650, 503, 25),

    makeItem("운영", 500, 500, 18),
    makeItem("실장", 550, 500, 18),
    makeItem("부소장", 700, 500, 27),
    makeItem("소장", 750, 500, 18),

    makeItem("과책", 452, 497, 18),
    makeItem("(센터)장", 600, 497, 36),
    makeItem("기술센터장", 650, 497, 45),
  ];

  const sevenRows = groupRows(sevenHeaderItems, 1);
  const sevenHeader = detectHeaderCandidate(
    sevenRows,
    EXPECTED_HEADERS
  );

  assert(
    sevenHeader?.matched === 7,
    "7-column header reconstruction failed"
  );

  assert(
    JSON.stringify(sevenHeader.order) ===
      JSON.stringify(EXPECTED_HEADERS),
    "7-column header order failed"
  );

  const multilineNames = sevenHeader.columns
    .filter((column) => column.rowOffsets.length > 1)
    .map((column) => column.name);

  for (const required of [
    "사책/과책",
    "부(센터)장",
    "원장/기술센터장",
  ]) {
    assert(
      multilineNames.includes(required),
      "multi-line header merge failed: " + required
    );
  }

  const symbolRows = groupRows(
    [
      makeItem("◎ ◎ ☆", 500, 450, 90),
      makeItem("★", 610, 450, 9),
      makeItem("◎", 700, 430, 9),
      makeItem("(책임원)", 709, 430, 36),
    ],
    1
  );

  const multiSymbols = symbolsInRow(symbolRows[0]);

  assert(
    multiSymbols.length === 4,
    "◎★☆ token split failed"
  );

  assert(
    new Set(
      multiSymbols.map((symbol) =>
        symbol.xCenter.toFixed(4)
      )
    ).size === multiSymbols.length,
    "◎★☆ individual x coordinates failed"
  );

  assert(
    multiSymbols.every(
      (symbol) =>
        symbol.coordinate_type === "pdf_point"
    ),
    "PDF coordinate type failed"
  );

  const suffixSymbol = symbolsInRow(symbolRows[1]).find(
    (symbol) => symbol.symbol === "◎"
  );

  assert(
    suffixSymbol?.suffix === "책임원",
    "symbol suffix split failed"
  );

  assert(
    suffixSymbol?.coordinatePrecision ===
      "raw-item-exact",
    "raw symbol coordinate precision failed"
  );

  const filled = fillDownRecords([
    {
      page: 1,
      category: "정책분야",
      task: "국정감사",
      detail: "중요사항",
    },
    {
      page: 1,
      category: "",
      task: "",
      detail: "일반사항",
    },
    {
      page: 1,
      kind: "legend",
      category: "범례",
      task: "★",
      detail: "",
    },
    {
      page: 2,
      category: "",
      task: "",
      detail: "후속사항",
    },
    {
      page: 2,
      newTable: true,
      category: "",
      task: "",
      detail: "새 표 첫행",
    },
  ]);

  assert(
    filled[1].filledCategory === "정책분야" &&
      filled[1].filledTask === "국정감사",
    "same-page fill-down failed"
  );

  assert(
    filled[3].filledCategory === "정책분야" &&
      filled[3].filledTask === "국정감사",
    "cross-page fill-down failed"
  );

  assert(
    filled[3].filledTask !== "★",
    "legend exclusion failed"
  );

  assert(
    filled[4].filledCategory === null &&
      filled[4].filledTask === null,
    "new-table fill-down reset failed"
  );

  console.log(
    "PDF_DETERMINISTIC_REGRESSION_PASS",
    JSON.stringify({
      simpleColumns: simpleHeader.order,
      sevenColumns: sevenHeader.order,
      multilineNames,
      individualSymbols: multiSymbols.map((symbol) => ({
        symbol: symbol.symbol,
        x0: symbol.x0,
        x1: symbol.x1,
        x_center: symbol.xCenter,
        y: symbol.y,
        coordinate_type: symbol.coordinate_type,
        precision: symbol.coordinatePrecision,
      })),
      suffix: suffixSymbol.suffix,
      fillDown: {
        samePage: true,
        crossPage: true,
        legendExcluded: true,
        newTableReset: true,
      },
    })
  );
}

async function runLivePdfRegression() {
  const response = await fetchWithRetry(PDF_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 ADD-Regulations-MCP-PDF-Structured-Test/2.0",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });

  assert(response.ok, "pdf HTTP " + response.status);

  const bytes = new Uint8Array(
    await response.arrayBuffer()
  );

  const downloadedBytes = bytes.byteLength;
  const pdf = await getDocumentProxy(bytes);

  try {
    const { totalPages, items } =
      await extractTextItems(pdf);

    const plain = await extractText(pdf, {
      mergePages: true,
    });

    const pages = items.map(
      (pageItems, pageIndex) => ({
        page: pageIndex + 1,
        rows: groupRows(pageItems, pageIndex + 1),
      })
    );

    const page34 = pages.find(
      (page) => page.page === 34
    );

    assert(page34, "page 34 not found");

    const header = detectHeaderCandidate(
      page34.rows,
      REAL_2023_HEADERS
    );

    assert(
      header?.matched === REAL_2023_HEADERS.length,
      "2023 page 34 repeated header reconstruction failed"
    );

    assert(
      JSON.stringify(header.order) ===
        JSON.stringify(REAL_2023_HEADERS),
      "2023 page 34 repeated header order failed"
    );

    assert(
      header.columns.find(
        (column) =>
          column.name === "사책/과책" &&
          column.rowOffsets.length > 1
      ),
      "2023 multi-line 사책/과책 header merge failed"
    );

    const columns = makeColumnBoundaries(
      header.columns
    );

    let currentTask = null;
    let target = null;

    for (
      let index = header.start + header.count;
      index < page34.rows.length;
      index++
    ) {
      const row = page34.rows[index];

      if (/계약\s*및\s*협약\s*승인/.test(row.text)) {
        currentTask = "계약 및 협약 승인";
      }

      const conditionMatch = row.text.match(
        /(\d+(?:\.\d+)?\s*억\s*원\s*(?:미만|이상|이하|초과))/
      );

      const symbols = symbolsInRow(row);

      if (!symbols.length) continue;

      const mapped = symbols.map((symbol) => {
        const column = mapSymbolToColumn(
          symbol,
          columns
        );

        return {
          ...symbol,
          approver: column?.name ?? null,
        };
      });

      if (
        currentTask === "계약 및 협약 승인" &&
        conditionMatch &&
        normalize(conditionMatch[1]).includes(
          normalize("30억 원 미만")
        )
      ) {
        const hit = mapped.find(
          (symbol) =>
            symbol.symbol === "◎" &&
            symbol.approver === "실장"
        );

        if (hit) {
          target = {
            page: row.page,
            row: row.row,
            task: currentTask,
            condition: conditionMatch[1]
              .replace(/\s+/g, " ")
              .trim(),
            symbol: hit.symbol,
            suffix: hit.suffix,
            approver: hit.approver,
            x0: hit.x0,
            x1: hit.x1,
            x_center: hit.xCenter,
            y: hit.y,
            coordinate_type: hit.coordinate_type,
            precision: hit.coordinatePrecision,
          };
          break;
        }
      }
    }

    assert(
      target,
      "page 34 fill-down failed: 계약 및 협약 승인 / 30억 원 미만 / 실장 ◎"
    );

    assert(
      target.suffix === "책임원",
      "page 34 ◎ suffix split failed"
    );

    assert(
      target.precision === "raw-item-exact",
      "page 34 ◎ did not keep raw-item coordinate"
    );

    assert(
      Math.abs(target.x0 - 545.04) < 0.15 &&
        Math.abs(target.x1 - 554.04) < 0.15,
      "page 34 ◎ coordinate regression failed"
    );

    const structuredTarget = {
      source_type: "pdf",
      page: target.page,
      row: target.row,
      task: target.task,
      condition: target.condition,
      approver: target.approver,
      symbol: target.symbol,
      suffix: target.suffix,
      coordinate: {
        x0: target.x0,
        x1: target.x1,
        x_center: target.x_center,
        y: target.y,
        coordinate_type: target.coordinate_type,
        precision: target.precision,
      },
      header_evidence: {
        columns: header.order,
        multiline: header.columns
          .filter((column) => column.rowOffsets.length > 1)
          .map((column) => column.name),
        mapping_method: "header_midpoints",
      },
      needs_review:
        !target.approver ||
        target.precision !== "raw-item-exact",
    };

    assert(
      structuredTarget.task === "계약 및 협약 승인" &&
        normalize(structuredTarget.condition).includes(
          normalize("30억 원 미만")
        ) &&
        structuredTarget.approver === "실장" &&
        structuredTarget.symbol === "◎" &&
        structuredTarget.suffix === "책임원",
      "structured PDF schema content failed"
    );

    assert(
      structuredTarget.needs_review === false,
      "high-confidence live PDF result should not need review"
    );

    console.log(
      "PDF_STRUCTURED_SCHEMA_PASS",
      JSON.stringify(structuredTarget)
    );

    const textLength = Array.isArray(plain.text)
      ? plain.text.join("\n").length
      : plain.text.length;

    console.log(
      "PDF_LIVE_REGRESSION_PASS",
      JSON.stringify({
        fileNo: "166852",
        downloadedBytes,
        totalPages,
        textLength,
        header: {
          columns: header.order,
          multiline: header.columns
            .filter(
              (column) =>
                column.rowOffsets.length > 1
            )
            .map((column) => column.name),
        },
        target,
      })
    );
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // no-op
    }
  }
}

runDeterministicRegressions();
await runLivePdfRegression();
console.log("PDF_STRUCTURED_REGRESSION_PASS");
