import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement } from "happy-dom";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { createOpportunity, OPPORTUNITY_STORAGE_KEY } from "../src/lib/opportunities.ts";
import { ATLAS_CONNECTION_SESSION_KEY } from "../src/components/atlas/connection-session.ts";
import { ATLAS_DEV_AUTOCONNECT_SUPPRESSED_KEY, type DevJobIndexBootstrap } from "../src/components/atlas/dev-index-bootstrap.ts";

const dom = new Window({ url: "http://atlas-connection-fixture.invalid" });
const React = await import("react");
const { createElement: h, act } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("MapLibrePrototype")) return { url: "data:text/javascript,export default function MapProbe() { return null; }", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); },
});
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { default: AtlasWorkspace } = await import("../src/components/AtlasWorkspace.tsx");
let root: ReturnType<typeof createRoot> | undefined;
let mountedActive = true;
let mountedStrict = false;
let mountedDevJobIndex: ((signal: AbortSignal) => Promise<DevJobIndexBootstrap | undefined>) | undefined;
const saved = { schemaVersion: 1, dataMode: "live", endpoint: "http://127.0.0.1:5178", token: "synthetic-tab-session-token" };
const snapshot = createAtlasDemo(); snapshot.revision = 42;
const response = () => new Response(JSON.stringify({ ok: true, requestId: "synthetic-connection-fixture", value: snapshot }));
async function waitFor(condition: () => boolean, label: string) {
  const deadline = performance.now() + 8000;
  while (!condition()) { assert.ok(performance.now() < deadline, `Timed out: ${label}: ${dom.document.body.textContent?.slice(0, 1800)}`); await act(async () => { await delay(15); }); }
}
async function mount(active = true, strict = false, devJobIndex?: (signal: AbortSignal) => Promise<DevJobIndexBootstrap | undefined>) {
  mountedActive = active; mountedStrict = strict; mountedDevJobIndex = devJobIndex;
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  const workspace = h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" }, children: h(AtlasWorkspace, { active, ...(devJobIndex ? { devJobIndex } : {}), onSaveOpportunity() {}, onAnalyze() {} }) });
  await act(async () => root!.render(strict ? h(React.StrictMode, null, workspace) : workspace));
}
async function reload() { await act(async () => root!.unmount()); root = undefined; await mount(mountedActive, mountedStrict, mountedDevJobIndex); }
function button(text: string) { const found = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text); assert.ok(found, `Missing button ${text}`); return found; }
const view = () => dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!;
function input(label: string) { const found = [...dom.document.querySelectorAll("label")].find(node => node.textContent?.startsWith(label))?.querySelector<HTMLInputElement>("input"); assert.ok(found); return found; }
function changeInput(element: HTMLInputElement, value: string) { Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new dom.Event("input", { bubbles: true })); }
async function explicitConnect() {
  await act(async () => button("连接本机服务").click());
  await act(async () => changeInput(input("访问令牌"), saved.token));
  await act(async () => button("连接并读取索引").click());
}
async function choose(mode: string) { await act(async () => { view().value = mode; view().dispatchEvent(new dom.Event("change", { bubbles: true })); }); }
function seedLocal() {
  const job = createOpportunity({ company: "Synthetic old library", title: "Only local C# fixture", sourceUrl: "https://careers.example.invalid/local", sourcePlatform: "synthetic", description: "Only the old opportunity library contains this job." });
  dom.localStorage.setItem(OPPORTUNITY_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: "2026-10-19T00:00:00Z", jobs: [job] }));
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; dom.localStorage.clear(); dom.sessionStorage.clear(); mock.restoreAll(); });
after(() => { hooks.deregister(); dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("reconciliation is offered only for a connected live index, and changing data view cancels its pending read", async () => {
  seedLocal(); let release: ((response: Response) => void) | undefined; let candidateSignal: AbortSignal | undefined;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/candidates")) { candidateSignal = options?.signal as AbortSignal; return new Promise<Response>(resolve => { release = resolve; }); }
    if (path.endsWith("/history")) return new Response(JSON.stringify({ ok: true, requestId: "synthetic-history", value: { snapshotRevision: 42, items: [], totalAvailable: 0, limit: 50, truncated: false, warnings: [] } }));
    return response();
  });
  await mount(); assert.ok(!dom.document.querySelector('button[aria-expanded]')?.textContent?.includes("重复岗位核对"));
  await explicitConnect(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "connected live index");
  await act(async () => button("重复岗位核对").click()); await waitFor(() => !!dom.document.querySelector(".atlas-merge-review"), "lazy reconciliation panel");
  assert.equal(release, undefined, "opening a review does not send requests");
  await act(async () => button("读取候选与记录").click()); await waitFor(() => !!release, "candidate read");
  await choose("local"); assert.equal(candidateSignal!.aborted, true); assert.equal(dom.document.querySelector(".atlas-merge-review"), null);
  await act(async () => release!(new Response(JSON.stringify({ ok: true, requestId: "synthetic-candidates", value: { snapshotRevision: 42, candidates: [], limit: 50, scannedCandidateLimit: 1000, truncated: false, warnings: [] } }))));
  assert.equal(view().value, "local"); assert.equal(dom.document.querySelector(".atlas-merge-review"), null);
  await choose("demo"); assert.ok(![...dom.document.querySelectorAll("button")].some(entry => entry.textContent === "重复岗位核对"));
});

test("only an explicitly successful connection persists, and a same-tab reload restores the full live index rather than the one-job library", async () => {
  seedLocal(); let release: ((value: Response) => void) | undefined;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, options?: RequestInit) => {
    requests.push({ url: String(url), authorization: new Headers(options?.headers).get("Authorization") });
    return requests.length === 1 ? new Promise<Response>(resolve => { release = resolve; }) : response();
  });
  await mount(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 1, "the existing library");
  assert.equal(requests.length, 0); assert.equal(view().value, "local");
  await explicitConnect(); await waitFor(() => !!release, "explicit snapshot request");
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null, "unverified credentials are never saved");
  await act(async () => release!(response()));
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "live index query");
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY)!), saved);
  assert.doesNotMatch(dom.localStorage.getItem(OPPORTUNITY_STORAGE_KEY)!, /synthetic-tab-session-token/);
  assert.ok(!dom.location.href.includes(saved.token));
  await reload(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "restored live index query");
  assert.equal(view().value, "live"); assert.match(dom.document.querySelector(".atlas-data-banner")!.textContent!, /索引版本 42/);
  assert.equal(requests.filter(request => request.url.endsWith("/dataset/export")).length, 2);
  assert.ok(requests.every(request => ["http://127.0.0.1:5178/api/v1/dataset/export", "http://127.0.0.1:5178/api/v1/enrichment/status"].includes(request.url) && request.authorization === `Bearer ${saved.token}`));
  assert.equal(dom.document.querySelector('input[type="password"]'), null, "credentials are not rendered outside the connection form");
});

test("failed restoration stays in live view with an actionable visible error, and retry can recover without returning to the old library", async () => {
  seedLocal(); dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved)); let fail = true;
  const fetcher = mock.method(globalThis, "fetch", async () => { if (fail) throw new TypeError("Synthetic service offline"); return response(); });
  await mount(); await waitFor(() => !!dom.document.querySelector('[role="alert"]'), "visible restore failure");
  assert.equal(view().value, "live"); assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /未能恢复本机索引连接.*仍保留本机索引视图.*Synthetic service offline/);
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0); assert.ok(!dom.document.body.textContent!.includes("Only local C# fixture"));
  assert.equal(fetcher.mock.callCount(), 1); assert.ok(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY));
  fail = false; await act(async () => button("重新读取索引").click());
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "retry live query");
  assert.equal(dom.document.querySelector('.atlas-error[role="alert"]')?.textContent ?? null, null, "connection error clears; an independent unavailable IndexedDB warning remains truthful");
});

test("a failed explicit connection never saves the attempted token", async () => {
  mock.method(globalThis, "fetch", async () => new Response("denied", { status: 401 }));
  await mount(); await explicitConnect();
  await waitFor(() => !!dom.document.querySelector('[role="alert"]'), "rejected explicit connection");
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null); assert.match(dom.document.body.textContent!, /401/);
});

test("blocked session storage keeps the successful connection usable and explains that refresh will require reconnecting", async () => {
  mock.method(globalThis, "fetch", async () => response());
  mock.method(dom.sessionStorage, "setItem", () => { throw new Error("synthetic storage quota exceeded"); });
  await mount(); await explicitConnect();
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "live query despite blocked persistence");
  assert.equal(view().value, "live"); assert.match(dom.document.body.textContent!, /本次已连接；浏览器未允许保存标签页会话，刷新后需要重新连接/);
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
  await reload(); assert.equal(view().value, "local");
});

for (const mode of ["local", "demo"] as const) test(`choosing ${mode} clears persisted credentials, survives reload and does not reconnect`, async () => {
  seedLocal(); dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  const fetcher = mock.method(globalThis, "fetch", async () => response());
  await mount(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "live index");
  await choose(mode); const stored = dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY)!;
  assert.deepEqual(JSON.parse(stored), { schemaVersion: 1, dataMode: mode }); assert.ok(!stored.includes(saved.token));
  await reload(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === (mode === "local" ? 1 : 22), "chosen view query");
  assert.equal(view().value, mode); assert.equal(fetcher.mock.calls.filter(call => String(call.arguments[0]).endsWith('/dataset/export')).length, 1);
});

test("damaged, future and nonloopback records cannot trigger automatic network requests", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("invalid saved records must never access the network"); });
  for (const raw of ["{", JSON.stringify({ ...saved, schemaVersion: 99 }), JSON.stringify({ ...saved, endpoint: "https://untrusted.example.invalid" }), JSON.stringify({ ...saved, endpoint: "http://localhost:5178/foreign/path" }), JSON.stringify({ ...saved, token: "" }), "x".repeat(5001)]) {
    dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, raw); await mount();
    assert.equal(view().value, "local"); assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
    await act(async () => { await delay(20); });
    await act(async () => root!.unmount()); root = undefined;
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

for (const action of ["local", "demo", "endpoint", "token", "disconnect"] as const) test(`${action} cancels pending restoration and a late response cannot restore old credentials or change the view`, async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  let release: ((value: Response) => void) | undefined; let signal: AbortSignal | null | undefined;
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, options?: RequestInit) => { signal = options?.signal; return new Promise<Response>(resolve => { release = resolve; }); });
  await mount(); await waitFor(() => !!release, "pending restore");
  if (action === "local" || action === "demo") await choose(action);
  else {
    await act(async () => button("连接本机服务").click());
    await act(async () => { if (action === "disconnect") button("断开并清除会话连接").click(); else changeInput(input(action === "endpoint" ? "服务地址" : "访问令牌"), action === "endpoint" ? "http://127.0.0.1:5999" : "new-synthetic-token"); });
  }
  assert.equal(signal?.aborted, true);
  await act(async () => release!(response())); await act(async () => { await delay(30); });
  const stored = dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY); assert.ok(!stored?.includes(saved.token));
  assert.equal(view().value, action === "local" || action === "disconnect" ? "local" : action === "demo" ? "demo" : "live");
  if (action !== "demo") assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  if (action === "disconnect") assert.equal(input("访问令牌").value, "");
});

test("an inactive workspace defers restoration, and StrictMode cleanup does not suppress the active restore", async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  const fetcher = mock.method(globalThis, "fetch", async () => response());
  await mount(false, true); assert.equal(fetcher.mock.callCount(), 0); assert.equal(view().value, "live");
  await mount(true, true); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "active StrictMode restore");
  assert.equal(view().value, "live"); assert.equal(fetcher.mock.calls.filter(call => String(call.arguments[0]).endsWith('/dataset/export')).length, 1);
});

test("active StrictMode may cancel its first setup but the second setup still restores the live snapshot", async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  mock.method(globalThis, "fetch", async () => response());
  await mount(true, true); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "StrictMode restore after effect replay");
  assert.equal(view().value, "live");
});

for (const mode of ["local", "demo"] as const) test(`choosing ${mode} closes source tools and prevents its late snapshot from replacing the chosen view`, async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  let exportReads = 0; let release: ((value: Response) => void) | undefined; let panelSignal: AbortSignal | null | undefined;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/sources") return new Response(JSON.stringify({ ok: true, requestId: "synthetic-empty-catalog", value: { sources: [], adapters: [] } }));
    assert.equal(path, "/api/v1/dataset/export");
    if (++exportReads === 1) return response();
    panelSignal = options?.signal; return new Promise<Response>(resolve => { release = resolve; });
  });
  await mount(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "restored live view");
  await act(async () => button("来源工具").click());
  await waitFor(() => dom.document.querySelector('[aria-label="岗位来源工具"]')?.getAttribute("aria-busy") === "false", "source tools catalog");
  await act(async () => button("更新地图快照").click()); await waitFor(() => !!release, "source tools snapshot in progress");
  await choose(mode); assert.equal(panelSignal?.aborted, true); assert.equal(dom.document.querySelector('[aria-label="岗位来源工具"]'), null);
  await act(async () => release!(response())); await act(async () => { await delay(30); });
  assert.equal(view().value, mode); assert.deepEqual(JSON.parse(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY)!), { schemaVersion: 1, dataMode: mode });
});

test("changing credentials while a filter query is pending clears the cancelled query loading state", async (t) => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  mock.method(globalThis, "fetch", async () => response());
  await mount(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "live query before editing credentials");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await act(async () => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "synthetic-pending-filter"));
  assert.equal(dom.document.querySelector(".atlas-job-list")!.getAttribute("aria-busy"), "true");
  await act(async () => button("连接本机服务").click());
  await act(async () => changeInput(input("访问令牌"), "changed-synthetic-token"));
  assert.equal(dom.document.querySelector(".atlas-job-list")!.getAttribute("aria-busy"), "false");
  assert.equal(dom.document.querySelector(".atlas-results-heading .animate-spin"), null);
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
});

test("local dev bootstrap reads the index without a typed token, and disconnect keeps this tab from reconnecting", async () => {
  let bootstraps = 0;
  let release: ((value: DevJobIndexBootstrap) => void) | undefined;
  const devJobIndex = (signal: AbortSignal) => new Promise<DevJobIndexBootstrap>((resolve, reject) => {
    bootstraps += 1;
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) { fail(); return; }
    signal.addEventListener("abort", fail, { once: true });
    release = resolve;
  });
  mock.method(globalThis, "fetch", async () => response());
  await mount(true, false, devJobIndex);
  await waitFor(() => bootstraps === 1 && !!dom.document.body.textContent?.includes("正在准备本机岗位索引"), "dev bootstrap started");
  assert.equal(dom.document.querySelector('input[type="password"]'), null);
  assert.equal(view().value, "live");
  await act(async () => release!({ ok: true, endpoint: saved.endpoint, token: saved.token }));
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "auto-connected index");
  assert.match(dom.document.querySelector(".atlas-data-banner")!.textContent!, /索引版本 42/);
  assert.equal(dom.localStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
  assert.equal(JSON.parse(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY)!).token, saved.token);
  assert.equal(dom.location.href.includes(saved.token), false);
  await act(async () => button("连接本机服务").click());
  await act(async () => button("断开并清除会话连接").click());
  assert.equal(view().value, "local");
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
  assert.equal(dom.sessionStorage.getItem(ATLAS_DEV_AUTOCONNECT_SUPPRESSED_KEY), "1");
  await act(async () => { await delay(40); });
  assert.equal(bootstraps, 1);
  await reload();
  await act(async () => { await delay(40); });
  assert.equal(bootstraps, 1);
  assert.equal(view().value, "local");
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
});

test("disconnect during dev bootstrap ignores credentials that arrive afterwards", async () => {
  let release: ((value: DevJobIndexBootstrap) => void) | undefined;
  mock.method(globalThis, "fetch", async () => response());
  await mount(true, false, () => new Promise<DevJobIndexBootstrap>((resolve) => { release = resolve; }));
  await waitFor(() => !!release, "bootstrap waiting");
  await act(async () => button("连接本机服务").click());
  await act(async () => button("断开并清除会话连接").click());
  await act(async () => release!({ ok: true, endpoint: saved.endpoint, token: saved.token }));
  await act(async () => { await delay(40); });
  assert.equal(view().value, "local");
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.equal(dom.localStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
});

test("a failed dev index preparation shows the real error and does not present a connected index", async () => {
  mock.method(globalThis, "fetch", async () => { throw new Error("snapshot must not run"); });
  await mount(true, false, async () => ({ ok: false, error: "synthetic job service refused to start: EADDRINUSE" }));
  await waitFor(() => dom.document.querySelector('[role="alert"]')?.textContent?.includes("EADDRINUSE") === true, "startup error");
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.equal(view().value, "live");
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
  assert.equal(dom.localStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
});

test("a saved tab session restores the index without asking the dev broker", async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  let bootstraps = 0;
  mock.method(globalThis, "fetch", async () => response());
  await mount(true, false, async () => { bootstraps += 1; return { ok: true, endpoint: saved.endpoint, token: "other-synthetic-token" }; });
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "restored session");
  assert.equal(bootstraps, 0);
  assert.equal(JSON.parse(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY)!).token, saved.token);
});
