import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { careerRuntimeBinding, makeInventorySource, inventoryKey } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("owner-only inventory API resumes read-only; optional interviewer charges one bounded kernel call and cannot approve a statement",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"betterme-inventory-api-")), token="synthetic-inventory-only";
  let calls=0;
  const host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(dir,"accounts"),runsDirectory:path.join(dir,"runs"),understandingDirectory:path.join(dir,"understanding"),checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>async(prompt,_sig,phase)=>{calls++;assert.equal(phase,"career_inventory");assert.match(prompt,/测试回放器/);assert.doesNotMatch(prompt,/PRIVATE_RAW_SENTINEL/);
      return JSON.stringify({question:"你在测试回放器里亲自验证了哪一步？"});}});
  try{
    await once(host,"listening");const addr=host.address();assert.ok(addr && typeof addr!=="string");const origin="http://127.0.0.1:"+addr.port;
    const a=await registerTestIdentity(origin,token,"inventory-anna"), b=await registerTestIdentity(origin,token,"inventory-bob");
    const call=(headers:Record<string,string>,suffix:string,body?:unknown)=>fetch(origin+"/api/v1/agent"+suffix,{method:body===undefined?"GET":"POST",headers:{...headers,Authorization:"Bearer "+token,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const source=makeInventorySource({documentId:"d",resumeId:"v",groups:[]}), url="/inventory/sessions/"+inventoryKey(source);
    assert.equal((await call({},"/inventory/profile")).status,401);
    const opened=await (await call(a.headers,"/inventory/start",source)).json();assert.equal(opened.ownerId,a.principal.id);
    assert.equal((await (await call(b.headers,url)).json()).view,null);
    const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic",baseUrl:"http://127.0.0.1:1/v1",apiKey:""}},runtimeBinding=careerRuntimeBinding(runtime);
    const payload={kind:"career_inventory",workspaceKey:"inventory-http",rootScopeKey:"d",objective:"提一个盘点追问",runtimeBinding,consent:true,idempotencyKey:randomUUID(),
      request:{sessionId:opened.view.session.id,revision:1,target:"current",prompt:"现在在做什么？",priorAnswer:"测试回放器"}};
    const created=await call(a.headers,"/tasks",payload);assert.equal(created.status,201,await created.clone().text());
    let task=(await created.json()).task;assert.equal(calls,0);
    assert.equal((await call(a.headers,"/tasks/"+task.id+"/start",{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding,runtime,consent:true})).status,202);
    for(let i=0;i<150 && task.status!=="completed";i++){await new Promise(r=>setTimeout(r,15));task=(await(await call(a.headers,"/tasks/"+task.id)).json()).task;}
    assert.equal(task.result?.question,"你在测试回放器里亲自验证了哪一步？");assert.equal(task.usage.modelCalls,1);assert.equal(task.usage.toolCalls,0);
    assert.equal((await call(b.headers,"/tasks/"+task.id)).status,404);
    assert.deepEqual((await(await call(a.headers,url)).json()).view,opened.view);assert.equal(calls,1);
  }finally{await new Promise<void>(r=>{host.close(()=>r());host.closeIdleConnections();});await rm(dir,{recursive:true,force:true});}
});
