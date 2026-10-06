/* eslint-disable @typescript-eslint/no-explicit-any -- PDF.js text items are runtime-shaped objects; validated before use. */
// Ported from splain0102/add-regulations-mcp @ f8126642daa3aeea7bbe40b42f06440993b04688.
import {extractText, extractTextItems, getDocumentProxy} from "unpdf";
const normalizeTableSearch=(value:string)=>value.normalize("NFKC").toLowerCase().replace(/[\s,]+/g,"");
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

export type PdfLayoutRow = {
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

export type PdfLayoutPage = {
  height?: number;
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

export function detectKnownPdfHeader(
  rows: PdfLayoutRow[]
): PdfHeaderCandidate | null {
  const candidates =
    [
      PDF_DELEGATION_HEADERS,
      PDF_LEGACY_DELEGATION_HEADERS,
    ]
      .map(
        (headers: readonly string[]) => ({
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
          headers: readonly string[];
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

export function makePdfHeaderBoundaries(
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
  header: PdfHeaderCandidate | null
): string | null {
  if (!header) return null;
  const firstHeaderX=Math.min(...header.columns.map(column=>column.x));
  const titles:{row:number;text:string}[]=[];
  for(const candidateRow of page.rows){
    for(const item of rawPdfItemsInRow(candidateRow)){
      const center=item.x+item.width/2;
      if(center>=firstHeaderX)continue;
      if(/^\s*\d+(?:-\d+)?\)\s*\S+/.test(item.str))titles.push({row:candidateRow.row,text:item.str});
    }
  }
  if(!titles.length)return null;
  // Merged task labels are often vertically centered, so they can appear after
  // their first child row. Assign by the nearest title center, with boundaries
  // halfway between adjacent title centers instead of previous-only fill-down.
  titles.sort((a,b)=>a.row-b.row);
  let best=titles[0],distance=Math.abs(rowIndex-best.row);
  for(const title of titles){const d=Math.abs(rowIndex-title.row);if(d<distance){best=title;distance=d;}}
  return distance<=8?best.text:null;
}
export async function extractPdfRichContent(
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

      pages = await Promise.all(positioned.items.map(async(pageItems,index)=>({
        page:index+1,
        height:(await pdf.getPage(index+1)).getViewport({scale:1}).height,
        rows:groupPdfLayoutRows(pageItems,index+1),
      })));
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
      const destroy=(pdf as unknown as {destroy?:()=>Promise<void>}).destroy;if(destroy)await destroy.call(pdf);
    } catch {
      // PDF.js resource cleanup is best-effort.
    }
  }
}

export function searchPdfLayoutRows(
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

export function buildPdfStructuredMatches(
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

export function renderPdfStructuredMatch(
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

export function renderPdfLayoutMatch(
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



