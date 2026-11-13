import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {createAgentServer} from "../../agent-host/src/server";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {createFreeChatTaskClient} from "../src/services/free-chat-task-client";
import {activatePrincipal} from "../src/lib/identity";

test("production Web client and real authenticated HTTP kernel complete two image turns on the same task",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-web-chat-http-"));let server:http.Server|undefined,calls=0,adapterBuilds=0;const wire:{path:string;method?:string}[]=[];
  const image={name:"synthetic.png",mimeType:"image/png",dataUrl:"data:image/png;base64,AAAA"};
  try{
    server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-web-chat-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
      careerTaskReasoner:async()=>{adapterBuilds++;return async(prompt,signal,phase,images)=>{signal.throwIfAborted();calls++;assert.equal(phase,"free_chat");assert.equal(images?.[0]?.dataUrl,image.dataUrl);assert.ok(prompt.includes("EARLY-END"));return {text:JSON.stringify({kind:"reply",content:`完整回答 ${calls}。`}),finishReason:"stop"};};}});
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
    const identity=await registerTestIdentity(base,"synthetic-web-chat-token","web-chat-owner");activatePrincipal(identity.principal);
    const client=createFreeChatTaskClient({baseUrl:base,pollMs:5,fetch:async(url,init)=>{wire.push({path:new URL(String(url)).pathname,method:init?.method});const headers=new Headers(init?.headers);for(const [key,value] of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization","Bearer synthetic-web-chat-token");return fetch(url,{...init,headers});}});
    const runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic",baseUrl:"http://127.0.0.1:1/v1"}},user={id:"web-u1",role:"user" as const,content:"本人边界。".repeat(3000)+"EARLY-END",attachments:[image]};
    const first=await client.send({workspaceKey:"advisor:isolated-http",messages:[user],runtime});
    const second=await client.send({workspaceKey:"advisor:isolated-http",messages:[user,{...first,meta:undefined},{id:"web-u2",role:"user",content:"继续，不编造。"}],runtime});
    assert.equal(first.meta?.taskId,second.meta?.taskId);const task=await client.get(second.meta!.taskId!);assert.equal(task.usage.modelCalls,2);assert.equal(task.turn,2);assert.equal(task.conversation.messages.length,4);assert.equal(calls,2);assert.equal(adapterBuilds,1,"both authenticated turns use the same owner runtime adapter");
    assert.ok(wire.every(row=>row.path.startsWith("/api/v1/agent/tasks")));assert.equal(wire.filter(row=>row.path==="/api/v1/agent/tasks"&&row.method==="POST").length,1);
    await client.send({workspaceKey:"advisor:isolated-http",messages:[user,first,{id:"web-u2",role:"user",content:"继续，不编造。"}],runtime});assert.equal(calls,2,"same message reconnect is read-only");
  }finally{activatePrincipal(undefined);if(server){const current=server;await new Promise<void>(resolve=>current.close(()=>resolve()));}await rm(directory,{recursive:true,force:true});}
});
