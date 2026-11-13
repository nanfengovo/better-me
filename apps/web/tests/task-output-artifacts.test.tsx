import assert from "node:assert/strict";
import test,{after,afterEach} from "node:test";
import {registerHooks} from "node:module";
import {Window} from "happy-dom";
import type {TaskOutputSource} from "../src/services/task-output-client";
import {activatePrincipal} from "../src/lib/identity";
registerHooks({load(url,context,next){return url.endsWith(".css")?{format:"module",source:"",shortCircuit:true}:next(url,context);}});
const dom=new Window({url:"http://synthetic-output.invalid"}),React=await import("react"),originals=new Map<string,PropertyDescriptor|undefined>();
for(const [key,value]of Object.entries({window:dom,document:dom.document,navigator:dom.navigator,HTMLElement:dom.HTMLElement,Element:dom.Element,Node:dom.Node,Event:dom.Event,React,IS_REACT_ACT_ENVIRONMENT:true})){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
const {createRoot}=await import("react-dom/client"),{TaskOutputArtifacts}=await import("../src/components/TaskOutputArtifacts"),{act}=React;
const alice={id:"11111111-1111-4111-8111-111111111111",username:"alice",displayName:"Alice"},outputId="out_"+"a".repeat(32),artifact={id:outputId,bytes:999,hash:"b".repeat(64),createdAt:"now"};
const source:TaskOutputSource={id:"ct_"+"a".repeat(32),ownerId:alice.id,outputArtifacts:[artifact]};
let root:ReturnType<typeof createRoot>|undefined;
async function render(task:TaskOutputSource,client:Parameters<typeof TaskOutputArtifacts>[0]["client"]){activatePrincipal(alice);const host=dom.document.createElement("div");dom.document.body.append(host);root=createRoot(host as unknown as Element);await act(async()=>root!.render(<TaskOutputArtifacts task={task} client={client}/>));}
function button(label:string){const value=[...dom.document.querySelectorAll("button")].find(item=>item.textContent===label);assert.ok(value,label);return value;}
afterEach(async()=>{await act(async()=>root?.unmount());root=undefined;activatePrincipal(undefined);dom.document.body.replaceChildren();});
after(()=>{dom.happyDOM.abort();for(const [key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});

test("reader is opt-in, raw safe text and full copy; closing drops page text without mutating task",async()=>{
  const text="\ufeff  <script>window.INJECTED=true</script>\r\n"+"长原文".repeat(60000)+"END  ",before=JSON.stringify(source);let reads=0,copied="";
  Object.defineProperty(dom.navigator.clipboard,"writeText",{configurable:true,value:async(value:string)=>{copied=value;}});
  await render(source,{read:async(task,id)=>{reads++;assert.equal(task,source);assert.equal(id,outputId);return {artifact,text};}});
  assert.equal(reads,0);assert.equal(dom.document.querySelector("pre"),null);
  await act(async()=>button("读取完整原文").click());assert.equal(reads,1);assert.equal(dom.document.querySelector("pre")!.textContent,text);assert.equal(dom.document.querySelector("script"),null);
  await act(async()=>button("复制完整原文").click());assert.equal(copied,text);assert.match(dom.document.body.textContent!,/已复制完整原文/);
  await act(async()=>button("收起并清除本页全文").click());assert.equal(dom.document.querySelector("pre"),null);assert.equal(reads,1);assert.equal(JSON.stringify(source),before);
});

test("cancel ignores late replies and owner change clears loaded text and disables re-read",async()=>{
  const late=Promise.withResolvers<{artifact:typeof artifact;text:string}>();let reads=0;
  await render(source,{read:async()=>{reads++;return reads===1?late.promise:{artifact,text:"PRIVATE-LOADED"};}});
  await act(async()=>button("读取完整原文").click());await act(async()=>button("取消读取").click());await act(async()=>{late.resolve({artifact,text:"LATE-PRIVATE"});});assert.equal(dom.document.querySelector("pre"),null);
  await act(async()=>button("读取完整原文").click());assert.equal(dom.document.querySelector("pre")!.textContent,"PRIVATE-LOADED");
  await act(async()=>activatePrincipal({...alice,id:"22222222-2222-4222-8222-222222222222"}));assert.equal(dom.document.querySelector("pre"),null);assert.equal(button("读取完整原文").disabled,true);assert.equal(reads,2);
});

test("failure shows a readable state without a partial body, automatic retry or unrelated empty chrome",async()=>{
  let reads=0;await render(source,{read:async()=>{reads++;throw Error("完整校验失败，未显示部分内容。");}});
  await act(async()=>button("读取完整原文").click());assert.equal(reads,1);assert.equal(dom.document.querySelector("pre"),null);assert.match(dom.document.querySelector('[role="status"]')!.textContent!,/校验失败/);
  await act(async()=>root!.render(<TaskOutputArtifacts task={{id:source.id,ownerId:alice.id}}/>));assert.equal(dom.document.body.textContent,"");
});
