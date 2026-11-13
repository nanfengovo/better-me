import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { activatePrincipal } from "../src/lib/identity";
import { buildSandboxedMicroApp, PRESET_MICRO_APP_TEMPLATES } from "../src/services/sandbox-build-client";
import { sandboxCodingClient, CodingHttpError, CodingInputSchema } from "../src/services/sandbox-coding-client";

const originalFetch = globalThis.fetch;
const first = { id:"11111111-1111-4111-8111-111111111111",username:"synthetic-a",displayName:"A" };
afterEach(() => { globalThis.fetch=originalFetch; activatePrincipal(undefined); });
test("an unavailable or rejecting host cannot turn a manual preset into a verified artifact",async()=>{
  activatePrincipal(first);
  for (const response of [() => Promise.reject(Error("fixture offline")), () => Promise.resolve(new Response("{}",{status:503})),
    () => Promise.resolve(Response.json({ok:true,app:{appId:"other",verification:{passed:true,checks:[]}}}))]) {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return response();};
    await assert.rejects(buildSandboxedMicroApp({appId:"star-prompter",...PRESET_MICRO_APP_TEMPLATES["star-prompter"]!}));
    assert.equal(calls,1);
  }
});

test("model stepping is owner-bound, uses one request and never replays HTTP conflicts",async()=>{
  activatePrincipal(first);
  const calls:string[]=[];
  globalThis.fetch=async(input,init)=>{calls.push(String(input)); assert.equal(new Headers(init?.headers).get("X-BetterMe-Owner"),first.id);
    assert.deepEqual(JSON.parse(String(init?.body)),{consent:true,expectedRevision:2});return Response.json({error:"revision_conflict"},{status:409});};
  await assert.rejects(sandboxCodingClient.step("fixture-one",2),e=>e instanceof CodingHttpError && e.status===409);
  assert.deepEqual(calls.map(s=>new URL(s).pathname),["/api/v1/agent/sandbox/coding/tasks/fixture-one/step"]);
});

test("only the current Host preflight profile with both passing named checks can produce a preset",async()=>{
  activatePrincipal(first);
  const input={appId:"star-prompter",...PRESET_MICRO_APP_TEMPLATES["star-prompter"]!};
  const checks=["template-integrity","compile"].map(id=>({id,name:id,detail:"fixture",passed:true}));
  const receipt={profile:"reviewed-builtin-v2",passed:true,timestamp:"2026-01-02T00:00:00Z",checks};
  const app={...input,codeHash:"d".repeat(64),compiledAt:receipt.timestamp,verifierVersion:receipt.profile,dependencies:{},bundleHtml:"<p>synthetic</p>"};
  for(const bad of [{...receipt,profile:"old-node-vm"}, {...receipt,checks:[]}, {...receipt,checks:[checks[0],checks[0]]},
    {...receipt,checks:[checks[0],{...checks[1],passed:false}]}]){
    globalThis.fetch=async()=>Response.json({ok:true,app:{...app,verification:bad},verification:bad});
    await assert.rejects(buildSandboxedMicroApp(input));
  }
  globalThis.fetch=async()=>Response.json({ok:true,app:{...app,verification:receipt},verification:receipt});
  const result=await buildSandboxedMicroApp(input);assert.equal(result.pinnedToDock,false);assert.deepEqual(result.verification.checks,checks);
});

test("a review-ready receipt without all fixed case IDs must not make a candidate look verified",async()=>{
  activatePrincipal(first);
  const id="fixture-one",cases=[{id:"one",input:1,expected:2},{id:"two",input:2,expected:4}];
  const task={id,revision:3,status:"review_ready",goal:"合成数据乘二",model:"fixture",modelDigest:"fixture-digest",attemptsUsed:1,maxAttempts:3,
    cases,maxActiveMs:180000,activeMs:18,createdAt:"2026-01-02T00:00:00Z",updatedAt:"2026-01-02T00:00:00Z"};
  const sample={source:"n => n * 2",sourceHash:"a".repeat(64),checks:[{id:"one",passed:true}]};
  for(const best of [undefined,sample,{...sample,checks:[...sample.checks,...sample.checks]}]){
    globalThis.fetch=async()=>Response.json({task:{...task,best}});await assert.rejects(sandboxCodingClient.get(id));
  }
  globalThis.fetch=async()=>Response.json({task:{...task,best:{...sample,checks:[...sample.checks,{id:"two",passed:true}]}}});
  assert.equal((await sandboxCodingClient.get(id)).best?.checks.length,2);
});

test("bounded automatic repair sends one explicit owner-bound authorization and accepts a 202 receipt",async()=>{
  activatePrincipal(first);let calls=0;
  const sample={id:"fixture-auto",revision:6,status:"ready",goal:"合成数字翻倍",model:"fixture",modelDigest:"fixture-digest",
    attemptsUsed:1,maxAttempts:3,maxActiveMs:180000,activeMs:5,cases:[{id:"zero",input:0,expected:0}],createdAt:"t",updatedAt:"t",autoRunning:true};
  globalThis.fetch=async(url,init)=>{calls++;assert.match(String(url),/fixture-auto\/run$/);assert.equal(init?.method,"POST");
    assert.equal(new Headers(init?.headers).get("X-BetterMe-Owner"),first.id);
    assert.deepEqual(JSON.parse(String(init?.body)),{expectedRevision:5,consent:true});return Response.json({task:sample},{status:202});};
  assert.equal((await sandboxCodingClient.run(sample.id,5)).autoRunning,true);assert.equal(calls,1);
});

test("the UI create contract defaults to 180 active seconds and rejects non-integral or out-of-range seconds",()=>{
  const input={goal:"合成数字加倍",model:"fixture",cases:[{id:"zero",input:0,expected:0}],maxAttempts:3,consent:true};
  assert.equal(CodingInputSchema.parse(input).maxActiveMs,180000);
  for(const ms of [0,999,1500,301000])assert.equal(CodingInputSchema.safeParse({...input,maxActiveMs:ms}).success,false);
  assert.equal(CodingInputSchema.parse({...input,maxActiveMs:300000}).maxActiveMs,300000);
});
