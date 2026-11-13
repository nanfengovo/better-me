import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {AgentTaskSchema,careerRuntimeBinding} from "@better-me/agent-contracts";
import {createAgentServer} from "../../agent-host/src/server";
import {ChatGptPlanService} from "../../agent-host/src/chatgpt/service";
import {chatGptProviderFixture} from "../../agent-host/tests/fixtures/chatgpt-provider";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {activatePrincipal} from "../src/lib/identity";
import {createFreeChatTaskClient} from "../src/services/free-chat-task-client";
import {createExperienceRefineTaskClient} from "../src/services/experience-refine-task-client";
import {createUnderstandingClient} from "../src/services/understanding-client";
import {createCoachGuidanceTaskClient} from "../src/services/coach-guidance-task-client";
import {coachPayload,coachRequest} from "../../agent-host/tests/fixtures/career-coach";

test("production ChatGPT facades use only authenticated tasks, exact account and complete material, sharing one root and no replay",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-account-facades-")),provider=await chatGptProviderFixture();let calls=0,fallback=0;
  const account=new ChatGptPlanService({directory:path.join(directory,"oauth"),fetch:async(url,init)=>{
    if(String(url).endsWith("/responses")){
      calls++;const body=JSON.parse(String(init?.body));assert.equal(body.model,"fixture-gpt");
      if(body.instructions.includes("learning coach"))provider.settings.responseText=JSON.stringify(coachPayload(coachRequest("analysis")));
      else if(body.instructions.includes("experience editor"))provider.settings.responseText=JSON.stringify({questions:["你的实际验证结果是什么？"],rationale:"先问，不补造。",evidenceQuotes:[]});
      else if(body.instructions.includes("project understanding"))provider.settings.responseText=JSON.stringify({kind:"reply",message:"先核对术语。",readyForConfirmation:false,
        understanding:{summary:"只做任务编排。",terms:[],boundaries:["不证明个人贡献"],claims:[],unknowns:["本人动作待确认"]},question:{id:"scope",text:"本人做了哪部分？",why:"先分清项目与本人。",options:[{id:"testing",label:"测试"}],allowMultiple:false}});
      else provider.settings.responseText=JSON.stringify({kind:"reply",content:"完整答复。"+"合成回复🚧\r\n".repeat(1700)+"REPLY-END"});
    }
    return provider.fetch(url,init);
  }});
  const login=await provider.login(account),runtime={kind:"chatgpt" as const,profileId:login.state.profiles[0]!.id,model:"fixture-gpt"};
  const token="synthetic-account-facades-token",server=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,chatGptService:account,
    careerTaskReasoner:async()=>{fallback++;throw Error("must not borrow API/native transport");}});
  try{
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const baseUrl=`http://127.0.0.1:${address.port}`,identity=await registerTestIdentity(baseUrl,token,"synthetic-facades-owner");activatePrincipal(identity.principal);
    const wire:{path:string;method:string;body?:unknown}[]=[];
    const fetcher:typeof fetch=async(url,init)=>{const pathname=new URL(String(url)).pathname;assert.ok(pathname.startsWith("/api/v1/agent/tasks"),pathname);wire.push({path:pathname,method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):undefined});const headers=new Headers(init?.headers);for(const [key,value]of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization",`Bearer ${token}`);return fetch(url,{...init,headers});};
    const options={baseUrl,fetch:fetcher,pollMs:5},chat=createFreeChatTaskClient(options),refine=createExperienceRefineTaskClient(options),project=createUnderstandingClient(options);
    const full="  完整原文\r\n🚧不证明个人贡献。".repeat(600)+"SOURCE-END  ",scope="synthetic-account-facades-scope";
    const messages=[{id:"u1",role:"user" as const,content:full,references:[{type:"resume_text" as const,sourceLabel:"完整原文",text:full}]}];
    const context={sharedMemory:"  已授权背景，不证明本人动作。\r\nBACKGROUND-END  "};
    const reply=await chat.send({workspaceKey:"companion:synthetic-account",rootScopeKey:scope,runtime,messages,context});assert.ok(reply.content.endsWith("REPLY-END"));assert.ok(reply.content.length>10000);assert.equal(calls,1);
    assert.equal((await chat.send({workspaceKey:"companion:synthetic-account",rootScopeKey:scope,runtime,messages,context})).id,reply.id);assert.equal(calls,1);
    const source={targetRef:{kind:"profile_headline" as const,locale:"zh" as const},text:full,label:"合成原文"},supplement="  本人只做输入校验\r\nSUPPLEMENT-END  ";
    const refinement=await refine.refine({workspaceKey:"writing:synthetic-account",rootScopeKey:scope,runtime,refinement:{source},supplement,supplementConfirmed:true});assert.equal(refinement.questions[0],"你的实际验证结果是什么？");assert.equal(calls,2);
    let session=await project.createSession({workspaceKey:"project:synthetic-account",rootScopeKey:scope,projectKey:"synthetic-project",label:"合成项目",sourceText:full,runtimeBinding:careerRuntimeBinding(runtime)});assert.match(session.id,/^ct_/);assert.equal(calls,2);
    const turn={expectedRevision:session.revision,idempotencyKey:"account-facades-project-turn",answer:supplement,selectedOptionIds:[],runtime,consentToSend:true as const};
    await project.startTurn(session.id,turn);
    for(let i=0;i<200;i++){session=await project.getSession(session.id);if(session.phase!=="running")break;await delay(5);}
    assert.equal(session.phase,"awaiting-answer");assert.equal(session.sourceText,full);assert.equal(calls,3);await project.startTurn(session.id,turn);assert.equal(calls,3);
    const coach=createCoachGuidanceTaskClient(options),coachingRequest=coachRequest("analysis",supplement);
    const coaching=await coach.generate({workspaceKey:"coach:synthetic-account",rootScopeKey:scope,runtime,request:coachingRequest,consent:true});assert.equal(coaching.payload.kind,"analysis");assert.equal(calls,4);
    assert.deepEqual(await coach.generate({workspaceKey:"coach:synthetic-account",rootScopeKey:scope,runtime,request:coachingRequest,consent:true}),coaching);assert.equal(calls,4);
    const rows=await (await fetcher(baseUrl+"/api/v1/agent/tasks")).json();const tasks=rows.tasks.map((row:unknown)=>AgentTaskSchema.parse(row));assert.equal(tasks.length,4);
    const root=tasks.find((task:ReturnType<typeof AgentTaskSchema.parse>)=>task.kind==="free_chat")!;
    for(const task of tasks){assert.equal(task.rootTaskId??task.id,root.id);assert.equal(task.rootLedger?.usage.modelCalls,4);assert.deepEqual(task.runtimeBinding,careerRuntimeBinding(runtime));}
    const chatTask=tasks.find((task:ReturnType<typeof AgentTaskSchema.parse>)=>task.kind==="free_chat")!;assert.equal(chatTask.conversation.messages[0].content,full);
    const refinementTask=tasks.find((task:ReturnType<typeof AgentTaskSchema.parse>)=>task.kind==="experience_refine")!;assert.equal(refinementTask.conversation.messages[0].content,supplement);
    const before=wire.filter(row=>row.method==="POST").length;await chat.get(root.id);await project.getSession(session.id);await coach.get(coaching.task.id);assert.equal(wire.filter(row=>row.method==="POST").length,before);assert.equal(calls,4);
    const prompts=provider.calls.filter(call=>call.url.endsWith("/responses")).map(call=>JSON.parse(String(call.init?.body)).input[0].content);
    const first=JSON.parse(prompts[0].split("\n\n").at(-1)!);assert.equal(first.conversation.messages[0].content,full);assert.equal(first.conversation.context.sharedMemory,context.sharedMemory);
    assert.equal(fallback,0);assert.equal(wire.filter(row=>row.path==="/api/v1/agent/tasks"&&row.method==="POST").length,4);
  }finally{activatePrincipal(undefined);await new Promise<void>(resolve=>server.close(()=>resolve()));account.dispose();await rm(directory,{recursive:true,force:true});}
});
