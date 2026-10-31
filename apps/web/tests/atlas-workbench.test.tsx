import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { defaultWorkbenchLayout, WORKBENCH_LAYOUT_KEY } from "../src/components/atlas/workbench-layout";

const dom = new Window({ url: "http://synthetic-workbench.invalid" });
const frames = new Map<number, FrameRequestCallback>();
const resizeObservers = new Set<WorkbenchResizeObserver>();
class WorkbenchResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { resizeObservers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); resizeObservers.delete(this); }
}
const initialViewportHeight = dom.innerHeight;
let frameId = 0;
const globals = { React, window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: WorkbenchResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId,callback); return frameId; },
  cancelAnimationFrame: (id: number) => { frames.delete(id); } };
const descriptors = new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
for (const [key,value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
const hooks = registerHooks({load(url,context,next){return url.endsWith(".css") ? {source:"export {};",format:"module",shortCircuit:true} : next(url,context);}});
const { AtlasWorkbench } = await import("../src/components/atlas/AtlasWorkbench");
let root: Root | undefined;
let host: HTMLDivElement;
const flush = async () => { await React.act(async()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(0);}); };
const click = async (element: Element) => { await React.act(async()=>{element.dispatchEvent(new dom.MouseEvent("click",{bubbles:true}));}); };
const key = async (element: Element, key: string, options={}) => { await React.act(async()=>{element.dispatchEvent(new dom.KeyboardEvent("keydown",{key,bubbles:true,...options}));}); };
const pointer = async (element: Element, type: string, x: number, y: number, id=1, primary=true) => {
  await React.act(async()=>{element.dispatchEvent(new dom.PointerEvent(type,{bubbles:true,button:0,pointerId:id,isPrimary:primary,clientX:x,clientY:y}));});
};
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const pane = (id: string) => host.querySelector<HTMLElement>(`[data-workbench-pane="${id}"]`)!;
const grid = () => host.querySelector<HTMLElement>(".atlas-workbench-grid")!;
const current = () => JSON.parse(localStorage.getItem(WORKBENCH_LAYOUT_KEY)!);
const notifyResize = async () => { await React.act(async () => { for (const observer of resizeObservers) observer.callback([], observer); }); };
async function mount(props: Partial<React.ComponentProps<typeof AtlasWorkbench>> = {}, leading?: React.ReactNode) {
  host = dom.document.createElement("div") as unknown as HTMLDivElement; dom.document.body.append(host);
  host.className = "atlas-workspace";
  root = createRoot(host);
  await React.act(async()=>{root!.render(<>{leading}<AtlasWorkbench map={<p>Map content</p>} jobs={<p>Jobs content</p>} detail={<p>JD content</p>} hasDetail layout="wide" {...props} /></>);});
}
function measuredWorkspace() {
  const geometry = { top: 80, height: 1000, gridOffset: 200, width: 1200 };
  Object.defineProperty(dom, "innerHeight", { configurable: true, value: 1200 });
  Object.defineProperty(host, "clientHeight", { configurable: true, get: () => geometry.height });
  host.style.paddingBottom = "12px";
  host.getBoundingClientRect = () => new dom.DOMRect(0, geometry.top - dom.scrollY, geometry.width, geometry.height) as unknown as DOMRect;
  grid().getBoundingClientRect = () => new dom.DOMRect(0,
    geometry.top + geometry.gridOffset - host.scrollTop - dom.scrollY, geometry.width,
    Number.parseFloat(grid().style.height) || 600) as unknown as DOMRect;
  button("调整工作区高度").getBoundingClientRect = () => new dom.DOMRect(0, 0, geometry.width, 18) as unknown as DOMRect;
  return geometry;
}
afterEach(async()=>{if(root)await React.act(async()=>{root!.unmount();});root=undefined;host?.remove();frames.clear();assert.equal(resizeObservers.size,0,"unmount releases layout observers");dom.localStorage.clear();Object.defineProperty(dom,"innerHeight",{configurable:true,value:initialViewportHeight});Object.defineProperty(dom,"scrollY",{configurable:true,value:0});Object.defineProperty(globalThis,"localStorage",{value:dom.localStorage,writable:true,configurable:true});});
after(()=>{hooks.deregister();dom.happyDOM.abort();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});

test("width hot loop does not render children or write preferences until release; cancel restores geometry and ARIA", async()=>{
  let renders=0,mounts=0,writes=0;
  function Probe(){renders++;React.useEffect(()=>{mounts++;},[]);return <input aria-label="unsaved probe" defaultValue="keep this" />;}
  localStorage.setItem("resume-unsaved-sentinel","private-test");
  const originalSet=dom.localStorage.setItem.bind(dom.localStorage);
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:dom.localStorage.getItem.bind(dom.localStorage),setItem:(key:string,value:string)=>{writes++;originalSet(key,value);}}});
  await mount({map:<Probe/>});const content=host.querySelector("input")!;
  const separator=host.querySelector<HTMLElement>('.atlas-workbench-divider')!;
  const before=grid().style.gridTemplateColumns, aria=separator.getAttribute("aria-valuenow");
  const baselineRenders=renders;
  await pointer(separator,"pointerdown",500,100);
  for(let i=1;i<=8;i++)await pointer(separator,"pointermove",500+i*5,100);
  await flush();
  assert.notEqual(grid().style.gridTemplateColumns,before);
  assert.equal(writes,0);assert.equal(renders,baselineRenders);
  await key(separator,"Escape");
  assert.equal(grid().style.gridTemplateColumns,before);assert.equal(separator.getAttribute("aria-valuenow"),aria);
  assert.equal(writes,0);assert.equal(frames.size,0);
  await pointer(separator,"pointerdown",500,100);
  await pointer(separator,"pointermove",530,100);await flush();
  await pointer(separator,"pointerup",530,100);
  assert.equal(writes,1);assert.equal(mounts,1);assert.equal(host.querySelector("input"),content);
  assert.equal(dom.localStorage.getItem("resume-unsaved-sentinel"),"private-test");
  assert.deepEqual(Object.keys(current()).sort(),["arrangement","height","order","rowHeights","version","weights"].sort());
});

test("reordering by keyboard and pointer keeps DOM, list scroll and map state; focus restores without remount",async()=>{
  let mounts=0;
  function Probe(){React.useEffect(()=>{mounts++;},[]);return <div className="probe-list"><input defaultValue="untouched" /></div>;}
  const map=<Probe/>,jobs=<Probe/>,detail=<Probe/>;
  await mount({map,jobs,detail});const nodes=[...host.querySelectorAll(".probe-list")];nodes[1]!.scrollTop=77;
  await key(button("拖动地图模块换位"),"ArrowRight",{altKey:true});await flush();
  assert.deepEqual(current().order,["jobs","map","detail"]);assert.equal(pane("jobs").querySelector(".probe-list"),nodes[1]);assert.equal(nodes[1]!.scrollTop,77);
  const rects={jobs:{left:0,right:380,top:0,bottom:600},map:{left:394,right:774,top:0,bottom:600},detail:{left:788,right:1200,top:0,bottom:600}};
  for(const[id,rect]of Object.entries(rects))pane(id).getBoundingClientRect=()=>({...rect,x:rect.left,y:0,width:rect.right-rect.left,height:600,toJSON(){return this;}});
  const handle=button("拖动地图模块换位");
  await pointer(handle,"pointerdown",420,20);await pointer(handle,"pointermove",900,20);await flush();
  assert.equal(pane("detail").hasAttribute("data-drop-target"),true);assert.equal(host.querySelector<HTMLElement>(".atlas-workbench-drag-ghost")!.hidden,false);
  await pointer(handle,"pointerup",900,20);await flush();
  assert.deepEqual(current().order,["jobs","detail","map"]);assert.equal(host.querySelector<HTMLElement>(".atlas-workbench-drag-ghost")!.hidden,true);
  await click(button("放大地图模块"));assert.equal(pane("jobs").hidden,true);assert.equal(pane("map").hidden,false);
  await click(button("还原地图模块"));assert.equal(pane("jobs").hidden,false);assert.equal(mounts,3);
  assert.equal(pane("jobs").querySelector(".probe-list"),nodes[1]);assert.equal(nodes[1]!.scrollTop,77);
});

test("row height keyboard and pointer controls clamp; hidden JD adds no empty column, layout reset and reload work",async()=>{
  localStorage.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify({ ...defaultWorkbenchLayout(), arrangement: "rows" }));
  await mount({hasDetail:false,layout:"medium"});
  assert.equal(pane("detail").hidden,true);assert.equal(host.querySelectorAll(".atlas-workbench-divider").length,0);
  const height=button("调整地图高度");assert.ok(height);
  await key(height,"Home");assert.equal(current().rowHeights.map,500);
  await key(height,"ArrowDown",{shiftKey:true});assert.equal(current().rowHeights.map,580);
  await pointer(height,"pointerdown",20,100);await pointer(height,"pointerup",20,140);
  assert.equal(current().rowHeights.map,620);assert.equal(pane("map").style.height,"620px");
  await key(height,"Enter");assert.equal(current().rowHeights.map,560);
  const before=localStorage.getItem(WORKBENCH_LAYOUT_KEY);await React.act(async()=>{root!.unmount();});root=undefined;host.remove();
  await mount({layout:"medium",hasDetail:false});assert.equal(pane("map").style.height,"560px");assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY),before);
  await click(button("还原默认工作区布局"));assert.deepEqual(current(),defaultWorkbenchLayout());
});

test("narrow workspaces start on the list and switch without remounting the map or touching saved layout", async () => {
  let mounts = 0;
  function MapProbe() { React.useEffect(() => { mounts++; }, []); return <p>persistent map</p>; }
  await mount({ layout: "narrow", hasDetail: false, map: <MapProbe /> });
  assert.equal(pane("jobs").hidden, false);
  assert.equal(pane("map").hidden, true);
  const mapNode = pane("map").firstElementChild;
  const toggle = [...host.querySelectorAll("button")].find(node => node.textContent === "查看地图")!;
  await click(toggle);
  assert.equal(pane("jobs").hidden, true);
  assert.equal(pane("map").hidden, false);
  assert.equal(pane("map").firstElementChild, mapNode);
  assert.equal(mounts, 1);
  assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY), null);
  assert.equal(host.querySelector('[aria-label="调整地图高度"]'), null);
});

test("narrow detail uses a native modal and Escape returns focus to the opener", async () => {
  let closes = 0;
  const opener = dom.document.createElement("button"); opener.textContent = "synthetic opener"; dom.document.body.append(opener); opener.focus();
  await mount({ layout: "narrow", onCloseDetail: () => { closes++; } });
  const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
  assert.equal(dialog.open, true);
  assert.equal(pane("detail").hidden, true);
  assert.equal(dialog.querySelector(".atlas-settings-dialog-body")!.textContent, "JD content");
  await React.act(async () => { dialog.dispatchEvent(new dom.Event("cancel", { cancelable: true })); });
  assert.equal(closes, 1);
  assert.equal(host.querySelector("dialog"), null);
  assert.equal(dom.document.activeElement, opener);
  opener.remove();
});

test("pointer cancellation, secondary touch, lost capture and unmount do not save or leave work queued",async()=>{
  await mount();const separator=host.querySelector<HTMLElement>(".atlas-workbench-divider")!,before=grid().style.gridTemplateColumns;
  await pointer(separator,"pointerdown",300,30,7,false);await pointer(separator,"pointermove",400,30,7,false);await flush();assert.equal(grid().style.gridTemplateColumns,before);
  await pointer(separator,"pointerdown",300,30,1);await pointer(separator,"pointermove",400,30,2);await flush();assert.equal(grid().style.gridTemplateColumns,before);
  await pointer(separator,"pointermove",350,30,1);await flush();await pointer(separator,"pointercancel",350,30,1);
  assert.equal(grid().style.gridTemplateColumns,before);assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY),null);
  await pointer(separator,"pointerdown",300,30);await pointer(separator,"pointermove",350,30);await flush();await pointer(separator,"lostpointercapture",350,30);
  assert.equal(grid().style.gridTemplateColumns,before);assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY),null);
  await pointer(separator,"pointerdown",300,30);await pointer(separator,"pointermove",350,30);assert.equal(frames.size,1);
  await React.act(async()=>{root!.unmount();});root=undefined;assert.equal(frames.size,0);assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY),null);
});

test("Escape cancels a drag before a previously mounted detail pane can close",async()=>{
  let closed=0;
  function Detail(){React.useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!event.defaultPrevented)closed++;};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[]);return <p>Existing JD</p>;}
  await mount({detail:<Detail/>});const separator=host.querySelector<HTMLElement>(".atlas-workbench-divider")!;
  await pointer(separator,"pointerdown",300,30);await pointer(separator,"pointermove",350,30);await flush();await key(separator,"Escape");
  assert.equal(closed,0);assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY),null);
});

test("a container resize immediately before release cancels even before ResizeObserver can notify React",async()=>{
  await mount();let measuredWidth=1200;grid().getBoundingClientRect=()=>new dom.DOMRect(0,0,measuredWidth,600) as unknown as DOMRect;
  const separator=host.querySelector<HTMLElement>(".atlas-workbench-divider")!;
  await pointer(separator,"pointerdown",300,30);await pointer(separator,"pointermove",350,30);await flush();
  measuredWidth=900;await pointer(separator,"pointerup",350,30);
  assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY),null);assert.equal(grid().getAttribute("data-gesture"),null);
});

test("presets, separator keys and height controls work independently of data; storage failure stays non-blocking",async()=>{
  localStorage.setItem(WORKBENCH_LAYOUT_KEY,"corrupt JSON");await mount();
  assert.equal(host.querySelector<HTMLButtonElement>(".atlas-workbench-presets button")!.getAttribute("aria-pressed"),"true");
  const separator=host.querySelector<HTMLElement>(".atlas-workbench-divider")!;
  await key(separator,"Home");assert.equal(Number(grid().style.gridTemplateColumns.split("px")[0]),300);
  await key(separator,"Enter");assert.deepEqual(current().weights,defaultWorkbenchLayout().weights);
  const height=button("调整工作区高度");await key(height,"Home");assert.equal(current().height,520);
  await key(height,"ArrowDown");assert.equal(current().height,544);
  const presets=host.querySelectorAll<HTMLButtonElement>(".atlas-workbench-presets button");await click(presets[2]!);assert.equal(current().weights.detail,56);
  await click(host.querySelector<HTMLButtonElement>(".atlas-workbench-arrange")!);assert.equal(current().arrangement,"rows");assert.equal(host.querySelector(".atlas-workbench")!.getAttribute("data-arrangement"),"rows");
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:()=>null,setItem:()=>{throw Error("quota");}}});
  await click(button("还原默认工作区布局"));assert.match(host.textContent!,/布局暂未保存/);assert.equal(pane("map").hidden,false);
});

test("automatic workbench height follows its real header and constrained scrollport without remounting or persisting", async () => {
  let mounts = 0;
  function Probe() { React.useEffect(() => { mounts++; }, []); return <input defaultValue="unsaved map state" />; }
  await mount({ map: <Probe /> }, <header className="atlas-command">Search controls</header>);
  const content = host.querySelector("input");
  const geometry = measuredWorkspace();
  await notifyResize();
  assert.equal(grid().style.height, "770px", "1000px scrollport minus 200px header, 12px padding and 18px handle");
  for (const target of [host, grid(), host.querySelector(".atlas-command")!, host.querySelector(".atlas-workbench-toolbar")!]) {
    assert.ok([...resizeObservers].some(observer => observer.targets.has(target)), "observe only geometry owners that can move or resize the grid");
  }
  geometry.gridOffset = 120;
  await notifyResize();
  assert.equal(grid().style.height, "850px", "a compact command area releases space to the actual map and list");
  assert.equal(button("调整工作区高度").getAttribute("aria-valuenow"), "850");
  assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY), null, "automatic measurements are not user preferences");
  assert.equal(mounts, 1);
  assert.equal(host.querySelector("input"), content);
});

test("automatic height is stable while scrolling and clips to the viewport on a real geometry resize", async () => {
  await mount();
  const geometry = measuredWorkspace();
  await notifyResize();
  host.scrollTop = 250;
  Object.defineProperty(dom, "scrollY", { configurable: true, value: 180 });
  host.dispatchEvent(new dom.Event("scroll"));
  dom.dispatchEvent(new dom.Event("scroll"));
  await notifyResize();
  assert.equal(grid().style.height, "770px", "scrolling must not grow the default height or chase the viewport");
  geometry.height = 1400;
  await notifyResize();
  assert.equal(grid().style.height, "890px", "a taller scrollport is still bounded by the unscrolled viewport bottom");
  Object.defineProperty(dom, "innerHeight", { configurable: true, value: 1000 });
  await React.act(async () => dom.dispatchEvent(new dom.Event("resize")));
  assert.equal(grid().style.height, "690px");
  geometry.gridOffset = 900;
  await notifyResize();
  assert.equal(grid().style.height, "520px", "the established usable minimum remains intact");
  assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY), null);
});

test("manual workbench height survives header changes and Enter restores responsive automatic sizing", async () => {
  localStorage.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify({ ...defaultWorkbenchLayout(), height: 860 }));
  await mount();
  const geometry = measuredWorkspace();
  await notifyResize();
  assert.equal(grid().style.height, "860px");
  geometry.gridOffset = 340;
  await notifyResize();
  assert.equal(grid().style.height, "860px");
  assert.equal(current().height, 860);
  await key(button("调整工作区高度"), "Enter");
  assert.equal(current().height, null, "reset returns to an automatic preference instead of freezing a measured pixel value");
  assert.equal(grid().style.height, "630px");
  geometry.gridOffset = 140;
  await notifyResize();
  assert.equal(grid().style.height, "830px");
  assert.equal(current().height, null);
});

test("automatic geometry never fights a height drag and resumes after cancellation without saving", async () => {
  await mount();
  const geometry = measuredWorkspace();
  await notifyResize();
  const handle = button("调整工作区高度");
  await pointer(handle, "pointerdown", 400, 100);
  await pointer(handle, "pointermove", 400, 180);
  await flush();
  assert.equal(grid().style.height, "850px");
  geometry.gridOffset = 300;
  await notifyResize();
  assert.equal(grid().style.height, "850px", "ResizeObserver cannot overwrite an in-progress pointer height");
  await key(handle, "Escape");
  assert.equal(grid().style.height, "670px", "cancellation resumes the current automatic layout");
  assert.equal(handle.getAttribute("aria-valuenow"), "670");
  assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY), null);
  assert.equal(frames.size, 0);
});

test("inactive workbenches stop observing and remeasure actual geometry when activated", async () => {
  await mount({ active: false });
  const geometry = measuredWorkspace();
  assert.equal(resizeObservers.size, 0);
  const renderActive = async (active: boolean) => {
    await React.act(async () => root!.render(<><AtlasWorkbench map={<p>Map content</p>} jobs={<p>Jobs content</p>}
      detail={<p>JD content</p>} hasDetail layout="wide" active={active} /></>));
  };
  await renderActive(true);
  assert.equal(grid().style.height, "770px");
  await renderActive(false);
  assert.equal(resizeObservers.size, 0);
  geometry.gridOffset = 300;
  await notifyResize();
  assert.equal(grid().style.height, "770px");
  await renderActive(true);
  assert.equal(grid().style.height, "670px");
  assert.equal(localStorage.getItem(WORKBENCH_LAYOUT_KEY), null);
});
