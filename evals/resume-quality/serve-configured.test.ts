import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serveConfiguredGold } from "./serve-configured.mjs";

test("operator bridge pins origin/recipient, durably claims one batch and restarts observe-only even after failure",{timeout:30_000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"betterme-operator-bridge-")),outputDirectory=path.join(directory,"batch");
  await fs.mkdir(outputDirectory);await fs.mkdir(path.join(outputDirectory,"run")); // Deliberately occupied: collector must fail before Host creation or provider dispatch.
  const pageOrigin="http://localhost:5173",options={outputDirectory,pageOrigin,providerOrigin:"https://fixture.invalid",model:"synthetic-only",declaredRevision:"synthetic-v1",port:0};
  const settings={provider:"custom",baseUrl:"https://fixture.invalid/v1",model:"synthetic-only",apiKey:"SYNTHETIC-OPERATOR-KEY-NEVER-PERSIST"};
  let bridge=await serveConfiguredGold(options);
  const close=()=>new Promise<void>(resolve=>bridge.server.close(()=>resolve()));
  const endpoint=()=>{const address=bridge.server.address();assert.ok(address&&typeof address!=="string");return `http://127.0.0.1:${address.port}`;};
  const post=(body:unknown,origin=pageOrigin)=>fetch(`${endpoint()}/run`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
  try{
    const foreign=await post({consent:true,modelSettings:settings},"https://foreign.invalid");assert.equal(foreign.status,403);assert.equal(foreign.headers.get("Access-Control-Allow-Origin"),null);
    const state=await fetch(`${endpoint()}/state`,{headers:{Origin:pageOrigin}});assert.equal(state.status,200);assert.equal((await state.json()).claimed,false);
    assert.equal((await post({consent:false,modelSettings:settings})).status,409);
    assert.equal((await post({consent:true,modelSettings:{...settings,baseUrl:"https://other.invalid/v1"}})).status,409);
    const replies=await Promise.all([post({consent:true,modelSettings:settings}),post({consent:true,modelSettings:settings})]);
    assert.deepEqual(replies.map(r=>r.status).sort(),[202,409]);await bridge.pending;
    const stopped=await fetch(`${endpoint()}/state`,{headers:{Origin:pageOrigin}}).then(r=>r.json());assert.equal(stopped.stage,"stopped");assert.equal(stopped.claimed,true);
    assert.deepEqual(await fs.readdir(path.join(outputDirectory,"run")),[]);
    await close();bridge=await serveConfiguredGold(options);
    const resumed=await fetch(`${endpoint()}/state`,{headers:{Origin:pageOrigin}}).then(r=>r.json());assert.equal(resumed.claimed,true);assert.equal((await post({consent:true,modelSettings:settings})).status,409);assert.equal(bridge.pending,undefined);
    for(const file of ["dispatch-claim.json","operator-status.json"])assert.ok(!(await fs.readFile(path.join(outputDirectory,file),"utf8")).includes(settings.apiKey));
  }finally{await close();}
});
