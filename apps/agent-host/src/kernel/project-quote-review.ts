import { createHash } from "node:crypto";
import { z } from "zod";
import { isImplementationEvidencePath, type CareerTaskEvidence, type ProjectUnderstanding, type UnderstandingDecision, type UnderstandingEvidence } from "@better-me/agent-contracts";
import { CareerTaskError } from "../tasks/evidence.js";
import { rankEvidence } from "./evidence-retrieval.js";

type QuoteRow = { id: string; evidence: UnderstandingEvidence };
export type ProjectQuoteReview = { reply: Extract<UnderstandingDecision, {kind:"reply"}>; evidence: UnderstandingEvidence[] };
const invalid = (code: string): never => { throw new CareerTaskError(code,422); };
const hash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 28);
const nonempty = z.string().trim().min(1).max(1500);

export function asksForProjectQuotes(text: string) {
  if (/(?:不用|不要|无需|省略|不必)[^。！？，,;；\n]{0,8}(?:引用|引述|摘录|原句)|\b(?:do not|don't|no need to)\s+(?:quote|cite)/iu.test(text)) return false;
  return /逐字(?:引|摘|核)|(?:引用|引述|摘录|摘出|列出|给出|提供|定位|找出|查找|核对|提取|展示|标出|对照)[^。！？\n]{0,80}(?:原句|原文|出处)|(?:请|需要|给我)引用(?:项目)?(?:材料|文档|记录|证据|来源)|原句(?:是|在哪|是什么)|\b(?:quote verbatim|verbatim|exact (?:passages?|quotations?|quotes?|wording)|quote (?:the |each )?(?:relevant |original )?(?:source|passage|line)s?)\b/iu.test(text);
}

export function mentionedProjectFiles(text: string): string[] {
  // Names narrow an explicit request. Authority is always resolved by the broker.
  const matches = text.matchAll(/(?:^|[\s"'“”‘’`（([：:，,、])([^\s"'“”‘’`()（）[\]<>，,、。！？;；:：]+\.(?:mdx?|txt|json|ya?ml|xml|[cm]?[jt]sx?|cs|py|go|rs|java|kt|swift|cpp|c|h|html|css|vue|svelte))(?=$|[\s"'“”‘’`)）\]，,、。！？;；:：])/giu);
  return [...new Set(Array.from(matches, match => match[1]!))];
}

export function buildProjectQuoteCatalog(passages: UnderstandingEvidence[], query: string, requestedFiles: readonly string[] = []): QuoteRow[] {
  const records = new Map<string, UnderstandingEvidence>();
  for (const item of passages) {
    if (item.grantId === "conversation" || item.startOffset === undefined || item.endOffset !== item.startOffset + item.excerpt.length) continue;
    let offset = item.startOffset, line = item.startLine;
    for (const original of item.excerpt.split("\n")) {
      const text = original.endsWith("\r") ? original.slice(0,-1) : original;
      let start = 0;
      while (start < text.length) {
        let end = Math.min(start + 900, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1]!)) end--;
        const excerpt = text.slice(start, end);
        const startOffset = offset+start, endOffset = offset+end;
        if (excerpt.trim()) {
          const key = hash([item.grantId,item.path,item.hash,startOffset,endOffset]);
          const id = startOffset===item.startOffset && endOffset===item.endOffset ? item.id : "ev_" + key;
          if (!records.has(key)) records.set(key,{...item,id,startOffset,endOffset,startLine:line,endLine:line,excerpt});
        }
        start=end;
      }
      offset += original.length + 1; line++;
    }
  }
  const rows = Array.from(records.values());
  const candidates: CareerTaskEvidence[] = rows.map(item=>({...item,kind:"source",sourceId:item.grantId,label:item.path}));
  const byId = new Map(rows.map(row=>[row.id,row]));
  const ranked = rankEvidence(candidates,query,24);
  const selected = ranked.selected.map(({evidence})=>evidence);
  const group = (item:CareerTaskEvidence)=>JSON.stringify([item.sourceId,item.path]);
  const requested=new Map<string,CareerTaskEvidence[]>();
  for(const item of candidates) {
    if(!requestedFiles.some(file=>item.path===file||(!file.includes("/")&&item.path?.split("/").at(-1)===file)))continue;
    const key=group(item);
    const matches=requested.get(key)??[];
    matches.push(item);
    requested.set(key,matches);
  }
  // An explicitly named file must have an opportunity to contribute. Keep
  // the globally ranked order and displace only redundant/unrequested rows.
  for(const [key,items] of requested) {
    if(selected.some(item=>group(item)===key))continue;
    const next=rankEvidence(items,query,1).selected[0]?.evidence;
    if(!next)continue;
    if(selected.length<24){selected.push(next);continue;}
    const counts=new Map<string,number>();
    for(const item of selected)counts.set(group(item),(counts.get(group(item))??0)+1);
    const index=selected.map(item=>!requested.has(group(item))||(counts.get(group(item))??0)>1).lastIndexOf(true);
    if(index>=0)selected.splice(index,1,next);
  }
  return selected.map((evidence,index)=>({id:"q"+(index+1),evidence:byId.get(evidence.id)!}));
}

export function projectQuoteSelectionSchema(ids: string[]) {
  const ref=ids.length ? z.enum(ids) : z.string();
  return z.object({kind:z.literal("quote_review"), facts:z.array(ref).max(ids.length ? 20 : 0),
    inferences:z.array(z.object({text:nonempty,basis:z.array(ref).min(1).max(8)}).strict()).max(ids.length ? 10 : 0),
    unknowns:z.array(nonempty).max(12)}).strict();
}

export function verifyProjectQuoteReview(rows: QuoteRow[], raw: unknown, missingFiles: readonly string[] = []): ProjectQuoteReview {
  const parsed=projectQuoteSelectionSchema(rows.map(row=>row.id)).safeParse(raw);
  if(!parsed.success) return invalid("invalid_project_quote_selection");
  const selection=parsed.data, ids=new Set(selection.facts);
  if(selection.inferences.some(item=>/[?？]\s*[”"']?$/.test(item.text) || /^(?:能否|是否|为何|为什么|如何|哪一种|哪一类|what |which |can we |how can )/iu.test(item.text))) {
    return invalid("project_quote_inference_requires_statement");
  }
  if((!ids.size&&!selection.unknowns.length&&!missingFiles.length) ||
    selection.inferences.some(item=>item.basis.some(id=>!ids.has(id)))) return invalid("invalid_project_quote_selection");
  const records=new Map(rows.map(row=>[row.id,row.evidence]));
  const evidence=[...ids].map(id=>records.get(id)!);
  const claims: ProjectUnderstanding["claims"]=evidence.map(item=>({id:"quote-"+item.id,
    text:item.excerpt, kind:isImplementationEvidencePath(item.path)?"source":"documentation", evidenceIds:[item.id]}));
  for(const inference of selection.inferences) {
    const evidenceIds=[...new Set(inference.basis)].map(id=>records.get(id)!.id);
    const claim={id:"inference-"+hash([inference.text,evidenceIds]),text:inference.text,kind:"inference" as const,evidenceIds};
    if(!claims.some(item=>item.id===claim.id))claims.push(claim);
  }
  const missing=[...new Set(missingFiles)];
  const missingNotes=missing.slice(0,25).map(file=>`尚未取得文件「${file}」可核对的完整候选范围，需要补充取证。`);
  if(missing.length>25)missingNotes.push(`另有 ${missing.length-25} 份指定文件的候选范围不足，请分批核对。`);
  const unknowns=[...new Set([...selection.unknowns.map(topic=>{
    if (!/[?？]\s*$/.test(topic) && /未知|无法|不能确认|不明|尚无|未提供|缺少|不确定|待确认|insufficient|unknown|unverified|uncertain|not established/iu.test(topic)) return topic;
    return /[\p{Script=Han}]/u.test(topic) ? `现有材料无法确认“${topic}”。` : `The available material does not establish the answer to “${topic}”.`;
  }),...missingNotes])];
  for(const text of unknowns) claims.push({id:"unknown-"+hash([text]),text,kind:"unknown",evidenceIds:[]});
  const summary=`本次核对了 ${evidence.length} 处资料原文，列出 ${claims.filter(claim=>claim.kind==="inference").length} 条推断和 ${unknowns.length} 项未知信息。`;
  return {reply:{kind:"reply",message:summary,readyForConfirmation:true,
    understanding:{summary,terms:[],boundaries:[],claims,unknowns}}, evidence};
}

export function checkQuoteProvenance(selected: UnderstandingEvidence[], mounted: UnderstandingEvidence[]) {
  for (const item of selected) {
    const parent=mounted.find(candidate=>candidate.grantId===item.grantId && candidate.path===item.path && candidate.hash===item.hash &&
      candidate.startOffset!==undefined && candidate.endOffset!==undefined && item.startOffset!==undefined && item.endOffset!==undefined &&
      candidate.startOffset<=item.startOffset && candidate.endOffset>=item.endOffset &&
      candidate.excerpt.slice(item.startOffset-candidate.startOffset,item.endOffset-candidate.startOffset)===item.excerpt);
    if (!parent) invalid("project_quote_source_changed");
  }
}
