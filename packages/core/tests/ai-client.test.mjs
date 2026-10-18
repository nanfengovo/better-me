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
  assert.match(failed.message, /未收到可读取的服务商响应/);
  assert.match(failed.message, /网络、代理、API 地址或浏览器跨域限制/);
  assert.match(failed.message, /无法据此判断 API Key 或模型是否有效/);
});

test("official Gemini versions use native model listing with header authentication and no key URL", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return Response.json({ models: [
      { name: "models/gemini-example", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-example", supportedGenerationMethods: ["embedContent"] },
    ] });
  });
  for (const version of ["v1beta", "v1alpha"]) {
    for (const suffix of ["", "/", "/openai/", "/openai/chat/completions", "/chat/completions/"]) {
      const baseUrl = `https://generativelanguage.googleapis.com/${version}${suffix}`;
      assert.deepEqual(await fetchAvailableModels({ ...config, provider: "gemini", baseUrl }), ["gemini-example"]);
      const request = requests.at(-1);
      assert.equal(request.url, `https://generativelanguage.googleapis.com/${version}/models`);
      assert.equal(new Headers(request.init.headers).get("x-goog-api-key"), "test-only");
      assert.equal(new Headers(request.init.headers).get("Authorization"), null);
      assert.equal(new URL(request.url).search, "");
      assert.ok(!request.url.includes(config.apiKey));
    }
  }
  const before = requests.length;
  await assert.rejects(fetchAvailableModels({ ...config, apiKey: " ", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }), /请先填写 Google Gemini API Key/);
  assert.equal(requests.length, before);
});

test("the explicitly configured official Gemini mTLS host is preserved for listing and generation", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return init.method === "POST"
      ? Response.json({ choices: [{ message: { content: "response" } }] })
      : Response.json({ models: [{ name: "models/example-model", supportedGenerationMethods: ["generateContent"] }] });
  });
  for (const version of ["v1beta", "v1alpha"]) {
    for (const suffix of ["", "/", "/openai/", "/openai/chat/completions", "/chat/completions/"]) {
      const baseUrl = `https://generativelanguage.mtls.googleapis.com/${version}${suffix}`;
      const sharedConfig = { ...config, provider: "gemini", baseUrl };
      assert.deepEqual(await fetchAvailableModels(sharedConfig), ["example-model"]);
      const listing = requests.at(-1);
      assert.equal(listing.url, `https://generativelanguage.mtls.googleapis.com/${version}/models`);
      assert.equal(new Headers(listing.init.headers).get("x-goog-api-key"), config.apiKey);
      assert.equal(new Headers(listing.init.headers).get("Authorization"), null);
      assert.equal(await fetchChatCompletion(sharedConfig, messages), "response");
      const generation = requests.at(-1);
      assert.equal(generation.url, `https://generativelanguage.mtls.googleapis.com/${version}/openai/chat/completions`);
      assert.deepEqual(JSON.parse(generation.init.body), { model: config.model, messages, temperature: config.temperature });
      for (const request of [listing, generation]) {
        assert.equal(new URL(request.url).search, "");
        assert.ok(!request.url.includes(config.apiKey));
      }
    }
  }
  assert.equal(requests.length, 20);
});

test("Gemini provider custom gateways and lookalike hosts keep their own compatible models endpoint", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return Response.json({ data: [{ id: "gateway-model" }] });
  });
  const targets = [
    ["https://gateway.invalid/v1", "https://gateway.invalid/v1/models"],
    ["https://gateway.invalid/v1/chat/completions", "https://gateway.invalid/v1/models"],
    ["https://generativelanguage.googleapis.com.attacker.invalid/v1beta/openai", "https://generativelanguage.googleapis.com.attacker.invalid/v1beta/openai/models"],
    ["https://generativelanguage.mtls.googleapis.com.attacker.invalid/v1beta/openai", "https://generativelanguage.mtls.googleapis.com.attacker.invalid/v1beta/openai/models"],
    ["https://gateway.invalid/generativelanguage.googleapis.com/v1beta", "https://gateway.invalid/generativelanguage.googleapis.com/v1beta/models"],
    ["http://generativelanguage.googleapis.com/v1beta", "http://generativelanguage.googleapis.com/v1beta/models"],
    ["https://generativelanguage.googleapis.com/custom", "https://generativelanguage.googleapis.com/custom/models"],
  ];
  for (const [baseUrl, expected] of targets) {
    assert.deepEqual(await fetchAvailableModels({ ...config, provider: "gemini", baseUrl }), ["gateway-model"]);
    const request = requests.at(-1);
    assert.equal(request.url, expected);
    assert.equal(new Headers(request.init.headers).get("Authorization"), "Bearer test-only");
    assert.equal(new Headers(request.init.headers).get("x-goog-api-key"), null);
  }
  assert.equal(requests.length, targets.length);
});

test("model listing and generation respect the same official or custom Gemini configuration", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    if (init.method === "POST") return Response.json({ choices: [{ message: { content: "response" } }] });
    return Response.json({
      data: [{ id: "example-model" }],
      models: [{ name: "models/example-model", supportedGenerationMethods: ["generateContent"] }],
    });
  });
  const targets = [
    ["https://gateway.invalid/v1", "https://gateway.invalid/v1/models", "https://gateway.invalid/v1/chat/completions"],
    ["https://gateway.invalid/v1/chat/completions/", "https://gateway.invalid/v1/models", "https://gateway.invalid/v1/chat/completions"],
    ["https://generativelanguage.googleapis.com.attacker.invalid/v1beta", "https://generativelanguage.googleapis.com.attacker.invalid/v1beta/models", "https://generativelanguage.googleapis.com.attacker.invalid/v1beta/chat/completions"],
    ["https://generativelanguage.mtls.googleapis.com.attacker.invalid/v1beta", "https://generativelanguage.mtls.googleapis.com.attacker.invalid/v1beta/models", "https://generativelanguage.mtls.googleapis.com.attacker.invalid/v1beta/chat/completions"],
    ["https://gateway.invalid/generativelanguage.googleapis.com/v1beta", "https://gateway.invalid/generativelanguage.googleapis.com/v1beta/models", "https://gateway.invalid/generativelanguage.googleapis.com/v1beta/chat/completions"],
  ];
  for (const version of ["v1beta", "v1alpha"]) {
    for (const suffix of ["", "/openai/", "/openai/chat/completions", "/chat/completions/"]) {
      targets.push([
        `https://generativelanguage.googleapis.com/${version}${suffix}`,
        `https://generativelanguage.googleapis.com/${version}/models`,
        `https://generativelanguage.googleapis.com/${version}/openai/chat/completions`,
      ]);
    }
  }
  for (const provider of ["gemini", "custom"]) {
    for (const [baseUrl, modelsUrl, completionUrl] of targets) {
      const sharedConfig = { ...config, provider, baseUrl };
      assert.deepEqual(await fetchAvailableModels(sharedConfig), ["example-model"]);
      assert.equal(requests.at(-1).url, modelsUrl);
      assert.equal(await fetchChatCompletion(sharedConfig, messages), "response");
      const generation = requests.at(-1);
      assert.equal(generation.url, completionUrl);
      assert.equal(generation.init.method, "POST");
      assert.equal(new Headers(generation.init.headers).get("Authorization"), "Bearer test-only");
      assert.deepEqual(JSON.parse(generation.init.body), { model: config.model, messages, temperature: config.temperature });
    }
  }
  assert.equal(requests.length, targets.length * 2 * 2);
});

test("network diagnostics do not expose raw fetch URLs or keys in listing or generation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError(`Failed to fetch https://service.invalid?key=${config.apiKey}&token=private-token`);
  });
  const result = await testLlmConnection(config);
  assert.equal(result.success, false);
  assert.match(result.message, /未收到可读取的服务商响应/);
  assert.doesNotMatch(result.message, /test-only|private-token|Failed to fetch/);
  await assert.rejects(fetchChatCompletion(config, messages), (error) => {
    assert.match(error.message, /AI 生成请求未收到可读取的服务商响应/);
    assert.doesNotMatch(error.message, /test-only|private-token|Failed to fetch/);
    return true;
  });
});

test("response body transport failures receive the same actionable diagnostic", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => { throw new TypeError(`Failed to fetch body for ${config.apiKey}`); },
  }));
  for (const baseUrl of [config.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai"]) {
    const result = await testLlmConnection({ ...config, baseUrl });
    assert.equal(result.success, false);
    assert.match(result.message, /未收到可读取的服务商响应/);
    assert.doesNotMatch(result.message, /test-only|Failed to fetch/);
  }
  await assert.rejects(fetchChatCompletion(config, messages), /AI 生成请求未收到可读取的服务商响应/);
});

test("HTTP failures keep provider details and status while redacting actual keys and URL credentials", async (t) => {
  const secretConfig = { ...config, apiKey: "test/key+only" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message:
    `account denied ${secretConfig.apiKey} ${encodeURIComponent(secretConfig.apiKey)} https://service.invalid/path?key=unrelated-key&token=private-token&access_token=another-secret` } }, { status: 403 }));
  const compatible = await testLlmConnection(secretConfig);
  const native = await testLlmConnection({ ...secretConfig, baseUrl: "https://generativelanguage.googleapis.com/v1alpha/openai" });
  for (const result of [compatible, native]) {
    assert.equal(result.success, false);
    assert.match(result.message, /403.*account denied/);
    assert.doesNotMatch(result.message, /test\/key\+only|test%2Fkey%2Bonly|unrelated-key|private-token|another-secret/);
    assert.match(result.message, /\[已隐藏\]/);
    assert.doesNotMatch(result.message, /未收到可读取的服务商响应/);
  }
  await assert.rejects(fetchChatCompletion(secretConfig, messages), (error) => {
    assert.match(error.message, /AI 接口请求失败 \(403\): account denied/);
    assert.doesNotMatch(error.message, /test\/key\+only|test%2Fkey%2Bonly|unrelated-key|private-token|another-secret/);
    return true;
  });
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
  await assert.rejects(analyzeJdMatch(config, {
    locale: "zh", templateId: "zh-classic",
    profile: { displayName: "Synthetic fixture", links: [], targetRoles: [], traits: [] },
    experiences: [{ id: "fixture-work", type: "work", org: "Fixture Lab", title: "Developer", start: "2024-01", end: null, techStack: ["C#"], claims: [{ id: "fixture-claim", kind: "action", text: "Developed a device status API with automated tests.", tags: [] }] }],
  }, "example JD"), (error) => {
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

test("already cancelled model requests do not start fetch", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchAvailableModels(config, { signal: controller.signal }), (error) => {
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /已取消/);
    assert.doesNotMatch(error.message, /超时/);
    return true;
  });
  const result = await testLlmConnection(config, { signal: controller.signal });
  assert.equal(result.success, false);
  assert.match(result.message, /已取消/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("caller cancellation aborts a pending fetch without becoming a timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requestSignal = init.signal;
    return rejectWhenAborted(init.signal);
  });
  const controller = new AbortController();
  const pending = fetchAvailableModels(config, { signal: controller.signal });
  assert.notEqual(requestSignal, controller.signal);
  controller.abort(new Error("test-only private cancellation reason"));
  t.mock.timers.tick(20_000);
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /已取消/);
    assert.doesNotMatch(error.message, /超时|private cancellation/);
    return true;
  });
  assert.equal(requestSignal.aborted, true);
});

test("caller cancellation remains active while a model-list response body is pending", async (t) => {
  let requestSignal;
  let finishBody;
  const body = new Promise((resolve) => { finishBody = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requestSignal = init.signal;
    return { ok: true, json: () => body };
  });
  const controller = new AbortController();
  const pending = fetchAvailableModels(config, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  finishBody({ data: [{ id: "late-model" }] });
  await assert.rejects(pending, (error) => error.name === "AbortError" && /已取消/.test(error.message));
  assert.equal(requestSignal.aborted, true);
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
  const pending = fetchAvailableModels({ ...config, provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });
  await fallbackReady;
  t.mock.timers.tick(20_000);
  await assert.rejects(pending, /获取模型列表超时（20 秒）/);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});
