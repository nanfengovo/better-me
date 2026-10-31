import assert from "node:assert/strict";
import test from "node:test";
import { LlmConfigSchema, isOfficialDeepSeek, jsonObjectOptions, fetchChatCompletionResult, fetchAvailableModels, testLlmGeneration } from "../dist/index.js";

const config = LlmConfigSchema.parse({ provider: "openai-compatible", apiKey: "synthetic-deepseek-key", thinkingMode: "disabled" });
const messages = [{ role: "user", content: "Synthetic test only" }];
const answer = (content = "BETTERME_OK", finish_reason = "stop") => Response.json({ choices: [{ message: { content, reasoning_content: "not an answer" }, finish_reason }] });

test("official DeepSeek detection and defaults do not alter third-party endpoints", () => {
  assert.equal(config.model, "deepseek-flash");
  for (const suffix of ["", "/", "/v1", "/v1/", "/chat/completions", "/v1/chat/completions/"]) assert.equal(isOfficialDeepSeek({ baseUrl: `https://api.deepseek.com${suffix}` }), true);
  for (const baseUrl of ["https://api.deepseek.com.evil.invalid", "https://api.deepseek.com@evil.invalid", "http://api.deepseek.com", "https://api.deepseek.com/?key=x", "https://api.deepseek.com/anthropic"]) assert.equal(isOfficialDeepSeek({ baseUrl }), false);
  assert.deepEqual(jsonObjectOptions(config), { responseFormat: { type: "json_object" } });
  assert.deepEqual(jsonObjectOptions({ ...config, baseUrl: "https://gateway.invalid/v1" }), {});
  assert.equal(LlmConfigSchema.safeParse({ ...config, maxTokens: 393217 }).success, false);
});

test("fast and thinking requests use documented controls; reasoning never becomes the final answer", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) }); return answer(); });
  const result = await fetchChatCompletionResult(config, messages, jsonObjectOptions(config));
  assert.equal(result.content, "BETTERME_OK");
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${config.apiKey}`);
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
  assert.equal(calls[0].body.reasoning_effort, undefined);
  assert.equal(calls[0].body.temperature, 0.3);
  assert.equal(calls[0].body.max_tokens, 8192);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  await fetchChatCompletionResult({ ...config, baseUrl: "https://api.deepseek.com/v1/", thinkingMode: "enabled", reasoningEffort: "max", maxTokens: 32768 }, messages);
  assert.equal(calls[1].url, "https://api.deepseek.com/v1/chat/completions");
  assert.deepEqual(calls[1].body.thinking, { type: "enabled" });
  assert.equal(calls[1].body.reasoning_effort, "max");
  assert.equal(calls[1].body.temperature, undefined);
  assert.equal(calls[1].body.max_tokens, 32768);
  await fetchChatCompletionResult({ ...config, baseUrl: "https://gateway.invalid/v1" }, messages);
  assert.equal(calls[2].body.thinking, undefined);
  assert.equal(calls[2].body.max_tokens, undefined);
});

test("missing key, unsupported schema and Pro images fail before sending any request", async t => {
  let count = 0;
  t.mock.method(globalThis, "fetch", async () => { count++; return answer(); });
  await assert.rejects(fetchAvailableModels({ ...config, apiKey: " " }), /DeepSeek API Key/);
  await assert.rejects(fetchChatCompletionResult({ ...config, apiKey: " " }, messages), /DeepSeek API Key/);
  await assert.rejects(fetchChatCompletionResult(config, messages, { responseFormat: { type: "json_schema" } }), /json_object/);
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,synthetic" } };
  await assert.rejects(fetchChatCompletionResult({ ...config, model: "deepseek-v4-pro" }, [{ role: "user", content: [image] }]), /不支持图片/);
  assert.equal(count, 0);
  await fetchChatCompletionResult(config, [{ role: "user", content: [image] }]);
  assert.equal(count, 1);
});

test("DeepSeek status errors are actionable and do not echo credentials or retry", async t => {
  let calls = 0;
  const checks = [[401, /Key 无效/], [402, /余额不足/], [422, /请求参数/], [429, /并发/], [503, /繁忙/]];
  for (const [status, pattern] of checks) {
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: { message: config.apiKey } }, { status }); });
    const result = await testLlmGeneration(config);
    assert.equal(result.success, false);
    assert.match(result.message, pattern);
    assert.ok(!result.message.includes(config.apiKey));
    t.mock.restoreAll();
  }
  assert.equal(calls, checks.length);
});

test("model listing and explicit generation probe are separate and send no resume/history", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return init.method === "POST" ? answer() : Response.json({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
  });
  assert.deepEqual(await fetchAvailableModels(config), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, undefined);
  assert.equal((await testLlmGeneration(config)).success, true);
  assert.deepEqual(JSON.parse(calls[1].init.body).messages, [{ role: "user", content: "Reply with only: BETTERME_OK" }]);
});

test("blank/reasoning-only and length-limited generations are not presented as successful", async t => {
  t.mock.method(globalThis, "fetch", async () => answer("   "));
  assert.equal((await testLlmGeneration(config)).success, false);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => answer("partial", "length"));
  assert.equal((await testLlmGeneration(config)).success, false);
});

test("cancelled DeepSeek generation propagates cancellation without retry", async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => { calls++; controller.abort(); init.signal.throwIfAborted(); });
  await assert.rejects(testLlmGeneration(config, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});
