import test from "node:test";
import assert from "node:assert/strict";
import { InventoryMicPermit } from "../src/main/inventory-microphone.js";

test("only the explicitly armed top-level loopback window may request audio; permission is transient and not a camera or screen grant",()=>{
  let now=1000;const origin="http://127.0.0.1:50123",p=new InventoryMicPermit(origin,()=>now);
  const req={window:true,mainFrame:true,url:origin+"/",origin};
  assert.equal(p.allow(req,["audio"]),false);
  assert.equal(p.arm({...req,mainFrame:false}),false);
  assert.equal(p.arm(req),true);
  for(const bad of [{window:false},{mainFrame:false},{url:"https://example.invalid/"},{url:origin+".invalid/"},{origin:"http://localhost:50123"}])
    assert.equal(p.allow({...req,...bad},["audio"]),false);
  for(const kinds of [[],["video"],["audio","video"],["unknown"]])assert.equal(p.allow(req,kinds),false);
  assert.equal(p.request(req,["audio","video"]),false);
  assert.equal(p.allow(req,["audio"]),true);assert.equal(p.request(req,["audio"]),true);
  assert.equal(p.request(req,["audio"]),false);p.arm(req);p.disarm();assert.equal(p.allow(req,["audio"]),false);
  p.arm(req);now+=16000;assert.equal(p.allow(req,["audio"]),false);
  assert.equal(p.allowGeolocation(req),true);
  assert.equal(p.allowGeolocation({...req,mainFrame:false}),false);
  assert.equal(p.allowGeolocation({...req,origin:"http://localhost:50123"}),false);
  assert.equal(new InventoryMicPermit("https://example.invalid").arm({...req,url:"https://example.invalid/",origin:"https://example.invalid"}),false);
});
