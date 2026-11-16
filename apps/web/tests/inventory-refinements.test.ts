import assert from "node:assert/strict";
import test from "node:test";
import { makeInventorySource, type InventorySession } from "@better-me/agent-contracts";
import { inventoryRefinements } from "../src/lib/inventory-refinements";
import type { WritingSource } from "../src/lib/resume-copilot";

const field=(experienceId:string,claimId:string):WritingSource=>({targetRef:{kind:"claim_text",experienceId,claimId,locale:"zh"},text:"外观相同的原句",label:"相同标题"});
function reviewed():InventorySession {
  const source=makeInventorySource({documentId:"document",resumeId:"edition",groups:[
    {id:"A",kind:"work",experienceId:"a",label:"相同标题",evidence:[]},
    {id:"B",kind:"work",experienceId:"b",label:"相同标题",evidence:[]},
    {id:"link",kind:"link",label:"相同标题",evidence:[]}]});
  const answers=source.groups.map(g=>({id:"answer-"+g.id,target:g.id,text:"只设计、没有交付 "+g.id}));
  const id=crypto.randomUUID(), at="2026-11-14T00:00:00Z";
  return {id,source,revision:3,phase:"confirmed",cursor:2,answers,skipped:[],receipt:{
    confirmedAt:at,reviewHash:"f".repeat(64),selected:answers.map(a=>a.id),profileEntryIds:[],direction:[],nextSteps:[],
    strategy:source.groups.map(g=>({groupId:g.id,kind:g.kind,label:g.label,disposition:"compress",reason:"少写"})),
    statements:source.groups.map((g,i)=>({id:"quote-"+g.id,text:answers[i]!.text,kind:"user_statement",taskId:id,approvedAt:at,
      evidence:[{id:answers[i]!.id,hash:"test",excerpt:answers[i]!.text,kind:"user_statement",label:"本人原话"}],
      inventoryBinding:{documentId:source.documentId,resumeId:source.resumeId,fingerprint:source.fingerprint,groupId:g.id,experienceId:g.experienceId}})),
  }};
}
test("confirmed material resolves by exact visible fields; a matching title or sentence grants no attachment",()=>{
  const s=reviewed(), a1=field("a","1"),a2=field("a","2"),b1=field("b","1");
  const lookup=inventoryRefinements(s,[a1,a2,b1,{...field("a","blank"),text:"  "}]);
  assert.deepEqual(lookup.get("A")?.fields,[a1,a2]);
  assert.deepEqual(lookup.get("A")?.statements.map(x=>x.text),["只设计、没有交付 A"]);
  assert.deepEqual(lookup.get("B")?.fields,[b1]);assert.ok(!lookup.has("link"));
  assert.deepEqual(inventoryRefinements(s,[a1,a1,b1]).get("A"),undefined); // duplicate field identity
  assert.ok(!inventoryRefinements({...s,phase:"review"},[a1]).size);
  for(const disposition of ["omit","pending"] as const){s.receipt!.strategy[0]!.disposition=disposition;assert.ok(!inventoryRefinements(s,[a1]).size);}
});
test("a foreign or revoked statement never follows a claim; unrelated private answers are not fallback evidence",()=>{
  for(const mutate of [
    (s:InventorySession)=>{s.receipt!.selected=[];},
    (s:InventorySession)=>{s.receipt!.statements[0]!.taskId="archived";},
    (s:InventorySession)=>{s.receipt!.statements[0]!.inventoryBinding!.documentId="elsewhere";},
    (s:InventorySession)=>{s.receipt!.statements[0]!.inventoryBinding!.resumeId="other-edition";},
    (s:InventorySession)=>{s.receipt!.statements[0]!.inventoryBinding!.fingerprint="0".repeat(64);},
    (s:InventorySession)=>{s.receipt!.statements[0]!.inventoryBinding!.experienceId="b";},
    (s:InventorySession)=>{s.receipt!.statements[0]!.text="另一条回答";},
    (s:InventorySession)=>{s.answers[0]!.target="redline";},
  ]){
    const s=reviewed();mutate(s);assert.ok(!inventoryRefinements(s,[field("a","1")]).size);
  }
});
