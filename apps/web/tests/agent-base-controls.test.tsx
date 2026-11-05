import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";
import { defaultAgentRoutingPolicy, type AgentRoutingPolicy, type AgentRoutingTrace, type UnderstandingCapability } from "@better-me/agent-contracts";
import type { AgentRoutingClient } from "../src/services/agent-routing-client";
import type { UnderstandingClient } from "../src/services/understanding-client";
registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "https://routing-synthetic.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createElement: h, act, StrictMode } = React;
const { createRoot } = await import("react-dom/client");
const { AgentRoutingProvider, useAgentRouting } = await import("../src/lib/agent-routing");
const { AgentBaseControls } = await import("../src/components/AgentBaseControls");
const { AgentTopBarStatus } = await import("../src/components/AgentTopBarStatus");
const { AgentRoutingClientError } = await import("../src/services/agent-routing-client");
const items: UnderstandingCapability[] = [
  { id: "codex", name: "Codex", available: true, supported: false, code: "managed_policy_unavailable", reason: "管理策略同步受阻" },
  { id: "opencode", name: "OpenCode", available: true, supported: true, code: "needs_verification", authorizationMode: "api-key" },
  { id: "claude-code", name: "Claude Code", available: true, supported: true, code: "ready", authorizationMode: "native" },
  { id: "gemini-cli", name: "Gemini CLI", available: true, supported: false, code: "needs_authorization" },
  { id: "pi", name: "Pi", available: false, supported: false, code: "not_installed" },
];
function fixture() {
  let policy = structuredClone(defaultAgentRoutingPolicy), trace: AgentRoutingTrace | undefined;
  let failure = false, release: (() => void) | undefined, hold: Promise<void> | undefined, signal: AbortSignal | undefined;
  const saved: AgentRoutingPolicy[] = [], requests: unknown[] = [];
  const client: AgentRoutingClient = {
    status: async () => ({ policy: structuredClone(policy), trace }),
    update: async next => { assert.equal(next.revision, policy.revision); policy = { ...next, revision: next.revision + 1 }; saved.push(policy); return structuredClone(policy); },
    respond: async (input, active) => {
      requests.push(input); signal = active; if (hold) await hold;
      trace = { id: input.id, at: new Date().toISOString(), policyRevision: input.expectedRevision, state: failure ? "failed" : "completed", runtimeId: "claude-code", attempts: [
        { runtimeId: "codex", status: "skipped", code: "managed_policy_unavailable", reason: "Codex 管理策略同步受阻；没有绕过限制。" },
        { runtimeId: "claude-code", status: failure ? "stopped" : "completed", code: failure ? "delivery_unknown" : "completed", reason: failure ? "结果不明，未自动重放。" : "选择已独立登录的 Claude。" },
      ] };
      if (failure) throw new AgentRoutingClientError("delivery_unknown", trace);
      return { text: "synthetic reply only", trace };
    },
  };
  const unused = async (): Promise<never> => { throw new Error("business/authorization routes forbidden in routing UI test"); };
  const tools: UnderstandingClient = { createSession: unused, getSession: unused, updateSource: unused, addGrant: unused, revokeGrant: unused, startTurn: unused, confirm: unused, cancel: unused, getCapabilities: async () => items };
  return { client, tools, saved, requests, get signal() { return signal; }, fail() { failure = true; }, defer() { hold = new Promise(resolve => { release = resolve; }); }, release() { release?.(); } };
}
function Probe() {
  const routing = useAgentRouting()!, [notice, setNotice] = React.useState("");
  return h("div", {}, h("button", { onClick: () => void routing.respond("synthetic instruction", [{ role: "user", content: "synthetic input" }], new AbortController().signal).then(result => setNotice(result.text), failure => setNotice(failure.message)) }, "发送合成任务"), h("p", { "data-probe": true }, notice));
}
let root: ReturnType<typeof createRoot> | undefined;
async function flush(action: () => void = () => {}) { await act(async () => { action(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render(f: ReturnType<typeof fixture>, key = "a", onSelectionChange = () => {}) {
  if (!root) { const main = dom.document.createElement("main"); dom.document.body.append(main); root = createRoot(main as unknown as Element); }
  await flush(() => root!.render(h(StrictMode, {}, h(AgentRoutingProvider, { key, client: f.client, onSelectionChange }, h(AgentBaseControls, { legacy: "current", onLegacy: () => {}, model: "unrelated-api", client: f.tools }), h(Probe)))));
}
function button(text: string) { const value = [...dom.document.querySelectorAll("button")].find(value => value.textContent === text); assert.ok(value, text); return value; }
async function select(value: string) { const field = dom.document.querySelector<HTMLSelectElement>('select[aria-label="统一 Agent 来源"]')!; await flush(() => { field.value = value; field.dispatchEvent(new dom.Event("change", { bubbles: true })); }); }
async function save() {
  const boxes = [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; await flush(() => boxes.at(-1)!.click());
  await flush(() => dom.document.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })));
}
afterEach(async () => { await act(async () => { root?.unmount(); root = undefined; }); dom.document.body.replaceChildren(); assert.equal(dom.localStorage.length, 0, "routing policy, source and authorization never enter localStorage"); });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
test("manual arbitrary registered selection and auto chain are explicit; unavailable choices explain their state", async () => {
  const f = fixture(); await render(f); assert.equal(f.saved.length, 0); assert.equal(f.requests.length, 0);
  const labels = dom.document.querySelector('select[aria-label="统一 Agent 来源"]')!.textContent!;
  assert.match(labels, /Codex.*管理策略/); assert.match(labels, /Pi.*未安装/);
  await select("auto"); assert.equal(button("保存底座选择").disabled, true); assert.equal(f.saved.length, 0);
  assert.equal(dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false, "API backup is off by default");
  await save(); assert.equal(f.saved.length, 1); assert.equal(f.saved[0]!.mode, "auto"); assert.equal(f.saved[0]!.allowApiBackups, false); assert.equal(f.requests.length, 0);
  await select("pi"); await save(); assert.equal(f.saved.at(-1)!.preferred, "pi"); assert.equal(f.saved.at(-1)!.mode, "manual");
});
test("switch reasons remain visible for completed and unknown outcomes without automatic replay", async () => {
  for (const failed of [false, true]) {
    const f = fixture(); if (failed) f.fail(); await render(f, String(failed)); await select("auto"); await save();
    await flush(() => button("发送合成任务").click());
    assert.equal(f.requests.length, 1); assert.match(dom.document.body.textContent!, /Codex 管理策略同步受阻/);
    assert.match(dom.document.body.textContent!, failed ? /结果不明，未自动重放/ : /选择已独立登录的 Claude/);
  }
});
test("account scope replacement aborts and discards a deliberately late response", async () => {
  const a = fixture(), b = fixture(); a.defer(); await render(a); await select("opencode"); await save();
  await flush(() => button("发送合成任务").click()); assert.equal(a.requests.length, 1);
  await render(b, "b"); assert.equal(a.signal?.aborted, true); await flush(() => a.release());
  assert.equal(b.saved.length, 0); assert.equal(b.requests.length, 0); assert.doesNotMatch(dom.document.body.textContent!, /synthetic reply only|选择已独立登录的 Claude/);
});
test("changing the routing revision cancels active business model operations, not old records", async () => {
  const f = fixture(); let cancelled = 0; await render(f, "a", () => { cancelled++; }); await select("auto"); await save();
  assert.equal(cancelled, 1); await select("claude-code"); await save(); assert.equal(cancelled, 2); assert.equal(f.requests.length, 0);
});
test("top bar follows the selected backend and never probes an old API during native routing", async () => {
  const f = fixture(); await f.client.update({ ...defaultAgentRoutingPolicy, mode: "auto" });
  const previous = globalThis.fetch; let probes = 0;
  globalThis.fetch = async () => { probes++; throw new Error("old provider must not be contacted"); };
  try {
    const main = dom.document.createElement("main"); dom.document.body.append(main); root = createRoot(main as unknown as Element);
    let navigated = 0, configured = 0;
    await flush(() => root!.render(h(AgentRoutingProvider, { client: f.client }, h(AgentTopBarStatus, {
      config: { provider: "openai-compatible", baseUrl: "https://old-provider.invalid/v1", apiKey: "synthetic-unused", model: "deepseek-chat", temperature: 0.3 },
      active: false, onNavigateToAgent: () => { navigated++; }, onOpenAiConfig: () => { configured++; },
    }), h(Probe))));
    assert.match(main.textContent!, /自动备援 · 待执行/); assert.doesNotMatch(main.textContent!, /在线 · DeepSeek|待配置 Key/);
    await flush(() => (main.querySelector(".agent-top-bar-main-btn") as HTMLElement).click()); assert.equal(navigated, 1); assert.equal(configured, 0);
    await flush(() => button("发送合成任务").click()); assert.match(main.textContent!, /最近 claude-code/);
    await flush(() => (main.querySelector(".agent-top-bar-toggle-btn") as HTMLElement).click()); assert.match(main.textContent!, /刷新本账号底座状态/);
    assert.equal(probes, 0, "loading the policy, showing the badge and opening actions do not probe the old API");
  } finally { globalThis.fetch = previous; }
});
