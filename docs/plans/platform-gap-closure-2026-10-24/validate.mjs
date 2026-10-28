// Document/traceability validator; no application behavior is exercised.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(dir,'../../..');
const read=p=>fs.readFileSync(path.join(dir,p),'utf8');
const json=p=>JSON.parse(read(p));
const problems=[];
const check=(ok,message)=>{if(!ok)problems.push(message);};
const sections=json('sections.json');
const coverage=json('coverage.json');
const requirements=json('requirement-witness-map.json');
const census=json('feature-census.json');
const audit=fs.readFileSync(path.join(root,'docs/research/platform-gap-analysis-2026-10-24.md'),'utf8');
const original=[...audit.matchAll(/^- \[ \] \*\*([A-Z]+-\d+)/gm)].map(m=>m[1]);
const gaps=original.filter(x=>!x.startsWith('CT-'));
check(sections.length===12,'Expected twelve section PRDs');
check(new Set(sections.map(s=>s.number)).size===12,'Duplicate section number');
for(const id of gaps)check(coverage.original_gaps.filter(x=>x.id===id).length===1,`Original gap ${id} lacks unique coverage`);
check(coverage.original_gaps.length===gaps.length,'Gap coverage has unexpected additions/omissions');
for(const id of original.filter(x=>x.startsWith('CT-')))check(coverage.live_checks.some(x=>x.id===id),`Unmapped live check ${id}`);
const categoryBlock=audit.split('## Category scorecard\n')[1].split('## Current implementation')[0];
const categories=categoryBlock.split('\n').filter(x=>x.startsWith('| ')).slice(1).map(x=>x.split('|')[1].trim());
check(JSON.stringify(categories)===JSON.stringify(coverage.categories.map(x=>x.category)),'Category mapping differs from audit');
const allWitnesses=new Set();const allReqs=new Set();let questionN=0,riskN=0;
const headings=['## Summary','## Motivation','## Proposal','## Compatibility','## Conformance','## Alternatives considered','## Unresolved questions','## Implementation notes (non-normative)','## Acceptance criteria','## References'];
for(const s of sections){
 const text=read(s.prd);
 let last=-1;
 for(const h of headings){const at=text.indexOf(h);check(at>last,`${s.prd} missing/out-of-order heading ${h}`);last=at;}
 for(const lens of ['Specification','Schema','Security','Conformance','Compatibility'])check(text.includes(`| ${lens} |`),`${s.prd} missing ${lens} pass`);
 for(const m of text.matchAll(/^- \*\*(S\d+-R\d+) \(([^)]+)\)/gm)){check(!allReqs.has(m[1]),`Duplicate requirement ${m[1]}`);allReqs.add(m[1]);check(s.gap_ids.includes(m[2]),`Wrong original ID ${m[2]} in ${s.prd}`);}
 for(const m of text.matchAll(/^\| (S\d+-T\d+) /gm))allWitnesses.add(m[1]);
 questionN+=[...read(s.gaps).matchAll(/^\| S\d+-G\d+ /gm)].length;
 riskN+=[...read(s.risks).matchAll(/^\| S\d+-K\d+ /gm)].length;
 for(const id of s.gap_ids)check(gaps.includes(id),`Unknown audit gap ${id}`);
 for(const dep of s.dependencies)check(Number(dep)<s.number,`Cycle/forward dependency ${s.number}->${dep}`);
}
check(requirements.length===allReqs.size,'Requirement mapping count differs');
check(new Set(requirements.map(x=>x.requirement_id)).size===requirements.length,'Duplicate requirement map');
for(const r of requirements){check(allReqs.has(r.requirement_id),`Unknown mapped requirement ${r.requirement_id}`);check(r.proposed_witnesses.length>0,`No witness for ${r.requirement_id}`);for(const w of r.proposed_witnesses)check(allWitnesses.has(w),`Unknown witness ${w}`);}
check(census.count===229 && census.directory_rows.length===229,'Expected 229 directory rows');
check(new Set(census.directory_rows.map(x=>x.path)).size===229,'Duplicate census directory');
for(const row of census.directory_rows)check(fs.statSync(path.join(root,row.path)).isDirectory(),`Census directory absent ${row.path}`);
check(census.directory_rows.filter(x=>x.side==='backend').length===128,'Backend census mismatch');
check(census.directory_rows.filter(x=>x.side==='frontend').length===101,'Frontend census mismatch');
for(const file of fs.readdirSync(dir).filter(x=>x.endsWith('.md'))){
 const text=read(file);
 for(const m of text.matchAll(/\]\(([^)]+)\)/g)){
  const ref=m[1].split('#')[0]; if(!ref || /^https?:/.test(ref))continue;
  check(fs.existsSync(path.resolve(dir,decodeURI(ref))),`${file}: missing link ${ref}`);
 }
}
for(const [key,value] of Object.entries({requirements:allReqs.size,witnesses:allWitnesses.size,planning_questions:questionN,risks:riskN}))check(coverage.counts[key]===value,`Count mismatch ${key}`);
const result={section_prds:sections.length,original_gaps:gaps.length,live_checks:coverage.live_checks.length,categories:categories.length,feature_rows:census.count,requirements:allReqs.size,witnesses:allWitnesses.size,planning_questions:questionN,risks:riskN,problems};
console.log(JSON.stringify(result,null,2));if(problems.length)process.exitCode=1;
