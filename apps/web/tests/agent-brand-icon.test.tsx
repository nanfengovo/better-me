import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test, { after } from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { AgentBrandIcon } from "../src/components/AgentBrandIcon";
import { getAgentIconAsset } from "../src/components/agent-icon-manifest";

const dom=new Window({url:"http://synthetic-agent-art.invalid"});
const globals={React,window:dom,document:dom.document,navigator:dom.navigator,HTMLElement:dom.HTMLElement,Element:dom.Element,Node:dom.Node,IS_REACT_ACT_ENVIRONMENT:true};
const descriptors=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
after(()=>{dom.happyDOM.abort();for(const[key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});

test("four generated WebP files are local, bounded and include provenance, without relabeling artwork official",()=>{
  let bytes=0;
  for(const id of ["claude-code","opencode","gemini-cli","codex"]){
    const asset=getAgentIconAsset(id)!;assert.equal(asset.source,"project-generated");assert.match(asset.generatedSrc!,/^\/agent-icons\/[\w-]+-3d-v1\.webp$/);
    const file=new URL("../public"+asset.generatedSrc,import.meta.url);const buffer=readFileSync(file);assert.equal(buffer.toString("ascii",0,4),"RIFF");assert.equal(buffer.toString("ascii",8,12),"WEBP");bytes+=statSync(file).size;
  }
  assert.equal(bytes,40582);
  const provenance=JSON.parse(readFileSync(new URL("../public/agent-icons/generated-prompts.json",import.meta.url),"utf8"));
  assert.equal(provenance.officialBrandAsset,false);assert.ok(JSON.stringify(provenance).includes("transparent"));
  assert.equal(getAgentIconAsset("__proto__"),undefined);assert.equal(getAgentIconAsset("unknown"),undefined);
});

test("decorative artwork has intrinsic size, cannot drag, falls back on failure and retries after identity changes",async()=>{
  const host=dom.document.createElement("div");dom.document.body.append(host);const root=createRoot(host as unknown as HTMLDivElement);
  try{
    await React.act(async()=>{root.render(<AgentBrandIcon id="claude-code"/>);});
    const image=host.querySelector("img")!;assert.equal(image.width,256);assert.equal(image.height,256);assert.equal(image.getAttribute("draggable"),"false");assert.equal(image.alt,"");assert.equal(image.getAttribute("aria-hidden"),"true");
    await React.act(async()=>{image.dispatchEvent(new dom.Event("error"));});assert.equal(host.querySelector("img"),null);assert.ok(host.querySelector('svg[data-agent-fallback="claude-code"] path'));
    await React.act(async()=>{root.render(<AgentBrandIcon id="codex"/>);});assert.ok(host.querySelector('img[data-agent-art="codex"]'));
    await React.act(async()=>{host.querySelector("img")!.dispatchEvent(new dom.Event("error"));});assert.ok(host.querySelector('svg[data-agent-fallback="codex"]'));
    await React.act(async()=>{root.render(<AgentBrandIcon id="unknown"/>);});assert.ok(host.querySelector("svg"));
    await React.act(async()=>{root.render(<AgentBrandIcon id="__proto__"/>);});assert.ok(host.querySelector("svg"));
    await React.act(async()=>{root.render(<AgentBrandIcon id="claude-code"/>);});assert.ok(host.querySelector("img"));
  }finally{await React.act(async()=>{root.unmount();});host.remove();}
});
