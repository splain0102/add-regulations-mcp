// Read-only audit of every current regulation in R2: the 시행일/개정일 evidence the
// stored snapshot carries (rules at parse time) against the current rules
// (versionCheck and 부칙 labels recomputed from the stored text). Prints the
// regulations whose dates disagree with ALIO or whose result changes.
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {r2Store} from '../d1/remote';
import {refreshDerived} from '../d1/records';
import {ROOT} from '../../src/r2/types';
const store=r2Store(),json=async(key:string)=>JSON.parse(new TextDecoder().decode(await store('GET',key)));
const head=await json(ROOT),catalog=await json(head.catalog.key),docs=catalog.documents.filter((d:any)=>d.status!=='repealed');
const iso=(v:string|null|undefined)=>{const m=String(v??'').match(/(20\d{2})\D{0,4}(\d{1,2})\D{0,4}(\d{1,2})/);return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:null;};
const dateOf=(v:any,source:string)=>v?.dates?.find((x:any)=>x.source===source)?.date??null;
const blockLabels=(sections:any[])=>sections.filter((s:any)=>s.kind==='supplement'&&!/\s제\s*\d+\s*조/.test(s.section_label)).map((s:any)=>s.section_label);
const rows:any[]=[];
for(let i=0;i<docs.length;i+=8)rows.push(...await Promise.all(docs.slice(i,i+8).map(async(d:any)=>{
 const snap=await json(d.snapshot_r2_key),text=String(snap.loaded?.text??''),old=JSON.parse(snap.records.document.validation_json??'null'),fresh=refreshDerived(snap.records,text),now=JSON.parse(fresh.document.validation_json);
 const alio=iso(d.st_date),oldLabel=blockLabels(snap.records.sections).at(-1)??null,newLabel=blockLabels(fresh.sections).at(-1)??null;
 const effective=now.current_effective_date??dateOf(now,'body_last_effective_date');
 return {title:d.title,reg_id:d.regulation_id,alio,old_revision:dateOf(old,'body_last_revision_date'),new_revision:dateOf(now,'body_last_revision_date'),old_effective:dateOf(old,'body_last_effective_date'),effective,stacked:Boolean(now.revision_basis),old_warning:Boolean(old?.warning),new_warning:Boolean(now.warning),old_label:oldLabel,new_label:newLabel,history:dateOf(now,'body_history_date'),majority:now.consensus?.date??null,agreeing:(now.consensus?.agreeing??[]).join(','),tie:Boolean(now.consensus?.tie),warning:now.warning?.note??null};
})));
const changed=rows.filter(r=>r.old_label!==r.new_label||r.old_warning!==r.new_warning||r.old_revision!==r.new_revision);
const effectiveDiff=rows.filter(r=>r.effective&&r.alio&&r.effective!==r.alio);
const noEffective=rows.filter(r=>!r.effective);
const summary={regulations:rows.length,stacked_effective_blocks:rows.filter(r=>r.stacked).length,changed_by_fix:changed.length,warnings_before:rows.filter(r=>r.old_warning).length,warnings_after:rows.filter(r=>r.new_warning).length,effective_differs_from_alio:effectiveDiff.length,no_effective_date_found:noEffective.length,no_history_found:rows.filter(r=>!r.history).length,split_sources:rows.filter(r=>r.tie).length};
const table=(title:string,list:any[],cols:string[])=>[`### ${title} (${list.length})`,'',`| ${cols.join(' | ')} |`,`|${cols.map(()=>'---').join('|')}|`,...list.map(r=>`| ${cols.map(c=>String(r[c]??'').replace(/\|/g,'/')).join(' | ')} |`),''];
const lines=['## 시행일 점검 (전체 규정)','',`\`${JSON.stringify(summary)}\``,'',
 ...table('수정으로 결과가 바뀐 규정',changed,['title','alio','old_revision','new_revision','effective','old_label','new_label','old_warning','new_warning']),
 ...table('수정 후에도 경고가 남는 규정 (다수결)',rows.filter(r=>r.new_warning),['title','alio','history','effective','majority','tie','warning']),
 ...table('연혁을 찾지 못한 규정',rows.filter(r=>!r.history),['title','alio','effective','new_label']),
 ...table('원문 시행일이 ALIO 개정일과 다른 규정',effectiveDiff,['title','alio','effective','new_label','stacked']),
 ...table('원문 시행일을 찾지 못한 규정',noEffective,['title','alio','new_revision','new_label'])];
mkdirSync('reports',{recursive:true});writeFileSync('reports/effective-audit.json',JSON.stringify({summary,rows},null,1));
console.log(lines.join('\n'));console.log('EFFECTIVE_AUDIT',JSON.stringify(summary));
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
