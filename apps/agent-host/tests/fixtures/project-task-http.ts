import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {careerRuntimeBinding,ProjectUnderstandingTaskSchema,UnderstandingCreateSchema,type UnderstandingSession} from "@better-me/agent-contracts";
import type {UnderstandingRuntime} from "../../src/understanding/http.js";

type Request=(route:string,body?:unknown,method?:string)=>Promise<Response>;
/** Test callers use the real task HTTP interface; no legacy handler or executor is invoked. */
export function projectTaskHttp(request:Request){
  async function task(id:string){const response=await request(`/tasks/${id}`);assert.equal(response.status,200,await response.clone().text());return ProjectUnderstandingTaskSchema.parse((await response.json()).task);}
  async function sessionResponse(response:Response){
    if(!response.ok)return response;
    const value=ProjectUnderstandingTaskSchema.parse((await response.json()).task);
    return Response.json(value.project,{status:response.status});
  }
  return {
    task,
    async create(input:z.input<typeof UnderstandingCreateSchema>,runtime:UnderstandingRuntime,preferredRuntimeId?:string){
      const {workspaceKey,...project}=input;
      const response=await request("/tasks",{kind:"project_understanding",workspaceKey,project,objective:"合成项目协议回归；不推断个人贡献。",runtimeBinding:careerRuntimeBinding(runtime,preferredRuntimeId),consent:true,idempotencyKey:`http-project:${randomUUID()}`});
      assert.equal(response.status,201,await response.clone().text());return ProjectUnderstandingTaskSchema.parse((await response.json()).task).project;
    },
    get:async(id:string)=>sessionResponse(await request(`/tasks/${id}`)),
    async start(id:string,input:{runtime:UnderstandingRuntime;expectedRevision:number;[key:string]:unknown}){
      const current=await task(id),{runtime,...projectTurn}=input,op=current.status==="ready"?"start":current.status==="awaiting_answer"?"answer":"resume";
      return sessionResponse(await request(`/tasks/${id}/${op}`,{expectedRevision:input.expectedRevision,sourceFingerprint:current.sourceFingerprint,runtimeBinding:current.runtimeBinding,consent:true,projectTurn,runtime}));
    },
    mutate:async(id:string,op:string,input:unknown)=>sessionResponse(await request(`/tasks/${id}/project/${op}`,input)),
    async settled(id:string):Promise<UnderstandingSession>{
      for(let i=0;i<400;i++){const value=await task(id);if(value.status!=="running")return value.project;await new Promise(resolve=>setTimeout(resolve,5));}
      throw Error("Synthetic project task did not settle");
    },
  };
}
