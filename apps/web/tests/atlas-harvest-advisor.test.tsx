import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import type { LlmConfig } from "@better-me/core";
import type { HarvestIssue } from "../src/components/atlas/harvest-issue-presentation";

const dom = new Window({ url: "http://atlas-advisor-fixture.invalid" });
const React = await import("react");
const { createElement, act } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const originalFetch = globalThis.fetch;
const { createRoot } = await import("react-dom/client");
const { AtlasHarvestAdvisor } = await import("../src/components/atlas/AtlasHarvestAdvisor");
const issue: HarvestIssue = { id: "source:test", scope: "source", severity: "error", source: "测试来源",
  title: "平台读取失败", reason: "token=do-not-send 读取超时", advice: "查看来源", action: { kind: "details", label: "查看" },
  rawDetails: ["Cookie: private-do-not-send"] };
let root: ReturnType<typeof createRoot> | undefined;
const requests: Array<{ url: string; init?: RequestInit }> = [];
async function render(config: LlmConfig, onAskAgent?: (prompt: string) => void) {
  root = createRoot(dom.document.body);
  await act(async () => root!.render(createElement(AtlasHarvestAdvisor, { issues: [issue], saved: 9, config, active: true, onAskAgent })));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; dom.document.body.replaceChildren(); requests.length = 0; globalThis.fetch = originalFetch;
});
after(() => { dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
} });

test("local Agent proactively checks browser health and analyses only structured receipts without executing recovery", async () => {
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/api/jd/real-chrome")) return new Response(JSON.stringify({ running: true, port: 9222, binaryFound: true, message: "就绪" }), { headers: { "Content-Type": "application/json" } });
    if (String(input).endsWith("/api/v1/agent/chat")) return new Response(JSON.stringify({ reply: { content: "已保存9张；先检查原站，再由用户决定是否重试。" } }), { headers: { "Content-Type": "application/json" } });
    assert.fail(`unexpected request: ${String(input)}`);
  };
  await render({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "", model: "fixture", temperature: 0.3 });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 850)); });
  assert.equal(requests.filter(request => request.url.endsWith("/api/jd/real-chrome")).length, 1);
  assert.equal(requests.filter(request => request.url.endsWith("/api/v1/agent/chat")).length, 1);
  const payload = String(requests.find(request => request.url.endsWith("/api/v1/agent/chat"))?.init?.body);
  assert.doesNotMatch(payload, /do-not-send|Cookie|读取超时/);
  assert.match(dom.document.body.textContent!, /已连接/);
  assert.match(dom.document.body.textContent!, /已保存9张/);
  assert.match(dom.document.body.textContent!, /不会自动重试平台/);
});

test("a non-local model waits for an explicit analysis click", async () => {
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ running: false, port: 9222, binaryFound: true, message: "未连接" }), { headers: { "Content-Type": "application/json" } });
  };
  let draft = "";
  await render({ provider: "gemini", baseUrl: "https://example.invalid/v1", apiKey: "fixture-key", model: "fixture", temperature: 0.3 }, prompt => { draft = prompt; });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 850)); });
  assert.deepEqual(requests.map(request => request.url), ["/api/jd/real-chrome"]);
  assert.match(dom.document.body.textContent!, /让当前模型补充分析/);
  const ask = [...dom.document.querySelectorAll("button")].find(button => button.textContent?.includes("在 Agent 对话里继续排查"));
  await act(async () => { ask!.click(); });
  assert.match(draft, /先问我一个最关键的核对问题/);
  assert.doesNotMatch(draft, /private-do-not-send|读取超时/);
  assert.deepEqual(requests.map(request => request.url), ["/api/jd/real-chrome"], "opening a guided draft must not send it automatically");
});
