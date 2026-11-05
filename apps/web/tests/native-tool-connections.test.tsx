import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";
import type { UnderstandingCapability } from "@better-me/agent-contracts";
import type { UnderstandingClient, NativeApiAuthorization } from "../src/services/understanding-client";
registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "https://native-synthetic.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createElement: h, act, StrictMode } = React;
const { createRoot } = await import("react-dom/client");
const { NativeToolConnections } = await import("../src/components/NativeToolConnections");
const { nativeToolStatus } = await import("../src/lib/native-tool-status");
const items: UnderstandingCapability[] = [
  { id: "codex", name: "Codex", available: true, supported: false, code: "needs_authorization", authMethods: ["device", "api-key"], reason: "请为本账号单独登录。" },
  { id: "opencode", name: "OpenCode", available: true, supported: true, code: "needs_verification", authMethods: ["api-key"], reason: "保存凭据不代表供应商已连接。" },
  { id: "pi", name: "Pi", available: false, supported: false, code: "not_installed", authMethods: [] },
];
function fixture() {
  const saved: NativeApiAuthorization[] = [], disconnected: string[] = [];
  let loginStarts = 0, changes = 0, cancelled = 0, release: (() => void) | undefined, saveSignal: AbortSignal | undefined;
  const unused = async (): Promise<never> => { throw new Error("unrelated client method used"); };
  const client: UnderstandingClient = { createSession: unused, getSession: unused, updateSource: unused, addGrant: unused, revokeGrant: unused, startTurn: unused, confirm: unused, cancel: unused, getCapabilities: async () => items,
    authorizeNative: async (_id, input, signal) => { saved.push(input); saveSignal = signal; if (release) await new Promise<void>(resolve => { release = resolve; }); return { saved: true }; },
    disconnectNative: async id => { disconnected.push(id); },
    startNativeLogin: async () => { loginStarts++; return { state: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" }; },
    getNativeLogin: async () => ({ state: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" }),
    cancelNativeLogin: async () => { cancelled++; },
  };
  return { client, saved, disconnected, onChange: () => { changes++; }, get changes() { return changes; }, get loginStarts() { return loginStarts; }, get cancelled() { return cancelled; }, get saveSignal() { return saveSignal; }, defer() { release = () => {}; }, release() { release?.(); } };
}
let root: ReturnType<typeof createRoot> | undefined;
async function flush(action: () => void = () => {}) { await act(async () => { action(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render(f: ReturnType<typeof fixture>, key = "alice", capabilities = items) {
  if (!root) { const main = dom.document.createElement("main"); dom.document.body.append(main); root = createRoot(main as unknown as Element); }
  await flush(() => root!.render(h(StrictMode, {}, h(NativeToolConnections, { key, items: capabilities, client: f.client, onChange: f.onChange }))));
}
function button(text: string) { const result = [...dom.document.querySelectorAll("button")].find(value => value.textContent === text); assert.ok(result, text); return result; }
async function fill(selector: string, value: string) {
  const input = dom.document.querySelector(selector); assert.ok(input, selector);
  await flush(() => { Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.Event("input", { bubbles: true })); });
}
async function unmount() { await act(async () => { root?.unmount(); root = undefined; }); dom.document.body.replaceChildren(); }
afterEach(async () => { await unmount(); assert.equal(dom.localStorage.length, 0, "keys and device codes must not be persisted in browser storage"); });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

test("all unavailable reasons have distinct labels; rendering does not initiate authorization", async () => {
  const f = fixture(); await render(f); assert.equal(f.loginStarts, 0); assert.equal(f.saved.length, 0);
  const codes = ["ready", "needs_authorization", "needs_verification", "authorization_pending", "not_installed", "adapter_missing", "sandbox_unavailable", "protocol_incompatible", "managed_policy_unavailable", "runtime_terminated"] as const;
  assert.equal(new Set(codes.map(code => nativeToolStatus({ ...items[0]!, code }))).size, codes.length);
  assert.match(dom.document.body.textContent!, /待本账号授权/); assert.match(dom.document.body.textContent!, /未安装/);
});
test("native Codex login is explicit, scoped and cancellable under React StrictMode", async () => {
  const f = fixture(); await render(f); await flush(() => button("为本账号登录 Codex").click());
  assert.equal(f.loginStarts, 1); assert.match(dom.document.body.textContent!, /TEST-ONLY/);
  assert.equal(dom.document.querySelector("a")?.getAttribute("href"), "https://auth.openai.com/codex/device");
  await flush(() => button("取消本次登录").click()); assert.equal(f.cancelled, 1); assert.doesNotMatch(dom.document.body.textContent!, /TEST-ONLY/);
});
test("a blocked installed tool still allows revoking its existing owner authorization", async () => {
  const f = fixture(); await render(f, "alice", [{ ...items[0]!, supported: false, authorized: true, code: "managed_policy_unavailable" }]);
  assert.equal(dom.document.querySelectorAll("button").length, 1);
  await flush(() => button("撤销本账号授权").click()); assert.deepEqual(f.disconnected, ["codex"]);
});
test("API authorization requires explicit consent and model; key clears on save", async () => {
  const f = fixture(); await render(f); await flush(() => button("独立 API 授权").click());
  assert.equal(button("保存本账号授权").disabled, true);
  await fill('input[type="password"]', "synthetic-only-key"); await fill('input[placeholder="填写本工具实际支持的模型"]', "synthetic-model");
  assert.equal(button("保存本账号授权").disabled, true);
  await flush(() => dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await flush(() => dom.document.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0]!.apiKey, "synthetic-only-key"); assert.equal(f.saved[0]!.consent, true);
  assert.equal(dom.document.querySelector('input[type="password"]'), null); assert.match(dom.document.body.textContent!, /还没有调用模型/);
});
test("identity switch aborts pending save and discards stale completion without refreshing another account", async () => {
  const f = fixture(); f.defer(); await render(f);
  await flush(() => button("独立 API 授权").click()); await fill('input[type="password"]', "synthetic-only-key"); await fill('input[placeholder="填写本工具实际支持的模型"]', "synthetic-model");
  await flush(() => dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await flush(() => dom.document.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(dom.document.querySelector<HTMLInputElement>('input[type="password"]')?.value, "");
  await render(f, "bob"); assert.equal(f.saveSignal?.aborted, true); await flush(() => f.release()); assert.equal(f.changes, 0);
  assert.doesNotMatch(dom.document.body.textContent!, /凭据已保存/);
});
test("revocation targets only selected tool and cancellation discards typed key", async () => {
  const f = fixture(); await render(f);
  await flush(() => button("撤销本账号授权").click()); assert.deepEqual(f.disconnected, ["opencode"]);
  await flush(() => button("独立 API 授权").click()); await fill('input[type="password"]', "synthetic-discard-key");
  await flush(() => button("取消").click()); await flush(() => button("独立 API 授权").click());
  assert.equal(dom.document.querySelector<HTMLInputElement>('input[type="password"]')?.value, ""); assert.equal(f.saved.length, 0);
});

test("Claude subscription native login shows the official code entry without creating or persisting an API key", async () => {
  const f = fixture(); let submitted = "";
  const login = { state: "pending" as const, runtimeId: "claude-code" as const, acceptsCode: true, verificationUrl: "https://claude.com/cai/oauth/authorize?response_type=code&state=synthetic-state" };
  f.client.startNativeLogin = async (_signal, id) => { assert.equal(id, "claude-code"); return login; };
  f.client.getNativeLogin = async () => login;
  f.client.submitNativeCode = async code => { submitted = code; };
  await render(f, "alice", [{ id: "claude-code", name: "Claude Code", available: true, supported: false, code: "needs_authorization", authMethods: ["browser", "api-key"] }]);
  await flush(() => button("为本账号登录 Claude 订阅").click());
  assert.match(dom.document.querySelector("a")!.href, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  await fill('input[type="password"]', "synthetic-code#synthetic-state");
  await flush(() => dom.document.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(submitted, "synthetic-code#synthetic-state"); assert.equal(dom.document.querySelector<HTMLInputElement>('input[type="password"]')!.value, ""); assert.equal(f.saved.length, 0);
  await flush(() => button("取消本次登录").click()); assert.equal(dom.document.querySelector('input[type="password"]'), null);
});
