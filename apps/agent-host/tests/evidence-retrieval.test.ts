import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import type { CareerTask } from "@better-me/agent-contracts";
import { EVIDENCE_RETRIEVAL_POLICY, evidenceManifest, evidencePassages, evidenceTerms, rankEvidence } from "../src/kernel/evidence-retrieval.js";
import { taskContext } from "../src/kernel/context.js";
import { executeTaskTool } from "../src/kernel/tools.js";
import { evidence, observe, requireEvidence } from "../src/tasks/evidence.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";

function task(): CareerTask {
  return { id:"ct_synthetic",ownerId:"synthetic",workspaceKey:"synthetic",objective:"核对 C# .NET Redis 缓存击穿兜底",status:"ready",revision:1,createdAt:"now",updatedAt:"now",
    job:{title:"合成后端岗",company:"虚构公司",description:"C# .NET Redis 缓存击穿"},
    resume:{id:"synthetic",name:"合成原稿",sourceFingerprint:"synthetic-source",fields:[{id:"f1",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"参与测试。"}]},
    runtimeBinding:{id:"synthetic",label:"synthetic",location:"local"},budget:{maxModelCalls:12,maxToolCalls:30,maxActiveMs:60000},usage:{modelCalls:0,toolCalls:0,activeMs:0},materials:[],directories:[],evidence:[],events:[],facts:[] };
}

test("local BM25 ranks mixed C#/.NET and Chinese responsibility evidence ahead of unrelated recent documents",()=>{
  const items=Array.from({length:12},(_,index)=>evidence("source",`m${index}`,`合成材料${index}`,index===0?"C# .NET Redis 缓存击穿，互斥重建与过期抖动。":"React CSS 组件交互与布局。"));
  const ranked=rankEvidence(items,"C# .NET Redis 缓存击穿",3);
  assert.equal(ranked.selected.length,3);assert.equal(ranked.selected[0]!.evidence.sourceId,"m0");
  assert.ok(ranked.selected[0]!.coarseScore>0);assert.equal(ranked.selected[0]!.queryCoverage,1);
  assert.deepEqual(rankEvidence(items.toReversed(),"C# .NET Redis 缓存击穿",3),ranked,"ties are source-stable, not input-recency based");
  assert.ok(evidenceTerms("C# .NET 缓存击穿").includes("c#"));assert.ok(evidenceTerms("缓存击穿").includes("击穿"));
});

test("lossless passage partition preserves CRLF, long-line tails, emoji and exact absolute coordinates",()=>{
  const full="prefix\r\n"+"🧪合成缓存".repeat(500)+"\r\n\r\n最后一段：没有上线。";
  const original=evidence("source","synthetic","合成原文",full);
  const chunks=evidencePassages(original,64);
  assert.equal(chunks.map(item=>item.excerpt).join(""),full);
  for(const item of chunks){
    assert.equal(full.slice(item.startOffset,item.endOffset),item.excerpt);
    assert.equal(item.startLine,full.slice(0,item.startOffset).split("\n").length);
    assert.equal(item.endLine,full.slice(0,item.endOffset).split("\n").length);
    assert.equal(item.hash,original.hash);assert.equal(item.sourceLength,full.length);
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(item.excerpt)&&!/[\uD800-\uDBFF]$/u.test(item.excerpt));
    assert.ok(!(item.excerpt.endsWith("\r")&&full[item.endOffset!]==="\n"));
  }
  assert.equal(chunks.at(-1)!.endOffset,full.length);
});

test("Top-K projection pins complete personal corrections/explicit pages and manifests every collected source without mutating it",()=>{
  const current=task();
  current.evidence=Array.from({length:12},(_,i)=>evidence("source",`material:m${i}`,`合成材料${i}`,i===0?"Redis 缓存击穿。":"仅设计材料，不是个人贡献。"));
  const correction=evidence("user_statement","answer:correction","本人纠正","本人不负责上线。"+"完整纠正。".repeat(1000));
  current.evidence.push(correction);
  const requested=current.evidence[10]!;
  const observations=[{tool:"read_evidence",evidenceIds:[requested.id],result:{full:"OBSERVATION".repeat(1000)}}];
  const before=structuredClone(current),context=taskContext(current,observations);
  assert.equal(context.retrieval.selected.length,EVIDENCE_RETRIEVAL_POLICY.topK);
  assert.equal(context.evidenceManifest.length,current.evidence.length);
  assert.equal(context.evidence.find(item=>item.id===correction.id)!.excerpt,correction.excerpt);
  assert.ok(context.evidence.some(item=>item.id===requested.id));
  assert.deepEqual(context.recentObservations,observations);assert.deepEqual(current,before);
  assert.ok(context.evidenceManifest.every(item=>!("excerpt" in item)&&item.handle.startsWith("ref_")));
});

test("omitted material handles page exact long-line offsets; unknown and another task's handles grant no access",async()=>{
  const current=task(),full="a".repeat(7000)+"长行尾部：仅联调，未投产。";
  current.materials=[{id:"m0",label:"合成材料",kind:"design",text:full}];
  current.evidence=[evidence("design","material:m0","合成材料",full,1,1,0,64)];
  const original=structuredClone(current.evidence),manifest=evidenceManifest(current.evidence),broker=new EvidenceBroker();
  const page=await executeTaskTool(current,[],broker,{kind:"tool",tool:"read_evidence",id:manifest[0]!.handle,offset:6950,length:100},new AbortController().signal);
  assert.equal(page.evidence[0]!.excerpt,full.slice(6950,7050));assert.equal(page.evidence[0]!.startOffset,6950);
  assert.equal(page.evidence[0]!.hash,current.evidence[0]!.hash);assert.deepEqual(current.evidence,original);
  assert.equal((page.detail as {nextOffset:null}).nextOffset,null);
  for(const handle of ["ref_unknown",evidenceManifest([evidence("source","other-task","合成其他来源","other")])[0]!.handle]){
    await assert.rejects(executeTaskTool(current,[],broker,{kind:"tool",tool:"read_evidence",id:handle},new AbortController().signal),/unknown_evidence/);
  }
});

test("a manifest/index entry alone cannot satisfy the model citation gate",()=>{
  const current=task();current.evidence=[evidence("design","material:unmounted","合成来源","仅设计，未实现。")];
  const id=current.evidence[0]!.id;
  assert.throws(()=>requireEvidence(current,[id],[]),/evidence_not_mounted_read_first/);
  assert.throws(()=>requireEvidence(current,[evidenceManifest(current.evidence)[0]!.handle],[id]),/unknown_evidence/);
  assert.deepEqual(requireEvidence(current,[id],[id]),current.evidence);
});

test("Broker-backed manifest pages preserve raw CRLF offsets, recheck file hashes, and reject revoked grants",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"betterme-retrieval-"));
  try{
    const full="first\r\n"+"x".repeat(6000)+"\r\nRedis 尾部：未上线。",filename=path.join(root,"synthetic.cs");await writeFile(filename,full);
    const broker=new EvidenceBroker(),grant=await broker.grant(root),current=task();current.directories=[{id:grant.id,label:grant.label}];
    const first=await observe(current,[grant],broker,{kind:"tool",tool:"read_file",id:grant.id,path:"synthetic.cs",startLine:1,endLine:2},new AbortController().signal);
    current.evidence=first.evidence;
    assert.equal(first.evidence[0]!.excerpt,full.slice(0,full.lastIndexOf("\r\n")));
    const handle=evidenceManifest(current.evidence)[0]!.handle;
    const request={kind:"tool",tool:"read_evidence",id:handle,offset:5990,length:100} as const;
    const page=await executeTaskTool(current,[grant],broker,request,new AbortController().signal);
    assert.equal(page.evidence[0]!.excerpt,full.slice(5990,6090));assert.equal(page.evidence[0]!.startOffset,5990);
    assert.equal(page.evidence[0]!.sourceLength,full.length);assert.equal(page.evidence[0]!.endLine,3);
    await writeFile(filename,full+" changed");
    await assert.rejects(executeTaskTool(current,[grant],broker,request,new AbortController().signal),/source_changed_new_comparison_required/);
    grant.revokedAt=new Date().toISOString();
    await assert.rejects(executeTaskTool(current,[grant],broker,request,new AbortController().signal),/directory_not_granted/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("legacy line-only file records require exact reread, never fabricated zero-based offsets",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"betterme-retrieval-legacy-"));
  try{
    const full="first\r\nsecond\r\nC# 缓存测试，未上线。";await writeFile(path.join(root,"legacy.cs"),full);
    const broker=new EvidenceBroker(),grant=await broker.grant(root),current=task();current.directories=[{id:grant.id,label:grant.label}];
    current.evidence=(await observe(current,[grant],broker,{kind:"tool",tool:"read_file",id:grant.id,path:"legacy.cs",startLine:3,endLine:3},new AbortController().signal)).evidence;
    for(const item of current.evidence){delete item.startOffset;delete item.endOffset;delete item.sourceLength;}
    const before=structuredClone(current.evidence),context=taskContext(current,[]);
    assert.deepEqual(context.evidence,[]);assert.deepEqual(context.retrieval.coordinateRereadRequired,[current.evidence[0]!.id]);
    assert.equal(context.evidenceManifest.length,1);assert.deepEqual(current.evidence,before);
    const reread=await executeTaskTool(current,[grant],broker,{kind:"tool",tool:"read_evidence",id:context.evidenceManifest[0]!.handle},new AbortController().signal);
    assert.equal(reread.evidence[0]!.excerpt,"C# 缓存测试，未上线。");
    assert.equal(reread.evidence[0]!.startOffset,"first\r\nsecond\r\n".length);
    assert.equal(reread.evidence[0]!.endOffset,full.length);assert.deepEqual(current.evidence,before);
  }finally{await rm(root,{recursive:true,force:true});}
});
