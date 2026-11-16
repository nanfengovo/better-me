import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { careerRuntimeBinding } from "@better-me/agent-contracts";
import { CareerTaskService, CareerTaskError } from "../src/tasks/service.js";
import { RejectedTaskModelOutput } from "../src/kernel/model-protocol.js";

for(const mode of ["returned","fenced"] as const)test(`text ${mode} late response remains private after pause, without adopting or replaying`,async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-text-late-")),service=new CareerTaskService({ownerId:"synthetic",directory});
  const binding=careerRuntimeBinding({kind:"model",modelSettings:{provider:"ollama",model:"fixture",baseUrl:"http://127.0.0.1:1/v1"}}),access={session:"synthetic",valid:async()=>true};
  const entered=Promise.withResolvers<void>(),done=Promise.withResolvers<void>(),output="  完整迟到文本😀\r\n"+"合成完整输出，不得裁剪或采用。".repeat(300)+"\r\nTAIL  ";let calls=0;
  try{
    let task=await service.create({workflow:"text_v1",workspaceKey:"synthetic",idempotencyKey:`synthetic-late-${mode}`,objective:"合成暂停边界",consent:true,runtimeBinding:binding,budget:{maxModelCalls:2,maxToolCalls:1,maxActiveMs:300000},job:{title:"合成岗位",company:"",description:"缓存测试。"},resume:{id:"r",name:"合成",sourceFingerprint:"s1",fields:[{id:"f",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"维护缓存测试。"}]}},access);
    task=await service.run(task.id,"start",{expectedRevision:task.revision,sourceFingerprint:task.resume.sourceFingerprint,runtimeBinding:binding,consent:true},{runtimeFingerprint:"fixture",reasoner:async()=>{calls++;entered.resolve();await done.promise;if(mode==="fenced")throw new RejectedTaskModelOutput({text:output,finishReason:"stop"},new CareerTaskError("stale_task_turn"));return {text:output,finishReason:"stop"};}},access);
    await entered.promise;task=await service.stop(task.id,task.revision);done.resolve();
    let archived=false;
    for(let i=0;i<200;i++){const stored=JSON.parse(await readFile(path.join(directory,`${task.id}.json`),"utf8"));if(stored.recent.some((row:{output?:string;late?:boolean})=>row.output===output&&row.late===true)){archived=true;break;}await delay(10);}
    assert.equal(archived,true,"complete already-returned wire must remain in the original owner's private journal");
    for(let i=0;i<3;i++)task=await service.get(task.id);
    assert.equal(task.status,"paused");assert.equal(task.writingPlan,undefined);assert.equal(task.draft,undefined);assert.equal(task.usage.modelCalls,1);assert.equal(calls,1);assert.ok(!JSON.stringify(task).includes("TAIL"));
  }finally{done.resolve();await service.close();}
});
