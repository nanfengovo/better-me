import assert from "node:assert/strict";
import { after,afterEach,beforeEach,test } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { Window } from "happy-dom";
import { activatePrincipal, capturePrivateStorage, currentPrincipal } from "../src/lib/identity";
import { CodingHttpError,type CodingInput,type CodingTask,type SandboxCodingClient } from "../src/services/sandbox-coding-client";
registerHooks({load(url,context,next){return url.endsWith(".css")?{format:"module",source:"",shortCircuit:true}:next(url,context);}});
const win=new Window({url:"https://offline.fixture.invalid"});
const React=await import("react");
const original=new Map<string,PropertyDescriptor|undefined>();
let network=0;
for(const [k,v] of Object.entries({window:win,document:win.document,localStorage:win.localStorage,navigator:win.navigator,HTMLElement:win.HTMLElement,
  HTMLInputElement:win.HTMLInputElement,HTMLTextAreaElement:win.HTMLTextAreaElement,Node:win.Node,Element:win.Element,React,IS_REACT_ACT_ENVIRONMENT:true,
  fetch:async()=>{network++;throw Error("No real network");}})){
  original.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});
}
const {createRoot}=await import("react-dom/client");
const {SandboxCodingLab}=await import("../src/components/SandboxCodingLab");
const {AutopilotStudioWorkspace}=await import("../src/components/AutopilotStudioWorkspace");
const {MicroAppPermissionModal}=await import("../src/components/MicroAppPermissionModal");
const {openReviewedPreset}=await import("../src/services/sandbox-build-client");
const {loadInstalledMicroApps,MICRO_APPS_STORAGE_KEY}=await import("../src/lib/micro-app-registry");
let root:ReturnType<typeof createRoot>|undefined;
const owner={id:"11111111-1111-4111-8111-111111111111",username:"fixture-a",displayName:"A"};
const cases=[{id:"zero",input:0,expected:0},{id:"two",input:2,expected:4}];
const job=(overrides:Partial<CodingTask>={}):CodingTask=>({id:"fixture-task",goal:"将数字加倍",model:"fixture-local",modelDigest:"fixture-digest",
  cases,revision:1,attemptsUsed:0,maxAttempts:3,maxActiveMs:180000,activeMs:0,status:"ready",createdAt:"2026-01-02T00:00:00Z",updatedAt:"2026-01-02T00:00:00Z",...overrides});
async function settle(fn:()=>unknown=()=>{}){await React.act(async()=>{fn();await tick();await tick();await tick();});}
async function mount(client:Partial<SandboxCodingClient>){
  const node=win.document.createElement("div");win.document.body.append(node);root=createRoot(node as unknown as HTMLElement);
  await settle(()=>root!.render(React.createElement(SandboxCodingLab,{client:client as SandboxCodingClient})));
}
async function unmount(){await settle(()=>root?.unmount());root=undefined;win.document.body.replaceChildren();}
const body=()=>win.document.body.textContent??"";
function btn(pattern:RegExp){const b=[...win.document.querySelectorAll("button")].find(b=>pattern.test(b.textContent??""));assert.ok(b,"button: "+pattern);return b;}
async function click(pattern:RegExp){await settle(()=>btn(pattern).click());}
async function fill(id:string,value:string) {
  const n=win.document.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[name="${id}"]`);assert.ok(n);
  await settle(()=>{const proto=n.tagName==="TEXTAREA"?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(n,value);n.dispatchEvent(new win.Event("input",{bubbles:true}) as unknown as Event);});
}
beforeEach(()=>activatePrincipal(owner));
afterEach(async()=>{await unmount();activatePrincipal(undefined);win.localStorage.clear();assert.equal(network,0);});
after(()=>{win.happyDOM.abort();for(const [k,d] of original){if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}});

test("create grants immutable synthetic cases but never dispatches a model; each step needs an explicit action",async()=>{
  let created:CodingInput|undefined,steps=0;
  await mount({list:async()=>[],create:async(data)=>{created=data;return job({model:data.model,cases:data.cases,maxActiveMs:data.maxActiveMs});},
    step:async(id,revision)=>{steps++;assert.equal(id,"fixture-task");assert.equal(revision,1);return job({status:"review_ready",attemptsUsed:1,revision:3,
      best:{source:"n => n * 2",sourceHash:"abc",checks:cases.map(c=>({id:c.id,passed:true}))}});}});
  assert.equal(steps,0);assert.equal(btn(/创建实验/).disabled,true);
  await fill("coding-goal","将数字加倍");await fill("coding-cases",JSON.stringify(cases));
  assert.equal(btn(/创建实验/).disabled,true);
  assert.equal(win.document.querySelector<HTMLInputElement>('[name="coding-seconds"]')?.value,"180");
  await fill("coding-seconds","301");await settle(()=>win.document.querySelector('input[type="checkbox"]')!.click());assert.equal(btn(/创建实验/).disabled,true);
  await fill("coding-seconds","73");
  await settle(()=>win.document.querySelector('input[type="checkbox"]')!.click());
  assert.match(body(),/73 秒/);assert.match(body(),/等待人工操作不扣/);
  await click(/创建实验/);assert.ok(created);assert.deepEqual(created.cases,cases);assert.equal(created.maxActiveMs,73_000);assert.equal(steps,0);
  await click(/调用.*一轮/);assert.equal(steps,1);assert.match(body(),/n => n \* 2/);
  assert.match(body(),/待审阅/);assert.match(body(),/不安装/);
  assert.equal(capturePrivateStorage().getItem(MICRO_APPS_STORAGE_KEY),null);
});

test("reopening an author's task is GET only and a stale revision re-reads without repeating a step",async()=>{
  capturePrivateStorage().setItem("sandbox-coding.active.v1","fixture-task");
  const calls:string[]=[];
  const client={list:async()=>{calls.push("list");return [job()];},get:async()=>{calls.push("get");return job({revision:calls.filter(c=>c==="get").length});},
    step:async()=>{calls.push("step");throw new CodingHttpError(409,"coding_revision_conflict");}};
  await mount(client);assert.deepEqual(calls,["list","get"]);await click(/调用.*一轮/);
  assert.deepEqual(calls,["list","get","step","get"]);assert.match(body(),/版本冲突/);assert.match(body(),/任务版本 2/);
  await unmount();await mount(client);assert.deepEqual(calls,["list","get","step","get","list","get"]);
});

test("a late response from a switched account cannot display or create a recovery handle for the new account",async()=>{
  let release!:(task:CodingTask)=>void;
  capturePrivateStorage().setItem("sandbox-coding.active.v1","fixture-task");
  await mount({list:async()=>currentPrincipal()?.id===owner.id?[job({goal:"OWNER_A_ONLY"})]:[],
    get:async()=>new Promise(resolve=>{release=resolve;})});
  await settle(()=>activatePrincipal({...owner,id:"22222222-2222-4222-8222-222222222222",username:"fixture-b"}));
  await settle(()=>release(job({goal:"LATE_A_PRIVATE"})));
  assert.doesNotMatch(body(),/OWNER_A_ONLY|LATE_A_PRIVATE/);assert.match(body(),/本账号的实验（0）/);
  assert.equal(capturePrivateStorage().getItem("sandbox-coding.active.v1"),null);
});

test("rejected regression shows the retained previous version, frozen checks and bounded per-round history; exhausted budget has no step",async()=>{
  const oldChecks=[{id:"zero",passed:true},{id:"two",passed:false,error:"output_mismatch"}];
  const newChecks=[{id:"zero",passed:false,error:"output_mismatch"},{id:"two",passed:true}];
  const item=job({revision:5,status:"budget_exhausted",attemptsUsed:2,maxAttempts:2,best:{source:"n => 0",sourceHash:"b".repeat(64),checks:oldChecks},
    lastAttempt:{number:2,targetCaseId:"two",outcome:"regression",checks:newChecks},
    history:[{number:1,targetCaseId:"zero",outcome:"accepted",passedIds:["zero"],failedIds:["two"],activeMs:47},
      {number:2,targetCaseId:"two",outcome:"regression",passedIds:["two"],failedIds:["zero"],activeMs:51}]});
  await mount({list:async()=>[item],get:async()=>item});await click(/将数字加倍/);
  assert.match(body(),/预算已耗尽/);assert.match(body(),/拒绝回归，保留上一版/);assert.match(body(),/n => 0/);
  assert.match(body(),/保留版本：通过 · 最近一轮：失败/);
  assert.match(body(),/逐轮记录（2）/);assert.match(body(),/检查通过 1\/2/);
  assert.ok(![...win.document.querySelectorAll("button")].some(b=>/调用.*一轮/.test(b.textContent??"")));
});

test("pausing a running task calls only pause and does not dispatch a replacement",async()=>{
  const calls:string[]=[];const running=job({status:"running",revision:4,attemptsUsed:1});
  await mount({list:async()=>[running],get:async()=>running,pause:async(id,revision)=>{calls.push("pause");assert.equal(id,running.id);assert.equal(revision,4);return job({status:"paused",revision:5,attemptsUsed:1});},
    step:async()=>{throw Error("must not dispatch");}});
  await click(/将数字加倍/);await click(/暂停此实验/);assert.deepEqual(calls,["pause"]);assert.match(body(),/已暂停/);assert.equal(btn(/调用.*一轮/).disabled,false);
});

test("permission denial blocks run and pin, and a granted one-off preview cannot mutate older installs",async()=>{
  const checks=["template-integrity","compile"].map(id=>({id,passed:true,name:id,detail:"synthetic"}));
  const time="2026-01-02T00:00:00Z",receipt={profile:"reviewed-builtin-v2",passed:true,timestamp:time,checks};
  const sample={appId:"synthetic-preset",name:"fixture",nameEn:"fixture",icon:"?",version:"1.0.0",description:"synthetic",
    compiledAt:time,installedAt:time,verification:receipt,grantedScopes:[],pinnedToDock:false,codeHash:"a".repeat(64),
    dependencies:{},verifierVersion:"reviewed-builtin-v2",bundleHtml:"<p>synthetic only</p>"};
  const bad={...sample,verification:{...receipt,checks:[checks[0]!,{...checks[1]!,passed:false}]}};
  const store=capturePrivateStorage();
  store.setItem(MICRO_APPS_STORAGE_KEY,JSON.stringify([{...sample,appId:"preexisting-synthetic"}]));
  const originalRecords=store.getItem(MICRO_APPS_STORAGE_KEY);let opens=0;const sessionOnly:boolean[]=[];
  const host=win.document.createElement("div");win.document.body.append(host);root=createRoot(host as unknown as HTMLElement);
  const render=(artifact:typeof sample)=>settle(()=>root!.render(React.createElement(MicroAppPermissionModal,{isOpen:true,artifact,onClose:()=>{},onApprove:(a,pin)=>openReviewedPreset(a,pin,opened=>{opens++;sessionOnly.push(!!opened.sessionOnly);})})));
  await render(bad);assert.match(body(),/1\/2/);assert.equal(btn(/仅单次运行/).disabled,true);assert.equal(btn(/批准并固定/).disabled,true);
  assert.throws(()=>openReviewedPreset(bad,true,()=>opens++));assert.equal(opens,0);
  await render(sample);await click(/仅单次运行/);assert.equal(opens,1);assert.equal(store.getItem(MICRO_APPS_STORAGE_KEY),originalRecords);
  await click(/批准并固定/);assert.equal(opens,2);assert.deepEqual(loadInstalledMicroApps().map(a=>a.appId),["preexisting-synthetic","synthetic-preset"]);
  assert.deepEqual(sessionOnly,[true,false]);
});

test("the shared studio node exposes the real lab separately from manual presets, and a rejecting Host opens nothing",async()=>{
  const calls:string[]=[],guard=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{calls.push((options?.method??"GET")+" "+new URL(String(url)).pathname);
    return String(url).endsWith("/sandbox/build")?Response.json({error:"unreviewed_sandbox_template"},{status:422}):Response.json({tasks:[]});};
  try{
    let opened=0;
    const host=win.document.createElement("div");win.document.body.append(host);root=createRoot(host as unknown as HTMLElement);
    await settle(()=>root!.render(React.createElement(AutopilotStudioWorkspace,{onOpenMicroApp:()=>{opened++;}})));
    const entry=win.document.querySelector('[data-node-id="20"]');assert.ok(entry instanceof win.HTMLButtonElement);
    assert.equal(entry.tagName,"BUTTON", "native buttons own keyboard activation; a DOM keydown alone does not synthesize a click");
    await settle(()=>entry.click());
    assert.ok(win.document.querySelector('section[aria-label="本地模型编码实验台"]'));
    assert.match(body(),/内置微应用 · 手工选择预设/);assert.doesNotMatch(body(),/Agent 生成并构建|3\/3 VM/);
    await click(/编译并审阅权限/);
    assert.equal(opened,0);assert.equal(win.document.querySelector('[role="dialog"]'),null);
    assert.match(body(),/HTTP 422/);assert.deepEqual(calls,["GET /api/v1/agent/runtimes","GET /api/v1/agent/sandbox/coding/tasks","POST /api/v1/agent/sandbox/build"]);
    assert.equal(capturePrivateStorage().getItem(MICRO_APPS_STORAGE_KEY),null);
  } finally {globalThis.fetch=guard;}
});

test("one bounded run authorization survives a read-only remount, polls between rounds and stops at a review receipt",async()=>{
  const calls:string[]=[], sample=job();let running=false,getsSinceRun=0;
  capturePrivateStorage().setItem("sandbox-coding.active.v1",sample.id);
  const complete=job({status:"review_ready",revision:7,attemptsUsed:3,autoRunning:false,
    autoStopReason:"coding_review_ready",best:{source:"n => n * 2",sourceHash:"d".repeat(64),checks:cases.map(c=>({id:c.id,passed:true}))}});
  const client={list:async()=>{calls.push("list");return [sample];},
    get:async()=>{calls.push("get");if(!running)return sample;
      return ++getsSinceRun===1?job({revision:4,attemptsUsed:1,status:"ready",autoRunning:true}):complete;},
    run:async(id:string,revision:number)=>{calls.push("run");assert.equal(id,sample.id);assert.equal(revision,1);running=true;return job({revision:2,autoRunning:true});},
    step:async()=>{calls.push("unapproved step");throw Error("unexpected step");}};
  await mount(client);assert.equal(calls.includes("run"),false);assert.match(body(),/最多还可用 3 轮/);
  await click(/授权连续修复至待审/);assert.equal(calls.filter(c=>c==="run").length,1);assert.match(body(),/连续修复授权中/);
  assert.ok(![...win.document.querySelectorAll("button")].some(b=>/调用.*一轮/.test(b.textContent??"")));
  await unmount();await mount(client);assert.match(body(),/连续修复授权中/);
  await React.act(async()=>{await new Promise(resolve=>setTimeout(resolve,1260));await tick();});
  assert.match(body(),/候选源码 · 待人工审阅/);assert.match(body(),/固定用例已全部通过，等待人工审阅/);assert.doesNotMatch(body(),/连续修复授权中/);
  assert.deepEqual(calls,["list","get","run","list","get","get"]);
});

test("a one-click pause between automatic rounds stops observation without granting another run",async()=>{
  const calls:string[]=[];const between=job({status:"ready",autoRunning:true,attemptsUsed:1,revision:4});
  capturePrivateStorage().setItem("sandbox-coding.active.v1",between.id);
  await mount({list:async()=>[between],get:async()=>between,pause:async(id,revision)=>{calls.push("pause");assert.equal(revision,4);return job({status:"paused",autoRunning:false,autoStopReason:"user_paused",revision:5,attemptsUsed:1});}});
  await click(/暂停此实验/);assert.deepEqual(calls,["pause"]);assert.doesNotMatch(body(),/连续修复授权中/);
  assert.match(body(),/已暂停/);assert.equal(btn(/授权连续修复至待审/).disabled,false);
});

test("a delayed observation at the same revision cannot erase a newer authorization receipt",async()=>{
  const initial=job();capturePrivateStorage().setItem("sandbox-coding.active.v1",initial.id);
  let reads=0,acceptRun!:(value:CodingTask)=>void,lateRead!:(value:CodingTask)=>void,requests=0;
  await mount({list:async()=>[initial],get:async()=>++reads===1?initial:new Promise<CodingTask>(resolve=>{lateRead=resolve;}),
    run:async()=>{requests++;return new Promise<CodingTask>(resolve=>{acceptRun=resolve;});}});
  await click(/授权连续修复至待审/);
  await React.act(async()=>{await new Promise(resolve=>setTimeout(resolve,1250));});assert.equal(typeof lateRead,"function");
  await settle(()=>acceptRun({...initial,autoRunning:true}));assert.match(body(),/连续修复授权中/);
  await settle(()=>lateRead({...initial,autoRunning:false}));assert.match(body(),/连续修复授权中/);assert.equal(requests,1);
});
