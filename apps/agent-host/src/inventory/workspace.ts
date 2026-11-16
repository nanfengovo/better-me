import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InventoryCommandSchema, InventoryProfileSchema, InventorySessionSchema, InventorySourceSchema, ProfileTopicSchema,
  inventoryDigest, inventoryKey, inventoryTargets, type InventoryProfile, type InventorySession, type InventorySource, type InventoryView } from "@better-me/agent-contracts";
import { PersonalStatementSchema } from "@better-me/core";
import { IdentityError } from "../identity/service.js";
import type { OwnedStore } from "../identity/owned-store.js";

const key = "private-career-inventory-v1";
const ledgerSchema = z.object({workspaceKey:z.literal(key),revision:z.number().int().nonnegative(),
  sessions:z.record(InventorySessionSchema), profile:InventoryProfileSchema}).strict();
type Ledger = z.infer<typeof ledgerSchema>;
type Access = () => Promise<boolean>;
const fail = (message:string):never => { throw new IdentityError(409,message); };
const check = async (access:Access) => { if (!await access()) throw new IdentityError(403,"inventory_access_revoked"); };
const reviewHash = (s:InventorySession, p:InventoryProfile) => inventoryDigest([s.id,s.revision,s.source.fingerprint,s.answers,s.skipped,p.revision]);
const viewOf = (s:InventorySession, p:InventoryProfile):InventoryView => ({session:s,reviewHash:reviewHash(s,p),profile:p});
function begin(source:InventorySource, previousAt?:string):InventorySession {
  return { id:randomUUID(),revision:1,source,phase:"interview",cursor:0,answers:[],skipped:[],previousAt };
}

/** One owner record is the atomic commit point for the reviewed source, private profile and receipt.
 * No write path to the resume, its print view, a company or a model is available here. */
export class InventoryWorkspace {
  constructor(private store:OwnedStore) {}
  private async load(access:Access):Promise<Ledger> {
    await check(access); const r=await this.store.read("inventory",key); await check(access);
    return r ? ledgerSchema.parse(r.value) : { workspaceKey:key,revision:0,sessions:{},profile:{revision:0,entries:[]} };
  }
  private async save(d:Ledger,access:Access) {
    const prior=d.revision++; await this.store.write("inventory",key,prior,ledgerSchema.parse(d),access);
  }
  async get(k:string,access:Access) {
    const d=await this.load(access), s=d.sessions[k];
    return s ? viewOf(s,d.profile) : null;
  }
  async profile(access:Access) { return (await this.load(access)).profile; }
  async forget(id:string,revision:number,access:Access) {
    const d=await this.load(access);
    if(d.profile.revision!==revision || !d.profile.entries.some(e=>e.id===id)) fail("inventory_profile_changed");
    d.profile={revision:revision+1,entries:d.profile.entries.filter(e=>e.id!==id)};
    await this.save(d,access);return d.profile;
  }
  async start(raw:unknown,access:Access) {
    const source=InventorySourceSchema.parse(raw), k=inventoryKey(source), d=await this.load(access);
    const prior=d.sessions[k];
    if(prior?.source.fingerprint===source.fingerprint) return viewOf(prior,d.profile);
    // A changed source gets a new review. Preserve the previous session separately, never transfer claims to it.
    if(prior) d.sessions[prior.id]=prior;
    const s=begin(source,prior?.receipt?.confirmedAt);d.sessions[k]=s;await this.save(d,access);return viewOf(s,d.profile);
  }
  async command(k:string,raw:unknown,access:Access) {
    const c=InventoryCommandSchema.parse(raw), d=await this.load(access), s=d.sessions[k];
    if(!s || inventoryKey(s.source)!==k) throw new IdentityError(404,"inventory_not_found");
    const hash=inventoryDigest(c);
    if(s.last?.commandId===c.commandId && s.last.hash===hash) return viewOf(s,d.profile);
    if(s.revision!==c.expectedRevision || s.source.fingerprint!==c.fingerprint) fail("inventory_changed");
    const targets=inventoryTargets(s.source), current=targets[s.cursor];
    if(c.kind==="again") {
      if(s.phase!=="confirmed") fail("inventory_not_confirmed");
      d.sessions[s.id]=s;
      const next=begin(s.source,s.receipt?.confirmedAt);next.revision=s.revision+1;next.last={commandId:c.commandId,hash};
      d.sessions[k]=next;await this.save(d,access);return viewOf(next,d.profile);
    }
    if(s.phase==="confirmed") fail("inventory_already_confirmed");
    if(c.kind==="confirm") {
      if(s.phase!=="review" || c.reviewHash!==reviewHash(s,d.profile) || new Set(c.selected).size!==c.selected.length ||
        c.selected.some(id=>!s.answers.some(a=>a.id===id))) fail("inventory_review_changed");
      this.confirm(s,d.profile,c.selected,c.reviewHash);
    } else if(c.kind==="review") { s.phase="review"; }
    else if(c.kind==="back") { if(s.phase!=="review" || s.cursor>=targets.length) fail("inventory_no_remaining_questions");s.phase="interview"; }
    else if(c.kind==="edit") {
      const a=s.answers.find(x=>x.id===c.answerId);if(s.phase!=="review" || !a) return fail("inventory_answer_missing");
      a.text=c.text;if(c.disposition) a.disposition=c.disposition;
    } else {
      if(s.phase!=="interview" || current!==c.target) fail("inventory_question_changed");
      if(c.kind==="skip") s.skipped.push(c.target);
      else if(c.kind==="add") s.answers.push({id:randomUUID(),target:"new",text:c.text,category:c.category,disposition:"feature"});
      else {
        if(c.target==="new") fail("inventory_category_required");
        s.answers.push({id:randomUUID(),target:c.target,text:c.text,disposition:c.disposition,uses:c.uses,
          matchTerm:c.matchTerm,strategyTerm:c.strategyTerm,question:c.question});
      }
      if(c.kind!=="add" || !c.more) s.cursor++;
      if(s.cursor>=targets.length) s.phase="review";
    }
    s.revision++;s.last={commandId:c.commandId,hash};await this.save(d,access);return viewOf(s,d.profile);
  }
  private confirm(s:InventorySession, profile:InventoryProfile, ids:string[], review:string) {
    const at=new Date().toISOString(), chosen=s.answers.filter(a=>ids.includes(a.id)), source=s.source;
    const items=[...chosen.filter(a=>a.target==="new").map(a=>({id:a.id,kind:a.category!,label:a.text,experienceId:undefined})),...source.groups];
    const receipt:NonNullable<InventorySession["receipt"]>={confirmedAt:at,reviewHash:review,selected:ids,profileEntryIds:[],statements:[],strategy:[],nextSteps:[],direction:[]};
    const base=chosen.find(a=>a.target==="baseline");
    if(base) receipt.baseline={text:base.text,documentId:source.documentId,fingerprint:source.fingerprint,confirmedAt:at};
    for(const a of chosen) {
      const topic=ProfileTopicSchema.safeParse(a.target);if(!topic.success) continue;
      const entry={id:a.id,topic:topic.data,quote:a.text,uses:a.uses??[],...(a.matchTerm?{matchTerm:a.matchTerm}:{}),...(a.strategyTerm?{strategyTerm:a.strategyTerm}:{}),
        confirmedAt:at,sessionId:s.id,answerId:a.id,revision:profile.revision+1};
      profile.entries=profile.entries.filter(e=>e.topic!==entry.topic);
      profile.entries.push(entry);receipt.profileEntryIds.push(entry.id);
    }
    if(receipt.profileEntryIds.length) profile.revision++;
    const permitted=profile.entries.filter(e=>e.uses.includes("strategy"));
    receipt.direction=permitted.filter(e=>["intent","like","style","atmosphere","avoid"].includes(e.topic)).map(e=>e.quote);
    const priorities=new Map<string,number>();
    for(const g of items) {
      const a=chosen.find(x=>x.target===g.id || x.target==="new" && x.id===g.id);
      const disposition=a?.disposition??"pending";
      const material=[g.label,...("evidence" in g ? g.evidence:[]),a?.text??""].join("\n").toLowerCase();
      // Only a user's explicit focus term (or a whole material title quoted by them). Never infer ability,
      // rewrite a chosen disposition, or promote an unreviewed item based on a word in an old resume.
      const hit=a&&disposition==="feature" ? permitted.filter(e=>e.topic==="like"||e.topic==="intent").map(e=>{
        const term=e.strategyTerm ?? (g.label.length>=3 && !/[不没无非]|\b(?:no|not|avoid)\b/iu.test(e.quote) && e.quote.includes(g.label) ? g.label:undefined);
        return term&&material.includes(term.toLowerCase())?term:undefined;
      }).find(Boolean):undefined;
      const advice=!a ? (s.skipped.includes(g.id) ? "本人跳过；保留待补，不代表没有这段经历。" : "尚无选用的本人说明，先保留为待核对材料。")
        : disposition==="omit" ? "本人决定本版不选，原材料保留。" : disposition==="compress" ? "保留一条能说明本人职责的要点，不展开日常工作清单。"
        : disposition==="pending" ? "本人标为待补：先核对职责和结果，再决定是否写入。"
        : "先展开本人动作与可核对的结果，不把未证实的影响写成绩效。";
      receipt.strategy.push({groupId:g.id,kind:g.kind,label:g.label,disposition,reason:[
        hit?"和你想多做的「"+hit+"」有原词呼应，在同为重点的材料中优先。":"",
        (g.kind==="portfolio"||g.kind==="link")?"这是一份独立作品线索，不归入雇主任职。":"",advice].filter(Boolean).join("")});
      priorities.set(g.id,({feature:0,compress:2,pending:3,omit:4} as const)[disposition]+(disposition==="feature"&&!hit?1:0));
      if(!a) continue;
      receipt.statements.push(PersonalStatementSchema.parse({id:"inventory:"+a.id,kind:"user_statement",text:a.text,taskId:s.id,
        evidence:[{id:a.id,hash:inventoryDigest(a.text),excerpt:a.text,label:"履历盘点 · 本人原话",kind:"user_statement"}],approvedAt:at,
        inventoryBinding:{documentId:source.documentId,resumeId:source.resumeId,fingerprint:source.fingerprint,groupId:g.id,experienceId:g.experienceId}}));
    }
    receipt.strategy.sort((left,right)=>priorities.get(left.groupId)!-priorities.get(right.groupId)!);
    const top=receipt.strategy.find(g=>g.disposition==="feature"), missing=receipt.strategy.find(g=>g.disposition==="pending");
    if(top) receipt.nextSteps.push("先展开「"+top.label+"」的一项本人动作，再决定是否用作简历开头。");
    if(missing) receipt.nextSteps.push("下次先核对「"+missing.label+"」，没有依据就不要补写成果。");
    const goal=profile.entries.find(e=>e.topic==="intent" && e.uses.includes("planning"));
    if(goal) receipt.nextSteps.push("围绕「"+goal.quote+"」选择一个可展示的下一步作品；这是建议，不是已制定的计划。");
    if(!receipt.nextSteps.length) receipt.nextSteps.push("目前没有明确的优先材料；可重新盘点，也可直接编辑，不自动改稿。");
    s.phase="confirmed";s.receipt=receipt;
  }
}
