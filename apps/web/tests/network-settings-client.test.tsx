import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_NETWORK_SETTINGS, getNetworkSettings, saveNetworkSettings, testNetworkConnection, validateNetworkSettings, type NetworkSettings } from "../src/lib/network-settings.ts";

test("国内独立代理兼容旧设置，空白与undefined不制造已启用配置", () => {
  assert.deepEqual(validateNetworkSettings(DEFAULT_NETWORK_SETTINGS), DEFAULT_NETWORK_SETTINGS);
  for (const domesticProxyUrl of [undefined, "", " \t "]) {
    const settings = validateNetworkSettings({ ...DEFAULT_NETWORK_SETTINGS, domesticProxyUrl });
    assert.deepEqual(settings, DEFAULT_NETWORK_SETTINGS);
    assert.equal(Object.hasOwn(settings, "domesticProxyUrl"), false);
    assert.equal(JSON.stringify(settings).includes("domesticProxyUrl"), false);
  }
});

test("国内独立代理在三种常规模式下均保留，规范化不修改调用者草稿", () => {
  for (const mode of ["auto", "direct", "manual"] as const) {
    const draft: NetworkSettings = { mode, proxyUrl: "http://127.0.0.1:7890", bypass: "localhost,.example.com", domesticProxyUrl: " HTTP://127.0.0.1:17891/ " };
    const original = structuredClone(draft);
    const result = validateNetworkSettings(draft);
    assert.equal(result.domesticProxyUrl, "http://127.0.0.1:17891");
    assert.equal(result.mode, mode);
    assert.equal(result.proxyUrl, mode === "manual" ? "http://127.0.0.1:7890" : "");
    assert.equal(result.bypass, original.bypass);
    assert.deepEqual(draft, original);
  }
  assert.equal(validateNetworkSettings({ ...DEFAULT_NETWORK_SETTINGS, domesticProxyUrl: "https://[::1]:17891/" }).domesticProxyUrl, "https://[::1]:17891");
});

test("国内独立代理共用代理地址限制，拒绝认证、SOCKS、PAC和错误字段类型", () => {
  for (const domesticProxyUrl of ["socks5://127.0.0.1:17891", "file:///proxy.pac", "http://user:secret@127.0.0.1:17891", "http://127.0.0.1:17891/config", "http://127.0.0.1:17891?token=secret", "http://127.0.0.1:17891#", "127.0.0.1:17891", "x".repeat(2049)]) {
    assert.throws(() => validateNetworkSettings({ ...DEFAULT_NETWORK_SETTINGS, domesticProxyUrl }), /国内招聘平台独立代理/);
  }
  for (const domesticProxyUrl of [null, 17891, false, {}, []]) {
    assert.throws(() => validateNetworkSettings({ ...DEFAULT_NETWORK_SETTINGS, domesticProxyUrl }), /国内招聘平台独立代理地址必须为文字/);
  }
});

test("网络API读取旧配置并仅在显式保存时写入国内独立代理", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ settings: init?.method === "PUT" ? JSON.parse(String(init.body)).settings : DEFAULT_NETWORK_SETTINGS }));
    };
    assert.deepEqual(await getNetworkSettings(), DEFAULT_NETWORK_SETTINGS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.method, undefined);
    const draft = { ...DEFAULT_NETWORK_SETTINGS, domesticProxyUrl: " HTTP://127.0.0.1:17891/ " };
    const before = structuredClone(draft);
    const saved = await saveNetworkSettings(draft);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.url, "/api/network/settings");
    assert.equal(calls[1]?.init?.method, "PUT");
    assert.equal(JSON.parse(String(calls[1]?.init?.body)).settings.domesticProxyUrl, "http://127.0.0.1:17891");
    assert.equal(saved.domesticProxyUrl, "http://127.0.0.1:17891");
    assert.deepEqual(draft, before);
  } finally { globalThis.fetch = original; }
});

test("测试国内独立代理发送当前草稿和站点但不保存或改变常规配置", async () => {
  const original = globalThis.fetch;
  const draft: NetworkSettings = { mode: "manual", proxyUrl: "http://127.0.0.1:7890", bypass: "localhost", domesticProxyUrl: "http://127.0.0.1:17891" };
  const before = structuredClone(draft);
  const calls: { url: string; method?: string; body: unknown }[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, status: 200, message: "收到HTTP响应", elapsedMs: 15, route: { mode: "manual", source: "国内招聘平台独立代理", proxyUrl: draft.domesticProxyUrl } }));
    };
    const result = await testNetworkConnection(draft, "51job");
    assert.deepEqual(calls, [{ url: "/api/network/test", method: "POST", body: { settings: draft, target: "51job" } }]);
    assert.equal(result.route.proxyUrl, draft.domesticProxyUrl);
    assert.deepEqual(draft, before);
  } finally { globalThis.fetch = original; }
});
