import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySaver } from "@langchain/langgraph";
import { CareerTaskSchema, careerRuntimeBinding, type CareerTask } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";

test("text phases reject incomplete inventories, borrowed answers, unsupported metrics and secrets without hidden retries", {timeout:60_000}, async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-text-boundaries-"));let calls=0;
  const provider=http.createServer(async(req,res)=>{
    let wire="";for await(const chunk of req)wire+=chunk;
    const body=JSON.parse(wire),state=JSON.parse(body.messages.at(-1).content.split("\n\n").at(-1));calls++;
    const refs=(field:string)=>state.evidence.filter((e:{sourceId:string})=>e.sourceId===`resume:${field}`).map((e:{id:string})=>e.id);
    const plan={kind:"material_plan",selections:state.resume.fields.map((f:{id:string})=>({fieldId:f.id,include:true,reason:"保留本轮测试工作。",evidenceIds:refs(f.id)})),questions:state.resume.fields.map((f:{id:string},index:number)=>({id:`q${index}`,fieldId:f.id,question:`${f.id} 本人补充？`,evidenceIds:refs(f.id)}))};
    let output:unknown=plan;
    if(state.writingPhase==="plan"){
      if(state.objective==="inventory")plan.selections.pop();
      if(state.objective==="duplicate-question")plan.questions[1].id=plan.questions[0].id;
      if(state.objective==="wrong-source")plan.selections[0].evidenceIds=refs("a:b");
    }else{
      const answers=state.evidence.filter((e:{sourceId:string})=>e.sourceId.startsWith("answer:"));
      const ownAnswer=answers.find((e:{label:string})=>e.label.includes(" · a（"));
      const otherAnswer=answers.find((e:{label:string})=>e.label.includes(" · a:b（"));
      output={kind:"draft",patches:[{fieldId:"a",targetRef:state.resume.fields[0].targetRef,originalText:"维护缓存测试。",proposedText:state.objective==="unsupported-number"?"维护缓存测试，耗时降低50%。":state.objective==="unsupported-delivery"?"负责生产上线缓存测试。":"维护缓存测试并补充异常分支。",evidenceIds:[...refs("a"),(state.objective==="borrowed-answer"?otherAnswer:ownAnswer).id],rationale:"合成负例，不得采纳。"}],unknowns:["上线与量化指标未知。"]};
    }
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id:"boundary-fixture",object:"chat.completion",model:body.model,choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:JSON.stringify(output)}}]}));
  });
  provider.listen(0,"127.0.0.1");await once(provider,"listening");const pa=provider.address();assert.ok(pa&&typeof pa!=="string");
  const runtime={kind:"model" as const,modelSettings:{provider:"custom" as const,model:"boundary-fixture",baseUrl:`http://127.0.0.1:${pa.port}/v1`}},runtimeBinding=careerRuntimeBinding(runtime);
  const host=createAgentServer({host:"127.0.0.1",port:0,authToken:"boundary-token",allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"accounts"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never});
  await once(host,"listening");const ha=host.address();assert.ok(ha&&typeof ha!=="string");const base=`http://127.0.0.1:${ha.port}`;
  try{
    const identity=await registerTestIdentity(base,"boundary-token","text-boundary-synthetic");
    const call=(route:string,body?:unknown)=>fetch(`${base}/api/v1/agent/tasks${route}`,{method:body===undefined?"GET":"POST",headers:{...identity.headers,Authorization:"Bearer boundary-token","Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const parse=async(res:Response)=>{const body=await res.json();assert.ok(res.ok,JSON.stringify(body));return CareerTaskSchema.parse(body.task);};
    const poll=async(id:string)=>{for(let i=0;i<200;i++){const state=await parse(await call(`/${id}`));if(state.status!=="running")return state;await delay(10);}throw Error("boundary fixture did not settle");};
    const command=(state:CareerTask)=>({expectedRevision:state.revision,sourceFingerprint:state.resume.sourceFingerprint,runtimeBinding,runtime,consent:true});
    const input=(objective:string)=>({workflow:"text_v1",idempotencyKey:`text-boundary-${objective}`,workspaceKey:"synthetic",objective,runtimeBinding,consent:true,budget:{maxModelCalls:2,maxToolCalls:1,maxActiveMs:300000},job:{title:"合成岗位",company:"",description:"缓存测试。"},resume:{id:"synthetic",name:"合成",sourceFingerprint:"v1",fields:[{id:"a",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"维护缓存测试。"},{id:"a:b",targetRef:{kind:"claim_text",experienceId:"e",claimId:"c",locale:"zh"},originalText:"维护缓存测试。"}]}});
    for(const [objective,error,expectedCalls] of [["inventory","writing_inventory_incomplete",1],["duplicate-question","writing_question_identity_conflict",1],["wrong-source","writing_own_field_evidence_required",1],["borrowed-answer","writing_cross_field_answer",2],["unsupported-number","unsupported_number",2],["unsupported-delivery","unsupported_personal_contribution",2]] as const){
      await t.test(objective,async()=>{
        const before=calls;let state=await parse(await call("",input(objective)));
        assert.equal((await call(`/${state.id}/start`,command(state))).status,202);state=await poll(state.id);
        if(expectedCalls===2){
          assert.equal(state.status,"awaiting_answer");
          const confirmation={planHash:state.writingPlan!.hash,selectedFieldIds:["a","a:b"],answers:state.writingPlan!.questions.map(q=>({questionId:q.id,text:"我维护缓存测试并补充异常分支，未负责上线，指标未知。"})),confirmed:true};
          assert.equal((await call(`/${state.id}/answer`,{...command(state),answer:JSON.stringify(confirmation)})).status,202);state=await poll(state.id);
        }
        assert.equal(state.status,"failed");assert.equal(state.error,error);assert.equal(state.draft,undefined);assert.equal(calls-before,expectedCalls);assert.equal(state.usage.modelCalls,expectedCalls);
        for(let i=0;i<3;i++)await parse(await call(`/${state.id}`));assert.equal(calls-before,expectedCalls);
      });
    }
    await t.test("secret-before-dispatch",async()=>{
      const before=calls,data=input("secret");data.resume.fields[0].originalText="合成凭据 sk-proj-THISISONLYASYNTHETICKEY123456789";
      const response=await call("",data);assert.equal(response.status,422);assert.match(JSON.stringify(await response.json()),/writing_material_contains_secret/);assert.equal(calls,before);
    });
  }finally{await new Promise<void>(resolve=>host.close(()=>resolve()));await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});
