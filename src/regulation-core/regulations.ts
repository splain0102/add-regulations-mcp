import {extractRevisionSection} from './revision-probe';
import { unzipSync, strFromU8 } from "fflate";
import { hwpToText } from "@ssabrojs/hwpxjs/browser";
import { extractText } from "unpdf";
import {searchGeneralTables, normalizeTableSearch, type SearchTableRow} from './general-table-search';
import {extractPdfRichContent, searchPdfLayoutRows, buildPdfStructuredMatches, detectKnownPdfHeader, makePdfHeaderBoundaries, type PdfLayoutPage} from './pdf-regression-layout';
import { DocumentError, extractHwpTables, extractHwpxTables, structureTables, extractPdfLayout, versionCheck, type StructuredRow, type Table } from './table-layout';
const ALIO_BASE = "https://www.alio.go.kr";
const ADD_APBA_ID = "C0345";

const REGULATION_LIST_URL =
  `${ALIO_BASE}/item/itemOrganList.do` +
  `?apbaId=${ADD_APBA_ID}&reportFormRootNo=21110`;

type RegulationItem = {
  title: string;
  detailUrl: string;
  revisionDate?: string;
  updatedDate?: string;
};

export type Attachment = {
  name: string;
  url: string;
  fileNo: string;
  extension?: string;
  detectedDate?: string | null;
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

export async function fetchWithRetry(
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
        await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(25000) });

      const retryable =
        response.status === 429 ||
        response.status >= 500;

      if (
        !retryable ||
        attempt === maxAttempts
      ) {
        return response;
      }

      await response.body?.cancel();
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
  const target = new URL(url);
  if (target.origin !== ALIO_BASE) throw new Error("ALIO 주소만 조회할 수 있습니다.");
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

export function normalizeDate(value?: string): string {
  if (!value) return "";

  const match = value.match(
    /(20\d{2})\D{0,4}(\d{1,2})\D{0,4}(\d{1,2})/
  );

  if (!match) return "";

  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function extractDateFromFilename(name:string):string|null {
 const full=name.match(/(20\d{2})\s*(?:년도|년|[.\-_])\s*(\d{1,2})\s*(?:월|[.\-_])\s*(\d{1,2})/)
   ??name.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/);
 const month=full??name.match(/(?<!\d)(20\d{2}|\d{2})\s*(?:년도|년|[.\-_])\s*(\d{1,2})\s*월/);
 if(!month)return null;
 const year=month[1].length===2?'20'+month[1]:month[1],m=Number(month[2]),d=full?Number(full[3]):null;
 if(m<1||m>12||d!==null&&(d<1||d>new Date(Date.UTC(Number(year),m,0)).getUTCDate()))return null;
 return `${year}-${String(m).padStart(2,'0')}`+(d!==null?`-${String(d).padStart(2,'0')}`:'');
}

function getExtension(name:string):string {
 return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]??'';
}

export function parseRegulations(
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

    const rowStart = html.lastIndexOf("<tr", match.index);
    const rowEnd = html.indexOf("</tr>", match.index);
    const start = rowStart >= 0 ? rowStart : Math.max(0, match.index - 200);
    const end = Math.min(
      html.length,
      rowEnd >= 0 ? rowEnd + 5 : match.index + match[0].length + 200
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

export function dedupeLatestRegulations(
  items: RegulationItem[]
): RegulationItem[] {
  const map = new Map<string, RegulationItem>();

  for (const item of items) {
    const key = normalizeRegulationTitle(item.title);

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

type AlioRow = {title:string;apbaId:string;idx:string;reportFormNo:string;tableName:string;idxName:string;disclosureNo?:string;reportGbn:string;bidType:string;stDate?:string;idate?:string;regdate?:string};
async function fetchListPage(pageNo:number):Promise<{result:AlioRow[];page:{totalPage:number;totalCount:number}}> {
  const response=await fetchWithRetry(`${ALIO_BASE}/item/itemReportListSusi.json`, {
    method:'POST',
    headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 ADD-Regulations-Site/2.0','Accept':'application/json', 'X-Requested-With':'XMLHttpRequest', Referer:REGULATION_LIST_URL, Origin:ALIO_BASE, 'Accept-Language':'ko-KR,ko;q=0.9'},
    body:JSON.stringify({pageNo,apbaId:ADD_APBA_ID,apbaType:'A2005',reportFormRootNo:'21110',search_word:'',search_flag:'title',bid_type:'',enfc_istt:''})
  });
  if(!response.ok)throw new Error(`ALIO 목록 요청 실패: HTTP ${response.status}`);
  const envelope=await response.json() as {data?:{result:AlioRow[];page:{totalPage:number;totalCount:number}}};
  if(!Array.isArray(envelope.data?.result)||!envelope.data?.page)throw new Error('ALIO 목록 응답 형식을 확인할 수 없습니다.');
  return envelope.data;
}
let cachedList:{items:RegulationItem[];expires:number}|null=null;
let pendingList:Promise<RegulationItem[]>|null=null;
export async function listRegulations():Promise<RegulationItem[]> {
  if(cachedList&&cachedList.expires>Date.now())return cachedList.items;
  if(pendingList)return pendingList;
  pendingList=(async()=>{
    const first=await fetchListPage(1);
    const total=first.page.totalPage;
    if(!Number.isInteger(total)||total<1||total>100)throw new Error('ALIO 목록 페이지 수를 확인할 수 없습니다.');
    const rows=[...first.result];
    // Fetch every page, with bounded concurrency. A first page is not the full latest list.
    for(let page=2;page<=total;page+=6){
      const pages=await Promise.all(Array.from({length:Math.min(6,total-page+1)},(_,i)=>fetchListPage(page+i)));
      rows.push(...pages.flatMap(p=>p.result));
    }
    const items=dedupeLatestRegulations(rows.filter(r=>r.apbaId===ADD_APBA_ID).map(r=>{
      const params=new URLSearchParams({disclosureNo:'',apbaId:ADD_APBA_ID,nowcode:r.reportFormNo,reportFormNo:r.reportFormNo,table_name:r.tableName,idx_name:r.idxName,idx:r.idx,reportGbn:r.reportGbn,bid_type:r.bidType});
      return {title:r.title,detailUrl:`${ALIO_BASE}/item/itemBoard21110.do?${params}`,revisionDate:r.stDate,updatedDate:r.idate};
    })).sort((a,b)=>(normalizeDate(b.revisionDate)||normalizeDate(b.updatedDate)).localeCompare(normalizeDate(a.revisionDate)||normalizeDate(a.updatedDate)));
    if(!items.length)throw new Error('ALIO에서 국방과학연구소 규정 목록을 찾지 못했습니다.');
    cachedList={items,expires:Date.now()+60000};return items;
  })();
  try{return await pendingList;}finally{pendingList=null;}
}

export function extractAttachments(
  html: string
): Attachment[] {
  const attachments: Attachment[] = [];
  const seen = new Set<string>();
  // Read each link's own filename first; fallback scans must not pair adjacent files.
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*rulefiledown\.json\?fileNo=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const name=cleanHtml(match[3]),fileNo=match[2];
    if(seen.has(fileNo))continue;
    seen.add(fileNo);
    attachments.push({name,fileNo,extension:getExtension(name),detectedDate:extractDateFromFilename(name),url:`${ALIO_BASE}/download/rulefiledown.json?fileNo=${fileNo}`});
  }

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

export type AttachmentSelection = {
  selected: Attachment | null;
  other_attachments: Array<Attachment & {selection_reason:string}>;
  selection_reason: string[];
};

const attachmentProbeCache = new Map<string, Promise<string>>();
async function attachmentRevisionText(file:Attachment,updatedDate:string):Promise<string> {
 const key=`${file.fileNo}:${updatedDate}`;
 let pending=attachmentProbeCache.get(key);
 if(!pending){
  pending=(async()=>{const downloaded=await downloadLatestFile(file);return extractRevisionSection(downloaded.bytes,downloaded.extension);})();
  if(attachmentProbeCache.size>=64)attachmentProbeCache.delete(attachmentProbeCache.keys().next().value!);
  attachmentProbeCache.set(key,pending);
 }
 try{return await pending;}catch(error){attachmentProbeCache.delete(key);throw error;}
}
export async function selectLatestAttachment(attachments:Attachment[],revisionDate?:string,updatedDate=''):Promise<AttachmentSelection> {
 if(!attachments.length)return {selected:null,other_attachments:[],selection_reason:['no_attachment']};
 const officialDate=normalizeDate(revisionDate);
 const formatRank=(f:Attachment)=>f.extension==='hwpx'?3:f.extension==='hwp'?2:f.extension==='pdf'?1:0;
 const evidence=[];
 const ordered=[...attachments].sort((a,b)=>Number(b.detectedDate===officialDate)-Number(a.detectedDate===officialDate)||formatRank(b)-formatRank(a)||Number(b.fileNo)-Number(a.fileNo));
 let confirmedLatest:Attachment|undefined;
 // Serial probes keep large document/PDF allocations out of the same isolate at once.
 for(const file of ordered){
  const sameFilenamePeriod=!!officialDate&&!!file.detectedDate&&officialDate.startsWith(file.detectedDate);
  const possiblyNewer=!!confirmedLatest&&Number(file.fileNo)>Number(confirmedLatest.fileNo);
  if(confirmedLatest&&!sameFilenamePeriod&&!possiblyNewer&&formatRank(file)<=formatRank(confirmedLatest)){evidence.push({file,bodyMatch:false,failed:false,filenameMatch:false,excluded:true,matchedReasons:[] as string[]});continue;}
  let bodyMatch=false,failed=false;const matchedReasons:string[]=[];
  try{
   const text=officialDate?await attachmentRevisionText(file,updatedDate):'';
   const check=text?versionCheck(revisionDate,file.detectedDate??undefined,text):null;
   for(const d of check?.dates??[]){if(d.date!==officialDate)continue;if(d.source==='body_last_revision_date')matchedReasons.push('body_revision_date_matches_alio');if(d.source==='body_last_effective_date')matchedReasons.push('body_effective_date_matches_alio');}
   bodyMatch=matchedReasons.length>0;
  }catch(error){failed=true;console.warn('attachment_selection_probe_failed',{fileNo:file.fileNo,code:'parse_failed',message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:undefined});}
  const filenameMatch=!!officialDate&&!!file.detectedDate&&(file.detectedDate===officialDate||file.detectedDate.length===7&&officialDate.startsWith(file.detectedDate+'-'));
  if(filenameMatch)matchedReasons.unshift('attachment_filename_date_matches_alio');
  if(!failed&&bodyMatch&&filenameMatch)confirmedLatest=file;
  evidence.push({file,bodyMatch,failed,filenameMatch,excluded:false,matchedReasons});
 }
 const valid=evidence.filter(e=>!e.failed&&!e.excluded).sort((a,b)=>Number(b.bodyMatch)-Number(a.bodyMatch)||Number(b.filenameMatch)-Number(a.filenameMatch)||formatRank(b.file)-formatRank(a.file)||Number(b.file.fileNo)-Number(a.file.fileNo));
 const winner=valid[0];
 const reason=!winner?['all_attachments_parse_failed']:winner.matchedReasons.length?winner.matchedReasons:['fallback_format_priority','fallback_latest_file_no'];
 return {selected:winner?.file??null,selection_reason:reason,other_attachments:evidence.filter(e=>e!==winner).map(({file,failed,bodyMatch,filenameMatch,excluded})=>({...file,detectedDate:file.detectedDate??null,selection_reason:failed?'parse_failed':excluded?'not_probed_latest_revision_confirmed':bodyMatch||filenameMatch?'not_selected_tiebreak_format_or_fileNo':'revision_date_does_not_match_selected_version'}))};
}

async function getRegulationDetail(
  url: string,
  fallbackUpdatedDate?:string
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

  const selection =
    await selectLatestAttachment(
      attachments,
      revisionDate,
      updatedDate ?? fallbackUpdatedDate ?? ''
    );
  const latestAttachment = selection.selected;

  return {
    title,
    category,
    revisionDate,
    updatedDate,
    sourceUrl: url,
    latestAttachment,
    attachments,
    other_attachments: selection.other_attachments,
    selection_reason: selection.selection_reason,
    totalAttachmentCount:
      attachments.length,
  };
}

export async function downloadLatestFile(
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

  if (Number(response.headers.get("content-length") || 0) > 20_000_000) throw new Error("첨부파일이 처리 한도(20MB)를 초과합니다.");
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

export function extractHwpxText(
  bytes: Uint8Array
): string {
  if (bytes.length > 20_000_000) throw new Error("HWPX 압축파일이 20MB를 초과합니다.");
  let extractedSize = 0;
  const zip = unzipSync(bytes, { filter(entry) {
    if (!/^Contents\/section\d+\.xml$/i.test(entry.name)) return false;
    extractedSize += entry.originalSize;
    if (extractedSize > 32_000_000) throw new Error("HWPX 본문 XML이 처리 한도를 초과합니다.");
    return true;
  }});

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

const normalizeAttachmentTitle=(value:string)=>normalizeRegulationTitle(value.replace(/(?:개정\s*전문|전문|개정본|\d{2,4}\s*년?\s*\d{1,2}\s*월?(?:\s*\d{1,2}\s*일?)?)/g,'').replace(/\.(?:hwp|hwpx|pdf)$/i,''));
let crossIndexCache:{expires:number;entries:{itemTitle:string;file:Attachment;revisionDate?:string}[]}|null=null;
async function crossAttachmentIndex(){
 if(crossIndexCache&&crossIndexCache.expires>Date.now())return crossIndexCache.entries;
 const items=await listRegulations(),entries:{itemTitle:string;file:Attachment;revisionDate?:string}[]=[];
 let next=0;
 await Promise.all(Array.from({length:Math.min(5,items.length)},async()=>{
  while(next<items.length){
   const item=items[next++];
   try{
    const html=await fetchAlio(item.detailUrl);
    for(const file of extractAttachments(html))entries.push({itemTitle:item.title,file,revisionDate:item.revisionDate});
   }catch{ /* ALIO may be intermittently unavailable: never replace a selected attachment */ }
  }
 }));
 crossIndexCache={entries,expires:Date.now()+600000};
 return entries;
}
export async function crossEntryAttachmentWarnings(name:string,selectedFileNo?:string,selectedDate?:string){
 const items=await listRegulations();
 const canonical=items.find(i=>i.title===name)?.title??name;
 const target=normalizeRegulationTitle(canonical);
 const entries=await crossAttachmentIndex(),warnings:any[]=[];
 for(const entry of entries){
  if(entry.itemTitle===canonical)continue;
  const fileTitle=normalizeAttachmentTitle(entry.file.name);
  if(!fileTitle||fileTitle!==target)continue;
  const date=entry.file.detectedDate??entry.revisionDate??null;
  const isNewer=!!date&&!!selectedDate&&normalizeDate(date)>normalizeDate(selectedDate);
  warnings.push({code:isNewer?'cross_entry_newer_attachment':'cross_entry_attachment_mismatch',fileNo:entry.file.fileNo,attachmentName:entry.file.name,itemTitle:entry.itemTitle,date,selectedFileNo:selectedFileNo??null,warning:'다른 규정 항목에 첨부된 파일입니다. 자동 교체하지 않습니다.'});
 }
 return warnings;
}
export async function getLatestRegulationByName(
  name: string
) {
  const items =
    await listRegulations();

  const query = normalizeRegulationTitle(name);
  const exact = items.filter(item=>item.title===name);
  const normalized = items.filter(item=>normalizeRegulationTitle(item.title)===query);
  const partial = items.filter(item=>normalizeRegulationTitle(item.title).includes(query));
  const candidates=exact.length?exact:normalized.length?normalized:partial;
  if(!candidates.length){
    const similar=items.filter(item=>query&&([...query].some(ch=>normalizeRegulationTitle(item.title).includes(ch)))).slice(0,5).map(item=>({title:item.title,revisionDate:item.revisionDate}));
    throw Object.assign(new Error(`규정을 찾지 못했습니다: ${name}`),{code:'not_found',candidates:similar});
  }
  if(candidates.length>1){
    throw Object.assign(new Error(`규정명 후보가 ${candidates.length}건입니다. 정확한 규정명을 지정하세요: ${name}`),{code:'ambiguous_name',candidates:candidates.map(item=>({title:item.title,revisionDate:item.revisionDate}))});
  }
  const match=candidates[0];
  const detail =
    await getRegulationDetail(
      match.detailUrl,
      match.updatedDate
    );

  return {
    match,
    detail,
  };
}

type DocumentEntry = {
 file: Awaited<ReturnType<typeof downloadLatestFile>>;
 text: string;
 rows?: StructuredRow[];
 layoutPending?: Promise<StructuredRow[]>;
 layoutDebug?: unknown[];
 tables?: Table[];
 pdfPages?: PdfLayoutPage[];
 pdfPending?: Promise<void>;
};
// Bounded isolate cache. Metadata is re-read before every lookup; changed fileNo/idate evicts the old entry.
export const PARSER_VERSION = "1.10.4-parser.1";
export const normalizeRegulationTitle = (value:string) => value.normalize("NFKC").toLowerCase().replace(/[·･‧ㆍ・\s「」｢｣()（）]/g,"");
const documentCache = new Map<string, Promise<DocumentEntry>>();
const latestDocumentKey = new Map<string, string>();
const MAX_CACHE_BYTES = 24_000_000;
let cacheBytes = 0;
const entrySizes = new Map<string, number>();
function evictDocument(key: string) { documentCache.delete(key); cacheBytes -= entrySizes.get(key) ?? 0; entrySizes.delete(key); }
export function clearDocumentCache() { documentCache.clear(); latestDocumentKey.clear(); entrySizes.clear(); cacheBytes = 0; }
async function loadLatestDocument(name: string) {
 const {match,detail} = await getLatestRegulationByName(name);
 const attachment = detail.latestAttachment;
 if (!attachment) throw new DocumentError('selection_error','최신 첨부파일을 선택하지 못했습니다: '+detail.selection_reason.join(', '));
 const updatedDate = detail.updatedDate ?? match.updatedDate ?? '';
 const key = `${PARSER_VERSION}:${attachment.fileNo}:${updatedDate}`;
 const previous = latestDocumentKey.get(match.detailUrl);
 if(previous && previous !== key) evictDocument(previous);
 latestDocumentKey.set(match.detailUrl,key);
 let promise=documentCache.get(key);const hit=!!promise;
 if (!promise) {
 promise=(async():Promise<DocumentEntry>=>{
 let file: Awaited<ReturnType<typeof downloadLatestFile>>;
 try {file=await downloadLatestFile(attachment);} catch(e) {
 throw new DocumentError(e instanceof Error&&/timeout|aborted/i.test(e.name+' '+e.message)?'timeout':'download_error',String(e));
 }
 let text:string;
 try {
 if(file.extension==='hwpx')text=extractHwpxText(file.bytes);
 else if(file.extension==='hwp')text=await hwpToText(file.bytes);
 else if(file.extension==='pdf'){const r=await extractText(file.bytes.slice(),{mergePages:true});text=Array.isArray(r.text)?r.text.join('\n\n'):r.text;}
 else throw new DocumentError('parse_error',`지원하지 않는 최신 파일 형식: ${file.extension}`);
 if(!text.trim())throw new DocumentError(file.extension==='pdf'?'no_text_layer':'parse_error','추출 가능한 본문이 없습니다.');
 }catch(e){if(e instanceof DocumentError)throw e;throw new DocumentError('parse_error',String(e));}
 const size=file.bytes.byteLength+text.length*2;
 while(cacheBytes+size>MAX_CACHE_BYTES&&documentCache.size>1){const oldest=[...documentCache.keys()].find(k=>k!==key);if(!oldest)break;evictDocument(oldest);}
 if(size<=MAX_CACHE_BYTES){entrySizes.set(key,size);cacheBytes+=size;}else documentCache.delete(key);
 return {file,text};
 })();documentCache.set(key,promise);
 }
 let document:DocumentEntry;try{document=await promise;}catch(e){evictDocument(key);throw e;}
 return {match,detail,attachment,document,cache:{key,hit,scope:'worker-isolate',metadataRevalidated:true}};
}
async function documentMeta(loaded: Awaited<ReturnType<typeof loadLatestDocument>>) {
 const {match,detail,attachment,document,cache}=loaded;
 const versions=versionCheck(detail.revisionDate??match.revisionDate,attachment.detectedDate??undefined,document.text);
 return {regulationName:detail.title!=='제목 확인 필요'?detail.title:match.title,
 revisionDate:detail.revisionDate??match.revisionDate,updatedDate:detail.updatedDate??match.updatedDate,
 sourceUrl:detail.sourceUrl,filename:document.file.filename,extension:document.file.extension,fileNo:attachment.fileNo,
 cache,cache_hit:cache.hit,parser_version:PARSER_VERSION,version_check:versions,version_warning:versions.warning,
 selection_reason:detail.selection_reason,other_attachments:detail.other_attachments};
}
export async function getRegulationMetadata(name:string) {
 const {match,detail}=await getLatestRegulationByName(name);
 const attachment=detail.latestAttachment;
 const probe=attachment?await attachmentRevisionText(attachment,detail.updatedDate??match.updatedDate??''):'';
 const versions=versionCheck(detail.revisionDate??match.revisionDate,attachment?.detectedDate??undefined,probe);
 return {regulationName:detail.title!=='제목 확인 필요'?detail.title:match.title,revisionDate:detail.revisionDate??match.revisionDate,
 updatedDate:detail.updatedDate??match.updatedDate,sourceUrl:detail.sourceUrl,filename:attachment?.name??null,extension:attachment?.extension??null,fileNo:attachment?.fileNo??null,
 version_check:{...versions,cross_entry_warnings:crossWarnings},version_warning:versions.warning,selection_reason:detail.selection_reason,other_attachments:detail.other_attachments};
}
/** Bounded-concurrency corpus search; offset is across regulation titles. */
export async function searchAllRegulations(query:string,limit=10,offset=0){
 const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
 if(!terms.length)return {query,limit,offset,totalRegulations:0,results:[],errors:[]};
 const items=await listRegulations(),selected=items.slice(offset),results:any[]=[],errors:any[]=[];
 let cursor=0;
 const worker=async()=>{
  while(cursor<selected.length){
   const item=selected[cursor++];
   try{
    const loaded=await loadLatestDocument(item.title),text=loaded.document.text;
    const headings=[...text.matchAll(/(?:^|\n)[ \t]*(?:제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?|\[(?:별표|별지)\s*제\s*\d+(?:-\d+)?\s*호\][^\n]*)/g)].map(m=>m.index??0);
    const bounds=[0,...headings,text.length].filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);
    const found:any[]=[];
    for(let i=0;i<bounds.length-1;i++){
     const part=text.slice(bounds[i],bounds[i+1]).toLowerCase();
     if(!terms.every(t=>part.includes(t)))continue;
     const at=bounds[i]+Math.max(0,part.indexOf(terms[0]));
     const snippet=extractArticleSnippet(text,at,query.length,true);
     found.push({label:snippet.label,snippet:snippet.snippet,score:(part.includes(query.toLowerCase())?10:0)+terms.length});
    }
    if(found.length)results.push({regulationName:item.title,fileNo:loaded.attachment.fileNo,matches:found.sort((a,b)=>b.score-a.score).slice(0,3)});
   }catch(e){errors.push({regulationName:item.title,code:e instanceof DocumentError?e.code:'document_error',message:String(e)});}
  }
 };
 await Promise.all(Array.from({length:Math.min(3,selected.length)},()=>worker()));
 results.sort((a,b)=>b.matches[0].score-a.matches[0].score||a.regulationName.localeCompare(b.regulationName,'ko'));
 return {query,limit,offset,totalRegulations:items.length,results:results.slice(0,limit),errors,partial:errors.length>0,scanned:selected.length};
}
export async function getLatestRegulationText(name:string) {
 const loaded=await loadLatestDocument(name);
 return {...await documentMeta(loaded),text:loaded.document.text};
}
async function layoutFromLoaded(loaded:Awaited<ReturnType<typeof loadLatestDocument>>) {
 const {document}=loaded;
 if(!document.rows){
 if(!document.layoutPending)document.layoutPending=(async()=>{
 try {
 if(document.file.extension==='pdf'){const parsed=await extractPdfLayout(document.file.bytes);document.layoutDebug=parsed.debug;return parsed.rows;}
 const tables=document.file.extension==='hwp'?extractHwpTables(document.file.bytes):extractHwpxTables(document.file.bytes);document.tables=tables;
 return structureTables(tables,document.text);
 }catch(e){if(e instanceof DocumentError)throw e;throw new DocumentError('layout_error',String(e));}
 })();
 try{document.rows=await document.layoutPending;}finally{document.layoutPending=undefined;}
 }
 const meta=await documentMeta(loaded);
 return {...meta,layout_debug:document.layoutDebug??null,rows:document.rows.map(row=>({...row,version_warning:meta.version_warning,...(document.file.extension!=='pdf'?{coordinate_type:'logical_cell' as const,row:row.bounding_box.y0,col:row.bounding_box.x0,symbol_coordinates:{...row.symbol_coordinates,coordinate_type:'logical_cell',row:row.bounding_box.y0,col:row.bounding_box.x0},confidence_basis:['explicit_cell_span','header_detected','symbol_inside_column']}:{} )})),
 limitations:document.file.extension==='pdf'?['기호 좌표는 PDF 글리프 이동량으로 계산합니다. 회전 또는 복합 글리프는 layout_error 디버그 근거를 남깁니다.','원문에서 헤더·기호가 비어 있거나 업무 조건이 불명확한 행은 needs_review로 표시합니다.']:
 ['HWP/HWPX 좌표는 실제 셀 주소 기준입니다. PDF 페이지 좌표가 아니며 페이지 번호는 null입니다.']};
}


export async function getLatestRegulationLayout(name:string){return layoutFromLoaded(await loadLatestDocument(name));}

/** Same cached download and latest-file selection as all original tools. */
export async function searchLatestRegulationTable(name:string,query:string){
 const loaded=await loadLatestDocument(name),{document}=loaded,meta=await documentMeta(loaded);
 if(document.file.extension==='pdf'){
  if(!document.pdfPages){
   if(!document.pdfPending)document.pdfPending=(async()=>{const parsed=await extractPdfRichContent(document.file.bytes);if(parsed.layoutSkippedReason)throw new DocumentError('layout_error',parsed.layoutSkippedReason);document.pdfPages=parsed.pages;})();
   try{await document.pdfPending;}finally{document.pdfPending=undefined;}
  }
  const priorLayout=await layoutFromLoaded(loaded);
  const terms=query.trim().split(/\s+/).map(normalizeTableSearch);
  const matches=searchPdfLayoutRows(document.pdfPages!,query,Number.MAX_SAFE_INTEGER);
  const rows=matches.flatMap<SearchTableRow>(({page,row,mode})=>{
   const detected=detectKnownPdfHeader(page.rows),isDelegation=!!detected&&detected.matched>=2;
   const cells=row.segments.map(segment=>({text:segment.text,x0:segment.x,x1:segment.xEnd,y:row.y,coordinate_type:'pdf_point',source_items:segment.sourceItems}));
   const fallbackColumns=cells.map((_,i)=>({name:`col_${i}`,col:i,colSpan:1}));
    const fallbackValues=Object.fromEntries(cells.map((cell,i)=>[`col_${i}`,cell.text]));
    const base={source_type:'pdf',y:row.y,page:page.page,row:row.row,table_id:`pdf-${page.page}`,match_mode:mode,coordinate_type:'pdf_point',coordinate_space:'pdf-points-bottom-left',cells,raw_cells:cells,raw_text:row.text,columns:fallbackColumns,values:fallbackValues,version_warning:meta.version_warning,bounding_box:{x0:Math.min(...cells.map(c=>c.x0)),x1:Math.max(...cells.map(c=>c.x1)),y0:row.y-row.fontMedian/2,y1:row.y+row.fontMedian/2}};
   if(!isDelegation)return [{...base,analysis_type:'general_table',header_evidence:null,needs_review:true,review_reasons:['PDF general table column boundaries are not established; positioned cells retained, no delegation inference.']}];
   const ranges=makePdfHeaderBoundaries(detected!.columns);
   return buildPdfStructuredMatches(page,row).filter(match=>terms.every(t=>normalizeTableSearch([match.task,match.condition,row.text].join(' ')).includes(t))).map(match=>{const prior=priorLayout.rows.find(r=>r.page===page.page&&r.symbol===match.symbol&&Math.abs(r.symbol_x_center-(match.coordinate?.xCenter??-999))<0.05&&normalizeTableSearch(r.task??'')===normalizeTableSearch(match.task??'')&&normalizeTableSearch(r.condition??'')===normalizeTableSearch(match.condition??''));return {...prior,...base,analysis_type:'delegation_table',task:match.task,condition:match.condition,approver:match.approver,symbol:match.symbol,suffix:match.suffix,coordinate:match.coordinate?{x0:match.coordinate.x0,x1:match.coordinate.x1,x_center:match.coordinate.xCenter,y:match.coordinate.y,coordinate_type:'pdf_point',precision:match.coordinate.precision}:null,symbol_coordinates:match.coordinate?{symbol:match.symbol,x0:match.coordinate.x0,x1:match.coordinate.x1,x_center:match.coordinate.xCenter,y:match.coordinate.y,suffix:match.suffix,coordinate_type:'pdf_point',precision:match.coordinate.precision}:null,header_evidence:{...match.headerEvidence,ranges,original_layout:prior?{coordinate_space:'pdf-points-top-left',evidence:prior.header_evidence}:null},needs_review:match.needsReview||!!prior?.needs_review,review_reasons:match.reviewReasons};});
  });
  // Preserve stronger glyph/merged-cell and cross-page results when the PR's row matcher misses them.
  for(const prior of priorLayout.rows){
   if(!terms.every(t=>normalizeTableSearch([prior.category,prior.task,prior.condition,JSON.stringify(prior.raw_cells)].join(' ')).includes(t)))continue;
   const page=document.pdfPages!.find(p=>p.page===prior.page);if(!page?.height)continue;
   const baseline=page.height-(prior.y??0);
   if(rows.some(r=>r.page===prior.page&&Math.abs(Number((r.coordinate as {y?:number}|null)?.y??-999)-baseline)<0.05&&r.symbol===prior.symbol))continue;
   const coordinate={...prior.symbol_coordinates,y:baseline,coordinate_type:'pdf_point',precision:'glyph-advance-exact'};
   rows.push({...prior,y:baseline,row:-1,analysis_type:'delegation_table',coordinate_space:'pdf-points-bottom-left',bounding_box:{...prior.bounding_box,y0:page.height-prior.bounding_box.y1,y1:page.height-prior.bounding_box.y0},coordinate,symbol_coordinates:coordinate});
  }
  return {...meta,rows,layout_debug:priorLayout.layout_debug??[],layout_debug_coordinate_space:'pdf-points-top-left',limitations:['PDF y is the original PDF.js baseline in points from the bottom-left; not a HWP cell address.','Compound text-run symbol widths are marked estimated and require review.']};
 }
 const layout=await layoutFromLoaded(loaded);
 return {...meta,cache:layout.cache,rows:searchGeneralTables(document.tables??[],query,document.rows??[],document.file.extension).map(row=>({...row,version_warning:meta.version_warning})),layout_debug:[],limitations:layout.limitations};
}

export function sectionAt(text:string, matchIndex:number) {
 const heading = /(?:^|\n)[ \t]*(\[(?:별표|별지)\s*제\s*\d+(?:-\d+)?\s*호\][^\n]*|제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?)/g;
 const sections=[...text.matchAll(heading)].map(m=>({index:m.index??0,label:m[1].replace(/\s+/g,' ').trim()}));
 let current:typeof sections[number]|undefined,next=text.length;
 for(const section of sections){if(section.index<=matchIndex)current=section;else{next=section.index;break;}}
 return {label:current?.label??'관련 본문',start:current?.index??Math.max(0,text.lastIndexOf('\n',matchIndex)),end:next,id:current?.index??-1};
}
export function extractArticleSnippet(text:string,matchIndex:number,queryLength:number,compact=false){
 const section=sectionAt(text,matchIndex);
 const annex=/^\[(?:별표|별지)/.test(section.label);
 const cap=compact?850:2200;
 let from=section.start,to=section.end;
 if(annex||to-from>cap){
   from=Math.max(from,matchIndex-(compact?240:500));
   to=Math.min(to,matchIndex+queryLength+(compact?500:1200));
 }
 const snippet=text.slice(from,to).split('\n').filter(line=>line.trim()||!annex).join('\n').trim().slice(0,cap);
 return {label:section.label,snippet};
}

/** Explicit opt-in only; these results never replace latest-document evidence. */
export async function searchHistoricalPdfTables(name:string,query:string){
 const {detail}=await getLatestRegulationByName(name);
 const rows:any[]=[];
 for(const attachment of detail.other_attachments.filter(a=>a.extension==='hwp'||a.extension==='hwpx')){
  const file=await downloadLatestFile(attachment);
  const text=file.extension==='hwpx'?extractHwpxText(file.bytes):await hwpToText(file.bytes);
  const tokens=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const headings=[...text.matchAll(/(?:^|\n)[ \t]*(?:제\s*\d+\s*조(?:의\s*\d+)?|부\s*칙|\[(?:별표|별지)\s*제\s*\d+(?:-\d+)?\s*호\])/g)].map(m=>m.index??0);
  const boundaries=[0,...headings,text.length].filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);
  for(let i=0;i<boundaries.length-1;i++){
   const start=boundaries[i],part=text.slice(start,boundaries[i+1]);
   if(!tokens.every(token=>part.toLowerCase().includes(token)))continue;
   const at=start+Math.max(0,part.toLowerCase().indexOf(tokens[0]));
   rows.push({historical:true,fileNo:attachment.fileNo,filename:attachment.name,extension:file.extension,...extractArticleSnippet(text,at,query.length,true)});
   if(rows.length>=10)return rows;
  }
 }
 for(const attachment of detail.other_attachments.filter(a=>a.extension==='pdf')){
  const file=await downloadLatestFile(attachment),parsed=await extractPdfRichContent(file.bytes);
  for(const {page,row} of searchPdfLayoutRows(parsed.pages,query,10)){
   const matches=buildPdfStructuredMatches(page,row);
   rows.push(...matches.map(m=>({historical:true,fileNo:attachment.fileNo,filename:attachment.name,page:page.page,task:m.task,condition:m.condition,approver:m.approver,symbol:m.symbol,coordinate_type:'pdf_point',coordinate:m.coordinate,needs_review:m.needsReview})));
  }
 }
 return rows.slice(0,10);
}
