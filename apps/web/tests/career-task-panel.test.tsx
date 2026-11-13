import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate as next } from "node:timers/promises";
import { Window } from "happy-dom";
import type { CareerTask, CareerTaskInput, ResumeEditContext } from "@better-me/agent-contracts";
import { careerRuntimeBinding } from "@better-me/agent-contracts";
import type { CareerTaskClient } from "../src/services/career-task-client";
import type { CareerTaskPanelProps } from "../src/components/CareerTaskPanel";
import { activatePrincipal } from "../src/lib/identity";
import { setTimeout as delay } from "node:timers/promises";

registerHooks({ load(url, context, step) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : step(url, context); } });
const win = new Window({ url: "https://career-fixture.invalid" });
const React = await import("react");
const original = new Map<string, PropertyDescriptor | undefined>();
let attemptedNetwork = 0;
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
  HTMLElement: win.HTMLElement, HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLInputElement: win.HTMLInputElement, Element: win.Element,
  Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => { attemptedNetwork++; throw Error("No network in this synthetic fixture"); } })) {
  original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { default: Panel } = await import("../src/components/CareerTaskPanel");
const { AgentSidebarProvider, AgentSurface, useAgentSidebar } = await import("../src/components/AgentSidebar");
const owner = "11111111-1111-4111-8111-111111111111";
const context: ResumeEditContext = { locale: "zh", profile: { headline: { targetRef: { kind: "profile_headline", locale: "zh" }, text: "合成标题" }, skills: [] },
  experiences: [{id:"test-project",organization:"演示机构",title:"演示工程",type:"project",
    claims:[{targetRef:{kind:"claim_text",locale:"zh",experienceId:"test-project",claimId:"s1"},text:"不勾选的保密合成文本",kind:"responsibility",tags:[]}]}] };
const props: CareerTaskPanelProps = { workspaceKey:"fixture-workspace", job:{id:"demo-job",title:"演示岗位",company:"测试公司",description:"合成岗位原句"},
  resumeFields:context,sourceResumeId:"cv-one",sourceResumeName:"合成简历",sourceFingerprint:"fixture-source-fp",
  llmConfig:{provider:"ollama",baseUrl:"http://127.0.0.1:11434/v1",model:"demo-model",temperature:0,apiKey:""},onSave:async()=>({versionId:"new-v1"}) };
let root: ReturnType<typeof createRoot> | undefined;
async function settle(action = () => {}) { await React.act(async () => { action(); await next(); await next(); await next(); }); }
async function mount(client: Partial<CareerTaskClient>, changes: Partial<CareerTaskPanelProps> = {}) {
  if (!root) { const container = win.document.createElement("div"); win.document.body.append(container); root = createRoot(container as unknown as HTMLElement); }
  await settle(() => root!.render(React.createElement(Panel,{ ...props, ...changes, client: client as CareerTaskClient })));
}
async function unmount() { await settle(() => { root?.unmount(); root = undefined; }); win.document.body.replaceChildren(); }
beforeEach(() => activatePrincipal({ id:owner,username:"fixture",displayName:"Fixture" }));
afterEach(async () => { await unmount(); activatePrincipal(undefined); win.localStorage.clear(); assert.equal(attemptedNetwork,0); });
after(() => { win.happyDOM.abort(); for(const [key,desc] of original){if(desc) Object.defineProperty(globalThis,key,desc); else Reflect.deleteProperty(globalThis,key);} });
function button(pattern:RegExp) { const item = [...win.document.querySelectorAll("button")].find(node => pattern.test(node.textContent??"")); assert.ok(item,`missing button ${pattern}`); return item; }
async function click(pattern:RegExp) { await settle(()=>button(pattern).click()); }
async function check(pattern:RegExp) { const label = [...win.document.querySelectorAll("label")].find(node=>pattern.test(node.textContent??"") && node.querySelector('input[type=checkbox]')); assert.ok(label,`missing choice ${pattern}`); await settle(()=>label.querySelector("input")!.click()); }
async function fill(label:RegExp,value:string){
  const wrapper=[...win.document.querySelectorAll("label")].find(e=>label.test(e.textContent??"")&&e.querySelector("textarea,input"));
  const el=wrapper?.querySelector("textarea,input");assert.ok(el,`missing field ${label}`);
  await settle(()=>{const proto=el.tagName==="TEXTAREA"?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(el,value);el.dispatchEvent(new win.Event("input",{bubbles:true}));});
}

test("opening a task never starts a model: only the individually selected fields are sent after consent", async () => {
  let input: CareerTaskInput | undefined, ran = 0; let task: CareerTask;
  const client: Partial<CareerTaskClient> = { list:async()=>[],create:async body=>{
    input=body as CareerTaskInput;
    task={...input,revision:1,status:"ready",id:"fixture-task",ownerId:owner,createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z",
      directories:[],usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[],evidence:[],facts:[]};return task;
  },run:async()=>{ran++;return {...task,status:"paused",revision:2};} };
  await mount(client); assert.equal(input,undefined); assert.equal(ran,0); assert.equal(button(/授权并启动/).disabled,true);
  await check(/合成标题/); assert.equal(button(/授权并启动/).disabled,true);
  await check(/允许本任务/); await click(/授权并启动/);
  assert.equal(ran,1); assert.equal(input!.resume.fields.length,1); assert.equal(input!.resume.fields[0]!.originalText,"合成标题");
  assert.deepEqual(input!.toolPolicy,{allowBuild:false,installedVersionIds:[]},"building and installed versions are not implicitly granted");
  assert.equal(JSON.stringify(input).includes("不勾选的保密合成文本"),false); assert.equal(JSON.stringify(input).includes("apiKey"),false);
});

test("writing handoff prepares exactly one anchored field and attributed statement, never carrying old grants",async()=>{
  let input:CareerTaskInput|undefined,runs=0;let server:CareerTask;
  const client:Partial<CareerTaskClient>={list:async()=>[],create:async body=>{input=body as CareerTaskInput;server={...input,id:"ct_writing",ownerId:owner,revision:1,status:"ready",createdAt:"now",updatedAt:"now",directories:[],usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[],evidence:[],facts:[]};return server;},run:async()=>{runs++;return {...server,status:"paused",revision:2};}};
  await mount(client,{initialFocus:{id:"synthetic-focus",sourceResumeId:props.sourceResumeId!,sourceFingerprint:props.sourceFingerprint!,targetRef:context.profile.headline!.targetRef,originalText:"合成标题",label:"合成标题",userStatement:"我只负责接口测试，未负责上线。"}});
  assert.equal(input,undefined);assert.equal(runs,0);assert.equal(button(/授权并启动/).disabled,true);
  assert.equal([...win.document.querySelectorAll('input[type=checkbox]')].filter(i=>(i as unknown as {checked:boolean}).checked).length,1,"only the requested field is selected, not the authorization");
  await check(/允许本任务将以上资料/);await click(/授权并启动/);
  assert.equal(runs,1);assert.equal(input!.resume.fields.length,1);assert.equal(input!.materials.length,1);
  assert.equal(input!.materials[0]!.kind,"user_statement");assert.equal(input!.materials[0]!.text,"我只负责接口测试，未负责上线。");
  assert.ok(!JSON.stringify(input).includes("不勾选的保密合成文本"));assert.deepEqual(input!.toolPolicy,{allowBuild:false,installedVersionIds:[]});
});

test("stale writing anchors do not select a replacement field or authorize a request",async()=>{
  let calls=0;await mount({list:async()=>[],create:async()=>{calls++;throw Error("must not send");}},{initialFocus:{id:"stale-focus",sourceResumeId:props.sourceResumeId!,sourceFingerprint:"old-fingerprint",targetRef:context.profile.headline!.targetRef,originalText:"旧标题",label:"旧原句"}});
  assert.match(win.document.body.textContent!,/旁写原稿已变化/);await check(/合成标题/);await check(/允许本任务将以上资料/);
  assert.equal(button(/授权并启动/).disabled,true);assert.equal(calls,0);
});

test("opting into task-local tool building invalidates prior consent without dispatching anything",async()=>{
  let runs=0;
  await mount({list:async()=>[],run:async()=>{runs++;throw Error("must not run");}});
  await check(/合成标题/);await check(/允许本任务将以上资料/);assert.equal(button(/授权并启动/).disabled,false);
  await check(/允许在本任务内构建纯 JSON 工具/);
  assert.equal(button(/授权并启动/).disabled,true,"tool policy is part of the immutable consent snapshot");assert.equal(runs,0);
});

function reviewFixture(overrides:Partial<CareerTask>={}):CareerTask{
  const at="2026-01-01T00:01:02Z";
  const targetRef=context.profile.headline!.targetRef, other=context.experiences[0]!.claims[0]!.targetRef;
  return {id:"ct_demo",ownerId:owner,workspaceKey:props.workspaceKey,rootScopeKey:props.workspaceKey,objective:"合成任务",status:"awaiting_review",revision:4,createdAt:at,updatedAt:at,
    job:{id:"demo-job",title:"演示岗位",company:"测试公司",description:"合成岗位原句"},
    resume:{id:"cv-one",name:"合成简历",sourceFingerprint:"fixture-source-fp",fields:[{id:"f1",targetRef,originalText:"合成标题"},{id:"f2",targetRef:other,originalText:"原句2"}]},
    runtimeBinding:careerRuntimeBinding({kind:"model",modelSettings:props.llmConfig!}),materials:[],directories:[],budget:{maxModelCalls:12,maxToolCalls:30,maxActiveMs:600000},
    usage:{modelCalls:3,toolCalls:2,activeMs:5100},events:[{sequence:1,at,kind:"tool_result",detail:"合成读取成功，返回两条。"}],
    evidence:[{id:"ev",kind:"user_statement",sourceId:"answer:synthetic",label:"本人本轮补充",excerpt:"我负责设计。",hash:"fp"}],
    facts:[{id:"fx",text:"我负责设计。",evidenceIds:["ev"],status:"proposed"}],draft:{hash:"draft-one",unknowns:["是否上线仍未知"],patches:[
      {id:"p1",fieldId:"f1",targetRef,originalText:"合成标题",proposedText:"设计服务接口",evidenceIds:["ev"],rationale:"澄清工作范围"},
      {id:"p2",fieldId:"f2",targetRef:other,originalText:"原句2",proposedText:"第二条改写",evidenceIds:["ev"],rationale:"澄清表达"}]},
    ...overrides};
}
async function openHistory(client:Partial<CareerTaskClient>,changes:Partial<CareerTaskPanelProps>={}){await mount(client,changes);await click(/演示岗位 ·/);}
test("returning from writing retains the original task, ledger and checked review; reload with a focus cannot hide its saved pointer",async()=>{
  const server=reviewFixture();let mutations=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,create:async()=>{mutations++;throw Error("must not create");},run:async()=>{mutations++;return server;}};
  await openHistory(client);await check(/批准第 1 条/);
  const focus={id:"return-focus",sourceResumeId:server.resume.id,sourceFingerprint:server.resume.sourceFingerprint,targetRef:context.profile.headline!.targetRef,originalText:"合成标题",label:"个人简介",userStatement:"新的本人补充，尚未发送。"};
  await mount(client,{initialObjective:"从旁写回到原任务",initialFocus:focus});
  assert.match(win.document.body.textContent!,/仍是同一任务 ct_demo/);assert.match(win.document.body.textContent!,/模型 3\/12/);
  assert.ok([...win.document.querySelectorAll("label")].find(l=>/批准第 1 条/.test(l.textContent??""))!.querySelector("input")!.checked);
  assert.equal(mutations,0);assert.equal(server.materials.length,0);assert.equal(server.facts.length,1);
  await unmount();await mount(client,{initialObjective:"从旁写恢复",initialFocus:focus});
  assert.match(win.document.body.textContent!,/仍是同一任务 ct_demo/);assert.equal(mutations,0);
});

test("after approval switches to the new edition, its completed task retains the historical source without a false stale-input alert",async()=>{
  const server=reviewFixture({status:"completed",receipt:{versionId:"new-edition",draftHash:"draft-one",approvedPatchIds:["p1"],at:"now"}});
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server};
  const initialFocus={id:"saved-focus",sourceResumeId:server.resume.id,sourceFingerprint:server.resume.sourceFingerprint,targetRef:context.profile.headline!.targetRef,originalText:"合成标题",label:"个人简介"};
  await openHistory(client,{initialFocus});await mount(client,{initialFocus,sourceResumeId:"new-edition",sourceFingerprint:"new-fingerprint"});
  assert.match(win.document.body.textContent!,/任务原句（历史）/);assert.ok(!win.document.body.textContent!.includes("旁写原稿已变化"));
  assert.match(win.document.body.textContent!,/已收到版本回执/);
});

test("a writing supplement can prepare the current question's answer, but only an explicit task grant sends it",async()=>{
  const server=reviewFixture({status:"awaiting_answer",question:"你负责哪部分？",draft:undefined,facts:[]});let runs=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,run:async(id,op,body)=>{runs++;assert.equal(id,server.id);assert.equal(op,"answer");assert.equal(body.answer,"只参与接口测试，不负责上线。");return {...server,status:"awaiting_review",revision:5};}};
  await openHistory(client);await mount(client,{initialFocus:{id:"answer-focus",sourceResumeId:server.resume.id,sourceFingerprint:server.resume.sourceFingerprint,targetRef:context.profile.headline!.targetRef,originalText:"合成标题",label:"个人简介",userStatement:"只参与接口测试，不负责上线。"}});
  await click(/将这段补充放入本任务回答框/);assert.equal(runs,0);
  await check(/允许本任务将以上资料/);await click(/确认回答并继续/);assert.equal(runs,1);assert.deepEqual(server.facts,[]);
});
test("saving just the checked proposal requires a business receipt; independent fact rejection is not a resume update",async()=>{
  let server=reviewFixture(),versions=0, factWrites=0,hostReceipts=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,
    fact:async(_id,id,choice)=>{assert.equal(choice,"reject");server={...server,revision:5,facts:server.facts.map(f=>({...f,status:f.id===id?"rejected":f.status}))};return server;},
    receipt:async(_id,body)=>{assert.equal(body.versionId,"new-v2");assert.equal(body.receiptId,"business-r2");assert.deepEqual(body.approvedPatchIds,["p2"]);hostReceipts++;
      server={...server,status:"completed",revision:6,receipt:{...body,at:"2026-01-01T00:01:02Z"}};return server;}};
  await openHistory(client,{onSave:async (_task,ids)=>{versions++;assert.deepEqual(ids,["p2"]);return {versionId:"new-v2",receiptId:"business-r2"};},onCommitFact:async()=>{factWrites++;}});
  assert.equal(button(/保存已批准/).disabled,true);assert.match(win.document.body.textContent!,/是否上线仍未知/);
  await click(/不记入长期事实/);assert.equal(versions,0);assert.equal(factWrites,0);
  await check(/批准第 2 条/);await click(/保存已批准/);assert.equal(versions,1);assert.equal(hostReceipts,1);assert.equal(factWrites,0);assert.match(win.document.body.textContent!,/new-v2/);assert.match(win.document.body.textContent!,/business-r2/);
});

test("a new instruction changes the form, and changing the model clears its earlier grant",async()=>{
  const client={list:async()=>[]};await mount(client,{initialObjective:"合成新的交付目标"});assert.equal(win.document.querySelector("textarea")!.value,"合成新的交付目标");
  await check(/合成标题/);await check(/允许本任务/);assert.equal(button(/授权并启动/).disabled,false);
  await mount(client,{llmConfig:{...props.llmConfig!,model:"second-model"}});
  assert.equal(button(/授权并启动/).disabled,true);assert.match(win.document.body.textContent!,/second-model/);
  await mount(client,{llmConfig:undefined});assert.equal(button(/授权并启动/).disabled,true);assert.match(win.document.body.textContent!,/没有明确选择/);
});
test("advisor and sidecar share a mounted task, preserving review choices when hidden or given another instruction",async()=>{
  const server=reviewFixture();let mutations=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,run:async()=>{mutations++;return server;}};
  function SharedView(){
    const sidebar=useAgentSidebar()!,[instruction,setInstruction]=React.useState("第一个目标");
    return <><button onClick={()=>sidebar.show("conversation","task")}>从顾问打开任务</button><button onClick={()=>{setInstruction("第二个目标");sidebar.show("conversation","task");}}>再次进入同一任务</button>
      <AgentSurface name="task"><Panel {...props} initialObjective={instruction} client={client as CareerTaskClient}/></AgentSurface></>;
  }
  const container=win.document.createElement("div");win.document.body.append(container);root=createRoot(container as unknown as HTMLElement);
  await settle(()=>root!.render(<AgentSidebarProvider><SharedView/></AgentSidebarProvider>));
  await click(/从顾问打开任务/);await click(/演示岗位 ·/);await check(/批准第 2 条/);
  const panel=win.document.querySelector(".career-task-panel");
  await settle(()=>win.document.querySelector<import("happy-dom").HTMLButtonElement>('button[aria-label="收起 BetterMe Agent"]')!.click());await click(/再次进入同一任务/);
  assert.equal(win.document.querySelector(".career-task-panel"),panel,"navigation does not remount the task controller");
  assert.ok([...win.document.querySelectorAll("label")].find(label=>/批准第 2 条/.test(label.textContent??""))!.querySelector("input")!.checked);
  assert.equal(win.document.querySelectorAll(".career-task-panel").length,1);assert.equal(mutations,0);
});
test("closing and reopening a running task does not cancel or resume it; pause and revoke require separate user actions",async()=>{
  const ops:string[]=[],signals:AbortSignal[]=[];let server=reviewFixture({status:"running",draft:undefined,facts:[]});
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async(_id,signal)=>{if(signal)signals.push(signal);return server;},
    control:async(_id,op)=>{ops.push(op);server={...server,revision:server.revision+1,status:op==="pause"?"paused":"revoked"};return server;},
    run:async(_id,op,input)=>{ops.push(op);assert.equal(input.consent,true);server={...server,revision:server.revision+1,status:"running"};return server;}};
  await openHistory(client,{pollIntervalMs:3});
  await React.act(async()=>{await delay(12);});assert.ok(signals.length);await unmount();
  assert.equal(signals[0]!.aborted,true);assert.deepEqual(ops,[]);
  await mount(client);assert.match(win.document.body.textContent!,/正在执行/);assert.deepEqual(ops,[]);
  await click(/暂停任务/);assert.equal(button(/确认资料与底座并继续/).disabled,true);
  await check(/允许本任务/);await click(/确认资料与底座并继续/);await click(/撤销本任务授权/);assert.deepEqual(ops,["pause","resume","revoke"]);
  assert.match(win.document.body.textContent!,/授权已撤销/);
});
test("budget is cumulative; raising a ceiling requires its own consent and does not resume the model", async()=>{
  let server=reviewFixture({status:"budget_exhausted",usage:{modelCalls:12,toolCalls:5,activeMs:5000},draft:undefined,facts:[]}),edits=0,runs=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,budget:async(_id,input)=>{edits++;server={...server,revision:5,budget:input.budget};return server;},
    run:async()=>{runs++;return {...server,status:"running",revision:6};}};
  await openHistory(client);await check(/允许本任务/);assert.equal(button(/确认资料与底座并继续/).disabled,true);
  await fill(/模型调用（次）/,"15");assert.equal(button(/确认增加预算/).disabled,true);
  await check(/我确认增加此任务额度/);await click(/确认增加预算/);assert.equal(edits,1);assert.equal(runs,0);
  assert.match(win.document.body.textContent!,/模型 12\/15 次/);assert.equal(button(/确认资料与底座并继续/).disabled,true);
  await check(/允许本任务/);await click(/确认资料与底座并继续/);assert.equal(runs,1);
});
test("new information is only an answer; it cannot implicitly create or approve a long-term fact",async()=>{
  const server=reviewFixture({status:"awaiting_answer",question:"你设计了什么？",questionEvidenceIds:["ev"],draft:undefined,facts:[]});
  let ran=0,facts=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],run:async(_id,op,input)=>{assert.equal(op,"answer");assert.equal(input.answer,"只负责设计。");ran++;return {...server,status:"running",revision:5};},
    fact:async()=>{facts++;return server;},proposeFact:async()=>{facts++;return server;}};
  await openHistory(client);await fill(/只用于这项任务的回答/,"只负责设计。");await check(/允许本任务/);await click(/确认回答并继续/);assert.equal(ran,1);assert.equal(facts,0);
});
test("an unassociated legacy task stays readable but cannot dispatch through a newly scoped entry",async()=>{
  const server=reviewFixture({rootScopeKey:undefined,status:"awaiting_answer",question:"旧记录追问",draft:undefined});let runs=0;
  await openHistory({list:async()=>[server],run:async()=>{runs++;return server;}});
  assert.match(win.document.body.textContent!,/旧记录追问/);await fill(/只用于这项任务的回答/,"原草稿保留");await check(/允许本任务/);await click(/确认回答并继续/);
  assert.equal(runs,0);assert.match(win.document.body.textContent!,/旧记录尚未关联/);
});
test("a changed draft blocks the stale approval, even when the old buttons were still visible",async()=>{
  const server=reviewFixture(),changed=reviewFixture({revision:5,draft:{...server.draft!,hash:"changed"}});let saves=0,receipts=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>changed,receipt:async()=>{receipts++;return changed;}};
  await openHistory(client,{onSave:async()=>{saves++;return{versionId:"unexpected"};}});await check(/批准第 1 条/);
  await click(/保存已批准/);assert.equal(saves,0);assert.equal(receipts,0);assert.match(win.document.querySelector('[role="alert"]')!.textContent!,/草稿已变化/);
  assert.equal(button(/保存已批准/).disabled,true);
});
test("lost host receipt after successful local save can be recovered after reload without writing a second version",async()=>{
  let server=reviewFixture(),saves=0,receipts=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,receipt:async(_id,input)=>{
    if(++receipts===1)throw Error("回执超时");server={...server,status:"completed",revision:5,receipt:{...input,at:"2026-01-01T03:00:00Z"}};return server;}};
  const onSave=async()=>{saves++;return{versionId:"persisted-one"};};
  await openHistory(client,{onSave});await check(/批准第 1 条/);await click(/保存已批准/);assert.match(win.document.body.textContent!,/宿主回执待核对/);
  await unmount();await mount(client,{onSave,onReconcile:async()=>({state:"current",receipt:{versionId:"persisted-one",draftHash:"draft-one",approvedPatchIds:["p1"]}})});await click(/仅核对并补写回执/);assert.equal(saves,1);assert.equal(receipts,2);assert.match(win.document.body.textContent!,/已保存独立版本：persisted-one/);
});
test("default budgets and the task pointer stay with the current account; materials and credentials are not browser preferences",async()=>{
  const client={list:async()=>[]};await mount(client,{llmConfig:{...props.llmConfig!,apiKey:"fixture-never-persist"}});
  await fill(/模型调用（次）/,"18");await click(/设为本账号默认预算/);await unmount();
  await mount(client);assert.equal(win.document.querySelector('input[type="number"]')!.getAttribute("value"),"18");await unmount();
  activatePrincipal({id:"22222222-2222-4222-8222-222222222222",username:"fixture-b",displayName:"B"});
  await mount(client);assert.equal(win.document.querySelector('input[type="number"]')!.getAttribute("value"),"12");
  const saved=Array.from({length:win.localStorage.length},(_,i)=>{const k=win.localStorage.key(i)!;return [k,win.localStorage.getItem(k)];});
  assert.equal(saved.length,1);assert.match(saved[0]![0]!,/betterme.owner.v1:11111111-/);assert.doesNotMatch(JSON.stringify(saved),/fixture-never-persist|合成标题|不勾选的保密合成文本/);
});
test("after a real fact write with a lost host acknowledgment, refresh cannot reject it or write it twice",async()=>{
  let server=reviewFixture(),writes=0,reports=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,fact:async(_id,_fid,decision)=>{
    assert.equal(decision,"approve");if(++reports===1)throw Error("合成断线");server={...server,revision:5,facts:server.facts.map(f=>({...f,status:"approved"}))};return server;}};
  const onCommitFact=async()=>{writes++;};await openHistory(client,{onCommitFact});await click(/单独确认长期本人陈述/);assert.equal(writes,1);
  await unmount();await mount(client,{onCommitFact,onReconcile:async()=>({state:"current"})});assert.equal(win.document.body.textContent!.includes("不记入长期事实"),false);
  await click(/仅补写事实回执/);assert.equal(writes,1);assert.equal(reports,2);assert.match(win.document.body.textContent!,/本人已单独确认/);
});
test("lost browser pointer with changed active source can recover only existing Workspace evidence; a removed edition cannot complete the Host task",async()=>{
  let server=reviewFixture(),receipts=0,saves=0,exists=false;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,receipt:async(_id,input)=>{receipts++;server={...server,status:"completed",receipt:{...input,at:server.updatedAt}};return server;}};
  await openHistory(client,{sourceResumeId:"other-active-version",onSave:async()=>{saves++;throw Error("must never write");},
    onReconcile:async()=>exists?{state:"current",receipt:{versionId:"exact-version",receiptId:"exact-receipt",draftHash:"draft-one",approvedPatchIds:["p2"]}}:{state:"missing"}});
  await click(/查找已保存版本并补写回执/);assert.equal(receipts,0);assert.match(win.document.body.textContent!,/未找到|已移除/);
  exists=true;await click(/查找已保存版本并补写回执/);assert.equal(receipts,1);assert.equal(saves,0);
});
test("delivery pointers survive history restore, but removed or edited business data cannot be acknowledged",async()=>{
  const server=reviewFixture();let receiptPosts=0,factPosts=0,versions=0,statements=0;
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,
    receipt:async()=>{receiptPosts++;throw Error("synthetic lost receipt");},fact:async()=>{factPosts++;throw Error("synthetic lost fact acknowledgment");}};
  const writes={onSave:async()=>{versions++;return {versionId:"dropped-version"};},onCommitFact:async()=>{statements++;}};
  await openHistory(client,writes);await check(/批准第 1 条/);await click(/保存已批准/);
  await click(/刷新状态/);await click(/单独确认长期本人陈述/);
  assert.deepEqual([receiptPosts,factPosts,versions,statements],[1,1,1,1]);
  await unmount();await mount(client,{...writes,onReconcile:async(_,q)=>({state:q.kind==="resume"?"edited":"missing"})});
  await click(/仅核对并补写回执/);assert.match(win.document.body.textContent!,/后来已编辑/);
  await click(/仅补写事实回执/);assert.match(win.document.body.textContent!,/未找到本人陈述/);
  assert.deepEqual([receiptPosts,factPosts,versions,statements],[1,1,1,1]);
});
test("without the fact-delivery pointer a durable fact is never falsely rejected and is recovered without another write",async()=>{
  let server=reviewFixture(),writes=0;
  const decisions:string[]=[];
  const client:Partial<CareerTaskClient>={list:async()=>[server],get:async()=>server,fact:async(_id,_factId,decision)=>{
    decisions.push(decision);server={...server,revision:5,facts:server.facts.map(f=>({...f,status:"approved"}))};return server;}};
  await openHistory(client,{onCommitFact:async()=>{writes++;},onReconcile:async()=>({state:"current"})});
  await click(/不记入长期事实/);assert.deepEqual(decisions,[]);
  await click(/查找已有陈述并补写事实回执/);
  assert.deepEqual(decisions,["approve"]);assert.equal(writes,0);
});
