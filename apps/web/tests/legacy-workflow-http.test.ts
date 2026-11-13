import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {seedLegacyCareer} from "../../agent-host/tests/fixtures/legacy-career";
import {createAgentServer} from "../../agent-host/src/server";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {activatePrincipal} from "../src/lib/identity";
import {getLegacyCareerWorkflow,startCareerWorkflow,resumeCareerWorkflow} from "../src/services/agent-client";

test("production legacy reader uses authenticated GET only, keeps full pending/approved records and rejects cross-owner or late switched reads",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-legacy-workflow-http-")),checkpointer=new MemorySaver(),original=globalThis.fetch;
  let external=0,model=0;const wire:{path:string;method:string}[]=[];
  const server=createAgentServer({host:"127.0.0.1",port:0,authToken:"better-me-agent-token",allowedOrigins:[],identityDirectory:directory,runtimeDefinitions:[],checkpointer:checkpointer as never,careerTaskReasoner:async()=>async()=>{model++;throw Error("history cannot dispatch");}});
  await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  const a=await registerTestIdentity(base,"better-me-agent-token","legacy-reader-a"),b=await registerTestIdentity(base,"better-me-agent-token","legacy-reader-b");
  const full="  合成历史😀\r\n"+"不推断个人贡献。".repeat(8000)+"HISTORY-END  ";
  const pending=await seedLegacyCareer(checkpointer,a.principal.id,"same-thread",full),approved=await seedLegacyCareer(checkpointer,a.principal.id,"approved-thread",full,true);
  const unowned=await seedLegacyCareer(checkpointer,null,"unowned-thread","UNOWNED-MUST-NOT-BE-CLAIMED"),unownedBefore=JSON.stringify(unowned.tuple);
  const before=JSON.stringify([await checkpointer.getTuple(pending.config),await checkpointer.getTuple(approved.config)]);
  let account=a,gate:Promise<void>|undefined;activatePrincipal(a.principal);
  globalThis.fetch=async(url,init)=>{
    if(!String(url).startsWith(base+"/")){external++;throw Error("outside synthetic Host");}
    const headers=new Headers(init?.headers);headers.set("Cookie",account.headers.Cookie!);wire.push({path:new URL(String(url)).pathname,method:init?.method??"GET"});
    const result=await original(url,{...init,headers});if(gate)await gate;return result;
  };
  try{
    for(const threadId of ["same-thread","approved-thread"]){const record=await getLegacyCareerWorkflow({baseUrl:base,threadId});assert.equal(record.state.task,full);assert.equal(record.readOnly,true);assert.equal(record.legacy,true);}
    assert.equal(model,0);assert.equal(external,0);assert.equal(wire.length,2);assert.ok(wire.every(row=>row.method==="GET"));
    await assert.rejects(startCareerWorkflow({threadId:"same-thread",task:full,baseUrl:base}),/旧职业工作流/);
    await assert.rejects(resumeCareerWorkflow({threadId:"same-thread",baseUrl:base,approval:{status:"approved",actorScope:a.principal.id,idempotencyKey:"never-dispatch"}}),/旧职业工作流/);assert.equal(wire.length,2);
    await assert.rejects(getLegacyCareerWorkflow({baseUrl:base,threadId:"unowned-thread"}),error=>error instanceof Error&&"code" in error&&error.code==="thread_not_found");
    account=b;activatePrincipal(b.principal);await assert.rejects(getLegacyCareerWorkflow({baseUrl:base,threadId:"same-thread"}),error=>error instanceof Error&&"code" in error&&error.code==="thread_not_found");
    account=a;activatePrincipal(a.principal);const hold=Promise.withResolvers<void>();gate=hold.promise;
    const late=getLegacyCareerWorkflow({baseUrl:base,threadId:"same-thread"});const failure=assert.rejects(late,/账号|身份/);
    await new Promise(resolve=>setTimeout(resolve,10));activatePrincipal(b.principal);hold.resolve();await failure;gate=undefined;
    assert.equal(JSON.stringify([await checkpointer.getTuple(pending.config),await checkpointer.getTuple(approved.config)]),before);assert.equal(model,0);assert.equal(external,0);
    assert.equal(JSON.stringify(await checkpointer.getTuple(unowned.config)),unownedBefore);
  }finally{globalThis.fetch=original;activatePrincipal(undefined);await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});
