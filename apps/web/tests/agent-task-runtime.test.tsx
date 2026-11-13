import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Window } from "happy-dom";
import { selectAgentTaskRuntime, useAgentTaskRuntime } from "../src/lib/agent-task-runtime";

const config={provider:"ollama" as const,model:"configured-only",baseUrl:"http://127.0.0.1:1/v1",apiKey:""};
const account={kind:"chatgpt" as const,profileId:"fixture-profile",model:"fixture-gpt",ready:true};
// Complete async DOM setup before registering even the pure tests, so Node
// cannot run the file's teardown while react-dom is still importing.
const dom=new Window({url:"http://task-runtime-fixture.invalid"});
const globals={window:dom,document:dom.document,navigator:dom.navigator,IS_REACT_ACT_ENVIRONMENT:true};
const descriptors=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
const {createElement,act}=await import("react"),{createRoot}=await import("react-dom/client");
after(()=>{dom.happyDOM.abort();for(const [key,value]of descriptors)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);});
test("explicit account selection never becomes a configured model, including unavailable accounts",()=>{
  assert.deepEqual(selectAgentTaskRuntime(config,undefined,account),{runtime:{kind:"chatgpt",profileId:account.profileId,model:account.model},preferredRuntimeId:undefined,label:"ChatGPT · fixture-gpt",error:undefined});
  for(const choice of [{...account,ready:false},{...account,profileId:""},{...account,model:""}]){
    const selected=selectAgentTaskRuntime(config,undefined,choice);assert.equal(selected.runtime.kind,"chatgpt");assert.match(selected.error!,/不会改用/);
  }
});
test("explicit unified routing has priority; unresolved routing fails closed",()=>{
  const selected=selectAgentTaskRuntime(config,{enabled:true,blocked:false,policy:{revision:7,preferred:"codex"}},account);
  assert.deepEqual(selected,{runtime:{kind:"unified",expectedRevision:7},preferredRuntimeId:"codex",label:"Agent 底座 · codex",error:undefined});
  assert.match(selectAgentTaskRuntime(config,{enabled:false,blocked:true},account).error!,/未使用旧 API/);
  assert.equal(selectAgentTaskRuntime(config,{enabled:true,blocked:true},account).runtime.kind,"unified");
  assert.equal(selectAgentTaskRuntime(config,undefined,{...account,kind:"current"}).runtime.kind,"model");
});

test("a late frontend result cannot cross a changed explicit account/model/readiness selection",async()=>{
  const host=document.createElement("div"),root=createRoot(host);let current:ReturnType<typeof useAgentTaskRuntime>|undefined;
  function Capture({choice}:{choice:typeof account}){current=useAgentTaskRuntime(config,choice);return null;}
  const render=async(choice:typeof account)=>act(async()=>root.render(createElement(Capture,{choice})));
  try{
    await render(account);const initial=current!;initial.assertSelected();
    await render({...account});assert.strictEqual(current,initial,"unrelated render does not invalidate the same task selection");
    await render({...account,model:"another-explicit-model"});assert.throws(initial.assertSelected,/选择已变化/);current!.assertSelected();
    const beforeDisconnect=current!;await render({...account,model:"another-explicit-model",ready:false});assert.throws(beforeDisconnect.assertSelected,/选择已变化/);assert.throws(current!.assertSelected,/不会改用/);
  }finally{await act(async()=>root.unmount());}
});
