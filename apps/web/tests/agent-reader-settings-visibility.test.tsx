import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";
import "fake-indexeddb/auto";
import { defaultUnderstandingClient, type UnderstandingClient } from "../src/services/understanding-client";

registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "http://native-settings-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { AgentSidebarProvider } = await import("../src/components/AgentSidebar");
const { DesktopSettings } = await import("../src/components/desktop/DesktopSettings");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const codex = { id: "codex", name: "Codex", available: true, supported: false, code: "needs_authorization" as const, authMethods: ["device" as const] };
let root: ReturnType<typeof createRoot> | undefined;
async function flush(action: () => void = () => {}) { await React.act(async () => { action(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function mount(client: UnderstandingClient) {
  const main = dom.document.createElement("main"); dom.document.body.append(main); root = createRoot(main as unknown as Element);
  await flush(() => root!.render(<React.StrictMode><UiPreferencesProvider><AgentSidebarProvider understandingClient={client}>
    <DesktopSettings onAiConfig={() => assert.fail("no model settings mutation")} onNetwork={() => assert.fail("no network settings mutation")} />
  </AgentSidebarProvider></UiPreferencesProvider></React.StrictMode>));
}
async function click(label: string) {
  const target = [...dom.document.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
  assert.ok(target, `Missing button: ${label}`); await flush(() => target.click());
}
afterEach(async () => { await flush(() => root?.unmount()); root = undefined; dom.document.body.replaceChildren(); dom.localStorage.clear(); });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

test("desktop tools load Codex with the Agent sidebar closed and refresh never initiates login", async () => {
  let checks = 0, logins = 0;
  const client: UnderstandingClient = { ...defaultUnderstandingClient,
    getCapabilities: async () => { checks++; return [codex]; },
    startNativeLogin: async () => { logins++; throw new Error("login must be explicit"); },
  };
  await mount(client); assert.equal(checks, 0, "other settings categories do not probe native tools");
  await click("工具与授权");
  assert.equal(checks, 1, "visible desktop settings must query without opening the old sidebar");
  assert.equal(dom.document.querySelector(".agent-sidebar")?.getAttribute("data-state"), "closed");
  assert.match(dom.document.querySelector(".agent-reader-tools")!.textContent!, /为本账号登录 Codex/);
  await click("刷新工具能力"); assert.equal(checks, 2); assert.equal(logins, 0);
  assert.equal(dom.localStorage.length, 0, "capability reads do not persist credentials or reader selection");
});

test("leaving the desktop tools category aborts a probe and ignores its late result", async () => {
  let resolve: ((items: typeof codex[]) => void) | undefined, signal: AbortSignal | undefined, checks = 0;
  const client: UnderstandingClient = { ...defaultUnderstandingClient, getCapabilities: async nextSignal => {
    checks++; signal = nextSignal;
    return checks === 1 ? new Promise<typeof codex[]>(done => { resolve = done; }) : [codex];
  } };
  await mount(client); await click("工具与授权"); assert.equal(checks, 1); assert.ok(signal);
  await click("外观"); assert.equal(signal.aborted, true);
  await flush(() => resolve!([{ ...codex, name: "STALE-CODEX" }]));
  assert.doesNotMatch(dom.document.querySelector(".agent-reader-tools")!.textContent!, /STALE-CODEX/);
  await click("工具与授权"); assert.equal(checks, 2);
  assert.match(dom.document.querySelector(".agent-reader-tools")!.textContent!, /为本账号登录 Codex/);
});

test("empty capability results and connection errors remain explicit in desktop settings", async () => {
  let fail = false;
  const client: UnderstandingClient = { ...defaultUnderstandingClient, getCapabilities: async () => { if (fail) throw new Error("synthetic service unavailable"); return []; } };
  await mount(client); await click("工具与授权");
  assert.match(dom.document.querySelector(".agent-reader-tools [role=status]")!.textContent!, /未发现可用于受控阅读/);
  fail = true; await click("刷新工具能力");
  assert.match(dom.document.querySelector(".agent-reader-tools [role=status]")!.textContent!, /暂时无法连接本机 Agent/);
});
