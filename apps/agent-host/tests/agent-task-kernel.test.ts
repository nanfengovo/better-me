import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { careerRuntimeBinding, type CareerTask, type CareerTaskCreate } from "@better-me/agent-contracts";
import { AgentTaskKernel } from "../src/kernel/service.js";
import { EvidenceBroker, type EvidenceRequest } from "../src/understanding/evidence-broker.js";
import type { UnderstandingGrant } from "@better-me/agent-contracts";
import { readPrivateJson, writePrivateJson } from "../src/identity/private-json.js";
import { evidence, observe } from "../src/tasks/evidence.js";

const access = { session: "synthetic-kernel-session", valid: async () => true };
const binding = careerRuntimeBinding({ kind: "model", modelSettings: { provider: "ollama", model: "offline-fixture", baseUrl: "http://127.0.0.1:11434/v1" } });
const input = (key = "synthetic-kernel-task"): CareerTaskCreate => ({
  workspaceKey: "isolated-workspace", idempotencyKey: key, consent: true, objective: "核对缓存测试要求并准备岗位版，不投递。", runtimeBinding: binding,
  job: { title: "合成后端岗", company: "虚构公司", description: "负责缓存测试，熟悉 C#。" },
  resume: { id: "synthetic-resume", name: "合成原稿", sourceFingerprint: "source-1", fields: [{ id: "f1", originalText: "参与缓存测试。", targetRef: { kind: "profile_headline", locale: "zh" } }] },
});
const runInput = (t: CareerTask) => ({ expectedRevision: t.revision, sourceFingerprint: t.resume.sourceFingerprint, runtimeBinding: t.runtimeBinding, consent: true as const });
async function settled(kernel: AgentTaskKernel, id: string) {
  for (let i = 0; i < 400; i++) { const task = await kernel.readTask(id); if (task.status !== "running") return task; await delay(5); }
  throw new Error("isolated kernel did not settle");
}

test("one host task exposes scoped tools and cursor events without replaying a decision", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "betterme-kernel-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-owner", directory: dir });
  try {
    const task = await kernel.createTask(input(), access);
    let calls = 0;
    await kernel.run(task.id, "start", runInput(task), { runtimeFingerprint: "synthetic-runtime", reasoner: async prompt => {
      calls++;
      if (calls === 1) return JSON.stringify({ kind: "tool", tool: "discover_tools" });
      if (calls === 2) {
        assert.ok(prompt.includes("decompose_job"));
        assert.ok(!prompt.includes('"tool":"read_file"'), "ungranted directory tools are not offered");
        return JSON.stringify({ kind: "tool", tool: "read_job" });
      }
      if (calls === 3) return JSON.stringify({ kind: "tool", tool: "read_resume", id: "f1" });
      return JSON.stringify({ kind: "draft", patches: [], unknowns: ["尚未确认本人负责范围。"] });
    } }, access);
    const review = await settled(kernel, task.id);
    assert.equal(review.status, "awaiting_review", review.error);
    assert.equal(review.usage.modelCalls, 4);
    const first = await kernel.watch(task.id, 0);
    assert.equal(first.task.id, task.id);
    assert.ok(first.events.some(event => event.kind === "tool_result"));
    assert.deepEqual((await kernel.watch(task.id, first.cursor)).events, []);
    assert.equal((await kernel.readTask(task.id)).usage.modelCalls, 4, "observing never dispatches again");
  } finally { await kernel.close(); await rm(dir, { recursive: true, force: true }); }
});

test("bounded context retains early personal corrections and can rehydrate precise long-line spans", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "betterme-context-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-owner", directory: dir });
  try {
    const data = input("synthetic-context-task");
    data.budget = {maxModelCalls:60,maxToolCalls:60,maxActiveMs:60_000};
    data.materials = Array.from({length:30}, (_,i) => ({id:`m${i}`,label:`合成材料${i}`,kind:"source",text:i===0?"x".repeat(6500)+"长行尾部：仅设计，未投产。":"合成无关记录。"}));
    let task = await kernel.createTask(data, access), initial = 0;
    const readState = (prompt:string) => JSON.parse(prompt.split("\n\n").at(-1)!);
    await kernel.run(task.id,"start",runInput(task),{runtimeFingerprint:"synthetic-runtime",reasoner:async prompt=>{
      if(++initial===1)return JSON.stringify({kind:"tool",tool:"read_job"});
      if(initial===2)return JSON.stringify({kind:"tool",tool:"read_resume",id:"f1"});
      return JSON.stringify({kind:"ask_user",question:"你负责什么？",evidenceIds:readState(prompt).evidence.map((e:{id:string})=>e.id)});
    }},access);
    task = await settled(kernel,task.id);
    assert.equal(task.status,"awaiting_answer");
    let reads = 0;
    await kernel.run(task.id,"answer",{...runInput(task),answer:"本人只参与缓存测试，不负责上线；之前的主导说法不正确。"},{runtimeFingerprint:"synthetic-runtime",reasoner:async prompt=>{
      const state=readState(prompt);
      if(reads<30)return JSON.stringify({kind:"tool",tool:"read_material",id:`m${reads++}`,offset:0,length:1000});
      assert.ok(state.evidence.some((e:{kind:string;excerpt:string})=>e.kind==="user_statement"&&e.excerpt.includes("不负责上线")),"early correction is not evicted by recent reads");
      if(reads++===30){
        const first=state.evidenceIndex.find((e:{sourceId:string})=>e.sourceId==="material:m0");
        return JSON.stringify({kind:"tool",tool:"read_evidence",id:first.id,offset:6400,length:500});
      }
      const tail=state.evidence.find((e:{excerpt:string})=>e.excerpt.includes("长行尾部"));
      assert.ok(tail,"a long single line is pageable beyond the old truncation boundary");
      assert.equal(tail.startOffset,6400);
      assert.equal(tail.sourceLength,data.materials![0]!.text.length);
      return JSON.stringify({kind:"draft",patches:[],unknowns:["上线经历被本人否认；材料为设计，不作为个人实绩。"]});
    }},access);
    task=await settled(kernel,task.id);
    assert.equal(task.status,"awaiting_review",task.error);
    assert.equal(task.usage.modelCalls,35);
    assert.ok(task.evidence.some(e=>e.excerpt.includes("长行尾部")));
  } finally { await kernel.close(); await rm(dir,{recursive:true,force:true}); }
});

test("line ranges retain exact offsets in CRLF sources",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-crlf-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    const data=input("synthetic-crlf-material");data.materials=[{id:"crlf",label:"合成换行",kind:"design",text:"alpha\r\nbeta\r\n仅设计，不投产"}];
    let task=await kernel.createTask(data,access),calls=0;
    await kernel.run(task.id,"start",runInput(task),{runtimeFingerprint:"synthetic-runtime",reasoner:async prompt=>{
      calls++;if(calls===1)return JSON.stringify({kind:"tool",tool:"read_job"});
      if(calls===2)return JSON.stringify({kind:"tool",tool:"read_resume"});
      if(calls===3)return JSON.stringify({kind:"tool",tool:"read_material",id:"crlf",startLine:3,endLine:3});
      const state=JSON.parse(prompt.split("\n\n").at(-1)!);const item=state.evidence.find((e:{sourceId:string})=>e.sourceId==="material:crlf");
      assert.equal(item.excerpt,"仅设计，不投产");assert.equal(item.startOffset,"alpha\r\nbeta\r\n".length);
      return JSON.stringify({kind:"draft",patches:[],unknowns:["仅设计。"]});
    }},access);
    task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("kernel persists every ranked passage before citation and pages omitted sources on its original ledger",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-ranked-kernel-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    const data=input("synthetic-ranked-projection");data.budget={maxModelCalls:30,maxToolCalls:30,maxActiveMs:60000};
    data.materials=Array.from({length:9},(_,i)=>({id:`m${i}`,label:`合成材料${i}`,kind:"design",text:"无关设计。".repeat(1200)+(i===8?"C# 缓存测试，尚未投产。":"其他设计。")}));
    let current=await kernel.createTask(data,access),calls=0,retrievals=0;
    await kernel.run(current.id,"start",runInput(current),{runtimeFingerprint:"synthetic-runtime",reasoner:async prompt=>{
      const state=JSON.parse(prompt.split("\n\n").at(-1)!);
      assert.equal(state.retrieval.version,"bm25-v1");assert.ok(state.retrieval.selected.length<=6);
      if(++calls===1)return JSON.stringify({kind:"tool",tool:"read_job"});
      if(calls===2)return JSON.stringify({kind:"tool",tool:"read_resume"});
      if(calls<=11)return JSON.stringify({kind:"tool",tool:"read_material",id:`m${calls-3}`});
      const persisted=await kernel.readTask(current.id);
      for(const mounted of state.evidence)assert.ok(persisted.evidence.some(item=>item.id===mounted.id&&item.excerpt===mounted.excerpt),"citation identity is durable before model observation");
      for(const mounted of state.evidence)assert.ok(state.citableEvidenceIds.includes(mounted.id),"all and only actually mounted identities enter the citation gate");
      if(retrievals++===0){
        assert.ok(state.evidence.some((item:{excerpt:string})=>item.excerpt.includes("尚未投产")),"JD-relevant long-line tail is mounted without a model search");
        assert.ok(state.evidenceManifest.length>6,"unmounted sources remain addressable");
        const hidden=state.evidenceManifest.find((item:{sourceId:string})=>item.sourceId==="material:m0");
        return JSON.stringify({kind:"tool",tool:"read_evidence",id:hidden.handle,offset:5000,length:100});
      }
      assert.ok(state.evidence.some((item:{sourceId:string;startOffset:number;excerpt:string})=>item.sourceId==="material:m0"&&item.startOffset===5000&&item.excerpt===data.materials![0]!.text.slice(5000,5100)));
      return JSON.stringify({kind:"draft",patches:[],unknowns:["设计不等于个人上线实绩。"]});
    }},access);
    current=await settled(kernel,current.id);assert.equal(current.status,"awaiting_review",current.error);
    assert.equal(current.usage.modelCalls,13);assert.equal(current.usage.toolCalls,12);
    for(const material of data.materials)assert.ok(current.evidence.some(item=>item.sourceId===`material:${material.id}`&&item.excerpt===material.text),"complete collected text stays stored alongside mounted passages");
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("an unmounted indexed source is rejected, then explicit page retrieval unlocks only the observed span",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-ranked-citations-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    const data=input("synthetic-ranked-citations");data.materials=[{id:"long",label:"合成材料",kind:"design",text:"无关设计。".repeat(1600)+"尾部仍未上线。"}];
    let current=await kernel.createTask(data,access),calls=0;
    await kernel.run(current.id,"start",runInput(current),{runtimeFingerprint:"synthetic-runtime",reasoner:async prompt=>{
      const state=JSON.parse(prompt.split("\n\n").at(-1)!);
      if(++calls===1)return JSON.stringify({kind:"tool",tool:"read_job"});
      if(calls===2)return JSON.stringify({kind:"tool",tool:"read_resume"});
      if(calls===3)return JSON.stringify({kind:"tool",tool:"read_material",id:"long"});
      if(calls===4){
        const original=state.evidenceIndex.find((item:{sourceId:string;endOffset:number})=>item.sourceId==="material:long"&&item.endOffset===data.materials![0]!.text.length);
        assert.ok(!state.citableEvidenceIds.includes(original.id));
        return JSON.stringify({kind:"ask_user",question:"索引不能冒充已读原文。",evidenceIds:[original.id]});
      }
      if(calls===5){
        assert.ok(state.recentObservations.some((item:{decisionRejected?:string})=>item.decisionRejected==="evidence_not_mounted_read_first"));
        const handle=state.evidenceManifest.find((item:{sourceId:string})=>item.sourceId==="material:long").handle;
        return JSON.stringify({kind:"tool",tool:"read_evidence",id:handle,offset:7800,length:200});
      }
      const page=state.evidence.find((item:{sourceId:string;startOffset:number})=>item.sourceId==="material:long"&&item.startOffset===7800);
      assert.ok(state.citableEvidenceIds.includes(page.id));
      return JSON.stringify({kind:"ask_user",question:"请说明本人已实现的范围。",evidenceIds:[page.id]});
    }},access);
    current=await settled(kernel,current.id);assert.equal(current.status,"awaiting_answer",current.error);
    assert.equal(current.usage.modelCalls,6);assert.equal(current.usage.toolCalls,4);
    const cited=current.evidence.find(item=>item.id===current.questionEvidenceIds![0])!;
    assert.equal(cited.startOffset,7800);assert.equal(cited.endOffset,8000);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("file edits between read and the next decision pause before stale ranked evidence reaches a model",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-ranked-stale-"));
  const source=path.join(directory,"source"),filename=path.join(source,"synthetic.cs");await mkdir(source);await writeFile(filename,"C# 缓存测试，未上线。");
  class EditedBroker extends EvidenceBroker {
    edited=false;
    override async execute(grant:UnderstandingGrant,request:EvidenceRequest,signal?:AbortSignal){
      const result=await super.execute(grant,request,signal);
      if(request.operation==="read"&&!this.edited){this.edited=true;await writeFile(filename,"源码已变化；不能复用旧片段。");}
      return result;
    }
  }
  const kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory:path.join(directory,"owner"),broker:new EditedBroker()});
  try{
    const data=input("synthetic-ranked-stale");data.directories=[{path:source,label:"合成源码"}];
    let current=await kernel.createTask(data,access),calls=0;
    await kernel.run(current.id,"start",runInput(current),{runtimeFingerprint:"synthetic-runtime",reasoner:async prompt=>{
      calls++;assert.equal(calls,1,"no subsequent send may contain the stale projection");
      const state=JSON.parse(prompt.split("\n\n").at(-1)!);
      return JSON.stringify({kind:"tool",tool:"read_file",id:state.directoryManifest[0].id,path:"synthetic.cs"});
    }},access);
    current=await settled(kernel,current.id);
    assert.equal(current.status,"paused");assert.equal(current.error,"source_changed_new_comparison_required");
    assert.equal(calls,1);assert.equal(current.usage.modelCalls,1);assert.equal(current.usage.toolCalls,2);
    assert.equal(current.evidence[0]!.excerpt,"C# 缓存测试，未上线。","original observation remains intact, not silently replaced");
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("a legacy persisted span gains hash-checked coordinates without replacing its text or citation identity",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-legacy-mount-")),source=path.join(directory,"source");
  await mkdir(source);const full="header\r\ncontext\r\nC# 缓存测试，未上线。";await writeFile(path.join(source,"legacy.cs"),full);
  const broker=new EvidenceBroker(),ownerDirectory=path.join(directory,"owner"),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory:ownerDirectory,broker});
  try{
    const data=input("synthetic-legacy-mount");data.directories=[{path:source,label:"合成源码"}];
    let current=await kernel.createTask(data,access);
    const file=path.join(ownerDirectory,`${current.id}.json`),stored=await readPrivateJson(file) as {task:CareerTask;grants:UnderstandingGrant[]};
    const observed=await observe(stored.task,stored.grants,broker,{kind:"tool",tool:"read_file",id:stored.grants[0]!.id,path:"legacy.cs",startLine:3,endLine:3},new AbortController().signal);
    const legacy=observed.evidence[0]!;delete legacy.startOffset;delete legacy.endOffset;delete legacy.sourceLength;
    stored.task.evidence=[evidence("job","job",data.job.title,[data.job.title,data.job.company,data.job.description].join("\n")),
      evidence("resume","resume:f1","f1",data.resume.fields[0]!.originalText),legacy];
    await writePrivateJson(file,stored);
    let calls=0;
    await kernel.run(current.id,"start",runInput(current),{runtimeFingerprint:"synthetic-runtime",reasoner:async prompt=>{
      const state=JSON.parse(prompt.split("\n\n").at(-1)!);
      if(++calls===1){
        assert.deepEqual(state.retrieval.coordinateRereadRequired,[legacy.id]);
        assert.ok(!state.evidence.some((item:{id:string})=>item.id===legacy.id));
        return JSON.stringify({kind:"tool",tool:"read_evidence",id:state.evidenceManifest.find((item:{sourceId:string})=>item.sourceId===legacy.sourceId).handle});
      }
      const exact=state.evidence.find((item:{id:string})=>item.id===legacy.id);
      assert.equal(exact.excerpt,legacy.excerpt);assert.equal(exact.startOffset,"header\r\ncontext\r\n".length);
      assert.equal(exact.endOffset,full.length);assert.ok(state.citableEvidenceIds.includes(legacy.id));
      return JSON.stringify({kind:"ask_user",question:"请确认本人的缓存测试职责。",evidenceIds:[legacy.id]});
    }},access);
    current=await settled(kernel,current.id);assert.equal(current.status,"awaiting_answer",current.error);
    const retained=current.evidence.filter(item=>item.id===legacy.id);assert.equal(retained.length,1);
    assert.equal(retained[0]!.excerpt,legacy.excerpt);assert.equal(retained[0]!.startOffset,"header\r\ncontext\r\n".length);
    assert.equal(current.usage.modelCalls,2);assert.equal(current.usage.toolCalls,3);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});
