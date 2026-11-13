import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { careerRuntimeBinding, type CareerTask } from "@better-me/agent-contracts";
import { createCareerTaskRuntimeResolver } from "../src/tasks/runtime.js";
import { CareerTaskService } from "../src/tasks/service.js";
import { buildModel } from "../src/model.js";
import type { UnderstandingRuntime } from "../src/understanding/http.js";
import type { NativeAccountTools } from "../src/native-tools/service.js";
import type { AgentRouting } from "../src/routing/service.js";
import { setTimeout as delay } from "node:timers/promises";
import { RejectedTaskModelOutput } from "../src/kernel/model-protocol.js";

const lease={session:"test-session",valid:async()=>true};
const model=(baseUrl:string):Extract<UnderstandingRuntime,{kind:"model"}>=>({kind:"model",modelSettings:{provider:"custom",model:"fixture-model",baseUrl,apiKey:"never-a-real-key"}});
const sample=(runtime:UnderstandingRuntime,preferred?:string)=>({id:"synthetic",runtimeBinding:careerRuntimeBinding(runtime,preferred)} as CareerTask);
const none=async()=>{};
test("Studio uses the full frozen JSON grammar and one shared SDK dispatch, not an independent local completion", async t => {
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-studio",baseUrl:"http://127.0.0.1:1/v1"}},contract={type:"object",additionalProperties:false,properties:{id:{type:"string",enum:["exact-evidence-id"]}},required:["id"]};let calls=0;
  t.mock.method(globalThis,"fetch",async(url,init)=>{calls++;assert.equal(String(url),"http://127.0.0.1:1/v1/chat/completions");const body=JSON.parse(String(init?.body));
    assert.equal(body.response_format.json_schema.name,"agent_studio_analysis");assert.deepEqual(body.response_format.json_schema.schema,contract);assert.equal(body.messages[1].content,"  完整分析请求😀\r\nEND  ");
    return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:'{"id":"exact-evidence-id"}'},finish_reason:"stop"}]});});
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none});
  try{const runtime=await resolve(rt,lease,sample(rt),none);await runtime.reasoner("  完整分析请求😀\r\nEND  ",new AbortController().signal,"studio_analysis",undefined,undefined,contract);assert.equal(calls,1);
    await assert.rejects(runtime.reasoner("x",new AbortController().signal,"free_chat",undefined,undefined,contract),/analysis_contract_phase_mismatch/);assert.equal(calls,1);
  }finally{resolve.close();}
});
test("committee phase forwards exact Host grammar through the existing SDK with no schema conversion or hidden retry", async t => {
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-committee",baseUrl:"http://127.0.0.1:1/v1"}};
  const contract={anyOf:[{type:"object",additionalProperties:false,properties:{kind:{const:"request_evidence"},requests:{type:"array",uniqueItems:true,prefixItems:[{const:{evidenceId:"exact-source",startLine:1,endLine:2}}]}}},{type:"object",additionalProperties:false,properties:{kind:{const:"assessment"},role:{const:"adjudicator"}}}]};
  const raw='{"kind":"request_evidence","requests":[{"evidenceId":"exact-source","startLine":1,"endLine":2}]}';let calls=0;
  t.mock.method(globalThis,"fetch",async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.name,"agent_studio_committee");assert.deepEqual(body.response_format.json_schema.schema,contract);assert.equal(body.messages[1].content,"  完整委员会轮次😀\r\nTAIL  ");
    return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:raw},finish_reason:"stop"}]});});
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none});
  try{const adapter=await resolve(rt,lease,sample(rt),none);const result=await adapter.reasoner("  完整委员会轮次😀\r\nTAIL  ",new AbortController().signal,"studio_committee",undefined,undefined,contract);assert.equal(typeof result==="string"?result:result.text,raw);assert.equal(calls,1);
    await assert.rejects(adapter.reasoner("x",new AbortController().signal,"studio_committee"),/analysis_contract_phase_mismatch/);assert.equal(calls,1);
  }finally{resolve.close();}
});
test("one owner resolver shares its adapter across concurrent tasks and turns, with explicit credential and lifetime fences", async () => {
  const rt = model("https://model.fixture.invalid/v1"); let builds = 0, calls = 0;
  const deps = { nativeTools: {} as NativeAccountTools, routing: {} as AgentRouting, scan: none,
    reasoner: async () => { builds++; return async () => { calls++; return "synthetic"; }; } };
  const resolve = createCareerTaskRuntimeResolver(deps);
  const [first, second] = await Promise.all([resolve(rt, lease, sample(rt), none), resolve(rt, lease, { ...sample(rt), id: "second-task" }, none)]);
  assert.equal(builds, 1, "concurrent construction crosses one cached promise");
  await first.reasoner("turn one", new AbortController().signal, "free_chat");
  await second.reasoner("tool source", new AbortController().signal, "tool_source");
  const third = await resolve(rt, lease, sample(rt), none);
  await third.reasoner("turn two", new AbortController().signal, "free_chat");
  assert.equal(builds, 1); assert.equal(calls, 3);
  const rotated = { ...rt, modelSettings: { ...rt.modelSettings, apiKey: "different-synthetic-key" } };
  const changed = await resolve(rotated, lease, sample(rotated), none);
  assert.notEqual(changed.runtimeFingerprint, first.runtimeFingerprint); assert.equal(builds, 2);
  const otherOwner = createCareerTaskRuntimeResolver(deps);
  await otherOwner(rt, lease, sample(rt), none); assert.equal(builds, 3, "another owner never borrows the adapter");
  resolve.invalidateSession(lease.session);
  await resolve(rt, lease, sample(rt), none); assert.equal(builds, 4, "sign-out drops configured credentials");
  resolve.close();
  await assert.rejects(third.reasoner("late", new AbortController().signal, "free_chat"), /runtime_resolver_closed/);
  await assert.rejects(resolve(rt, lease, sample(rt), none), /runtime_resolver_closed/);
  assert.equal(calls, 3); otherOwner.close();
});

test("native adapter reuse is lease-local while every turn installs and releases its own watcher", async () => {
  const rt = { kind: "native" as const, runtimeId: "codex" }; let selections = 0, watchers = 0, releases = 0;
  const native = { authorizationFingerprint: async () => "generation-one", reasoner: async () => { selections++; return async () => "synthetic"; },
    watchTurn: () => { watchers++; return () => { releases++; }; } } as unknown as NativeAccountTools;
  const resolve = createCareerTaskRuntimeResolver({ nativeTools: native, routing: {} as AgentRouting, scan: none });
  const first = await resolve(rt, lease, sample(rt), none), second = await resolve(rt, lease, { ...sample(rt), id: "next-turn" }, none);
  assert.equal(selections, 1); assert.equal(watchers, 2);
  first.release?.(); second.release?.(); assert.equal(releases, 2);
  const another = await resolve(rt, { ...lease, session: "another-session" }, sample(rt), none);
  assert.equal(selections, 2, "a native closure cannot inherit another interaction lease"); another.release?.();
  resolve.invalidateSession(lease.session);
  const resumed = await resolve(rt, lease, sample(rt), none); assert.equal(selections, 3); resumed.release?.(); resolve.close();
});

test("configured runtime selects the distinct experience-writing wire schema with one SDK send",async t=>{
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-editor",baseUrl:"http://127.0.0.1:1/v1"}};let calls=0;
  t.mock.method(globalThis,"fetch",async(url,init)=>{calls++;assert.equal(String(url),"http://127.0.0.1:1/v1/chat/completions");const body=JSON.parse(String(init?.body));
    assert.equal(body.response_format.json_schema.name,"agent_experience_refine");assert.ok(body.response_format.json_schema.schema.properties.evidenceQuotes);assert.equal(body.response_format.json_schema.schema.properties.kind,undefined);
    assert.match(body.messages[0].content,/experience editor/);assert.equal(body.messages[1].content,"完整授权字段与补充。");
    return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:JSON.stringify({questions:["本人做了什么？"],rationale:"缺事实先问。",evidenceQuotes:[]})},finish_reason:"stop"}]});});
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none}),runtime=await resolve(rt,lease,sample(rt),none);
  await runtime.reasoner("完整授权字段与补充。",new AbortController().signal,"experience_refine");assert.equal(calls,1);resolve.close();
});

test("project-understanding uses its explicit broker/paging schema on the selected SDK transport",async t=>{
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-project",baseUrl:"http://127.0.0.1:1/v1"}};let calls=0;
  t.mock.method(globalThis,"fetch",async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.name,"agent_project_understanding");assert.match(JSON.stringify(body.response_format.json_schema.schema),/read_evidence/);assert.match(body.messages[0].content,/project understanding/);assert.equal(body.messages[1].content,"完整项目原文及证据句柄。");return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:'{"kind":"read","requests":[{"grantId":"evidence","operation":"read_evidence","path":"ref_synthetic","offset":0,"length":100}]}'},finish_reason:"stop"}]});});
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none}),runtime=await resolve(rt,lease,sample(rt),none);await runtime.reasoner("完整项目原文及证据句柄。",new AbortController().signal,"project_understanding");assert.equal(calls,1);resolve.close();
});

test("configured JD runtime selects its strict match/read schema with one SDK send",async t=>{
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-jd",baseUrl:"http://127.0.0.1:1/v1"}};let calls=0;
  t.mock.method(globalThis,"fetch",async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.name,"agent_jd_match");assert.match(JSON.stringify(body.response_format.json_schema.schema),/read_evidence/);assert.equal(body.messages[1].content,"完整岗位原句与已授权自述。");return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:'{"kind":"match","proposals":[]}'},finish_reason:"stop"}]});});
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none});
  try{const runtime=await resolve(rt,lease,sample(rt),none);await runtime.reasoner("完整岗位原句与已授权自述。",new AbortController().signal,"jd_match");assert.equal(calls,1);}finally{resolve.close();}
});

test("configured interview runtime selects the question/page/receipt schema with one SDK send",async t=>{
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-interview",baseUrl:"http://127.0.0.1:1/v1"}};let calls=0;
  t.mock.method(globalThis,"fetch",async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.name,"agent_mock_interview");const schema=JSON.stringify(body.response_format.json_schema.schema);assert.match(schema,/read_evidence/);assert.match(schema,/receipt/);assert.match(schema,/answerId/);assert.match(body.messages[0].content,/mock interviewer/);assert.equal(body.messages[1].content,"完整父证据与作答历史。");return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:'{"kind":"question","content":"请说明本人职责？","evidenceIds":[]}'},finish_reason:"stop"}]});});
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none});
  try{const runtime=await resolve(rt,lease,sample(rt),none);await runtime.reasoner("完整父证据与作答历史。",new AbortController().signal,"mock_interview");assert.equal(calls,1);}finally{resolve.close();}
});

test("coaching phase uses one explicit SDK or native dispatch with the same schema and no internal retry",async t=>{
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-coach",baseUrl:"http://127.0.0.1:1/v1"}};let calls=0;
  t.mock.method(globalThis,"fetch",async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.name,"agent_career_coach");assert.match(JSON.stringify(body.response_format.json_schema.schema),/evidenceAssessment/);assert.match(body.messages[0].content,/learning coach/);assert.equal(body.messages[1].content,"完整职业成长请求");return Response.json({id:"synthetic",object:"chat.completion",created:1,model:"synthetic-coach",choices:[{index:0,message:{role:"assistant",content:'{"kind":"analysis"}'},finish_reason:"stop"}]});});
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none});
  try{const runtime=await resolve(rt,lease,sample(rt),none);await runtime.reasoner("完整职业成长请求",new AbortController().signal,"career_coach");assert.equal(calls,1);}finally{resolve.close();}
  let nativeCalls=0;
  const native={authorizationFingerprint:async()=>"same-native-grant",reasoner:async()=>async(prompt:string)=>{nativeCalls++;assert.match(prompt,/learning coach/);assert.match(prompt,/Host output schema:/);assert.ok(prompt.endsWith("完整职业成长请求"));return "{}";},watchTurn:()=>()=>{}} as unknown as NativeAccountTools;
  const nativeResolve=createCareerTaskRuntimeResolver({nativeTools:native,routing:{} as AgentRouting,scan:none}),selected={kind:"native" as const,runtimeId:"codex"};
  try{const runtime=await nativeResolve(selected,lease,sample(selected),none);await runtime.reasoner("完整职业成长请求",new AbortController().signal,"career_coach");runtime.release?.();assert.equal(nativeCalls,1);}finally{nativeResolve.close();}
});

test("configured runtime sends every image as an exact multimodal part, not base64 inside the text prompt",async t=>{
  const rt=model("https://fixture-model.invalid/v1"),image={messageId:"u-image",name:"synthetic.png",mimeType:"image/png",dataUrl:"data:image/png;base64,AAAA"};let calls=0;
  t.mock.method(globalThis,"fetch",async(url,init)=>{calls++;assert.equal(String(url),"https://fixture-model.invalid/v1/chat/completions");const body=JSON.parse(String(init?.body)),parts=body.messages[1].content;
    assert.equal(parts[0].text,"complete authorized text");assert.ok(parts[1].text.includes("u-image"));assert.equal(parts[2].image_url.url,image.dataUrl);
    return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:JSON.stringify({kind:"reply",content:"image received"})},finish_reason:"stop"}]});});
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none}),runtime=await resolve(rt,lease,sample(rt),none);
  const reply=await runtime.reasoner("complete authorized text",new AbortController().signal,"free_chat",[image]);assert.equal(calls,1);assert.equal(typeof reply==="string"?undefined:reply.finishReason,"stop");
});
test("JD intake uses one explicit SDK/native dispatch, full source and exact-offset schema",async t=>{
  const prompt="  完整岗位正文🚧\r\n"+"原文不截取。\r\n".repeat(600)+"TAIL-METADATA  ";
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-intake",baseUrl:"http://127.0.0.1:1/v1"}};let calls=0;
  t.mock.method(globalThis,"fetch",async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.name,"agent_jd_intake");
    assert.match(JSON.stringify(body.response_format.json_schema.schema),/start/);assert.match(body.messages[0].content,/exact job metadata/);
    assert.equal(body.messages[1].content,prompt);
    return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:'{"kind":"metadata","fields":{"title":null,"company":null,"salary":null,"location":null}}'},finish_reason:"stop"}]});
  });
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none});
  try{const runtime=await resolve(rt,lease,sample(rt),none);await runtime.reasoner(prompt,new AbortController().signal,"jd_intake");assert.equal(calls,1);}finally{resolve.close();}
  let nativeCalls=0;
  const native={authorizationFingerprint:async()=>"same-grant",reasoner:async()=>async(text:string)=>{
    nativeCalls++;assert.match(text,/exact job metadata/);assert.match(text,/Host output schema:/);assert.ok(text.endsWith(prompt));return "{}";
  },watchTurn:()=>()=>{}} as unknown as NativeAccountTools;
  const nativeResolve=createCareerTaskRuntimeResolver({nativeTools:native,routing:{} as AgentRouting,scan:none}),selected={kind:"native" as const,runtimeId:"codex"};
  try{const runtime=await nativeResolve(selected,lease,sample(selected),none);await runtime.reasoner(prompt,new AbortController().signal,"jd_intake");runtime.release?.();assert.equal(nativeCalls,1);}finally{nativeResolve.close();}
});
test("OCR phase dispatches exact ordered image parts once through the SDK, and native rejects images without fallback",async t=>{
  const rt={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-ocr",baseUrl:"http://127.0.0.1:1/v1"}},images=Array.from({length:6},(_,index)=>({messageId:`img-${index}`,name:`原始截图-${index}.png`,mimeType:"image/png",dataUrl:`data:image/png;base64,${Buffer.alloc(1024,index).toString("base64")}`}));let calls=0;
  t.mock.method(globalThis,"fetch",async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.equal(body.response_format.json_schema.name,"agent_jd_ocr");assert.match(body.messages[0].content,/transcribe job screenshots/);
    const parts=body.messages[1].content;assert.equal(parts[0].text,"  完整截图任务与原图清单\r\nTAIL  ");assert.deepEqual(parts.filter((part:{type:string})=>part.type==="image_url").map((part:{image_url:{url:string}})=>part.image_url.url),images.map(image=>image.dataUrl));
    return Response.json({id:"synthetic",object:"chat.completion",created:1,model:rt.modelSettings.model,choices:[{index:0,message:{role:"assistant",content:JSON.stringify({kind:"ocr",text:"  合成岗位文字保留原样，不推断任何个人任职事实。  "})},finish_reason:"stop"}]});
  });
  const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none});
  try{const runtime=await resolve(rt,lease,sample(rt),none);await runtime.reasoner("  完整截图任务与原图清单\r\nTAIL  ",new AbortController().signal,"jd_ocr",images);assert.equal(calls,1);}finally{resolve.close();}
  let nativeCalls=0;const selected={kind:"native" as const,runtimeId:"codex"},native={authorizationFingerprint:async()=>"same-grant",watchTurn:()=>()=>{},reasoner:async()=>async()=>{nativeCalls++;return "never";}} as unknown as NativeAccountTools;
  const nativeResolve=createCareerTaskRuntimeResolver({nativeTools:native,routing:{} as AgentRouting,scan:none});
  try{const runtime=await nativeResolve(selected,lease,sample(selected),none);assert.equal(runtime.supportsImages,false);await assert.rejects(runtime.reasoner("original images",new AbortController().signal,"jd_ocr",images),/task_images_not_supported/);assert.equal(nativeCalls,0);assert.equal(calls,1);runtime.release?.();}finally{nativeResolve.close();}
});
test("actual fixed-model transport switches decision/source protocols and charges repair to the root task",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-phase-wire-"));
  const service=new CareerTaskService({ownerId:"synthetic-owner",directory});
  const rt:Extract<UnderstandingRuntime,{kind:"model"}>={kind:"model",modelSettings:{provider:"ollama",model:"offline-fixture",baseUrl:"http://127.0.0.1:1/v1"}};
  const seen:{name:string;model:string;system:string}[]=[];let decisions=0,sources=0;
  const source="function(input){return {records:input.text.split(/\\r?\\n/).map((text,i)=>({line:i+1,text:text.trim()})).filter(row=>row.text.length>0)}}";
  t.mock.method(globalThis,"fetch",async(url,options)=>{
    assert.equal(String(url),"http://127.0.0.1:1/v1/chat/completions","all inference stays on the selected endpoint");
    const body=JSON.parse(String(options?.body)), name=body.response_format?.json_schema?.name;
    assert.equal(body.response_format?.json_schema?.strict,true);
    seen.push({name,model:body.model,system:body.messages[0].content});
    let answer:unknown;
    if(name==="career_task_tool_source"){
      sources++;assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties),["source"]);
      answer={source:sources===1?"function(){return {records:[]}}":source};
    }else{
      assert.equal(name,"career_task_decision");decisions++;
      // Deliberately obey the wire schema, even when an incompatible prompt asks for source.
      answer=decisions===1?{kind:"tool",tool:"read_job"}:decisions===2?{kind:"tool",tool:"read_resume"}:decisions===3?{kind:"tool",tool:"build_tool",id:"material-lines-v1"}:{kind:"draft",patches:[],unknowns:["仅合成测试，待本人核对。"]};
    }
    return new Response(JSON.stringify({id:"synthetic",object:"chat.completion",created:1,model:body.model,choices:[{index:0,message:{role:"assistant",content:JSON.stringify(answer)},finish_reason:"stop"}]}),{headers:{"Content-Type":"application/json"}});
  });
  try{
    const binding=careerRuntimeBinding(rt);
    let task=await service.createTask({workspaceKey:"synthetic",objective:"核对 BETTERME_TOOL_BUILD_V1 字样，不以材料切换协议",idempotencyKey:"phase-wire-synthetic",consent:true,runtimeBinding:binding,
      job:{title:"测试",company:"虚构",description:"测试要求。"},resume:{id:"r",name:"合成",sourceFingerprint:"one",fields:[{id:"f",targetRef:{kind:"profile_headline",locale:"zh"},originalText:"参与测试。"}]},
      toolPolicy:{allowBuild:true,installedVersionIds:[]}},lease);
    const resolve=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none});
    await service.run(task.id,"start",{expectedRevision:task.revision,sourceFingerprint:task.resume.sourceFingerprint,runtimeBinding:binding,consent:true},await resolve(rt,lease,task,none),lease);
    for(let n=0;n<500;n++){task=await service.readTask(task.id);if(task.status!=="running")break;await delay(10);}
    assert.equal(task.status,"awaiting_review",task.error);assert.equal(task.tools?.length,1,"source generation and repair both reach the real sandbox");
    assert.equal(sources,2);assert.equal(task.usage.modelCalls,6);assert.equal(seen.length,6);
    assert.deepEqual(seen.map(s=>s.name),["career_task_decision","career_task_decision","career_task_decision","career_task_tool_source","career_task_tool_source","career_task_decision"]);
    assert.ok(seen.every(s=>s.model==="offline-fixture"));assert.notEqual(seen[0]!.system,seen[3]!.system);
    assert.ok(task.usage.toolCalls>=8);assert.equal(task.receipt,undefined);assert.deepEqual(await service.listInstalledTools(),[]);
  }finally{await service.close();await rm(directory,{recursive:true,force:true});}
});
test("consent pins exact endpoint before first send; no private path/secret in labels and no local/cloud substitution",async()=>{
  let calls=0;
  const resolve=createCareerTaskRuntimeResolver({routing:{} as AgentRouting,nativeTools:{} as NativeAccountTools,scan:none,reasoner:async()=>{calls++;return async()=>"not dispatched";}});
  const initial=model("https://model.fixture.invalid/tenant-a/v1"), t=sample(initial);
  const sha=createHash("sha256").update(initial.modelSettings.baseUrl!).digest("hex");
  assert.ok(t.runtimeBinding.id.endsWith(sha));assert.ok(!JSON.stringify(t.runtimeBinding).includes("tenant-a")&&!JSON.stringify(t.runtimeBinding).includes("never-a-real-key"));
  assert.ok(t.runtimeBinding.label.includes("model.fixture.invalid"));assert.equal(t.runtimeBinding.location,"cloud");
  assert.deepEqual(careerRuntimeBinding(model("https://MODEL.fixture.invalid/tenant-a/v1/")),t.runtimeBinding);
  for(const endpoint of ["https://model.fixture.invalid/tenant-b/v1","https://different.fixture.invalid/tenant-a/v1","http://127.0.0.1:1234/v1"]){
    await assert.rejects(resolve(model(endpoint),lease,t,none),/runtime_binding_changed/);
  }
  await assert.rejects(resolve(initial,lease,{...t,runtimeBinding:{...t.runtimeBinding,location:"local"}},none),/runtime_binding_changed/);
  assert.equal(calls,0);await resolve(initial,lease,t,none);assert.equal(calls,1);
  for(const url of ["http://outside.fixture.invalid/v1","https://person:secret@outside.fixture.invalid/v1","https://outside.fixture.invalid/v1?key=fixture"]){
    assert.throws(()=>careerRuntimeBinding(model(url)),/unsafe_model_endpoint/);
  }
});

test("late configured-model result cannot cross a lease change or reuse a non-manual backup chain",async()=>{
  let valid=true,scans=0;const entered=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();
  const a={session:"owner-A",valid:async()=>valid};
  const selected=model("https://model.fixture.invalid/v1");
  const r=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{policy:async()=>({mode:"auto",revision:7,preferred:"codex",backups:["fake-paid"]})} as unknown as AgentRouting,
    scan:async()=>{scans++;},reasoner:async()=>async()=>{entered.resolve();await done.promise;return "must not publish";}});
  const {reasoner}=await r(selected,a,sample(selected),none);
  const pending=reasoner("synthetic",new AbortController().signal,"tool_source");await entered.promise;valid=false;done.resolve();
  await assert.rejects(pending,/identity_changed/);valid=true;
  const unified={kind:"unified" as const,expectedRevision:7};
  await assert.rejects(r(unified,a,sample(unified,"codex"),none),/explicit_selected_runtime_required/);assert.equal(scans,0);
});

for(const reason of ["pause","lease","close"] as const)test(`a ${reason} fence preserves the full returned wire without authorizing it`,async()=>{
  let valid=true,calls=0;const entered=Promise.withResolvers<void>(),done=Promise.withResolvers<void>(),controller=new AbortController();
  const output={text:"  完整返回😀\r\n"+"unabridged wire ".repeat(12000)+"\r\nTAIL  ",finishReason:"stop"};
  const selected=model("https://model.fixture.invalid/v1"),r=createCareerTaskRuntimeResolver({nativeTools:{} as NativeAccountTools,routing:{} as AgentRouting,scan:none,
    reasoner:async()=>async()=>{calls++;entered.resolve();await done.promise;return output;}});
  try{
    const runtime=await r(selected,{session:"synthetic-private-owner",valid:async()=>valid},sample(selected),none);
    const pending=runtime.reasoner("full synthetic input",controller.signal,"free_chat");await entered.promise;
    if(reason==="pause")controller.abort("explicit_stop");else if(reason==="lease")valid=false;else r.close();
    done.resolve();
    await assert.rejects(pending,error=>{assert.ok(error instanceof RejectedTaskModelOutput);assert.deepEqual(error.output,output);
      assert.equal(error.code,reason==="pause"?"stale_task_turn":reason==="lease"?"identity_changed":"runtime_resolver_closed");return true;});
    await assert.rejects(runtime.reasoner("no new send",controller.signal,"free_chat"));assert.equal(calls,1);
  }finally{done.resolve();r.close();}
});

test("native credential generation changes reject an existing paused task before dispatch; watchers released when settled or rejected",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"betterme-career-native-pin-"));const service=new CareerTaskService({ownerId:"fixture-owner",directory:dir});
  const rt={kind:"unified" as const,expectedRevision:7};let generation="one",dispatches=0,releases=0;
  const sent=Promise.withResolvers<void>(),late=Promise.withResolvers<void>(),uses:string[]=[];
  const native={authorizationFingerprint:async(id:string)=>{assert.equal(id,"codex");return generation;},reasoner:async(id:string)=>{uses.push(id);return async()=>{
    dispatches++;sent.resolve();await late.promise;return JSON.stringify({kind:"tool",tool:"read_job"});};}} as unknown as NativeAccountTools;
  const routing={policy:async()=>({mode:"manual",revision:7,preferred:"codex",backups:["never-used"]}),watchTurn:async()=>()=>{releases++;}} as unknown as AgentRouting;
  const resolve=createCareerTaskRuntimeResolver({nativeTools:native,routing,scan:none});
  try{
    const binding=careerRuntimeBinding(rt,"codex");let t=await service.create({workspaceKey:"w",objective:"synthetic",idempotencyKey:"native-pin-task",consent:true,runtimeBinding:binding,
      job:{title:"Synthetic",company:"Synthetic",description:"test"},resume:{id:"r",name:"r",sourceFingerprint:"s1",fields:[{id:"f",targetRef:{kind:"profile_headline",locale:"en"},originalText:"Testing"}]}});
    const input=(t:CareerTask)=>({expectedRevision:t.revision,sourceFingerprint:t.resume.sourceFingerprint,runtimeBinding:binding,consent:true as const});
    t=await service.run(t.id,"start",input(t),await resolve(rt,lease,t,()=>service.cancelActive(t.id)),lease);await sent.promise;
    t=await service.stop(t.id,t.revision);assert.equal(releases,1);generation="two";late.resolve();
    const next=await resolve(rt,lease,t,()=>service.cancelActive(t.id));await assert.rejects(service.run(t.id,"resume",input(t),next,lease),/runtime_authorization_changed/);
    assert.equal(dispatches,1);assert.ok(uses.every(x=>x==="codex"));assert.equal(releases,2);assert.equal((await service.get(t.id)).usage.modelCalls,1);
  }finally{late.resolve();await service.close();await rm(dir,{recursive:true,force:true});}
});

test("configured SDK transient failure issues exactly one wire request when using task budgets",async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response(JSON.stringify({error:{message:"fixture overload",type:"server_error"}}),{status:503,headers:{"Content-Type":"application/json","retry-after":"0"}});});
  const m=buildModel(model("https://fixture-model.invalid/v1").modelSettings,{maxRetries:0});
  await assert.rejects(m.invoke([{role:"user",content:"synthetic input"}]));assert.equal(calls,1);
});

test("authorization/policy replacements before dispatch and while a native result is in flight are fenced",async()=>{
  const rt={kind:"unified" as const,expectedRevision:3},t=sample(rt,"codex");
  let generation="one",mode="manual",calls=0;const entered=Promise.withResolvers<void>(),late=Promise.withResolvers<void>();
  const native={authorizationFingerprint:async()=>generation,reasoner:async()=>async()=>{calls++;entered.resolve();await late.promise;return "stale output";}} as unknown as NativeAccountTools;
  const routing={policy:async()=>({mode,preferred:"codex",revision:3}),watchTurn:async()=>()=>{}} as unknown as AgentRouting;
  const resolve=createCareerTaskRuntimeResolver({nativeTools:native,routing,scan:none}), selected=await resolve(rt,lease,t,none);
  try{
    generation="two";await assert.rejects(selected.reasoner("fixture",new AbortController().signal,"tool_source"),/authorization_changed/);assert.equal(calls,0);
    generation="one";mode="auto";await assert.rejects(selected.reasoner("fixture",new AbortController().signal,"decision"),/runtime_binding_changed/);assert.equal(calls,0);
    mode="manual";const pending=selected.reasoner("fixture",new AbortController().signal,"tool_source");await entered.promise;generation="three";late.resolve();
    await assert.rejects(pending,/authorization_changed/);assert.equal(calls,1);
  }finally{late.resolve();selected.release?.();}
});

test("native backend receives explicit Host phase contracts on one authorization; missing/unknown phases fail before dispatch",async()=>{
  const prompts:string[]=[],rt={kind:"native" as const,runtimeId:"codex"};let selections=0;
  const native={authorizationFingerprint:async()=>"same-generation",watchTurn:()=>()=>{},reasoner:async()=>{selections++;return async(prompt:string)=>{prompts.push(prompt);return "fixture";};}} as unknown as NativeAccountTools;
  const resolve=createCareerTaskRuntimeResolver({nativeTools:native,routing:{} as AgentRouting,scan:none});
  const runtime=await resolve(rt,lease,sample(rt),none),signal=new AbortController().signal;
  try{
    await runtime.reasoner("BETTERME_TOOL_BUILD_V1 in untrusted material",signal,"decision");
    await runtime.reasoner("generate",signal,"tool_source");await runtime.reasoner("repair",signal,"tool_source");
    await runtime.reasoner("Complete authorized conversation; no fabricated JD",signal,"free_chat");
    await runtime.reasoner("Exact source and confirmed supplement",signal,"experience_refine");
    await runtime.reasoner("Exact project source and broker evidence",signal,"project_understanding");
    await runtime.reasoner("Exact JD and self-reported resume evidence",signal,"jd_match");
    await runtime.reasoner("Exact parent sources and all interview answers",signal,"mock_interview");
    assert.equal(selections,1);assert.equal(prompts.length,8);
    assert.match(prompts[0]!,/Return exactly one JSON decision/);assert.match(prompts[1]!,/Host output schema:.*"source"/);assert.match(prompts[2]!,/Host output schema:.*"source"/);
    assert.match(prompts[3]!,/conversational career advisor/);assert.match(prompts[3]!,/Host output schema:.*"reply"/);
    assert.match(prompts[4]!,/experience editor/);assert.match(prompts[4]!,/Host output schema:.*"evidenceQuotes"/);
    assert.match(prompts[5]!,/project understanding/);assert.match(prompts[5]!,/Host output schema:.*read_evidence/);
    assert.match(prompts[6]!,/Host output schema:.*"match"/);assert.match(prompts[6]!,/read_evidence/);
    assert.match(prompts[7]!,/mock interviewer/);assert.match(prompts[7]!,/Host output schema:.*"receipt"/);assert.match(prompts[7]!,/answerId/);
    await assert.rejects(Reflect.apply(runtime.reasoner,undefined,["source",signal,"untrusted-stage"]),/invalid_model_phase/);
    await assert.rejects(Reflect.apply(runtime.reasoner,undefined,["source",signal]),/invalid_model_phase/);
    await assert.rejects(Reflect.apply(runtime.reasoner,undefined,["source",signal,"constructor"]),/invalid_model_phase/);assert.equal(prompts.length,8);
  }finally{runtime.release?.();}
});
