import assert from "node:assert/strict";
import test,{afterEach,mock} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {sendAgentChat} from "../src/services/agent-client";
import {createFreeChatTaskClient,FreeChatTaskError} from "../src/services/free-chat-task-client";
import {activatePrincipal,IdentityBoundaryError} from "../src/lib/identity";
import {chatHost,chatOwner} from "./fixtures/free-chat-host";
const config={provider:"ollama" as const,model:"synthetic",baseUrl:"http://127.0.0.1:1/v1",apiKey:"SYNTHETIC-NEVER-A-REAL-KEY"};
const user={id:"u1",role:"user" as const,content:"只参与测试，不负责上线。"};
const answer=(content="请保留实际职责，缺少结果时先问。")=>JSON.stringify({kind:"reply",content});
afterEach(()=>{mock.restoreAll();activatePrincipal(undefined);});
test("real shared send interface uses only tasks, retains full prose and continues one conversation ledger",async t=>{
  let calls=0;const full="完整回答 "+ "正文。".repeat(3000)+"END\n\n```json\n{\"example\":\"this is prose, not a card\"}\n```";
  const host=await chatHost(t,async()=>{calls++;return {text:answer(full),finishReason:"stop"};});
  const first=await sendAgentChat({messages:[user],llmConfig:config,workspaceKey:"advisor:synthetic"});
  assert.equal(first.content,full);assert.equal(first.meta?.source,"agent-host");assert.equal(first.meta?.completeness,"complete");assert.equal(first.meta?.taskId,(await host.task()).id);
  const second={id:"u2",role:"user" as const,content:"继续，仍不补造上线成果。"};
  await sendAgentChat({messages:[user,first,second],llmConfig:config,workspaceKey:"advisor:synthetic"});
  assert.equal((await host.task()).usage.modelCalls,2);assert.equal((await host.task()).turn,2);assert.equal(calls,2);
  assert.equal(host.requests.filter(r=>r.path==="/api/v1/agent/tasks"&&r.body).length,1);
  assert.ok(host.requests.every(r=>r.path.startsWith("/api/v1/agent/tasks")));
  assert.ok(!JSON.stringify(await host.task()).includes(config.apiKey));
});
test("reconnecting the same input reads its existing result; budget exhaustion never opens a new task",async t=>{
  let calls=0;const host=await chatHost(t,async()=>{calls++;return answer();});
  const first=await sendAgentChat({messages:[user],llmConfig:config,workspaceKey:"resume:synthetic"});
  const saved=await host.task();await host.kernel.budget(saved.id,saved.revision,{...saved.budget,maxModelCalls:1});
  assert.equal((await sendAgentChat({messages:[user],llmConfig:config,workspaceKey:"resume:synthetic"})).id,first.id);assert.equal(calls,1);
  await assert.rejects(sendAgentChat({messages:[user,first,{...user,id:"u2",content:"继续"}],llmConfig:config,workspaceKey:"resume:synthetic"}),e=>e instanceof FreeChatTaskError&&e.code==="model_call_budget");
  assert.equal(calls,1);assert.equal((await host.kernel.listTasks()).length,1);
});
test("old images and long references are exact image parts on both turns, never discarded from history",async t=>{
  const image={name:"synthetic.png",mimeType:"image/png",dataUrl:"data:image/png;base64,AAAA"},reference="完整引用。".repeat(9000)+"REF-END";let calls=0;
  const host=await chatHost(t,async(prompt,_signal,phase,images)=>{calls++;assert.equal(phase,"free_chat");assert.ok(prompt.includes("REF-END"));assert.equal(images?.[0]?.dataUrl,image.dataUrl);assert.equal(images?.[0]?.messageId,user.id);assert.equal(prompt.includes(image.dataUrl),false);return answer();});
  const withImage={...user,attachments:[image],references:[{type:"resume_text" as const,text:reference,sourceLabel:"合成引用"}]};
  const first=await sendAgentChat({messages:[withImage],llmConfig:config});await sendAgentChat({messages:[withImage,first,{...user,id:"u2"}],llmConfig:config});
  assert.equal(calls,2);assert.equal((await host.task()).conversation.messages[0]?.references?.[0]?.text,reference);
});
test("a provider length limit remains paused with complete raw output and no automatic continuation",async t=>{
  let calls=0;const raw=answer("原始部分。".repeat(2000)+"PARTIAL-END"),host=await chatHost(t,async()=>{calls++;return {text:raw,finishReason:"length"};});
  await assert.rejects(sendAgentChat({messages:[user],llmConfig:config}),e=>e instanceof FreeChatTaskError&&e.code==="model_output_incomplete");
  assert.equal((await host.task()).partialOutput?.text,raw);assert.equal(calls,1);
  await assert.rejects(sendAgentChat({messages:[user],llmConfig:config}));assert.equal(calls,1);
});
test("scope, endpoint and history changes are explicit conflicts, not budget-resetting conversations",async t=>{
  let calls=0;const host=await chatHost(t,async()=>{calls++;return answer();}),context={resumeSummary:{headline:"参与测试"}};
  const first=await sendAgentChat({messages:[user],llmConfig:config,context}),messages=[user,first,{...user,id:"u2"}];
  await assert.rejects(sendAgentChat({messages,llmConfig:config}),e=>e instanceof FreeChatTaskError&&e.code==="conversation_scope_changed");
  await assert.rejects(sendAgentChat({messages,llmConfig:{...config,baseUrl:"http://127.0.0.1:2/v1"},context}),e=>e instanceof FreeChatTaskError&&e.code==="runtime_binding_changed");
  await assert.rejects(sendAgentChat({messages:[{...user,content:"偷偷改早期原文"},first,{...user,id:"u2"}],llmConfig:config,context}),e=>e instanceof FreeChatTaskError&&e.code==="conversation_history_changed");
  assert.equal(calls,1);assert.equal((await host.kernel.listTasks()).length,1);
});
test("observer cancellation does not cancel execution; explicit pause fences late output",async t=>{
  const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>(),controller=new AbortController();
  const host=await chatHost(t,async()=>{entered.resolve();return finish.promise;}),client=createFreeChatTaskClient({fetch:host.fetch,pollMs:1});
  const pending=client.send({messages:[user],workspaceKey:"synthetic",runtime:{kind:"model",modelSettings:config},signal:controller.signal});
  await entered.promise;controller.abort();await assert.rejects(pending);assert.equal((await host.task()).status,"running");
  await client.pause((await host.task()).id);finish.resolve(answer("迟到答案"));await delay(10);
  assert.equal((await host.task()).status,"paused");assert.equal((await host.task()).reply,undefined);assert.equal((await host.task()).usage.modelCalls,1);
});
test("unavailable, malformed or foreign task responses never trigger a browser provider",async t=>{
  activatePrincipal(chatOwner);let calls=0;
  t.mock.method(globalThis,"fetch",async url=>{calls++;assert.match(String(url),/\/api\/v1\/agent\/tasks$/);throw new TypeError("Failed to fetch");});
  await assert.rejects(sendAgentChat({messages:[user],llmConfig:config}),e=>e instanceof FreeChatTaskError&&e.code==="outcome_unknown");assert.equal(calls,1);
  t.mock.method(globalThis,"fetch",async()=>Response.json({reply:null}));
  await assert.rejects(sendAgentChat({messages:[user],llmConfig:config}),e=>e instanceof FreeChatTaskError&&e.code==="invalid_response");
  t.mock.method(globalThis,"fetch",async()=>Response.json({tasks:[{kind:"resume_tailor",ownerId:"22222222-2222-4222-8222-222222222222"}]}));
  await assert.rejects(sendAgentChat({messages:[user],llmConfig:config}),IdentityBoundaryError);
  activatePrincipal(undefined);const before=calls;await assert.rejects(sendAgentChat({messages:[user],llmConfig:config}),e=>e instanceof FreeChatTaskError&&e.code==="identity_required");assert.equal(calls,before);
});
test("a late response cannot be adopted after switching the account",async t=>{
  activatePrincipal(chatOwner);const started=Promise.withResolvers<void>(),response=Promise.withResolvers<Response>();
  t.mock.method(globalThis,"fetch",async()=>{started.resolve();return response.promise;});
  const pending=sendAgentChat({messages:[user],llmConfig:config});await started.promise;activatePrincipal({...chatOwner,id:"22222222-2222-4222-8222-222222222222"});response.resolve(Response.json({tasks:[]}));
  await assert.rejects(pending,IdentityBoundaryError);
});
