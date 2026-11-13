import assert from "node:assert/strict";
import test,{after,afterEach} from "node:test";
import {registerHooks} from "node:module";
import {Window} from "happy-dom";
import {createHash} from "node:crypto";
import type {FreeChatTask} from "@better-me/agent-contracts";
import {activatePrincipal} from "../src/lib/identity";
import type {defaultTaskLedgerClient} from "../src/services/agent-task-scope";
registerHooks({load(url,context,next){return url.endsWith(".css")?{format:"module",source:"",shortCircuit:true}:next(url,context);}});
const dom=new Window({url:"http://synthetic-ledger.invalid"}),React=await import("react"),originals=new Map<string,PropertyDescriptor|undefined>();
for(const [key,value]of Object.entries({window:dom,document:dom.document,navigator:dom.navigator,HTMLElement:dom.HTMLElement,Element:dom.Element,Node:dom.Node,Event:dom.Event,React,IS_REACT_ACT_ENVIRONMENT:true})){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
const {createRoot}=await import("react-dom/client"),{AgentTaskLedger}=await import("../src/components/AgentTaskLedger"),{act}=React;
let mounted:ReturnType<typeof createRoot>|undefined;
const ownerId="11111111-1111-4111-8111-111111111111",budget={maxModelCalls:3,maxToolCalls:5,maxActiveMs:60000};
const noAssociation={legacy:async()=>assert.fail("legacy preview requires explicit click"),associate:async()=>assert.fail("association requires explicit confirmation")};
function fixture():FreeChatTask{return {id:"ct_synthetic_root",ownerId,kind:"free_chat",workspaceKey:"advisor",rootScopeKey:"synthetic-ledger",rootTaskId:"ct_synthetic_root",objective:"合成",revision:1,status:"awaiting_answer",createdAt:"now",updatedAt:"now",runtimeBinding:{id:"native:codex",label:"合成本机工具",location:"local"},budget:{...budget},usage:{modelCalls:1,toolCalls:0,activeMs:20},rootLedger:{rootTaskId:"ct_synthetic_root",budget:{...budget},usage:{modelCalls:3,toolCalls:2,activeMs:50},memberCount:3},events:[],sourceFingerprint:"synthetic",turn:1,conversation:{messages:[{id:"u1",role:"user",content:"合成"}]}};}
async function render(client:typeof defaultTaskLedgerClient){activatePrincipal({id:ownerId,username:"synthetic",displayName:"Synthetic"});const host=dom.document.createElement("div");dom.document.body.append(host);mounted=createRoot(host as unknown as Element);await act(async()=>mounted!.render(<AgentTaskLedger rootScopeKey="synthetic-ledger" client={client}/>));}
const button=(text:string)=>{const found=[...dom.document.querySelectorAll("button")].find(item=>item.textContent===text);assert.ok(found,text);return found;};
afterEach(async()=>{await act(async()=>mounted?.unmount());mounted=undefined;activatePrincipal(undefined);dom.document.body.replaceChildren();});
after(()=>{dom.happyDOM.abort();for(const [key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});

test("shared ledger displays aggregate usage; only an exact explicit limit confirmation mutates metadata",async()=>{
  let root=fixture(),reads=0,changes=0;const client:typeof defaultTaskLedgerClient={...noAssociation,read:async()=>{reads++;return {root,members:[root]};},budget:async(before,next)=>{changes++;assert.equal(before.revision,1);root={...root,budget:next,revision:2,rootLedger:{...root.rootLedger!,budget:next}};return root;},pause:async()=>assert.fail("no implicit pause")};
  await render(client);assert.equal(reads,1);assert.equal(changes,0);assert.equal(dom.document.querySelector("details")!.open,false);assert.match(dom.document.querySelector("summary")!.textContent!,/模型 3\/3/);
  await act(async()=>dom.document.querySelector("summary")!.click());assert.match(dom.document.body.textContent!,/3 项任务/);assert.equal(button("确认调整根额度").disabled,true);
  const input=dom.document.querySelector('input[type="number"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype,"value")!.set!.call(input,"4");input.dispatchEvent(new dom.Event("input",{bubbles:true}));});
  assert.equal(changes,0);assert.equal(button("确认调整根额度").disabled,true);
  await act(async()=>dom.document.querySelector('input[type="checkbox"]')!.dispatchEvent(new dom.MouseEvent("click",{bubbles:true})));
  assert.equal(button("确认调整根额度").disabled,false);await act(async()=>button("确认调整根额度").click());
  assert.equal(changes,1);assert.equal(reads,2);assert.equal(root.rootLedger!.usage.modelCalls,3);assert.equal(root.budget.maxModelCalls,4);assert.equal((dom.document.querySelector('input[type="checkbox"]') as unknown as HTMLInputElement).checked,false);
  await act(async()=>button("刷新根账（不推理）").click());assert.equal(reads,3);assert.equal(changes,1);
});

test("running members require a manual group stop; failures keep the current ledger and never retry",async()=>{
  const root=fixture(),child={...root,id:"ct_child",status:"running" as const,parentTaskId:root.id};let pauses=0,reads=0;
  const client:typeof defaultTaskLedgerClient={...noAssociation,read:async()=>{reads++;return {root,members:[root,child]};},budget:async()=>assert.fail("running budget cannot change"),pause:async()=>{pauses++;throw new Error("合成修订冲突，请刷新核对");}};
  await render(client);await act(async()=>dom.document.querySelector("summary")!.click());assert.equal(button("确认调整根额度").disabled,true);assert.equal(pauses,0);
  await act(async()=>button("停止整组运行").click());assert.equal(pauses,1);assert.equal(reads,1);assert.match(dom.document.querySelector('[role="alert"]')!.textContent!,/修订冲突/);assert.match(dom.document.querySelector("summary")!.textContent!,/模型 3\/3/);
});

test("root ledger exposes all member output handles without automatic body reads or budget mutation",async(t)=>{
  const text="\ufeff  根账中的完整原文😀\r\nEND  ",root={...fixture(),id:"ct_"+"a".repeat(32)},child={...fixture(),id:"ct_"+"b".repeat(32),parentTaskId:root.id,rootTaskId:root.id,outputArtifacts:[{id:"out_"+"c".repeat(32),bytes:Buffer.byteLength(text),hash:createHash("sha256").update(text).digest("hex"),createdAt:"now"}]};
  let reads=0;t.mock.method(globalThis,"fetch",async(url,init)=>{reads++;assert.equal(init?.method,"GET");assert.ok(String(url).endsWith(`/tasks/${child.id}/outputs/${child.outputArtifacts[0]!.id}`));return new Response(text,{headers:{"Content-Type":"text/plain"}});});
  const client:typeof defaultTaskLedgerClient={...noAssociation,read:async()=>({root,members:[root,child]}),budget:async()=>assert.fail("read does not adjust budget"),pause:async()=>assert.fail("read does not stop task")};
  await render(client);assert.match(dom.document.querySelector("summary")!.textContent!,/原始输出 1 项任务/);assert.equal(reads,0);
  await act(async()=>dom.document.querySelector("summary")!.click());assert.equal(reads,0);
  await act(async()=>button("读取完整原文").click());
  for(let i=0;i<50&&!dom.document.querySelector('[aria-label="完整原始输出正文"]');i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
  assert.equal(reads,1);assert.equal(dom.document.querySelector('[aria-label="完整原始输出正文"]')!.textContent,text);
});

test("legacy preview is explicit, exact confirmation associates only metadata and refreshes the original root",async()=>{
  const root={...fixture(),id:`ct_${"a".repeat(32)}`,rootTaskId:`ct_${"a".repeat(32)}`},candidate={rootTaskId:root.id,objective:"  完整旧任务😀\r\nEND  ",workspaceKey:"old-view",status:"awaiting_answer",updatedAt:"now",runtimeBinding:root.runtimeBinding,ledger:{...root.rootLedger!,rootTaskId:root.id},previewToken:"b".repeat(64)};
  let reads=0,previews=0,associations=0,linked=false;
  const client:typeof defaultTaskLedgerClient={...noAssociation,read:async()=>{reads++;return linked?{root,members:[root]}:undefined;},budget:async()=>assert.fail("no budget adjustment"),pause:async()=>assert.fail("no task execution"),legacy:async scope=>{previews++;return {ownerId,rootScopeKey:scope,candidates:[candidate]};},associate:async(scope,selected)=>{associations++;assert.equal(selected.previewToken,candidate.previewToken);linked=true;return {task:root,association:{ownerId,rootTaskId:root.id,rootScopeKey:scope,previewToken:selected.previewToken!,associatedAt:"2026-11-12T00:00:00.000Z",memberIds:[root.id],effect:"records_and_usage_only"}};}};
  await render(client);assert.equal(reads,1);assert.equal(previews,0);
  await act(async()=>button("读取可关联旧根账（不推理）").click());assert.equal(previews,1);assert.equal(associations,0);assert.equal(dom.document.querySelector("strong")!.textContent,candidate.objective);
  assert.equal(button("确认关联原根账").disabled,true);
  await act(async()=>dom.document.querySelector('input[type="radio"]')!.dispatchEvent(new dom.MouseEvent("click",{bubbles:true})));
  assert.equal(button("确认关联原根账").disabled,true);
  await act(async()=>dom.document.querySelector('input[type="checkbox"]')!.dispatchEvent(new dom.MouseEvent("click",{bubbles:true})));
  await act(async()=>button("确认关联原根账").click());assert.equal(associations,1);assert.equal(reads,2);assert.match(dom.document.body.textContent!,/已关联原根/);assert.equal(root.rootLedger.usage.modelCalls,3);
});

test("owner generation change clears old preview and aggregate totals without sending or adopting a late result",async()=>{
  const root={...fixture(),id:`ct_${"a".repeat(32)}`},pending=Promise.withResolvers<Awaited<ReturnType<typeof defaultTaskLedgerClient.legacy>>>();let legacyReads=0;
  const client:typeof defaultTaskLedgerClient={...noAssociation,read:async()=>({root,members:[root]}),budget:async()=>assert.fail("no budget"),pause:async()=>assert.fail("no pause"),legacy:async()=>{legacyReads++;return pending.promise;}};
  await render(client);await act(async()=>button("读取可关联旧根账（不推理）").click());assert.equal(legacyReads,1);
  await act(async()=>activatePrincipal({id:"22222222-2222-4222-8222-222222222222",username:"other",displayName:"Other"}));
  pending.resolve({ownerId,rootScopeKey:"synthetic-ledger",candidates:[]});await act(async()=>{await pending.promise;});
  assert.equal(button("读取可关联旧根账（不推理）").disabled,true);assert.equal(button("刷新根账（不推理）").disabled,true);assert.doesNotMatch(dom.document.querySelector("summary")!.textContent!,/模型 3\/3/);assert.match(dom.document.body.textContent!,/旧账预览已清除/);
});

test("a late ledger refresh cannot publish the former workspace after a scope change",async()=>{
  const old=fixture(),next={...fixture(),rootScopeKey:"new-scope",rootLedger:{...fixture().rootLedger!,usage:{modelCalls:0,toolCalls:0,activeMs:0}}},pending=Promise.withResolvers<{root:FreeChatTask;members:FreeChatTask[]}>();let reads=0;
  const client:typeof defaultTaskLedgerClient={...noAssociation,read:async scope=>{reads++;return scope==="new-scope"?{root:next,members:[next]}:reads===1?{root:old,members:[old]}:pending.promise;},budget:async()=>assert.fail("no budget"),pause:async()=>assert.fail("no pause")};
  await render(client);await act(async()=>button("刷新根账（不推理）").click());
  await act(async()=>mounted!.render(<AgentTaskLedger rootScopeKey="new-scope" client={client}/>));assert.match(dom.document.querySelector("summary")!.textContent!,/模型 0\/3/);
  pending.resolve({root:old,members:[old]});await act(async()=>{await pending.promise;});assert.match(dom.document.querySelector("summary")!.textContent!,/模型 0\/3/);assert.equal(reads,3);
});
