import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeJdMatch,
  fetchAvailableModels,
  fetchChatCompletion,
  testLlmConnection,
} from "../dist/ai/client.js";

const config = {
  provider: "custom", baseUrl: "https://model.invalid/v1", apiKey: "test-only",
  model: "example-model", temperature: 0.3,
};
const messages = [{ role: "user", content: "example request" }];

test("model-list success does not claim generation has been tested", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return Response.json({ data: [{ id: "example-model" }, { id: "" }, { id: 3 }] });
  });
  const result = await testLlmConnection(config);
  assert.equal(result.success, true);
  assert.deepEqual(result.models, ["example-model"]);
  assert.match(result.message, /实际生成请求尚未验证/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://model.invalid/v1/models");
  assert.equal(requests[0].init.headers.Authorization, "Bearer test-only");
  assert.equal(requests[0].init.method, undefined);
});

test("an empty model list is not reported as a successful model check", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  const result = await testLlmConnection(config);
  assert.equal(result.success, false);
  assert.deepEqual(result.models, []);
  assert.match(result.message, /未返回模型标识/);
  assert.match(result.message, /实际生成请求尚未验证/);
});

test("listing HTTP and network failures remain visible", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "account denied" } }, { status: 403 }));
  const denied = await testLlmConnection(config);
  assert.equal(denied.success, false);
  assert.match(denied.message, /403.*account denied/);
  fetchMock.mock.mockImplementation(async () => { throw new TypeError("network unavailable"); });
  const failed = await testLlmConnection(config);
  assert.equal(failed.success, false);
  assert.match(failed.message, /network unavailable/);
});

test("generation normalizes Gemini URL and requires nonempty string content", async (t) => {
  const requests = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return Response.json({ choices: [{ message: { content: "response" } }] });
  });
  assert.equal(await fetchChatCompletion({ ...config, provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/" }, messages), "response");
  assert.equal(requests[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(JSON.parse(requests[0].init.body).messages[0].content, "example request");
  fetchMock.mock.mockImplementation(async () => Response.json({ choices: [{ message: { content: { invalid: true } } }] }));
  await assert.rejects(fetchChatCompletion(config, messages), /未返回有效/);
});

test("invalid JD model output is neither logged nor echoed in parse errors", async (t) => {
  const sensitiveOutput = "private model content not valid JSON";
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: sensitiveOutput } }] }));
  const errorLog = t.mock.method(console, "error", () => {});
  await assert.rejects(analyzeJdMatch(config, {}, "example JD"), (error) => {
    assert.match(error.message, /标准诊断报告/);
    assert.ok(!error.message.includes(sensitiveOutput));
    return true;
  });
  assert.equal(errorLog.mock.callCount(), 0);
});

function rejectWhenAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

test("generation times out after 90 seconds even while reading the response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requestSignal = init.signal;
    return { ok: true, json: () => rejectWhenAborted(init.signal) };
  });
  const pending = fetchChatCompletion(config, messages);
  await Promise.resolve();
  t.mock.timers.tick(89_999);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, /AI 生成请求超时（90 秒）/);
  assert.equal(requestSignal.aborted, true);
});

test("model listing times out after 20 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requestSignal = init.signal;
    return rejectWhenAborted(init.signal);
  });
  const pending = fetchAvailableModels(config);
  t.mock.timers.tick(19_999);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, /获取模型列表超时（20 秒）/);
});

test("Gemini native and fallback list requests share a single 20-second deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  let fallbackStarted;
  const fallbackReady = new Promise((resolve) => { fallbackStarted = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    signals.push(init.signal);
    if (signals.length === 1) return Response.json({ models: [] });
    fallbackStarted();
    return rejectWhenAborted(init.signal);
  });
  const pending = fetchAvailableModels({ ...config, provider: "gemini" });
  await fallbackReady;
  t.mock.timers.tick(20_000);
  await assert.rejects(pending, /获取模型列表超时（20 秒）/);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});
