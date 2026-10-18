import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { LlmConfig } from "@better-me/core";

// Mount the real modal and AI client. Only synthetic model-list responses are used.
const dom = new Window({ url: "http://127.0.0.1:5199" });
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, HTMLSelectElement: dom.HTMLSelectElement,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AiConfigModal } = await import("../src/components/AiConfigModal.tsx");
const originalFetch = globalThis.fetch;
const config: LlmConfig = {
  provider: "openai-compatible", baseUrl: "https://ai-fixture.invalid/v1",
  apiKey: "fixture-secret-only", model: "user-chosen-model", temperature: 0.3,
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const modelsResponse = (...models: string[]) => response({ data: models.map(id => ({ id })) });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
type Request = { url: string; init: RequestInit | undefined };
let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void | Promise<void> = () => undefined) {
  await act(async () => { await action(); await nextTurn(); await nextTurn(); });
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(found, `missing button: ${label}`);
  assert.equal(found.disabled, false, `disabled button: ${label}`);
  return found;
}
async function click(label: string) { await flush(() => button(label).click()); }
function modelSelect() {
  const field = dom.document.getElementById("ai-model");
  assert.ok(field instanceof dom.HTMLSelectElement, "missing model selector");
  return field;
}
const optionValues = () => [...modelSelect().options].map(option => option.value);
function keyInput() {
  const field = dom.document.getElementById("ai-api-key");
  assert.ok(field instanceof dom.HTMLInputElement, "missing API key field");
  return field;
}
const alertText = () => dom.document.querySelector('[role="alert"]')?.textContent ?? "";

async function mount(policy: (request: Request, index: number) => Response | Promise<Response> = () => modelsResponse("model-a", "model-b")) {
  const calls: Request[] = [];
  const saved: LlmConfig[] = [];
  let visible = true;
  let currentConfig = config;
  globalThis.fetch = async (url, init) => {
    const request = { url: String(url), init };
    assert.match(request.url, /^https:\/\/ai-fixture\.invalid\/v[12]\/models$/, "fixture must never request external services");
    assert.ok(!init?.method || init.method === "GET", "model listing must not make a generation request");
    assert.equal(init?.body, undefined);
    calls.push(request);
    return policy(request, calls.length - 1);
  };
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")! as unknown as Element);
  const renderCurrent = () => root!.render(createElement(AiConfigModal, {
    isOpen: visible, config: currentConfig,
    onClose() { visible = false; renderCurrent(); },
    onSave(value: LlmConfig) { saved.push(value); },
  }));
  const render = async (isOpen = true, nextConfig = currentConfig) => {
    visible = isOpen;
    currentConfig = nextConfig;
    await flush(renderCurrent);
  };
  await render();
  return { calls, saved, render };
}

afterEach(async () => {
  await flush(() => { root?.unmount(); root = undefined; });
  globalThis.fetch = originalFetch;
});
after(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("成功获取列表保留用户模型，只有显式选择才更换并保存", async () => {
  const { calls, saved } = await mount();
  assert.ok(dom.document.querySelector('[role="dialog"][aria-modal="true"]'));
  assert.equal(modelSelect().value, config.model);
  await click("获取模型列表（不测试生成）");
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.init?.signal instanceof AbortSignal);
  assert.equal(modelSelect().value, config.model, "a successful refresh must not silently choose the first model");
  assert.deepEqual(optionValues(), ["model-a", "model-b", config.model]);
  assert.match(dom.document.querySelector('[role="status"]')?.textContent ?? "", /模型列表已获取/);
  assert.match(dom.document.querySelector('[role="status"]')?.textContent ?? "", /生成请求尚未验证/);
  assert.equal(alertText(), "");
  await flush(() => {
    modelSelect().value = "model-b";
    modelSelect().dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
  await click("保存配置");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.model, "model-b");
});

test("网络 TypeError 显示可操作原因，不把预设或原模型当作读取成功", async () => {
  const { calls } = await mount(() => { throw new TypeError("Failed to fetch"); });
  await click("刷新列表");
  assert.equal(calls.length, 1);
  assert.match(alertText(), /未获得模型列表/);
  assert.match(alertText(), /网络/);
  assert.match(alertText(), /代理/);
  assert.match(alertText(), /跨域/);
  assert.match(alertText(), /检查.*重试/);
  assert.doesNotMatch(alertText(), /Failed to fetch/);
  assert.equal(dom.document.querySelector('[role="status"]'), null);
  assert.deepEqual(optionValues(), [config.model]);
  assert.equal(modelSelect().value, config.model);
});

test("关闭中止列表请求，忽略 abort 的迟到响应不能污染重开后的新列表", async () => {
  const old = deferred<Response>();
  const { calls, render } = await mount((_request, index) => index === 0 ? old.promise : modelsResponse("current-model"));
  await click("刷新列表");
  const oldSignal = calls[0]!.init?.signal;
  assert.ok(oldSignal && !oldSignal.aborted);
  await click("关闭 AI 配置");
  assert.equal(oldSignal.aborted, true);
  assert.equal(dom.document.querySelector('[role="dialog"]'), null);
  await render();
  await click("刷新列表");
  assert.deepEqual(optionValues(), ["current-model", config.model]);
  await flush(() => old.resolve(modelsResponse("late-old-model")));
  assert.deepEqual(optionValues(), ["current-model", config.model]);
  assert.equal(modelSelect().value, config.model);
  assert.equal(alertText(), "");
  assert.match(dom.document.querySelector('[role="status"]')?.textContent ?? "", /已获取 1 个模型标识/);
});

test("外部关闭面板同样中止请求，迟到响应不在重开时留下旧结果", async () => {
  const old = deferred<Response>();
  const { calls, render } = await mount(() => old.promise);
  await click("刷新列表");
  await render(false);
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  await flush(() => old.resolve(modelsResponse("late-old-model")));
  await render();
  assert.deepEqual(optionValues(), [config.model]);
  assert.equal(dom.document.querySelector('[role="status"]'), null);
  assert.equal(alertText(), "");
});

test("外部配置切换中止旧请求并保留新配置，旧列表不能覆盖新模型", async () => {
  const old = deferred<Response>();
  const { calls, render } = await mount(() => old.promise);
  await click("刷新列表");
  const nextConfig = { ...config, baseUrl: "https://ai-fixture.invalid/v2", model: "new-config-model" };
  await render(true, nextConfig);
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  assert.equal(modelSelect().value, nextConfig.model);
  await flush(() => old.resolve(modelsResponse("late-old-model")));
  assert.deepEqual(optionValues(), [nextConfig.model]);
  assert.equal(dom.document.querySelector('[role="status"]'), null);
  assert.equal(alertText(), "");
});

test("真实 unmount 中止请求，迟到结果不会进入后续新挂载", async () => {
  const old = deferred<Response>();
  const { calls } = await mount(() => old.promise);
  await click("刷新列表");
  await flush(() => { root!.unmount(); root = undefined; });
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  await flush(() => old.resolve(modelsResponse("late-old-model")));
  await mount();
  assert.deepEqual(optionValues(), [config.model]);
  assert.equal(dom.document.querySelector('[role="status"]'), null);
  assert.equal(alertText(), "");
});

test("API Key 默认隐藏，主动显示后关闭重开仍隐藏且不自动请求", async () => {
  const { calls, render } = await mount();
  assert.equal(keyInput().type, "password");
  assert.equal(keyInput().value, config.apiKey);
  assert.equal(keyInput().autocomplete, "off");
  await click("显示");
  assert.equal(keyInput().type, "text");
  await click("取消");
  await render();
  assert.equal(keyInput().type, "password");
  assert.equal(keyInput().value, config.apiKey);
  assert.equal(calls.length, 0);
});

test("HTTP 403 保留状态和服务商错误，隐藏回显 Key 且不显示成功", async () => {
  await mount(() => response({ error: { message: `fixture permission denied for ${config.apiKey}` } }, 403));
  await click("获取模型列表（不测试生成）");
  assert.match(alertText(), /未获得模型列表/);
  assert.match(alertText(), /403/);
  assert.match(alertText(), /fixture permission denied/);
  assert.doesNotMatch(alertText(), /fixture-secret-only/);
  assert.equal(dom.document.querySelector('[role="status"]'), null);
  assert.equal(modelSelect().value, config.model);
});
