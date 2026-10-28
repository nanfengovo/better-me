import assert from "node:assert/strict";
import test, {after} from "node:test";
import {registerHooks} from "node:module";
import {setImmediate as nextTurn} from "node:timers/promises";
import {Window} from "happy-dom";
import type {AtlasPrototypeProps} from "../src/components/atlas/prototypes/types";

const dom = new Window({url:"http://synthetic-map-viewport.invalid"});
const instances: Array<{props:any;callbacks:any;updates:number;disposed:number;sources:any[];qualities:string[]}> = [];
const factory=(element:HTMLElement,props:any,callbacks:any)=>{
  const entry={props,callbacks,updates:0,disposed:0,sources:[] as any[],qualities:[] as string[]};instances.push(entry);
  callbacks.status({phase:"ready",rootRequests:0});
  return {update(){entry.updates++;},source(source:any){entry.sources.push(source);},quality(quality:string){entry.qualities.push(quality);},navigate(){},dispose(){entry.disposed++;callbacks.camera({position:{x:1,y:2,z:3},heading:1,pitch:-1,roll:0});}};
};
const globals={window:dom,document:dom.document,navigator:dom.navigator,HTMLElement:dom.HTMLElement,Element:dom.Element,Node:dom.Node,IS_REACT_ACT_ENVIRONMENT:true,__atlasCesiumFactory:factory};
const descriptors=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier.endsWith("/MapLibrePrototype"))return{url:"data:text/javascript,export default function Work(){return globalThis.React.createElement('div',{'data-test-work-map':''});}",shortCircuit:true};
  if(specifier.endsWith("/cesium-runtime"))return{url:"data:text/javascript,export const createCesiumAtlas=globalThis.__atlasCesiumFactory;",shortCircuit:true};
  return next(specifier,context);
},load(url,context,next){if(url.endsWith(".css"))return{source:"export {};",format:"module",shortCircuit:true};return next(url,context);}});
const React=await import("react"),{createRoot}=await import("react-dom/client");
Object.defineProperty(globalThis,"React",{configurable:true,writable:true,value:React});
const {default:Viewport}=await import("../src/components/atlas/AtlasMapViewport");
after(()=>{hooks.deregister();dom.happyDOM.abort();Reflect.deleteProperty(globalThis,"React");for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});

test("real viewport/React effects gate paid data, survive progress/reset, restore native camera and clear memory-only credentials",async()=>{
  const host=dom.document.createElement("div");dom.document.body.append(host);const root=createRoot(host as unknown as HTMLElement);
  let props:AtlasPrototypeProps={mode:"global",buckets:[],visual:{viewMode:"spatial"}};
  const flush=async(action:()=>void)=>{await React.act(async()=>{action();for(let i=0;i<4;i++)await nextTurn();});};
  const render=async(next:Partial<AtlasPrototypeProps>={})=>{props={...props,...next};await flush(()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Viewport,props))));};
  const button=(label:string)=>{const result=[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===label);assert.ok(result,label);return result;};
  const input=(value:string)=>{const element=host.querySelector<HTMLInputElement>('input[type="password"]')!;Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new dom.Event("input",{bubbles:true}));};
  try{
    await render();assert.equal(instances.length,0);assert.ok(host.querySelector("[data-test-work-map]"));
    await flush(()=>button("实景 3D").click());assert.equal(instances.length,0);
    await flush(()=>button("加载实景数据").click());assert.match(host.textContent!,/请先确认/);assert.equal(instances.length,0);
    await flush(()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await flush(()=>button("加载实景数据").click());assert.match(host.textContent!,/API Key/);assert.equal(instances.length,0,"no missing-key ion fallback");
    await flush(()=>input("synthetic-memory-canary"));await flush(()=>button("加载实景数据").click());
    assert.equal(instances.length,1,"StrictMode discarded mount must not create a second scene/root");
    assert.equal(instances[0]!.sources.at(-1).apiKey,"synthetic-memory-canary");
    await render({selectedJobId:"job",resetRevision:1});assert.equal(instances.length,1);assert.ok(instances[0]!.updates>0);
    await flush(()=>button("数据与画质").click());
    await flush(()=>{const select=host.querySelector<HTMLSelectElement>("select")!;select.value="economy";select.dispatchEvent(new dom.Event("change",{bubbles:true}));});
    assert.equal(instances.length,1);assert.equal(instances[0]!.qualities.at(-1),"economy");
    await flush(()=>button("关闭").click());await flush(()=>button("工作地图").click());assert.equal(instances[0]!.disposed,1);
    await flush(()=>button("实景 3D").click());assert.equal(instances.length,2);assert.deepEqual(instances[1]!.callbacks.initialCamera.position,{x:1,y:2,z:3});
    await flush(()=>button("数据与画质").click());await flush(()=>button("清除本页凭据并返回工作地图").click());
    assert.equal(host.querySelector<HTMLInputElement>('input[type="password"]')!.value,"");
    assert.equal(dom.localStorage.length,0);assert.equal(dom.sessionStorage.length,0,"keys and source config never persist to web storage");
    await render({visual:{viewMode:"flat"}});assert.equal(button("三维地球").disabled,true);assert.equal(button("实景 3D").disabled,true);assert.ok(host.querySelector("[data-test-work-map]"));
  }finally{await flush(()=>root.unmount());host.remove();}
});
