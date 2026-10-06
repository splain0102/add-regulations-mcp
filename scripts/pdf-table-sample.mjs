import { extractText, extractTextItems } from "unpdf";

const DETAIL_URL =
  "https://www.alio.go.kr/item/itemBoard21110.do?disclosureNo=&apbaId=C0345&nowcode=21110&reportFormNo=21110&table_name=COMM_RULE&idx_name=RULE_NO&idx=24523&reportGbn=N&bid_type=K1100";

function cleanHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function findPdfAttachments(html) {
  const found = [];
  const seen = new Set();

  const forward =
    /([\w가-힣().,\-_+\s]+?\.pdf)[\s\S]{0,800}?(?:rulefiledown\.json\?fileNo=|fileNo\s*[:=,(\'"\s]+)(\d+)/gi;

  let match;
  while ((match = forward.exec(html)) !== null) {
    const fileNo = match[2];
    if (seen.has(fileNo)) continue;
    seen.add(fileNo);
    found.push({
      name: cleanHtml(match[1]),
      fileNo,
      url: `https://www.alio.go.kr/download/rulefiledown.json?fileNo=${fileNo}`,
    });
  }

  const reverse =
    /(?:rulefiledown\.json\?fileNo=|fileNo\s*[:=,(\'"\s]+)(\d+)[\s\S]{0,800}?([\w가-힣().,\-_+\s]+?\.pdf)/gi;

  while ((match = reverse.exec(html)) !== null) {
    const fileNo = match[1];
    if (seen.has(fileNo)) continue;
    seen.add(fileNo);
    found.push({
      name: cleanHtml(match[2]),
      fileNo,
      url: `https://www.alio.go.kr/download/rulefiledown.json?fileNo=${fileNo}`,
    });
  }

  return found;
}

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!xs.length) return 0;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m-1] + xs[m]) / 2;
}

function groupRows(items) {
  const usable = items
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({...item, str:item.str.trim()}))
    .sort((a,b) => b.y - a.y || a.x - b.x);

  const fontMedian = median(usable.map((x) => x.fontSize)) || 10;
  const tolerance = Math.max(1.5, Math.min(4, fontMedian * 0.28));

  const rows = [];
  for (const item of usable) {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (!row) {
      row = { y:item.y, items:[] };
      rows.push(row);
    }
    row.items.push(item);
    row.y = row.items.reduce((s,x)=>s+x.y,0) / row.items.length;
  }

  return rows
    .sort((a,b)=>b.y-a.y)
    .map((row) => {
      const xs = row.items.sort((a,b)=>a.x-b.x);
      const gaps = [];
      for (let i=1;i<xs.length;i++) {
        gaps.push(xs[i].x - (xs[i-1].x + xs[i-1].width));
      }
      const positive = gaps.filter((g)=>g>0);
      const gapMedian = median(positive) || fontMedian * 0.3;
      const splitThreshold = Math.max(fontMedian * 1.1, gapMedian * 3, 10);

      const segments = [];
      let current = null;
      for (const item of xs) {
        if (!current) {
          current = { x:item.x, xEnd:item.x+item.width, text:item.str };
          continue;
        }
        const gap = item.x - current.xEnd;
        if (gap > splitThreshold) {
          segments.push(current);
          current = { x:item.x, xEnd:item.x+item.width, text:item.str };
        } else {
          current.text += gap > fontMedian * 0.15 ? " " + item.str : item.str;
          current.xEnd = Math.max(current.xEnd, item.x + item.width);
        }
      }
      if (current) segments.push(current);

      return {
        y: row.y,
        segments,
        text: segments.map((s)=>s.text).join(" | "),
      };
    });
}

function normalize(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s,]+/g, "");
}

const detail = await fetch(DETAIL_URL, {
  headers: {
    "User-Agent": "Mozilla/5.0 ADD-Regulations-MCP-PDF-Table-Test/1.0",
    "Accept-Language": "ko-KR,ko;q=0.9",
  },
});
if (!detail.ok) throw new Error(`detail HTTP ${detail.status}`);
const html = await detail.text();
const pdfs = findPdfAttachments(html);
console.log("PDF_ATTACHMENTS_START");
console.log(JSON.stringify(pdfs, null, 2));
console.log("PDF_ATTACHMENTS_END");
if (!pdfs.length) throw new Error("No PDF attachment found");

const selected =
  pdfs.find((x) => /21|2021|순환보직/i.test(x.name)) ?? pdfs[0];

const res = await fetch(selected.url, {
  headers: {"User-Agent":"Mozilla/5.0 ADD-Regulations-MCP-PDF-Table-Test/1.0"},
});
if (!res.ok) throw new Error(`pdf HTTP ${res.status}`);
const bytes = new Uint8Array(await res.arrayBuffer());

const [{ totalPages, items }, plain] = await Promise.all([
  extractTextItems(bytes),
  extractText(bytes, { mergePages: true }),
]);

console.log("PDF_LAYOUT_META_START");
console.log(JSON.stringify({
  selected,
  bytes: bytes.byteLength,
  totalPages,
  totalItems: items.reduce((s,p)=>s+p.length,0),
  plainTextLength: plain.text.length,
}, null, 2));
console.log("PDF_LAYOUT_META_END");

const pages = items.map((pageItems, pageIndex) => ({
  page: pageIndex + 1,
  rows: groupRows(pageItems),
}));

const keywords = ["출산휴가", "대상 제외자", "구 분", "비고"];
for (const keyword of keywords) {
  const q = normalize(keyword);
  const matches = [];
  for (const page of pages) {
    for (let rowIndex=0; rowIndex<page.rows.length; rowIndex++) {
      const row = page.rows[rowIndex];
      if (normalize(row.text).includes(q)) {
        matches.push({
          page:page.page,
          rowIndex,
          y:row.y,
          row:row.text,
          segments:row.segments,
          before: page.rows[Math.max(0,rowIndex-1)]?.text,
          after: page.rows[Math.min(page.rows.length-1,rowIndex+1)]?.text,
        });
      }
    }
  }
  console.log(`PDF_KEYWORD_${keyword}_START`);
  console.log(JSON.stringify(matches.slice(0,10), null, 2));
  console.log(`PDF_KEYWORD_${keyword}_END`);
}

const multiSegment = pages.flatMap((page) =>
  page.rows
    .filter((row)=>row.segments.length >= 3)
    .slice(0,8)
    .map((row)=>({
      page:page.page,
      y:row.y,
      segmentCount:row.segments.length,
      segments:row.segments,
    }))
).slice(0,30);

console.log("PDF_MULTI_SEGMENT_ROWS_START");
console.log(JSON.stringify(multiSegment, null, 2));
console.log("PDF_MULTI_SEGMENT_ROWS_END");

if (items.reduce((s,p)=>s+p.length,0) === 0) {
  throw new Error("No positioned PDF text items extracted");
}
