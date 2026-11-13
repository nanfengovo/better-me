import assert from "node:assert/strict";
import test from "node:test";
import {registerHooks} from "node:module";
import {once} from "node:events";
import {mkdtemp,rm,readFile,readdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {Window} from "happy-dom";
import type {FreeChatTask} from "@better-me/agent-contracts";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {createAgentServer} from "../../agent-host/src/server";
import type {CareerTaskReasoner} from "../../agent-host/src/kernel/model-protocol";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {activatePrincipal} from "../src/lib/identity";
import {createFreeChatTaskClient} from "../src/services/free-chat-task-client";
import {createTaskLedgerClient} from "../src/services/agent-task-scope";
import {understandingModelRuntime} from "../src/services/understanding-client";

registerHooks({load(url,context,next){return url.endsWith(".css")?{format:"module",source:"",shortCircuit:true}:next(url,context);}});
const dom=new Window({url:"http://one-off-task-fixture.invalid"});
const React=await import("react");
for(const [key,value] of Object.entries({window:dom,document:dom.document,navigator:dom.navigator,localStorage:dom.localStorage,HTMLElement:dom.HTMLElement,Element:dom.Element,Node:dom.Node,Event:dom.Event,CustomEvent:dom.CustomEvent,React,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
const {act,createElement:h}=React,{createRoot}=await import("react-dom/client");
const {UiPreferencesProvider}=await import("../src/lib/ui-preferences");
const {AgentCompanion}=await import("../src/components/AgentCompanion");
const {AiConfigModal}=await import("../src/components/AiConfigModal");
const {MODEL_CONFIGURATION_PROBE}=await import("../src/components/OneOffAgentTask");
const config={provider:"ollama" as const,model:"synthetic-one-off",baseUrl:"http://127.0.0.1:1/v1",apiKey:"",temperature:0.3};
const probeConfig={...config,apiKey:"synthetic-probe-secret-never-archive"};
const runtime={kind:"model" as const,modelSettings:{provider:config.provider,model:config.model,baseUrl:config.baseUrl,temperature:config.temperature}},scope="synthetic-one-off-workspace";
async function flush(action:()=>void=()=>{}){await act(async()=>{action();await delay(10);});}
async function until(predicate:()=>boolean){for(let i=0;i<300&&!predicate();i++)await flush();assert.ok(predicate(),dom.document.body.textContent?.slice(-2500));}
const button=(label:string)=>[...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node=>node.textContent?.trim()===label);
const consent=()=>dom.document.querySelector<HTMLInputElement>('.agent-companion-run input[type="checkbox"]')!;
async function input(text:string){const field=dom.document.querySelector<HTMLTextAreaElement>(".agent-companion-field textarea")!;assert.ok(field);await flush(()=>{Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype,"value")!.set!.call(field,text);field.dispatchEvent(new dom.Event("input",{bubbles:true}));});}

async function fixture(reasoner:CareerTaskReasoner,modelProbe=false){
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-one-off-http-")),originalFetch=globalThis.fetch,wire:{path:string;method:string}[]=[];
  const server=createAgentServer({host:"127.0.0.1",port:0,authToken:"synthetic-one-off-token",allowedOrigins:[],identityDirectory:path.join(directory,"identity"),runtimeDefinitions:[],checkpointer:new MemorySaver() as never,careerTaskReasoner:reasoner});
  await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  const identity=await registerTestIdentity(base,"synthetic-one-off-token","synthetic-one-off-owner");activatePrincipal(identity.principal);
  let loseCreate=false;
  globalThis.fetch=async(url,init)=>{
    const pathname=new URL(String(url)).pathname,method=init?.method??"GET";
    if(pathname.startsWith("/api/v1/agent/")){
      wire.push({path:pathname,method});assert.ok(!pathname.startsWith("/api/v1/agent/runs"),"no legacy execution or read path");
      const headers=new Headers(init?.headers);for(const [key,value] of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization","Bearer synthetic-one-off-token");
      const response=await originalFetch(base+pathname,{...init,headers});
      if(loseCreate&&pathname==="/api/v1/agent/tasks"&&method==="POST"){loseCreate=false;throw Error("synthetic lost create receipt after commit");}
      return response;
    }
    // Capability probes do not reach a real provider or the external network.
    if(pathname.endsWith("/models"))return Response.json({data:[]});
    throw Error(`outside isolated Host: ${pathname}`);
  };
  dom.localStorage.clear();dom.document.body.innerHTML='<main id="fixture"></main>';
  let root=createRoot(dom.document.getElementById("fixture")!);
  const render=()=>root.render(h(UiPreferencesProvider,null,modelProbe?h(AiConfigModal,{isOpen:true,rootScopeKey:scope,config:probeConfig,onClose(){},onSave(){}}):h(AgentCompanion,{workspaceKey:scope,llmConfig:config,onOpenAiConfig(){},onOpenWorkspace(){}})));
  const open=async()=>{
    if(modelProbe){await flush(()=>button("测试文本生成（计入总额度）")!.click());return;}
    await flush(()=>dom.document.querySelector<HTMLButtonElement>('[aria-label="打开 Agent 伴侣"]')!.click());
    await flush(()=>dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-companion-tools-toggle"]')!.click());
    await flush(()=>dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-companion-quick-run-toggle"]')!.click());
  };
  return {wire,base,directory,ownerId:identity.principal.id,ledger:createTaskLedgerClient({baseUrl:base}),client:createFreeChatTaskClient({baseUrl:base,pollMs:5}),render:async()=>flush(render),open,loseCreate:()=>{loseCreate=true;},
    remount:async()=>{await flush(()=>root.unmount());dom.document.body.innerHTML='<main id="fixture"></main>';root=createRoot(dom.document.getElementById("fixture")!);await flush(render);await open();},
    tasks:async()=>{const response=await fetch(base+"/api/v1/agent/tasks");return (await response.json()).tasks as FreeChatTask[];},
    close:async()=>{await flush(()=>root.unmount());activatePrincipal(undefined);globalThis.fetch=originalFetch;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});dom.localStorage.clear();},
  };
}

test("actual Companion one-off uses authenticated tasks, full long text/reply and the prior chat root/runtime; remount only reads",async()=>{
  let calls=0,adapters=0;const source="  完整原文😀\r\n"+"不裁剪输入。".repeat(9000)+"SOURCE-END  ",answer="  最终完整答复_START_\r\n"+"完整输出".repeat(22000)+"_END  ";
  const f=await fixture(async()=>{adapters++;return async(prompt,_signal,phase)=>{calls++;assert.equal(phase,"free_chat");if(calls===2){assert.ok(prompt.includes(JSON.stringify(source).slice(1,-1)));assert.ok(!prompt.includes("PRIVATE-CHAT-ONLY"));}return {text:JSON.stringify({kind:"reply",content:calls===1?"先前聊天结果":answer}),finishReason:"stop"};};});
  try{
    const prior=await f.client.send({workspaceKey:"companion:prior",rootScopeKey:scope,runtime,messages:[{id:"prior-user",role:"user",content:"PRIVATE-CHAT-ONLY"}]});
    await f.render();await f.open();assert.equal(button("开始运行")!.disabled,true);await input(source);assert.equal(calls,1);
    await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());await until(()=>Boolean(dom.document.querySelector(".agent-output-text")));
    const tasks=await f.tasks(),task=tasks.find(row=>row.workspaceKey===`one-off:${scope}`)!;
    assert.equal(task.reply!.content,answer);assert.equal(task.conversation.messages[0]!.content,source);assert.equal(task.conversation.context,undefined);
    assert.equal(task.rootTaskId,prior.meta!.taskId);assert.equal(task.rootLedger!.usage.modelCalls,2);assert.equal(adapters,1);assert.equal(calls,2);
    let copied="";Object.defineProperty(dom.navigator.clipboard,"writeText",{configurable:true,value:async(text:string)=>{copied=text;}});
    await flush(()=>dom.document.querySelector<HTMLButtonElement>('[aria-label="复制完整运行结果"]')!.click());assert.equal(copied,answer);
    const posts=f.wire.filter(row=>row.method==="POST").length;
    await f.remount();await until(()=>Boolean(dom.document.querySelector(".agent-output-text")));assert.equal(consent().checked,false);
    assert.equal(dom.document.querySelector<HTMLTextAreaElement>(".agent-companion-field textarea")!.value,source);assert.equal(f.wire.filter(row=>row.method==="POST").length,posts);assert.equal(calls,2);
    assert.ok(f.wire.filter(row=>row.method==="POST").every(row=>row.path.startsWith("/api/v1/agent/tasks")));
  }finally{await f.close();}
});

test("actual Companion recovers an oversized output through the authenticated task reader without inference or clipping",async()=>{
  const output="\ufeff  合成原始输出😀\r\n"+"保留完整输出，不声称成功。\r\n".repeat(15000)+"HTTP-ARTIFACT-END  ";let calls=0;
  const f=await fixture(async()=>async()=>{calls++;return output;});
  try{
    await f.render();await f.open();await input("只做合成全文读取验收，不接真实资料。");await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());
    await until(()=>Boolean(button("读取完整原文")));assert.equal(calls,1);assert.equal(dom.document.querySelector('[aria-label="完整原始输出正文"]'),null);
    const before=await f.tasks(),hash=JSON.stringify(before),posts=f.wire.filter(row=>row.method==="POST").length;
    assert.equal(before[0]!.status,"budget_exhausted");assert.equal(before[0]!.reply,undefined);assert.equal(before[0]!.outputArtifacts!.length,1);
    await flush(()=>button("读取完整原文")!.click());await until(()=>Boolean(dom.document.querySelector('[aria-label="完整原始输出正文"]')));
    assert.equal(dom.document.querySelector('[aria-label="完整原始输出正文"]')!.textContent,output);assert.equal(calls,1);assert.equal(f.wire.filter(row=>row.method==="POST").length,posts);
    let copied="";Object.defineProperty(dom.navigator.clipboard,"writeText",{configurable:true,value:async(text:string)=>{copied=text;}});
    await flush(()=>button("复制完整原文")!.click());assert.equal(copied,output);assert.equal(JSON.stringify(await f.tasks()),hash);
    await f.remount();await until(()=>Boolean(button("读取完整原文")));assert.equal(consent().checked,false);assert.equal(dom.document.querySelector('[aria-label="完整原始输出正文"]'),null);assert.equal(calls,1);assert.equal(f.wire.filter(row=>row.method==="POST").length,posts);
    assert.ok(f.wire.some(row=>row.method==="GET"&&/\/tasks\/ct_[a-f0-9]{32}\/outputs\/out_[a-f0-9]{32}$/.test(row.path)));
  }finally{await f.close();}
});

test("unknown create receipt reconciles by stable message ID without a second create or automatic dispatch",async()=>{
  let calls=0;
  const f=await fixture(async()=>async()=>{calls++;return JSON.stringify({kind:"reply",content:"明确重授权后才完成。"});});
  try{
    await f.render();await f.open();await input("  未知回执原文😀  ");f.loseCreate();await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());
    await until(()=>Boolean(dom.document.querySelector('.agent-companion-run [role="alert"]')));assert.equal(calls,0);
    const registered=(await f.tasks())[0]!;assert.equal(registered.status,"ready");
    await f.remount();await until(()=>Boolean(button("读取现有任务")));assert.equal(consent().checked,false);assert.equal(calls,0);
    await flush(()=>button("读取现有任务")!.click());await until(()=>!button("读取现有任务")!.disabled&&!consent().disabled);await flush(()=>consent().click());assert.equal(consent().checked,true);await flush(()=>button("开始运行")!.click());await until(()=>Boolean(dom.document.querySelector(".agent-output-text")));
    const tasks=await f.tasks();assert.equal(tasks.length,1);assert.equal(tasks[0]!.id,registered.id);assert.equal(calls,1);
    assert.equal(f.wire.filter(row=>row.method==="POST"&&row.path==="/api/v1/agent/tasks").length,1);
  }finally{await f.close();}
});

test("partial output survives remount; explicit resume keeps task/root/usage and never changes the selected runtime",async()=>{
  let calls=0;const partial="  PARTIAL😀\r\n"+"原始未完成内容".repeat(2000)+"  ";
  const f=await fixture(async()=>async()=>{calls++;return calls===1?{text:partial,finishReason:"length"}:{text:JSON.stringify({kind:"reply",content:"重授权后完整结果"}),finishReason:"stop"};});
  try{
    await f.render();await f.open();await input("原文不变");await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());await until(()=>Boolean(dom.document.querySelector(".agent-companion-run pre")));
    const before=(await f.tasks())[0]!;assert.equal(before.status,"paused");assert.equal(before.partialOutput!.text,partial);
    await f.remount();await until(()=>Boolean(dom.document.querySelector(".agent-companion-run pre")));assert.equal(consent().checked,false);assert.equal(calls,1);
    await assert.rejects(f.client.resume({task:before,rootScopeKey:scope,runtime:{...runtime,modelSettings:{...runtime.modelSettings,model:"other"}}}),/底座已变化/);assert.equal(calls,1);
    await flush(()=>consent().click());await flush(()=>button("继续原任务")!.click());await until(()=>Boolean(dom.document.querySelector(".agent-output-text")));
    const after=(await f.tasks())[0]!;assert.equal(after.id,before.id);assert.equal(after.rootTaskId,before.rootTaskId);assert.equal(after.usage.modelCalls,2);assert.equal(calls,2);
    assert.equal(f.wire.filter(row=>row.method==="POST"&&row.path.endsWith("/resume")).length,1);
  }finally{await f.close();}
});

test("explicit stop fences ignored late output; opening and reading never resumes the task",async()=>{
  const entered=Promise.withResolvers<void>(),late=Promise.withResolvers<string>();let calls=0;
  const f=await fixture(async()=>async()=>{calls++;entered.resolve();return late.promise;});
  try{
    await f.render();await f.open();await input("停止仍保留全部原文。");await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());await entered.promise;
    await until(()=>Boolean(dom.document.querySelector('[aria-label="停止单次任务"]')));
    await flush(()=>dom.document.querySelector<HTMLButtonElement>('[aria-label="停止单次任务"]')!.click());await until(()=>dom.document.querySelector(".agent-companion-run-status")?.textContent?.includes("paused")===true);
    const before=(await f.tasks())[0]!;assert.equal(before.status,"paused");late.resolve(JSON.stringify({kind:"reply",content:"LATE-MUST-NOT-APPLY"}));await delay(20);
    await f.remount();await flush(()=>button("读取现有任务")!.click());const after=(await f.tasks())[0]!;assert.equal(after.reply,undefined);assert.equal(after.usage.modelCalls,1);assert.equal(after.status,"paused");assert.equal(consent().checked,false);assert.equal(calls,1);
  }finally{late.resolve("{}");await f.close();}
});

test("real configuration modal probe uses the prior root/adapter, keeps complete output and restores GET-only without credentials in archives",async()=>{
  let calls=0,adapters=0;const answer="  PROBE-START😀\r\n"+"完整配置测试输出。".repeat(9000)+"PROBE-END  ";
  const f=await fixture(async()=>{adapters++;return async(prompt,_signal,phase)=>{
    calls++;assert.equal(phase,"free_chat");
    if(calls>1){assert.ok(prompt.includes(MODEL_CONFIGURATION_PROBE));assert.ok(!prompt.includes("PRIVATE-PRIOR-CHAT"));assert.ok(!prompt.includes("PRIVATE-RESUME"));}
    return JSON.stringify({kind:"reply",content:calls===1?"先前根账回复":answer});
  };},true);
  try{
    const prior=await f.client.send({workspaceKey:"advisor:prior-probe",rootScopeKey:scope,runtime:understandingModelRuntime(probeConfig),messages:[{id:"probe-prior",role:"user",content:"PRIVATE-PRIOR-CHAT PRIVATE-RESUME"}]});
    const root=await f.client.get(prior.meta!.taskId!);await f.ledger.budget(root,{...root.budget,maxModelCalls:2});
    await f.render();const before=f.wire.filter(row=>row.method==="POST").length;await f.open();
    assert.equal(calls,1);assert.equal(f.wire.filter(row=>row.method==="POST").length,before,"opening only reads saved records");
    await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());await until(()=>Boolean(dom.document.querySelector(".agent-output-text")));
    const tasks=await f.tasks(),probe=tasks.find(row=>row.workspaceKey===`one-off:model-probe:${scope}`)!;
    assert.equal(probe.conversation.messages[0]!.content,MODEL_CONFIGURATION_PROBE);assert.equal(probe.conversation.context,undefined);
    assert.equal(probe.reply!.content,answer);assert.equal(probe.rootTaskId,root.id);assert.equal(probe.rootLedger!.usage.modelCalls,2);assert.equal(probe.rootLedger!.budget.maxModelCalls,2);assert.equal(calls,2);assert.equal(adapters,1);
    let copied="";Object.defineProperty(dom.navigator.clipboard,"writeText",{configurable:true,value:async(text:string)=>{copied=text;}});
    await flush(()=>dom.document.querySelector<HTMLButtonElement>('[aria-label="复制完整运行结果"]')!.click());assert.equal(copied,answer);
    const posts=f.wire.filter(row=>row.method==="POST").length,hash=JSON.stringify(tasks);
    await f.remount();await until(()=>Boolean(dom.document.querySelector(".agent-output-text")));assert.equal(consent().checked,false);
    assert.equal(f.wire.filter(row=>row.method==="POST").length,posts);assert.equal(calls,2);assert.equal(JSON.stringify(await f.tasks()),hash);
    await flush(()=>button("新任务 · 沿用总额度")!.click());await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());await until(()=>Boolean(dom.document.querySelector('.agent-companion-run [role="alert"]')));
    assert.equal(calls,2);assert.equal((await f.tasks()).length,2,"exhausted root refuses the next test before creating a new budget");
    const taskDirectory=path.join(f.directory,"identity","owners",f.ownerId,"career-tasks-v1");
    for(const file of (await readdir(taskDirectory)).filter(name=>/^ct_.*\.json$/.test(name))){const text=await readFile(path.join(taskDirectory,file),"utf8");assert.ok(!text.includes('"apiKey"'));assert.ok(!text.includes(probeConfig.apiKey));}
    assert.ok(!JSON.stringify(dom.localStorage).includes(probeConfig.apiKey),"recovery journal has no credential");
    assert.ok(f.wire.filter(row=>row.method==="POST").every(row=>row.path.startsWith("/api/v1/agent/tasks")));
  }finally{await f.close();}
});

test("configuration probe refuses a conflicting root model without fallback, new root or changing the prior archive",async()=>{
  let calls=0;const f=await fixture(async()=>async()=>{calls++;return JSON.stringify({kind:"reply",content:"原底座完整记录"});},true);
  try{
    await f.client.send({workspaceKey:"advisor:other-model",rootScopeKey:scope,runtime:{...runtime,modelSettings:{...runtime.modelSettings,model:"different-fixed-model"}},messages:[{id:"other-model-prior",role:"user",content:"原对话保留。"}]});
    const before=JSON.stringify(await f.tasks());await f.render();await f.open();await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());
    await until(()=>Boolean(dom.document.querySelector('.agent-companion-run [role="alert"]')));
    assert.match(dom.document.querySelector('.agent-companion-run [role="alert"]')!.textContent!,/另一运行时/);assert.equal(calls,1);assert.equal(JSON.stringify(await f.tasks()),before);
  }finally{await f.close();}
});

test("configuration probe reconciles an unknown create on reopen and requires fresh consent before the original task is dispatched",async()=>{
  let calls=0;const f=await fixture(async()=>async()=>{calls++;return JSON.stringify({kind:"reply",content:"BETTERME_OK"});},true);
  try{
    await f.render();await f.open();f.loseCreate();await flush(()=>consent().click());await flush(()=>button("开始运行")!.click());await until(()=>Boolean(dom.document.querySelector('.agent-companion-run [role="alert"]')));
    const before=(await f.tasks())[0]!;assert.equal(before.status,"ready");assert.equal(calls,0);
    await f.remount();await until(()=>Boolean(button("读取现有任务")));assert.equal(consent().checked,false);assert.equal(calls,0);
    await flush(()=>button("读取现有任务")!.click());await until(()=>!button("读取现有任务")!.disabled&&!consent().disabled);await flush(()=>consent().click());await until(()=>!button("开始运行")!.disabled);await flush(()=>button("开始运行")!.click());await until(()=>Boolean(dom.document.querySelector(".agent-output-text")));
    const tasks=await f.tasks();assert.equal(tasks.length,1);assert.equal(tasks[0]!.id,before.id);assert.equal(calls,1);assert.equal(f.wire.filter(row=>row.method==="POST"&&row.path==="/api/v1/agent/tasks").length,1);
  }finally{await f.close();}
});
