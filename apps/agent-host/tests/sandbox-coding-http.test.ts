import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import type { CodingTask } from "../src/sandbox/coding-tasks.js";
import type { CodingGenerateInput } from "../src/sandbox/coding-engine.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("authenticated coding workbench: one consented model dispatch per step, real WASM checks, private review only",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-coding-http-")),token="isolated-http-fixture";
  const calls:CodingGenerateInput[]=[];
  const working=Promise.withResolvers<void>(), allow=Promise.withResolvers<void>();
  const switching=Promise.withResolvers<void>(), late=Promise.withResolvers<void>();
  const server=createAgentServer({port:0,host:"127.0.0.1",authToken:token,allowedOrigins:[],identityDirectory:path.join(directory,"identities"),
    runsDirectory:path.join(directory,"runs"),runtimeDefinitions:[],checkpointer:new MemorySaver() as never,
    sandboxCoding:{resolveModel:async()=>"a".repeat(64),generate:async input=>{
      calls.push(structuredClone(input));
      if(input.goal==="continuous"&&!input.previousSource){working.resolve();await allow.promise;}
      if(input.goal==="switch accounts"){switching.resolve();await late.promise;}
      return !input.previousSource?"function(input){return input.value}":"function(input){return Math.abs(input.value)}";
    }}});
  await once(server,"listening");const addr=server.address();assert.ok(addr&&typeof addr!=="string");
  const base=`http://127.0.0.1:${addr.port}`,prefix="/api/v1/agent/sandbox/coding/tasks";
  const request=(h:Record<string,string>,route:string,body?:unknown)=>fetch(base+route,{method:body===undefined?"GET":"POST",headers:{
    Authorization:`Bearer ${token}`,"Content-Type":"application/json",...h},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const task=async(r:Response)=>{const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data.task as CodingTask;};
  try {
    const a=await registerTestIdentity(base,token,"studio-coder-a"),b=await registerTestIdentity(base,token,"studio-coder-b");
    const contract={goal:"Return absolute value of input.value",model:"offline-fixture:1",cases:[
      {id:"positive",input:{value:4},expected:4},{id:"negative",input:{value:-3},expected:3}],maxAttempts:3,consent:true};
    assert.equal((await request({},prefix)).status,401);
    assert.equal((await request({...a.headers,Origin:"https://unauthorized.example"},prefix,contract)).status,403);
    assert.equal((await request(a.headers,prefix,{...contract,source:"untrusted",passes:true})).status,400);
    let t=await task(await request(a.headers,prefix,contract));const at=prefix+"/"+t.id;
    assert.equal(t.status,"ready");assert.equal(calls.length,0);
    assert.equal((await request(b.headers,at)).status,404);
    assert.deepEqual((await (await request(b.headers,prefix)).json()).tasks,[]);
    assert.equal((await request(a.headers,at+"/step",{expectedRevision:t.revision,consent:false})).status,400);
    const initial=t.revision;t=await task(await request(a.headers,at+"/step",{expectedRevision:initial,consent:true}));
    assert.equal(t.best?.checks.filter(c=>c.passed).length,1);
    assert.equal((await request(a.headers,at+"/step",{expectedRevision:initial,consent:true})).status,409);
    assert.equal((await task(await request(a.headers,at))).attemptsUsed,1);
    t=await task(await request(a.headers,at+"/step",{expectedRevision:t.revision,consent:true}));
    assert.equal(t.status,"review_ready");assert.equal(calls.length,2);assert.equal(calls[1]!.targetCaseId,"negative");
    assert.ok(calls[1]!.previousSource?.includes("input.value"));assert.ok(t.best?.checks.every(c=>c.passed));
    const list=await (await request(a.headers,prefix)).json();assert.equal(list.tasks[0].id,t.id);
    assert.equal("cases" in list.tasks[0],false);assert.equal("best" in list.tasks[0],false);
    let cont=await task(await request(a.headers,prefix,{...contract,goal:"continuous"}));
    const contAt=prefix+"/"+cont.id,cmd={consent:true,expectedRevision:cont.revision};
    assert.equal((await request(a.headers,contAt+"/run",cmd)).status,202);await working.promise;
    assert.equal((await request(a.headers,contAt+"/run",cmd)).status,409);
    assert.equal((await request(a.headers,contAt+"/step",cmd)).status,409);
    assert.equal((await (await request(a.headers,contAt)).json()).task.autoRunning,true);
    assert.equal(calls.length,3);allow.resolve();
    for(let i=0;i<200;i++){cont=await task(await request(a.headers,contAt));if(cont.status==="review_ready")break;await delay(20);}
    assert.equal(cont.status,"review_ready");assert.equal(cont.attemptsUsed,2);assert.equal(calls.length,4);
    const pending=await task(await request(a.headers,prefix,{...contract,goal:"switch accounts"})), pendingAt=prefix+"/"+pending.id;
    assert.equal((await request(a.headers,pendingAt+"/run",{expectedRevision:pending.revision,consent:true})).status,202);await switching.promise;
    const switched=await request(a.headers,"/api/v1/agent/identity/sign-in",{username:b.principal.username,password:"synthetic-only-password-2026"});
    late.resolve();assert.equal(switched.status,200);assert.equal((await request(a.headers,at)).status,403);
    const again=await request({Cookie:switched.headers.getSetCookie()[0]!.split(";")[0]!},"/api/v1/agent/identity/sign-in",{username:a.principal.username,password:"synthetic-only-password-2026"});
    const back={...a.headers,Cookie:again.headers.getSetCookie()[0]!.split(";")[0]!};
    let stopped:CodingTask;for(let i=0;;i++){stopped=await task(await request(back,pendingAt));if(stopped.status!=="running"||i>=100)break;await delay(10);}
    assert.equal(stopped.status,"paused");assert.equal(stopped.best,undefined);assert.equal(calls.length,5);
  } finally {allow.resolve();late.resolve();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}
});
