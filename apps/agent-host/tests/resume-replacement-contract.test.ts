import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { FreeChatTaskCreateSchema } from "@better-me/agent-contracts";
import { parseReplacementSelection, buildReplacementSelectionPrompt } from "@better-me/core";
import { AgentTaskKernel } from "../src/kernel/service.js";
import { careerTaskProtocol } from "../src/kernel/model-protocol.js";

const input = { jobDescription:"核对退款工单。", materials:[
  {experienceId:"a",claimId:"duties",label:"合成组",text:"负责日常工作。",visible:true},
  {experienceId:"a",claimId:"check",label:"合成组",text:"逐项核对退款工单材料，整理提交清单。",visible:false},
] };
const prompt = buildReplacementSelectionPrompt(input);
const binding = {id:"native:replacement-fixture",label:"Local test",location:"local" as const};
const access = {session:"replacement-test",valid:async () => true};
const request = FreeChatTaskCreateSchema.parse({kind:"free_chat",responseContract:"resume_replacement_v1",workspaceKey:"test",
  objective:"选择一条经历",conversation:{messages:[{id:"case",role:"user",content:prompt}]},runtimeBinding:binding,
  budget:{maxModelCalls:3,maxToolCalls:1,maxActiveMs:60000},consent:true,idempotencyKey:"replacement-fixture"});

for (const [label, raw, expected] of [
  ["select", '{"kind":"select","optionIndex":0,"requirementIndex":0}', "replace"],
  ["keep", '{"kind":"keep","optionIndex":null,"requirementIndex":null}', "keep"],
  ["ordinary envelope", '{"kind":"reply","content":"Welcome!","actions":[]}', "failed"],
] as const) test(`native replacement ${label} uses one model dispatch and no chat envelope`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(),"betterme-replacement-contract-"));
  const kernel = new AgentTaskKernel({ownerId:"synthetic-replacement",directory});
  try {
    let task = await kernel.createTask(request,access), calls = 0;
    const runtime = {runtimeFingerprint:"synthetic-replacement-runtime",reasoner:async (text:string,_signal:AbortSignal,phase:Parameters<typeof careerTaskProtocol>[0])=>{
      calls++;
      assert.equal(text,prompt);
      assert.equal(phase,"resume_replacement");
      const p=careerTaskProtocol(phase);
      assert.equal(p.name,"agent_resume_replacement");
      assert.ok(p.jsonSchema?.properties);
      assert.equal(p.schema.safeParse(JSON.parse(raw)).success,expected!=="failed");
      return raw;
    }};
    await kernel.run(task.id,"start",{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:binding,consent:true},runtime,access);
    for (let i=0;i<300;i++) {task=await kernel.readTask(task.id); if(task.status!=="running") break; await delay(10);}
    assert.equal(task.kind,"free_chat");
    if(task.kind!=="free_chat") throw Error("wrong_task_kind");
    assert.equal(calls,1); assert.equal(task.usage.modelCalls,1); assert.equal(task.usage.toolCalls,0);
    if(expected==="failed") {
      assert.equal(task.error,"invalid_resume_replacement"); assert.equal(task.reply,undefined);
    } else {
      assert.equal(task.status,"awaiting_answer"); assert.equal(task.reply?.content,raw);
      assert.equal(parseReplacementSelection(input,task.reply!.content).kind,expected);
      await assert.rejects(kernel.run(task.id,"answer",{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,
        runtimeBinding:binding,consent:true,message:{role:"user",id:"other",content:"a second request"}},runtime,access),/task_kind_not_supported/);
    }
  } finally {await kernel.close(); await rm(directory,{recursive:true,force:true});}
});
