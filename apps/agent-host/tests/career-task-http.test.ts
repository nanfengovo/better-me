import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySaver } from "@langchain/langgraph";
import { careerRuntimeBinding, CareerTaskSchema, type CareerTask, type CareerTaskEvidence, type UnderstandingReasoner } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("authenticated main-task HTTP detaches from its browser, fences owners, and restart requires a manual grant",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"betterme-career-task-http-"));
  const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,baseUrl:"http://127.0.0.1:11434/v1",model:"fixture-only",apiKey:"SYNTHETIC-DO-NOT-PERSIST-CAREER"}};
  const runtimeBinding=careerRuntimeBinding(runtime),targetRef={kind:"profile_headline",locale:"zh"};
  const create=(idempotencyKey:string)=>({idempotencyKey,workspaceKey:"synthetic",objective:"准备岗位版本",consent:true,runtimeBinding,
    job:{id:"job-a",title:"合成岗位",company:"合成公司",description:"需要缓存测试。"},resume:{id:"r1",name:"合成简历",sourceFingerprint:"doc-version-1",fields:[{id:"f",targetRef,originalText:"维护缓存测试。"}]}});
  const command=(task:CareerTask)=>({expectedRevision:task.revision,sourceFingerprint:task.resume.sourceFingerprint,consent:true,runtimeBinding,runtime});
  let server:http.Server|undefined,base="",calls=0;
  const entered=Promise.withResolvers<void>(),work=Promise.withResolvers<void>(),hanging=Promise.withResolvers<void>(),late=Promise.withResolvers<void>();
  const delegate:UnderstandingReasoner=async p=>{
    calls++;if(calls===1){entered.resolve();await work.promise;}if(calls===4){hanging.resolve();await late.promise;}
    const state=JSON.parse(p.split("\n\n").at(-1)!) as {evidence:CareerTaskEvidence[]};
    if(!state.evidence.some(e=>e.kind==="job"))return JSON.stringify({kind:"tool",tool:"read_job"});
    if(!state.evidence.some(e=>e.kind==="resume"))return JSON.stringify({kind:"tool",tool:"read_resume",id:"f"});
    return JSON.stringify({kind:"draft",patches:[{fieldId:"f",targetRef,originalText:"维护缓存测试。",proposedText:"维护缓存模块的测试。",evidenceIds:state.evidence.map(x=>x.id),rationale:"岗位关注点。"}],unknowns:["上线状态未知"]});
  };
  const open=async()=>{
    server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-career-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(dir,"accounts"),
      runsDirectory:path.join(dir,"runs"),understandingDirectory:path.join(dir,"understanding"),checkpointer:new MemorySaver() as never,careerTaskReasoner:async()=>delegate});
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");base=`http://127.0.0.1:${address.port}`;
  };
  const shut=async()=>{if(!server)return;const current=server;server=undefined;await new Promise<void>(r=>current.close(()=>r()));};
  const headers=(h:Record<string,string>)=>({...h,Authorization:"Bearer synthetic-career-token","Content-Type":"application/json"});
  const call=(h:Record<string,string>,route:string,body?:unknown)=>fetch(base+"/api/v1/agent/career-tasks"+route,{method:body===undefined?"GET":"POST",headers:headers(h),...(body===undefined?{}:{body:JSON.stringify(body)})});
  const task=async(response:Response)=>{const body=await response.json();assert.ok(response.ok,JSON.stringify(body));return CareerTaskSchema.parse(body.task);};
  const poll=async(h:Record<string,string>,id:string)=>{for(let i=0;i<160;i++){const res=await call(h,`/${id}`);if(res.status===503){await delay(8);continue;}const t=await task(res);if(t.status!=="running")return t;await delay(8);}throw Error("synthetic HTTP run did not settle");};
  const observer=new http.Agent({keepAlive:true});
  try{
    await open();const a=await registerTestIdentity(base,"synthetic-career-token","career-alice"),b=await registerTestIdentity(base,"synthetic-career-token","career-bob");
    assert.equal((await call({},"")).status,401);
    let t=await task(await call(a.headers,"",create("observer-isolated-1")));assert.equal(t.ownerId,a.principal.id);
    const unified=base+`/api/v1/agent/tasks/${t.id}`;
    const library=await fetch(base+"/api/v1/agent/tasks/tools",{headers:headers(a.headers)});assert.equal(library.status,200);assert.deepEqual((await library.json()).tools,[]);
    assert.equal((await task(await fetch(unified,{headers:headers(a.headers)}))).id,t.id,"new and legacy namespaces share the exact stored task");
    assert.equal((await fetch(unified,{headers:headers(b.headers)})).status,404);
    const feed=await (await fetch(unified+"/events?after=0",{headers:headers(a.headers)})).json();
    assert.equal(feed.taskId,t.id);assert.ok(feed.events.some((e:{kind:string})=>e.kind==="created"));
    assert.deepEqual((await (await fetch(unified+`/events?after=${feed.cursor}`,{headers:headers(a.headers)})).json()).events,[]);
    assert.equal((await call(b.headers,`/${t.id}`)).status,404);assert.deepEqual((await (await call(b.headers,"")).json()).tasks,[]);
    const started=await new Promise<number|undefined>((resolve,reject)=>{const req=http.request(base+`/api/v1/agent/career-tasks/${t.id}/start`,{agent:observer,method:"POST",headers:headers(a.headers)},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);req.end(JSON.stringify(command(t)));});
    assert.equal(started,202);await entered.promise;
    assert.equal((await fetch(unified+"/start",{method:"POST",headers:headers(a.headers),body:JSON.stringify(command(t))})).status,409,"another entry cannot launch a second turn");
    observer.destroy();work.resolve();
    t=await poll(a.headers,t.id);assert.equal(t.status,"awaiting_review");assert.equal(t.draft?.patches.length,1);assert.equal(calls,3);
    assert.equal((await call(b.headers,`/${t.id}/receipt`,{expectedRevision:t.revision,draftHash:t.draft!.hash,versionId:"forged",approvedPatchIds:[t.draft!.patches[0]!.id]})).status,404);
    assert.equal((await task(await call(a.headers,`/${t.id}`))).receipt,undefined);
    const stored=await readFile(path.join(dir,"accounts","owners",a.principal.id,"career-tasks-v1",`${t.id}.json`),"utf8");assert.ok(!stored.includes(runtime.modelSettings.apiKey));assert.ok(!stored.includes(runtime.modelSettings.baseUrl));
    let t2=await task(await call(a.headers,"",create("restart-isolated-2")));assert.equal((await call(a.headers,`/${t2.id}/start`,command(t2))).status,202);
    await hanging.promise;await shut();await open();t2=await poll(a.headers,t2.id);assert.equal(t2.status,"interrupted");assert.equal(t2.usage.modelCalls,1);assert.equal(calls,4);
    late.resolve();await delay(15);assert.equal((await task(await call(a.headers,`/${t2.id}`))).evidence.length,0);
    assert.equal((await call(a.headers,`/${t2.id}/resume`,{...command(t2),consent:false})).status,400);
    assert.equal((await call(a.headers,`/${t2.id}/resume`,{...command(t2),sourceFingerprint:"changed-doc"})).status,409);
    assert.equal((await call(a.headers,`/${t2.id}/resume`,command(t2))).status,202);
    t2=await poll(a.headers,t2.id);assert.equal(t2.status,"awaiting_review");assert.equal(t2.usage.modelCalls,4);assert.equal(calls,7);
  }finally{work.resolve();late.resolve();observer.destroy();await shut();await delay(25);await rm(dir,{recursive:true,force:true});}
});
