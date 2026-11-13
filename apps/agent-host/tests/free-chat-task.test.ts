import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { careerRuntimeBinding, FreeChatTaskCreateSchema, isCareerTask, type FreeChatTask, type FreeChatTaskCreate } from "@better-me/agent-contracts";
import { AgentTaskKernel, type CareerTaskRuntime } from "../src/kernel/service.js";
import { readPrivateJson } from "../src/identity/private-json.js";

const access={session:"synthetic-chat-session",valid:async()=>true};
const binding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const input=(key="synthetic-free-chat-1"):FreeChatTaskCreate=>({kind:"free_chat",workspaceKey:"synthetic-conversation",objective:"讨论职业方向，不写入简历。",runtimeBinding:binding,consent:true,idempotencyKey:key,
  conversation:{messages:[{id:"user-1",role:"user",content:"我只参与缓存测试，不负责上线。请帮我梳理如何表达。"}]}});
const command=(task:FreeChatTask)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,consent:true as const});
async function read(kernel:AgentTaskKernel,id:string){const task=await kernel.readTask(id);assert.ok(!isCareerTask(task));return task;}
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<300;i++){const task=await read(kernel,id);if(task.status!=="running")return task;await delay(5);}throw Error("synthetic chat did not settle");}
const reply=(content="先保留参与测试的职责，缺少结果时先补充可观察行为。")=>JSON.stringify({kind:"reply",content});

test("free_chat is a native kernel task with no invented JD/resume or implicit tool grant",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-contract-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    const data=input(),task=await kernel.createTask(data,access);
    assert.equal(task.kind,"free_chat");assert.equal(task.status,"ready");assert.equal(task.usage.modelCalls,0);
    assert.ok(!("job" in task));assert.ok(!("resume" in task));assert.ok(!("directories" in task));
    assert.equal((await kernel.createTask(data,access)).id,task.id);assert.deepEqual(await kernel.list(),[]);
    assert.equal((await kernel.listTasks())[0]!.id,task.id);
    await assert.rejects(kernel.createTask({...data,objective:"different"},access),/idempotency_conflict/);
    assert.equal(FreeChatTaskCreateSchema.safeParse({...data,directories:[{path:"/not-authorized",label:"invalid"}]}).success,false);
    const original=structuredClone(data);const withImage=structuredClone(data);withImage.conversation.messages[0]!.attachments=[{name:"synthetic.png",mimeType:"image/png",dataUrl:"data:image/png;base64,AAAA"}];
    assert.equal(FreeChatTaskCreateSchema.safeParse(withImage).success,true,"image transport is represented without dropping bytes");
    withImage.conversation.messages[0]!.attachments![0]!.mimeType="image/jpeg";
    assert.equal(FreeChatTaskCreateSchema.safeParse(withImage).success,false,"mismatched declared MIME is rejected");assert.deepEqual(data,original);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("all historical images are transported intact outside text JSON, and unsupported runtimes fail before charging",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-images-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    const data=input("synthetic-image-conversation"),image={name:"synthetic.png",mimeType:"image/png",dataUrl:"data:image/png;base64,AAAA"};
    data.conversation.messages[0]!.attachments=[image];let task=await kernel.createTask(data,access),calls=0;
    const reasoner:CareerTaskRuntime["reasoner"]=async(prompt,_signal,phase,images)=>{calls++;assert.equal(phase,"free_chat");assert.equal(prompt.includes(image.dataUrl),false);assert.equal(images?.[0]?.dataUrl,image.dataUrl);assert.equal(images?.[0]?.messageId,"user-1");return reply(`image answer ${calls}`);};
    await assert.rejects(kernel.run(task.id,"start",command(task),{runtimeFingerprint:"fixture",reasoner},access),/task_images_not_supported/);
    assert.equal((await read(kernel,task.id)).usage.modelCalls,0);
    await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"fixture",supportsImages:true,reasoner},access);task=await settled(kernel,task.id);
    await kernel.run(task.id,"answer",{...command(task),message:{id:"u2",role:"user",content:"接着看原图"}},{runtimeFingerprint:"fixture",supportsImages:true,reasoner},access);task=await settled(kernel,task.id);
    assert.equal(task.usage.modelCalls,2);assert.equal(calls,2);assert.equal(task.conversation.messages[0]!.attachments![0]!.dataUrl,image.dataUrl);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("complete history, raw repair output and subsequent answers use one cumulative conversation ledger",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-ledger-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    const data=input("synthetic-chat-ledger");data.budget={maxModelCalls:3,maxToolCalls:2,maxActiveMs:60000};
    const early="早期纠正：我不负责上线。"+"完整旧信息。".repeat(2200)+"EARLY-END";
    data.conversation.messages=[{id:"first",role:"user",content:early},{id:"prior",role:"assistant",content:"历史建议不是个人事实。"},{id:"current",role:"user",content:"请结合上述限制继续。",references:[{type:"resume_text",text:"参与缓存测试。"+"授权引用。".repeat(1600)+"REF-END",sourceLabel:"合成只读摘录"}]}];
    let task=await kernel.createTask(data,access),calls=0;const raw="invalid JSON; preserve this entire output "+"修复记录。".repeat(1800)+"RAW-END";
    const runtime:CareerTaskRuntime={runtimeFingerprint:"same-native-generation",reasoner:async(prompt,signal,phase)=>{
      signal.throwIfAborted();assert.equal(phase,"free_chat");const state=JSON.parse(prompt.split("\n\n").at(-1)!);
      assert.equal(state.conversation.messages[0].content,early);assert.ok(prompt.includes("REF-END"));
      if(++calls===1)return raw;
      assert.ok(state.observations.some((item:{output?:string})=>item.output===raw),"invalid output retained whole across both repair and later turns");
      if(calls===3)assert.ok(state.conversation.messages.some((message:{content:string})=>message.content==="本人补充：只验证了测试环境。"));
      return {text:reply("完整回答。".repeat(900)+`ANSWER-${calls}`),finishReason:"stop"};
    }};
    await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);
    assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.usage.modelCalls,2);assert.ok(task.reply!.content.endsWith("ANSWER-2"));
    await kernel.run(task.id,"answer",{...command(task),message:{id:"follow-1",role:"user",content:"本人补充：只验证了测试环境。"}},runtime,access);task=await settled(kernel,task.id);
    assert.equal(task.turn,2);assert.equal(task.usage.modelCalls,3);assert.equal(task.usage.toolCalls,0);assert.equal(task.reply!.meta!.completeness,"complete");
    assert.ok(task.conversation.messages.some(message=>message.id==="first"&&message.content===early));assert.ok(task.conversation.messages.some(message=>message.content.endsWith("ANSWER-2")));
    await assert.rejects(kernel.run(task.id,"answer",{...command(task),message:{id:"follow-2",role:"user",content:"继续"}},runtime,access),/model_call_budget/);assert.equal(calls,3);
    await kernel.budget(task.id,task.revision,{maxModelCalls:4,maxToolCalls:2,maxActiveMs:60000},access);task=await read(kernel,task.id);
    assert.equal(task.usage.modelCalls,3);assert.equal(task.turn,2);
    await kernel.run(task.id,"answer",{...command(task),message:{id:"follow-2",role:"user",content:"继续"}},runtime,access);task=await settled(kernel,task.id);assert.equal(task.usage.modelCalls,4);assert.equal(task.turn,3);
    const stored=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.ok(stored.recent.some(item=>item.output===raw));
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("ungranted editable anchors are rejected with bounded charged repair, while cards execute no effects",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-proposals-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    let task=await kernel.createTask(input("synthetic-chat-proposals"),access),calls=0;
    await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same-native-generation",reasoner:async prompt=>{
      if(++calls===1)return JSON.stringify({kind:"reply",content:"不应允许这个写回锚。",actions:[{type:"resume_proposal",targetSection:"简介",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"未共享原文",proposedText:"虚构改写",rationale:"invalid"}]});
      assert.ok(prompt.includes("resume_proposal_source_not_granted"));
      return JSON.stringify({kind:"reply",content:"以下仅为待核对提案。",actions:[{type:"company_card",companyName:"合成公司",summary:"未联网核实",verified:true},{type:"badge_3d",title:"合成提案",highlight:"待确认",style:"quantum_prism",imageUrl:"https://invalid.example/fake.png",renderDurationMs:10}]});
    }},access);task=await settled(kernel,task.id);
    assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.usage.modelCalls,2);assert.equal(task.usage.toolCalls,0);
    const company=task.reply!.actions!.find(card=>card.type==="company_card"),badge=task.reply!.actions!.find(card=>card.type==="badge_3d");
    assert.ok(company?.type==="company_card");assert.equal(company.verified,false);assert.ok(badge?.type==="badge_3d");assert.equal(badge.imageUrl,undefined);assert.equal(badge.renderDurationMs,undefined);
    await assert.rejects(kernel.fact(task.id,task.revision,"invalid",["not-an-evidence"],access),/task_kind_not_supported_by_operation/);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("a transport length limit cannot pass as a complete reply even if its JSON parses",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-incomplete-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    let task=await kernel.createTask(input("synthetic-chat-incomplete"),access),calls=0;const partial=reply("原始未完回答。".repeat(600));
    const runtime:CareerTaskRuntime={runtimeFingerprint:"same-native-generation",reasoner:async prompt=>++calls===1?{text:partial,finishReason:"length"}:(assert.ok(prompt.includes(partial.replace(/"/g,'\\"'))),{text:reply("完整重新核对后的回答。"),finishReason:"stop"})};
    await kernel.run(task.id,"start",command(task),runtime,access);task=await settled(kernel,task.id);
    assert.equal(task.status,"paused");assert.equal(task.error,"model_output_incomplete");assert.equal(task.reply,undefined);assert.equal(task.partialOutput!.text,partial);assert.equal(calls,1);
    await kernel.run(task.id,"resume",command(task),runtime,access);task=await settled(kernel,task.id);
    assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.usage.modelCalls,2);assert.equal(task.partialOutput,undefined);assert.equal(task.reply!.meta!.completeness,"complete");
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("pause and revoke fence a late conversational output and release the selected runtime exactly once",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-late-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();let releases=0;
  try{
    const created=await kernel.createTask(input("synthetic-chat-late"),access);
    await kernel.run(created.id,"start",command(created),{runtimeFingerprint:"same-native-generation",reasoner:async()=>{entered.resolve();return finish.promise;},release:()=>releases++},access);
    await entered.promise;let task=await read(kernel,created.id);await kernel.stop(task.id,task.revision,false,access);task=await read(kernel,task.id);assert.equal(task.status,"paused");
    finish.resolve(reply("这个迟到回答不能采用。"));await delay(20);task=await read(kernel,task.id);assert.equal(task.reply,undefined);assert.equal(task.conversation.messages.length,1);assert.equal(releases,1);
    let changedRelease=0;await assert.rejects(kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"changed-native-generation",reasoner:async()=>reply(),release:()=>changedRelease++},access),/runtime_authorization_changed_new_task_required/);assert.equal(changedRelease,1);
    await kernel.stop(task.id,task.revision,true,access);task=await read(kernel,task.id);assert.equal(task.status,"revoked");assert.equal(task.usage.modelCalls,1);
    await assert.rejects(kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"same-native-generation",reasoner:async()=>reply()},access),/task_not_runnable/);
  }finally{finish.resolve(reply());await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("host restart preserves the root history and usage but never replays a conversational request",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-restart-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();let calls=0;
  try{
    let task=await kernel.createTask(input("synthetic-chat-restart"),access);
    await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same-native-generation",reasoner:async()=>{calls++;entered.resolve();return finish.promise;}},access);await entered.promise;
    await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});task=await read(kernel,task.id);assert.equal(task.status,"interrupted");assert.equal(task.usage.modelCalls,1);assert.equal(calls,1);
    finish.resolve(reply("过期"));await delay(20);assert.equal((await read(kernel,task.id)).reply,undefined);
    await kernel.run(task.id,"resume",command(task),{runtimeFingerprint:"same-native-generation",reasoner:async()=>{calls++;return reply("明确恢复后的回答。");}},access);task=await settled(kernel,task.id);
    assert.equal(task.status,"awaiting_answer",task.error);assert.equal(task.usage.modelCalls,2);assert.equal(calls,2);assert.equal(task.conversation.messages[0]!.id,"user-1");
  }finally{finish.resolve(reply());await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("an oversized output is preserved in full as an owner-scoped artifact, never clipped or silently retried",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-overflow-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    let task=await kernel.createTask(input("synthetic-chat-overflow"),access),calls=0;const output=reply("长输出不丢尾部。".repeat(18000)+"OUTPUT-END");
    await kernel.run(task.id,"start",command(task),{runtimeFingerprint:"same-native-generation",reasoner:async()=>{calls++;return output;}},access);task=await settled(kernel,task.id);
    assert.equal(task.status,"budget_exhausted");assert.equal(task.error,"decision_output_budget");assert.equal(task.reply,undefined);assert.equal(calls,1);assert.equal(task.usage.modelCalls,1);
    const artifact=task.outputArtifacts![0]!;assert.equal(artifact.bytes,Buffer.byteLength(output));assert.equal((await kernel.readOutput(task.id,artifact.id)).text,output);
    await assert.rejects(kernel.readOutput(task.id,"out_"+"0".repeat(32)),/task_output_not_found/);
    const stored=await readPrivateJson(path.join(directory,`${task.id}.json`));assert.ok(JSON.stringify(stored).length<15000,"task state remains readable rather than overflowing its durable envelope");
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});
