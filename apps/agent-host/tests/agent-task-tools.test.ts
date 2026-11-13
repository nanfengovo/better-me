import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { careerRuntimeBinding, type CareerTask, type CareerTaskCreate } from "@better-me/agent-contracts";
import { AgentTaskKernel } from "../src/kernel/service.js";

const access={session:"isolated-tool-owner",valid:async()=>true};
const binding=careerRuntimeBinding({kind:"model",modelSettings:{provider:"ollama",model:"offline-fixture",baseUrl:"http://127.0.0.1:11434/v1"}});
function input(key:string):CareerTaskCreate{return {workspaceKey:"synthetic-tools",idempotencyKey:key,consent:true,runtimeBinding:binding,objective:"核对合成材料",job:{title:"合成岗位",company:"虚构",description:"核对测试记录。"},resume:{id:"r",name:"合成",sourceFingerprint:"v1",fields:[{id:"f",originalText:"参与测试。",targetRef:{kind:"profile_headline",locale:"zh"}}]},materials:[{id:"m",label:"合成输入",kind:"source",text:"  alpha  \n\n beta\n"}],toolPolicy:{allowBuild:true,installedVersionIds:[]}};}
const runInput=(task:CareerTask)=>({expectedRevision:task.revision,consent:true as const,runtimeBinding:task.runtimeBinding,sourceFingerprint:task.resume.sourceFingerprint});
async function settled(kernel:AgentTaskKernel,id:string){for(let n=0;n<500;n++){const t=await kernel.readTask(id);if(t.status!=="running")return t;await delay(8);}throw Error("synthetic tool task did not settle");}
const source="function(input){return {records:input.text.split(/\\r?\\n/).map((text,i)=>({line:i+1,text:text.trim()})).filter(row=>row.text.length>0)}}";

test("generated pure-JSON tool repairs under its parent budget, is task-local until approval, and reuses an installed exact version",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-task-tools-"));
  const kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    let t=await kernel.createTask(input("synthetic-build-1"),access),decisions=0,generations=0;
    await kernel.run(t.id,"start",runInput(t),{runtimeFingerprint:"same-runtime",reasoner:async prompt=>{
      if(prompt.includes("BETTERME_TOOL_BUILD_V1")){generations++;return JSON.stringify({source:generations===1?"function(){return {records:[]}}":source});}
      const state=JSON.parse(prompt.split("\n\n").at(-1)!);decisions++;
      if(decisions===1)return JSON.stringify({kind:"tool",tool:"read_job"});
      if(decisions===2)return JSON.stringify({kind:"tool",tool:"read_resume",id:"f"});
      if(decisions===3)return JSON.stringify({kind:"tool",tool:"build_tool",id:"material-lines-v1"});
      if(decisions===4){assert.equal(state.toolArtifacts.length,1);return JSON.stringify({kind:"tool",tool:"use_tool",id:state.toolArtifacts[0].versionId,materialId:"m"});}
      const result=state.recentObservations.findLast((x:{tool:string})=>x.tool==="use_tool").result;
      assert.deepEqual(result.records,[{line:1,text:"alpha"},{line:3,text:"beta"}]);
      return JSON.stringify({kind:"draft",patches:[],unknowns:["工具仅整理原文，不证明个人贡献。"]});
    }},access);
    t=await settled(kernel,t.id);assert.equal(t.status,"awaiting_review",t.error);
    assert.equal(generations,2);assert.equal(t.usage.modelCalls,7,"decisions and repair generation share one ledger");
    assert.ok(t.usage.toolCalls>=8,"qualification and invocation cannot create a separate read allowance");
    const artifact=t.tools![0]!;assert.equal(artifact.status,"qualified");assert.equal((await kernel.listInstalledTools()).length,0);
    await assert.rejects(kernel.createTask({...input("synthetic-unapproved-reuse"),toolPolicy:{allowBuild:false,installedVersionIds:[artifact.versionId]}},access),/tool_not_installed/);
    await assert.rejects(kernel.installTool(t.id,t.revision,artifact.versionId,"wrong-hash",access),/tool_artifact_changed/);
    t=await kernel.installTool(t.id,t.revision,artifact.versionId,artifact.sourceHash,access);
    assert.equal((await kernel.listInstalledTools())[0]!.versionId,artifact.versionId);
    const reuse=input("synthetic-build-reuse");reuse.materials![0]!.text="new input\n\n  next item ";reuse.toolPolicy={allowBuild:false,installedVersionIds:[artifact.versionId]};
    let second=await kernel.createTask(reuse,access),calls=0;
    await kernel.run(second.id,"start",runInput(second),{runtimeFingerprint:"same-runtime",reasoner:async prompt=>{
      assert.ok(!prompt.includes("BETTERME_TOOL_BUILD_V1"),"installed version is not regenerated");calls++;
      const state=JSON.parse(prompt.split("\n\n").at(-1)!);
      if(calls===1)return JSON.stringify({kind:"tool",tool:"read_job"});
      if(calls===2)return JSON.stringify({kind:"tool",tool:"read_resume",id:"f"});
      if(calls===3)return JSON.stringify({kind:"tool",tool:"use_tool",id:artifact.versionId,materialId:"m"});
      assert.deepEqual(state.recentObservations.findLast((x:{tool:string})=>x.tool==="use_tool").result.records,[{line:1,text:"new input"},{line:3,text:"next item"}]);
      return JSON.stringify({kind:"draft",patches:[],unknowns:["等待本人核对。"]});
    }},access);
    second=await settled(kernel,second.id);assert.equal(second.status,"awaiting_review",second.error);assert.equal(second.usage.modelCalls,4);
    const pendingInput=input("synthetic-installed-revocation");pendingInput.toolPolicy={allowBuild:false,installedVersionIds:[artifact.versionId]};
    let pending=await kernel.createTask(pendingInput,access);
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),returned=Promise.withResolvers<void>();
    await kernel.run(pending.id,"start",runInput(pending),{runtimeFingerprint:"same-runtime",reasoner:async()=>{
      entered.resolve();await release.promise;returned.resolve();return JSON.stringify({kind:"tool",tool:"use_tool",id:artifact.versionId,materialId:"m"});
    }},access);
    await entered.promise;
    await assert.rejects(kernel.revokeTool(artifact.versionId,"wrong-hash",access),/tool_artifact_changed/);
    assert.equal((await kernel.listInstalledTools()).length,1,"a mismatched fingerprint cannot revoke another version");
    await kernel.revokeTool(artifact.versionId,artifact.sourceHash,access);release.resolve();await returned.promise;await delay(20);
    pending=await kernel.readTask(pending.id);assert.equal(pending.status,"paused");assert.equal(pending.error,"tool_version_revoked");
    assert.ok(!pending.evidence.some(e=>e.sourceId==="material:m"),"a late model decision cannot publish results after version revocation");
    assert.deepEqual(await kernel.listInstalledTools(),[]);
    await assert.rejects(kernel.createTask({...pendingInput,idempotencyKey:"synthetic-revoked-new-grant"},access),/tool_not_installed/);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("build scope and budget cannot be bypassed by generated code, and a late candidate cannot survive task revocation",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-tool-fences-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    const denied=input("synthetic-no-build");denied.toolPolicy={allowBuild:false,installedVersionIds:[]};
    let task=await kernel.createTask(denied,access),calls=0;
    await kernel.run(task.id,"start",runInput(task),{runtimeFingerprint:"same-runtime",reasoner:async prompt=>{
      assert.ok(!prompt.includes("BETTERME_TOOL_BUILD_V1"));const state=JSON.parse(prompt.split("\n\n").at(-1)!);
      if(++calls===1){assert.ok(!state.availableTools.some((t:{tool:string})=>t.tool==="build_tool"));return JSON.stringify({kind:"tool",tool:"build_tool",id:"material-lines-v1"});}
      if(calls===2)return JSON.stringify({kind:"tool",tool:"read_job"});
      if(calls===3)return JSON.stringify({kind:"tool",tool:"read_resume"});
      assert.ok(state.recentObservations.some((o:{result:{error?:string}})=>o.result?.error==="tool_not_granted"));
      return JSON.stringify({kind:"draft",patches:[],unknowns:["工具未授权。"]});
    }},access);task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review");assert.deepEqual(task.tools,[]);
    const capped=input("synthetic-capped-build");capped.budget={maxModelCalls:4,maxToolCalls:30,maxActiveMs:60_000};
    task=await kernel.createTask(capped,access);calls=0;
    await kernel.run(task.id,"start",runInput(task),{runtimeFingerprint:"same-runtime",reasoner:async prompt=>{
      if(prompt.includes("BETTERME_TOOL_BUILD_V1"))return JSON.stringify({source});
      return JSON.stringify(++calls===1?{kind:"tool",tool:"read_job"}:calls===2?{kind:"tool",tool:"read_resume"}:{kind:"tool",tool:"build_tool",id:"material-lines-v1"});
    }},access);task=await settled(kernel,task.id);assert.equal(task.status,"budget_exhausted");assert.equal(task.usage.modelCalls,4);
    // The fourth model send produced source. Its four separately charged
    // QuickJS checks are still allowed by the tool ceiling, not a fifth model send.
    assert.equal(task.usage.toolCalls,7);assert.equal(task.rootLedger!.usage.toolCalls,7);assert.equal(task.tools?.length,1);assert.equal(task.tools![0]!.status,"qualified");assert.equal(task.toolUsage?.executions,0);assert.equal(task.draft,undefined);assert.deepEqual(await kernel.listInstalledTools(),[]);
    const toolCapped={...capped,idempotencyKey:"synthetic-capped-qualification",budget:{...capped.budget,maxToolCalls:6}};task=await kernel.createTask(toolCapped,access);calls=0;
    await kernel.run(task.id,"start",runInput(task),{runtimeFingerprint:"same-runtime",reasoner:async prompt=>{
      if(prompt.includes("BETTERME_TOOL_BUILD_V1"))return JSON.stringify({source});
      return JSON.stringify(++calls===1?{kind:"tool",tool:"read_job"}:calls===2?{kind:"tool",tool:"read_resume"}:{kind:"tool",tool:"build_tool",id:"material-lines-v1"});
    }},access);task=await settled(kernel,task.id);assert.equal(task.status,"budget_exhausted");assert.equal(task.usage.modelCalls,4);assert.equal(task.usage.toolCalls,6);assert.deepEqual(task.tools,[],"a missing final qualification charge cannot yield a candidate");assert.deepEqual(await kernel.listInstalledTools(),[]);
    task=await kernel.createTask(input("synthetic-revoked-build"),access);calls=0;
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    await kernel.run(task.id,"start",runInput(task),{runtimeFingerprint:"same-runtime",reasoner:async prompt=>{
      if(prompt.includes("BETTERME_TOOL_BUILD_V1")){entered.resolve();await release.promise;return JSON.stringify({source});}
      return JSON.stringify(++calls===1?{kind:"tool",tool:"read_job"}:calls===2?{kind:"tool",tool:"read_resume"}:{kind:"tool",tool:"build_tool",id:"material-lines-v1"});
    }},access);
    await entered.promise;task=await kernel.readTask(task.id);await kernel.stop(task.id,task.revision,true,access);release.resolve();await delay(30);
    task=await kernel.readTask(task.id);assert.equal(task.status,"revoked");assert.deepEqual(task.tools,[]);assert.deepEqual(await kernel.listInstalledTools(),[]);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});

test("fixture overfitting cannot publish fabricated records on a real authorized input",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-tool-oracle-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  try{
    let task=await kernel.createTask(input("synthetic-overfit-tool"),access),calls=0;
    await kernel.run(task.id,"start",runInput(task),{runtimeFingerprint:"same-runtime",reasoner:async prompt=>{
      if(prompt.includes("BETTERME_TOOL_BUILD_V1"))return JSON.stringify({source:`function(input){if(input.text.includes('alpha'))return {records:[{line:1,text:'本人负责上线'}]};return (${source})(input)}`});
      calls++;const state=JSON.parse(prompt.split("\n\n").at(-1)!);
      if(calls===1)return JSON.stringify({kind:"tool",tool:"read_job"});
      if(calls===2)return JSON.stringify({kind:"tool",tool:"read_resume"});
      if(calls===3)return JSON.stringify({kind:"tool",tool:"build_tool",id:"material-lines-v1"});
      if(calls===4)return JSON.stringify({kind:"tool",tool:"use_tool",id:state.toolArtifacts[0].versionId,materialId:"m"});
      assert.equal(state.recentObservations.at(-1).result.error,"tool_actual_input_mismatch");
      return JSON.stringify({kind:"draft",patches:[],unknowns:["工具结果未通过实际输入核对，未采用。"]});
    }},access);
    task=await settled(kernel,task.id);assert.equal(task.status,"awaiting_review",task.error);assert.ok(!task.evidence.some(e=>e.excerpt.includes("本人负责上线")));
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});
