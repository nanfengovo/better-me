import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTaskCreateSchema,type FreeChatTask } from "@better-me/agent-contracts";
import { AgentTaskKernel,type CareerTaskRuntime } from "../../../agent-host/src/kernel/service.js";
import { activatePrincipal,currentPrincipal } from "../../src/lib/identity";

export const chatOwner={id:"11111111-1111-4111-8111-111111111111",username:"synthetic-chat",displayName:"Synthetic chat"};
/** Real kernel/persistence, no model/provider/network. Strict fake transport at the HTTP seam. */
export async function chatHost(t:TestContext,reasoner:CareerTaskRuntime["reasoner"]){
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-web-chat-task-")),kernel=new AgentTaskKernel({ownerId:chatOwner.id,directory});
  activatePrincipal(chatOwner);const requests:{path:string;body?:Record<string,unknown>}[]=[],access={session:"synthetic-browser",valid:async()=>currentPrincipal()?.id===chatOwner.id};
  const fetcher:typeof fetch=async(url,init)=>{
    const pathname=new URL(String(url)).pathname;assert.ok(pathname.startsWith("/api/v1/agent/tasks"),`unexpected transport ${pathname}`);
    assert.equal(new Headers(init?.headers).get("x-betterme-owner"),chatOwner.id);
    const body=init?.body?JSON.parse(String(init.body)):undefined,route=pathname.slice("/api/v1/agent/tasks".length);requests.push({path:pathname,body});
    try{
      if(route==="")return Response.json(init?.method==="POST"?{task:await kernel.createTask(AgentTaskCreateSchema.parse(body),access)}:{tasks:await kernel.listTasks()});
      const [,id,action]=route.split("/");if(!id)throw Error("invalid test route");
      if(!action)return Response.json({task:await kernel.readTask(id)});
      if(action==="pause")return Response.json({task:await kernel.stop(id,body.expectedRevision,false,access)});
      assert.ok(action==="start"||action==="answer"||action==="resume");
      const {runtime:_,...command}=body;
      const task=await kernel.run(id,action,command as Parameters<typeof kernel.run>[2],{reasoner,runtimeFingerprint:"synthetic-model-generation",supportsImages:true},access);return Response.json({task},{status:202});
    }catch(error){const e=error as {code?:string;status?:number};return Response.json({error:e.code??"fixture_error"},{status:e.status??500});}
  };
  t.mock.method(globalThis,"fetch",fetcher);
  t.after(async()=>{activatePrincipal(undefined);await kernel.close();await rm(directory,{recursive:true,force:true});});
  const task=async()=>{const all=await kernel.listTasks();assert.equal(all.length,1);return all[0] as FreeChatTask;};
  return {kernel,requests,fetch:fetcher,task};
}
