import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySaver } from "@langchain/langgraph";
import { CareerTaskSchema, careerRuntimeBinding, type CareerTask } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("text writing uses two explicit task turns, confirms the exact plan, and restart/read/repeated commands never redispatch", { timeout: 60_000 }, async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"betterme-text-http-"));
  let calls=0;
  const provider=http.createServer(async(req,res)=>{
    let bytes=""; for await(const chunk of req)bytes+=chunk;
    const body=JSON.parse(bytes),prompt=body.messages.at(-1).content;
    const state=JSON.parse(prompt.split("\n\n").at(-1));
    calls++;
    const own=state.evidence.find((e:{sourceId:string})=>e.sourceId==="resume:f");
    const omitted=state.evidence.find((e:{sourceId:string})=>e.sourceId==="resume:g");
    const output=state.writingPhase==="plan"?{kind:"material_plan",selections:[
      {fieldId:"f",include:true,reason:"缓存测试与岗位直接相关。",evidenceIds:[own.id]},
      {fieldId:"g",include:false,reason:"旧资料未体现本岗位关注点，保留原稿不删除。",evidenceIds:[omitted.id]},
    ],questions:[{id:"q1",fieldId:"f",question:"缓存测试中你实际补了什么？没有记录的指标可以说未知。",evidenceIds:[own.id]}]}:
      {kind:"draft",patches:[{fieldId:"f",targetRef:state.resume.fields[0].targetRef,originalText:"维护缓存测试。",proposedText:"维护缓存测试并补充异常分支。",evidenceIds:[own.id,...state.evidence.filter((e:{sourceId:string})=>e.sourceId.startsWith("answer:")).map((e:{id:string})=>e.id)],rationale:"仅采用已确认的实际补充。"}],unknowns:["耗时和上线指标未知，不填写数字。"]};
    const usage=state.writingPhase==="plan"?{prompt_tokens:37,completion_tokens:11,total_tokens:48}:undefined;
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id:"text-fixture",object:"chat.completion",model:body.model,usage,choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:JSON.stringify(output)}}]}));
  });
  provider.listen(0,"127.0.0.1");await once(provider,"listening");const pa=provider.address();assert.ok(pa&&typeof pa!=="string");
  const runtime={kind:"model" as const,modelSettings:{provider:"custom" as const,model:"text-fixture",baseUrl:`http://127.0.0.1:${pa.port}/v1`,apiKey:"SYNTHETIC-TEXT-KEY-NEVER-SAVE"}},runtimeBinding=careerRuntimeBinding(runtime);
  let server:http.Server|undefined,base="";
  const open=async()=>{server=createAgentServer({host:"127.0.0.1",port:0,authToken:"text-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"accounts"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never});await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");base=`http://127.0.0.1:${address.port}`;};
  const close=async()=>{if(server){const current=server;server=undefined;await new Promise<void>(resolve=>current.close(()=>resolve()));}};
  let identity:Awaited<ReturnType<typeof registerTestIdentity>>;
  const call=(route:string,body?:unknown)=>fetch(`${base}/api/v1/agent/tasks${route}`,{method:body===undefined?"GET":"POST",headers:{...identity.headers,Authorization:"Bearer text-token","Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const task=async(res:Response)=>{const body=await res.json();assert.ok(res.ok,JSON.stringify(body));return CareerTaskSchema.parse(body.task);};
  const poll=async(id:string)=>{for(let n=0;n<100;n++){const t=await task(await call(`/${id}`));if(t.status!=="running")return t;await delay(20);}throw Error("text fixture did not settle");};
  const command=(t:CareerTask)=>({expectedRevision:t.revision,sourceFingerprint:t.resume.sourceFingerprint,runtimeBinding,runtime,consent:true});
  try{
    await open();identity=await registerTestIdentity(base,"text-token","text-only-synthetic");
    const input={workflow:"text_v1",idempotencyKey:"text-loop-stable-command-1",workspaceKey:"synthetic-text",objective:"先选材与追问，确认后成稿。",runtimeBinding,consent:true,budget:{maxModelCalls:2,maxToolCalls:1,maxActiveMs:300000},job:{title:"合成测试岗位",company:"",description:"缓存测试与异常分支。"},resume:{id:"synthetic-r",name:"合成简历",sourceFingerprint:"synthetic-version-1",fields:[{id:"f",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"维护缓存测试。"},{id:"g",targetRef:{kind:"claim_text",experienceId:"synthetic-e",claimId:"synthetic-c",locale:"zh"},originalText:"整理旧资料。"}]}};
    let t=await task(await call("",input));assert.equal(calls,0);
    assert.equal((await call(`/${t.id}/start`,command(t))).status,202);t=await poll(t.id);
    assert.equal(t.status,"awaiting_answer");assert.equal(calls,1);assert.ok(t.writingPlan?.hash);assert.equal(t.writingPlan?.selections.length,2);assert.equal(t.draft,undefined);
    await close();await open();for(let n=0;n<3;n++)t=await task(await call(`/${t.id}`));assert.equal(calls,1);
    const confirmation={planHash:t.writingPlan!.hash,selectedFieldIds:["f"],answers:[{questionId:"q1",text:"我维护缓存测试并补充异常分支，耗时与上线指标未知。"}],confirmed:true};
    assert.equal((await call(`/${t.id}/answer`,{...command(t),answer:JSON.stringify({...confirmation,planHash:"stale"})})).status,422);assert.equal(calls,1);
    assert.equal((await call(`/${t.id}/answer`,{...command(t),answer:JSON.stringify({...confirmation,confirmed:false})})).status,422);assert.equal(calls,1);
    const grant={...command(t),answer:JSON.stringify(confirmation)};
    assert.equal((await call(`/${t.id}/answer`,grant)).status,202);assert.equal((await call(`/${t.id}/answer`,grant)).status,409);
    t=await poll(t.id);assert.equal(t.status,"awaiting_review");assert.equal(t.draft?.patches.length,1);assert.equal(t.writingConfirmation?.answers[0]?.text,confirmation.answers[0]!.text);assert.equal(calls,2);
    const receipt={expectedRevision:t.revision,draftHash:t.draft!.hash,versionId:"synthetic-edition-1",receiptId:"synthetic-receipt-1",approvedPatchIds:t.draft!.patches.map(p=>p.id)};
    t=await task(await call(`/${t.id}/receipt`,receipt));assert.equal(t.status,"completed");assert.equal((await task(await call(`/${t.id}/receipt`,receipt))).receipt?.versionId,receipt.versionId);
    await close();await open();assert.equal((await task(await call(`/${t.id}`))).status,"completed");assert.equal(calls,2);
    const raw=await fs.readFile(path.join(directory,"accounts","owners",identity.principal.id,"career-tasks-v1",`${t.id}.json`),"utf8");assert.ok(!raw.includes(runtime.modelSettings.apiKey));
    const rows=JSON.parse(raw).recent.filter((r:{writingPhase?:string})=>r.writingPhase);
    assert.deepEqual(rows.map((r:{providerCallOrdinal:number})=>r.providerCallOrdinal),[1,2]);
    assert.deepEqual(rows.map((r:{writingPhase:string})=>r.writingPhase),["resume_text_plan","resume_text_draft"]);
    const timings=rows.map((r:{providerObservation:{wallMs:number}})=>r.providerObservation.wallMs);
    assert.ok(timings.every((ms:number)=>Number.isSafeInteger(ms)&&ms>=0));
    assert.deepEqual(rows.map((r:{providerObservation:unknown})=>r.providerObservation),[
      {wallMs:timings[0],inputTokens:37,outputTokens:11},{wallMs:timings[1]},
    ]);
    assert.doesNotMatch(JSON.stringify(t),/providerObservation|providerCallOrdinal/);
  }finally{await close();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});
