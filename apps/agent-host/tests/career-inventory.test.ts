import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeInventorySource, inventoryKey } from "@better-me/agent-contracts";
import { OwnedStore } from "../src/identity/owned-store.js";
import { InventoryWorkspace } from "../src/inventory/workspace.js";
import { inventoryJobSignals } from "@better-me/agent-contracts";

test("a confirmed selection produces a source-bound private statement and portfolio strategy, never treats unselected preferences or skipped groups as confirmed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),"betterme-inventory-fixture-"));
  try {
    const space = new InventoryWorkspace(new OwnedStore(dir,randomUUID()));
    const source = makeInventorySource({ documentId:"doc",resumeId:"view",groups:[
      { id:"e", kind:"work", label:"最新任职", experienceId:"work-2", evidence:["维护接口"] },
      { id:"p", kind:"link", label:"独立作品集", evidence:["https://example.invalid/portfolio"] },
    ] });
    const key = inventoryKey(source), access = async () => true;
    let view = await space.start(source,access);
    const cmd = async (op: Record<string,unknown>) => view = await space.command(key,{ ...op, expectedRevision:view.session.revision, commandId:randomUUID(), fingerprint:source.fingerprint },access);
    await cmd({ kind:"answer", target:"baseline", text:"大约 2023 年底" });
    await cmd({ kind:"skip", target:"current" });
    await cmd({ kind:"add", target:"new", text:"去年做了个人作品回放器", category:"portfolio", more:false });
    await cmd({ kind:"answer", target:"e", text:"我设计了接口，未上线。", disposition:"feature" });
    await cmd({ kind:"skip", target:"p" });
    await cmd({ kind:"answer", target:"style", text:"只留在草稿的发言" });
    assert.deepEqual(await space.profile(access),{ revision:0, entries:[] });
    await cmd({ kind:"review" });
    const selected = view.session.answers.filter(a => a.target !== "style").map(a => a.id);
    await cmd({ kind:"confirm", selected, reviewHash:view.reviewHash });
    assert.equal(view.session.phase,"confirmed");
    assert.equal(view.session.receipt?.baseline?.text,"大约 2023 年底");
    assert.equal(view.session.receipt?.statements.find(s => s.inventoryBinding?.experienceId === "work-2")?.text,"我设计了接口，未上线。");
    assert.equal(view.session.receipt?.strategy.find(g => g.groupId === "p")?.disposition,"pending");
    assert.ok(view.session.receipt?.strategy.some(g => g.kind === "portfolio" && g.disposition === "feature"));
    assert.doesNotMatch(JSON.stringify(view.session.receipt),/只留在草稿/);
    assert.deepEqual((await space.profile(access)).entries,[]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("review binds the cited version, preferences need purpose, and a negative or unmentioned JD does not become a conflict", async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"betterme-inventory-review-"));
  try {
    const space=new InventoryWorkspace(new OwnedStore(dir,randomUUID())), access=async()=>true;
    const source=makeInventorySource({documentId:"d",resumeId:"v",groups:[]}), k=inventoryKey(source);
    let v=await space.start(source,access);
    const command=(op:Record<string,unknown>)=>({expectedRevision:v.session.revision,fingerprint:source.fingerprint,commandId:randomUUID(),...op});
    for (const target of ["baseline","current","new","style","like","atmosphere","avoid"]) v=await space.command(k,command({kind:"skip",target}),access);
    v=await space.command(k,command({kind:"answer",target:"redline",text:"偶尔出差可以，不能长期驻场",uses:["jd"],matchTerm:"长期驻场"}),access);
    v=await space.command(k,command({kind:"review"}),access);const stale=v.reviewHash, answer=v.session.answers[0]!;
    v=await space.command(k,command({kind:"edit",answerId:answer.id,text:"我能接受短期出差，不接受长期驻场"}),access);
    await assert.rejects(space.command(k,command({kind:"confirm",selected:[answer.id],reviewHash:stale}),access));
    const exact=command({kind:"confirm",selected:[answer.id],reviewHash:v.reviewHash});v=await space.command(k,exact,access);
    assert.deepEqual(await space.command(k,exact,access),v);
    assert.deepEqual(v.session.receipt?.direction,[]);
    assert.equal(inventoryJobSignals(v.profile,"岗位要求：需长期驻场。")[0]?.state,"conflict");
    assert.equal(inventoryJobSignals(v.profile,"不需要长期驻场。")[0]?.state,"check");
    assert.equal(inventoryJobSignals(v.profile,"负责接口开发。")[0]?.state,"unknown");
    const profile=await space.forget(answer.id,v.profile.revision,access);
    assert.deepEqual(inventoryJobSignals(profile,"需长期驻场"),[]);
    await assert.rejects(space.get(k,async()=>false));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("confirmed strategy preferences prioritise related evidence without overriding an omission; revoked or superseded preferences no longer rank a new review", async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"betterme-inventory-selection-"));
  try {
    const space=new InventoryWorkspace(new OwnedStore(dir,randomUUID())), access=async()=>true;
    const source=makeInventorySource({documentId:"d",resumeId:"a",groups:[
      {id:"a",kind:"work",label:"例行维护",evidence:[]},{id:"b",kind:"other",label:"回放工具",evidence:["实现事件回放协议"]},
      {id:"c",kind:"work",label:"另一段",evidence:["事件回放"]}]}), key=inventoryKey(source);
    let v=await space.start(source,access);
    const act=async(op:Record<string,unknown>)=>v=await space.command(key,{expectedRevision:v.session.revision,commandId:randomUUID(),fingerprint:source.fingerprint,...op},access);
    async function review(like?:string){
      for(const target of ["baseline","current","new"])await act({kind:"skip",target});
      for(const target of ["a","b","c"])await act({kind:"answer",target,text:"本人维护了其中的测试。",disposition:target==="c"?"omit":"feature"});
      await act({kind:"skip",target:"style"});if(like)await act({kind:"answer",target:"like",text:"下份工作想多做"+like,uses:["strategy"],strategyTerm:like});
      await act({kind:"review"});await act({kind:"confirm",selected:v.session.answers.map(a=>a.id),reviewHash:v.reviewHash});
    }
    await review("事件回放");
    assert.equal(v.session.receipt?.strategy[0]?.groupId,"b");
    assert.match(v.session.receipt?.strategy[0]?.reason??"",/事件回放/);
    assert.equal(v.session.receipt?.strategy.find(x=>x.groupId==="c")?.disposition,"omit");
    await act({kind:"again"});await review();assert.equal(v.session.receipt?.strategy[0]?.groupId,"b");
    await act({kind:"again"});await review("例行维护");assert.equal(v.session.receipt?.strategy[0]?.groupId,"a");
    assert.equal(v.profile.entries.length,1);assert.deepEqual(v.session.receipt?.direction,["下份工作想多做例行维护"]);
    await space.forget(v.profile.entries[0]!.id,v.profile.revision,access);
    await act({kind:"again"});await review();assert.deepEqual(v.session.receipt?.direction,[]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("concurrent drafts cannot overwrite each other; changed sources keep historical receipts separate and stale commands fail",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"betterme-inventory-race-"));
  try {
    const space=new InventoryWorkspace(new OwnedStore(dir,randomUUID())),access=async()=>true;
    const source=makeInventorySource({documentId:"d",resumeId:"v",groups:[]}),k=inventoryKey(source);
    const initial=await space.start(source,access),advance=(cmd:Record<string,unknown>)=>({fingerprint:source.fingerprint,expectedRevision:1,commandId:randomUUID(),...cmd});
    const outcomes=await Promise.allSettled(["甲","乙"].map(text=>space.command(k,advance({kind:"answer",target:"baseline",text}),access)));
    assert.equal(outcomes.filter(v=>v.status==="fulfilled").length,1);
    const review=await space.command(k,advance({expectedRevision:2,kind:"review"}),access);
    const done=await space.command(k,advance({expectedRevision:3,kind:"confirm",selected:review.session.answers.map(a=>a.id),reviewHash:review.reviewHash}),access);
    const changed=makeInventorySource({documentId:"d",resumeId:"v",groups:[{id:"exp:2",kind:"work",label:"新版经历",evidence:[]}]});
    const next=await space.start(changed,access);
    assert.notEqual(next.session.id,initial.session.id);assert.equal(next.session.previousAt,done.session.receipt?.confirmedAt);
    assert.deepEqual(next.session.answers,[]);assert.equal(next.session.receipt,undefined);
    await assert.rejects(space.command(k,advance({kind:"skip",target:"baseline"}),access),/inventory_changed/);
    assert.equal((await space.get(k,access))?.session.source.fingerprint,changed.fingerprint);
  } finally {await rm(dir,{recursive:true,force:true});}
});
