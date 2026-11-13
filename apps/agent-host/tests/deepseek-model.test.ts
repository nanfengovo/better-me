import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { buildModel, ModelSettingsSchema, DeepSeekApiError } from "../src/model.js";
import { ChatRequestBodySchema } from "../src/chat/types.js";
import { createAgentServer } from "../src/server.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { registerTestIdentity } from "./fixtures/identity.js";
import {careerRuntimeBinding,FreeChatTaskSchema} from "@better-me/agent-contracts";

const settings = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "synthetic-only", thinkingMode: "enabled" as const, reasoningEffort: "max" as const, maxTokens: 32768 };

test("agent request validation preserves DeepSeek controls and rejects invalid limits", () => {
  const input = { modelSettings: settings, messages: [{ id: "user", role: "user", content: "synthetic" }] };
  assert.equal(ChatRequestBodySchema.parse(input).modelSettings.reasoningEffort, "max");
  assert.equal(ModelSettingsSchema.safeParse({ ...settings, maxTokens: 393217 }).success, false);
});

test("DeepSeek model sends thinking parameters and preserves reasoning across a real SDK tool round trip", async t => {
  const calls: Record<string, any>[] = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const message = calls.length === 1
      ? { role: "assistant", content: null, reasoning_content: "synthetic private reasoning", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] }
      : { role: "assistant", content: "Final answer", reasoning_content: "more private reasoning" };
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: settings.model, choices: [{ index: 0, message, finish_reason: calls.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
  });
  const model = buildModel(settings);
  assert.ok(model.bindTools);
  const bound = model.bindTools([{ type: "function", function: { name: "lookup", description: "Synthetic read only", parameters: { type: "object", properties: {} } } }]);
  const user = new HumanMessage("Synthetic request");
  const first = await bound.invoke([user]);
  assert.equal(first.content, "");
  assert.equal(first.additional_kwargs.reasoning_content, "synthetic private reasoning");
  const second = await bound.invoke([user, first, new ToolMessage({ tool_call_id: "call-1", content: "synthetic result" })]);
  assert.equal(second.content, "Final answer");
  assert.deepEqual(calls[0]!.thinking, { type: "enabled" });
  assert.equal(calls[0]!.reasoning_effort, "max");
  assert.equal(calls[0]!.temperature, undefined);
  assert.equal(calls[0]!.max_tokens, 32768);
  assert.equal(calls[1]!.messages[1].reasoning_content, "synthetic private reasoning");
  assert.equal(second.usage_metadata?.total_tokens, 30);
});

test("fast mode omits reasoning effort and unrelated providers keep generic transport", async t => {
  const bodies: Record<string, any>[] = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: settings.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
  });
  await buildModel({ ...settings, thinkingMode: "disabled", temperature: 0.4 }).invoke([new HumanMessage("Synthetic")]);
  assert.deepEqual(bodies[0]!.thinking, { type: "disabled" });
  assert.equal(bodies[0]!.temperature, 0.4);
  assert.equal(bodies[0]!.reasoning_effort, undefined);
  await buildModel({ ...settings, baseUrl: "https://gateway.invalid/v1" }).invoke([new AIMessage("Synthetic"), new HumanMessage("Continue")]);
  assert.equal(bodies[1]!.thinking, undefined);
});

test("DeepSeek SDK errors are sanitized, classified and not retried", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: { message: `balance error ${settings.apiKey}`, type: "insufficient_balance" } }, { status: 402 });
  });
  await assert.rejects(buildModel(settings).invoke([new HumanMessage("Synthetic request")]), error => {
    assert.ok(error instanceof DeepSeekApiError);
    assert.equal(error.status, 402);
    assert.match(error.message, /余额不足/);
    assert.ok(!error.message.includes(settings.apiKey));
    return true;
  });
  assert.equal(calls, 1);
});

test("pasted official DeepSeek endpoint paths resolve to the same model transport", async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    urls.push(String(url));
    assert.deepEqual(JSON.parse(String(init?.body)).thinking, { type: "enabled" });
    return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: settings.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
  });
  for (const suffix of ["/models/", "/v1/models", "/beta/chat/completions/"]) {
    await buildModel({ ...settings, baseUrl: `https://api.deepseek.com${suffix}` }).invoke([new HumanMessage("Synthetic")]);
  }
  assert.deepEqual(urls, ["https://api.deepseek.com/chat/completions", "https://api.deepseek.com/v1/chat/completions", "https://api.deepseek.com/beta/chat/completions"]);
});

test("authenticated task chat honors DeepSeek controls and persists only safe provider failure codes", async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!String(url).startsWith("https://api.deepseek.com/")) return originalFetch(url, init);
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.reasoning_effort, "max");
    assert.equal(body.max_tokens, 32768);
    return calls === 1
      ? Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: settings.model, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({kind:"reply",content:"Synthetic HTTP response"}), reasoning_content: "never displayed" }, finish_reason: "stop" }] })
      : Response.json({ error: { message: settings.apiKey } }, { status: 402 });
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-deepseek-http-"));
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: "synthetic-host-token", allowedOrigins: ["http://127.0.0.1:5173"], checkpointer: new MemorySaver(), runsDirectory: directory });
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const identity = await registerTestIdentity(`http://127.0.0.1:${address.port}`, "synthetic-host-token", "fixture-user", "http://127.0.0.1:5173");
    const runtime={kind:"model" as const,modelSettings:settings},runtimeBinding=careerRuntimeBinding(runtime);
    const request=(route:string,body?:unknown)=>originalFetch(`http://127.0.0.1:${address.port}/api/v1/agent${route}`,{method:body===undefined?"GET":"POST",headers:{...identity.headers,"Content-Type":"application/json",Authorization:"Bearer synthetic-host-token",Origin:"http://127.0.0.1:5173"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const send=async(key:string)=>{
      const created=await request("/tasks",{kind:"free_chat",workspaceKey:"synthetic-http",rootScopeKey:"synthetic-deepseek-root",objective:"合成HTTP传输回归",conversation:{messages:[{id:key,role:"user",content:"Synthetic HTTP request"}]},runtimeBinding,consent:true,idempotencyKey:key});
      assert.equal(created.status,201,await created.clone().text());let task=FreeChatTaskSchema.parse((await created.json()).task);
      const started=await request(`/tasks/${task.id}/start`,{expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding,consent:true,runtime});assert.equal(started.status,202,await started.clone().text());
      for(let i=0;i<300;i++){task=FreeChatTaskSchema.parse((await(await request(`/tasks/${task.id}`)).json()).task);if(task.status!=="running")return task;await new Promise(resolve=>setTimeout(resolve,5));}
      throw Error("synthetic DeepSeek task did not settle");
    };
    const first=await send("synthetic-first-request");assert.equal(first.status,"awaiting_answer");assert.equal(first.reply?.content,"Synthetic HTTP response");assert.equal(first.reply?.meta?.source,"agent-host");assert.ok(!JSON.stringify(first).includes("never displayed"));
    const second=await send("synthetic-second-request");assert.equal(second.status,"failed");assert.equal(second.error,"model_provider_402");assert.equal(second.rootLedger!.usage.modelCalls,2);assert.ok(!JSON.stringify(second).includes(settings.apiKey));
    const retired=await request("/chat",{modelSettings:settings,messages:[{id:"old",role:"user",content:"no inference"}]});assert.equal(retired.status,410);
    assert.equal(calls, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
