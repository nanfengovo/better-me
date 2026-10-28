import assert from "node:assert/strict";
import test, { after } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import * as Cesium from "cesium";
import type { AtlasPrototypeProps } from "../src/components/atlas/prototypes/types";

// Actual Cesium math/coordinates, with deterministic GPU and upstream request seams.
const dom = new Window({url:"http://synthetic-3d-runtime.invalid"});
class Event {
  handlers = new Set<(...args: any[]) => void>();
  addEventListener(callback: (...args: any[]) => void) { this.handlers.add(callback); return () => { this.handlers.delete(callback); }; }
  emit(...args: any[]) { this.handlers.forEach(callback => callback(...args)); }
}
const viewers: Viewer[] = [], collections: Billboards[] = [], roots: Array<{kind:string;options:any;source:any;resolve:(value:any)=>void;reject:(reason:any)=>void}> = [];
const frames = new Map<number, FrameRequestCallback>(); let frameId = 0, reduced = false, observersDisconnected = 0;
class Viewer {
  destroyed = 0; renders = 0; fits = 0; looks = 0; credits: any[] = []; primitives: any[] = []; datasources: any[] = [];
  camera = { positionWC: Cesium.Cartesian3.fromDegrees(121,31,1000), heading:0,pitch:-1,roll:0,
    positionCartographic:Cesium.Cartographic.fromDegrees(121,31,1000), moveEnd:new Event(),
    setView:() => { this.fits++; }, lookAt:() => { this.looks++; }, lookAtTransform() {}, flyToBoundingSphere:() => {this.looks++;},
    getPickRay:() => ({}), getRectangleCameraCoordinates:()=>Cesium.Cartesian3.fromDegrees(121,31,1000), computeViewRectangle:() => undefined, zoomIn() {}, zoomOut() {} };
  scene: any;
  clock = {currentTime:Cesium.JulianDate.now()}; screenSpaceEventHandler = {removeInputAction(){}};
  creditDisplay = {addStaticCredit:(credit:any) => this.credits.push(credit),removeStaticCredit:(credit:any) => {this.credits=this.credits.filter(c=>c!==credit);}};
  dataSources = {add:async(data:any) => {this.datasources.push(data);return data;},remove:() => {}}; imageryLayers={addImageryProvider(){}};
  constructor(element: HTMLElement, readonly options: any) {
    const canvas=dom.document.createElement("canvas"); element.append(canvas);
    this.scene={canvas, globe:{show:true,pick:()=>Cesium.Cartesian3.fromDegrees(121,31)},screenSpaceCameraController:{},
      primitives:{add:(p:any)=>{this.primitives.push(p);return p;},remove:(p:any)=>{p.destroy?.();return true;}},
      renderError:new Event(),requestRender:()=>{this.renders++;},drillPick:()=>[]}; viewers.push(this);
  }
  resize() {} isDestroyed(){return this.destroyed>0;} destroy(){this.destroyed++;}
}
class Billboards { values:any[]=[]; uploads=0; constructor(){collections.push(this);} add(value:any){this.values.push(value);this.uploads++;return value;} remove(value:any){this.values=this.values.filter(p=>p!==value);} }
class Input { setInputAction(){} destroy(){} }
function root(kind:string,source:any,options:any) { return new Promise((resolve,reject)=>roots.push({kind,source,options,resolve,reject})); }
const stub = {Viewer,BillboardCollection:Billboards,ScreenSpaceEventHandler:Input,
  createGooglePhotorealistic3DTileset:(source:any,options:any)=>root("google",source,options),
  Cesium3DTileset:{fromUrl:(source:any,options:any)=>root("tileset",source,options)},
  TileMapServiceImageryProvider:{fromUrl:async()=>({})},buildModuleUrl:(path:string)=>path,
  GeoJsonDataSource:{load:async()=>({show:true,entities:{values:[{polyline:{}}],add(){}}})}};
const globals = {window:dom,document:dom.document,ResizeObserver:class {observe(){}disconnect(){observersDisconnected++;}},
  requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;},cancelAnimationFrame:(id:number)=>frames.delete(id),__atlasCesiumStub:stub};
const descriptors = new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
Object.defineProperty(dom,"matchMedia",{value:()=>({get matches(){return reduced;},addEventListener(){},removeEventListener(){}})});
Object.defineProperty(dom.document,"visibilityState",{configurable:true,value:"visible"});
const fetchBefore=globalThis.fetch;
globalThis.fetch=async()=>new Response(JSON.stringify({type:"FeatureCollection",features:[]}));
const actual=import.meta.resolve("cesium");
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==="cesium")return {url:`data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(actual)}; const s=globalThis.__atlasCesiumStub; export const Viewer=s.Viewer,BillboardCollection=s.BillboardCollection,ScreenSpaceEventHandler=s.ScreenSpaceEventHandler,createGooglePhotorealistic3DTileset=s.createGooglePhotorealistic3DTileset,Cesium3DTileset=s.Cesium3DTileset,GeoJsonDataSource=s.GeoJsonDataSource,TileMapServiceImageryProvider=s.TileMapServiceImageryProvider,buildModuleUrl=s.buildModuleUrl;`)}`,shortCircuit:true};
  if(specifier.endsWith("?url"))return{url:"data:text/javascript,export default '/synthetic-boundary';",shortCircuit:true};
  return next(specifier,context);
}});
const {createCesiumAtlas}=await import("../src/components/atlas/map3d/cesium-runtime");
after(()=>{hooks.deregister();globalThis.fetch=fetchBefore;dom.happyDOM.abort();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
const props:AtlasPrototypeProps={mode:"global",framingKey:"search-one",buckets:[{id:"a",label:"Synthetic address",latitude:31,longitude:121,jobCount:1,pinCount:1,jobIds:["job"],locationIds:["office"],displayGrade:"address",categories:[]}],visual:{autoRotate:false},bounds:[120,30,122,32]};
function tiles(){return {destroyed:0,tileFailed:new Event(),destroy(){this.destroyed++;}};}

test("actual scene controller owns one renderer, requires explicit Google key, updates incrementally, and cleans up stale roots",async()=>{
  const statuses:any[]=[];let snapshots=0;
  const handle=createCesiumAtlas(dom.document.createElement("div") as unknown as HTMLElement,props,{status:s=>statuses.push(s),pick(){},camera(){snapshots++;}});
  const viewer=viewers.at(-1)!, points=collections.at(-1)!;
  assert.equal(roots.length,0,"unconfigured globe must never fall through to ion or Google");
  assert.equal(viewer.options.baseLayer,false);assert.equal(viewer.options.requestRenderMode,true);assert.equal(viewer.options.maximumRenderTimeChange,Infinity);
  for(let i=0;i<120;i++)handle.update({...props});
  assert.equal(viewers.length,1);assert.equal(points.uploads,1);assert.equal(viewer.fits,1,"same query batches do not hijack the camera");assert.equal(frames.size,0);
  await nextTurn();
  assert.equal(viewer.datasources[0].entities.values[0].polygon,undefined,"world overview never builds filled polygon geometry");
  assert.equal(viewer.datasources[0].entities.values[0].polyline.arcType.getValue(),Cesium.ArcType.GEODESIC,"pole boundaries cannot enter RHUMB subdivision");
  handle.update({...props,selectedBucketId:"a"});assert.equal(points.values[0].scale,1.45);assert.equal(points.uploads,1);
  const focus={longitude:121,latitude:31,zoom:16,jobId:"job",requestId:"one"};
  handle.update({...props,focus,selectedJobId:"job"});const looks=viewer.looks;
  handle.update({...props,focus,selectedJobId:"job"});assert.equal(viewer.looks,looks,"focus is event-like, not repeated on each data/UI update");
  handle.source({kind:"google",apiKey:"synthetic-canary-not-a-real-key"});assert.equal(roots.length,1);assert.equal(roots[0].source.key,"synthetic-canary-not-a-real-key");
  handle.source({kind:"google",apiKey:"synthetic-canary-not-a-real-key"});handle.quality("economy");assert.equal(roots.length,1,"theme/quality/progress cannot create a new paid root");
  assert.equal(roots[0].options.showCreditsOnScreen,true);assert.equal(roots[0].options.enableCollision,true);
  handle.source({kind:"globe"});const stale=tiles();roots[0].resolve(stale);await nextTurn();assert.equal(stale.destroyed,1);
  handle.source({kind:"tileset",url:"http://127.0.0.1/tileset.json",attribution:"Own <script> canary"});
  const loaded=tiles();roots[1].resolve(loaded);await nextTurn();assert.equal(viewer.scene.globe.show,false);
  assert.ok(viewer.credits.some(credit=>credit.html.includes("&lt;script&gt;")),"source attribution is text, not HTML injection");
  loaded.tileFailed.emit({statusCode:429,message:"key=SECRET"});assert.equal(statuses.at(-1).failure.kind,"quota");assert.equal(roots.length,2,"quota failures never automatically create another session");
  viewer.scene.renderError.emit(viewer.scene,new Error("WebGL rendering stopped"));
  handle.source({kind:"globe"});assert.equal(statuses.at(-1).phase,"error","late source-ready must not mask a fatal renderer error");
  handle.dispose();handle.dispose();assert.equal(viewer.destroyed,1);assert.equal(viewer.camera.moveEnd.handlers.size,0);assert.equal(viewer.scene.renderError.handlers.size,0);assert.equal(observersDisconnected,1);assert.ok(snapshots>0);
});
test("late tiles after unmount are destroyed and reduced-motion never starts a rotation loop",async()=>{
  reduced=true;
  const handle=createCesiumAtlas(dom.document.createElement("div") as unknown as HTMLElement,{...props,visual:{autoRotate:true}},{status(){},pick(){},camera(){}});
  assert.equal(frames.size,0);
  handle.source({kind:"google",apiKey:"synthetic-key"});const pending=roots.at(-1)!;
  handle.dispose();const loaded=tiles();pending.resolve(loaded);await nextTurn();assert.equal(loaded.destroyed,1);assert.equal(frames.size,0);
});
