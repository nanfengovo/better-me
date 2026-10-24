import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement } from "happy-dom";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { createOpportunity, OPPORTUNITY_STORAGE_KEY } from "../src/lib/opportunities.ts";
import { ATLAS_CONNECTION_SESSION_KEY } from "../src/components/atlas/connection-session.ts";

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
const saved = { schemaVersion: 1, dataMode: "live", endpoint: "http://127.0.0.1:5178", token: "synthetic-tab-session-token" };
const snapshot = createAtlasDemo(); snapshot.revision = 42;
const response = () => new Response(JSON.stringify({ ok: true, requestId: "synthetic-connection-fixture", value: snapshot }));
// Connection scenarios intentionally model a backend predating FX management.
// Keep its optional capability probe separate from the asserted connection requests.
function installLegacyBackendFetch(handler: typeof fetch) {
  const requests = mock.fn(handler);
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, options?: RequestInit) => {
    if (new URL(String(url)).pathname.endsWith("/api/v1/fx/state")) return new Response("", { status: 404 });
    return requests(url, options);
  });
  return requests;
}
async function waitFor(condition: () => boolean, label: string) {
  const deadline = performance.now() + 8000;
  while (!condition()) { assert.ok(performance.now() < deadline, `Timed out: ${label}: ${dom.document.body.textContent?.slice(0, 1800)}`); await act(async () => { await delay(15); }); }
}
async function mount(active = true, strict = false) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  const workspace = h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" }, children: h(AtlasWorkspace, { active, onSaveOpportunity() {}, onAnalyze() {} }) });
  await act(async () => root!.render(strict ? h(React.StrictMode, null, workspace) : workspace));
}
async function reload() { await act(async () => root!.unmount()); root = undefined; await mount(); }
function button(text: string) { const found = text === "连接本机服务" ? dom.document.querySelector<HTMLButtonElement>('[aria-label="本机后端状态与高级设置"]') : [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text); assert.ok(found, `Missing button ${text}`); return found; }
const view = () => dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!;
function input(label: string) { const found = [...dom.document.querySelectorAll("label")].find(node => node.textContent?.startsWith(label))?.querySelector<HTMLInputElement>("input"); assert.ok(found); return found; }
function changeInput(element: HTMLInputElement, value: string) { Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new dom.Event("input", { bubbles: true })); }
async function explicitConnect() {
  await act(async () => button("连接本机服务").click());
  await act(async () => changeInput(input("服务地址"), saved.endpoint));
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
  seedLocal(); dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify({ schemaVersion: 1, dataMode: "local" })); let release: ((response: Response) => void) | undefined; let candidateSignal: AbortSignal | undefined;
  installLegacyBackendFetch(async (url: RequestInfo | URL, options?: RequestInit) => {
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
  seedLocal(); dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify({ schemaVersion: 1, dataMode: "local" })); let release: ((value: Response) => void) | undefined;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  installLegacyBackendFetch(async (url: RequestInfo | URL, options?: RequestInit) => {
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
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.url === "http://127.0.0.1:5178/api/v1/dataset/export" && request.authorization === `Bearer ${saved.token}`));
  assert.equal(dom.document.querySelector('input[type="password"]'), null, "credentials are not rendered outside the connection form");
});

test("failed restoration stays in live view with an actionable visible error, and retry can recover without returning to the old library", async () => {
  seedLocal(); dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved)); let fail = true;
  const fetcher = installLegacyBackendFetch(async () => { if (fail) throw new TypeError("Synthetic service offline"); return response(); });
  await mount(); await waitFor(() => !!dom.document.querySelector('[role="alert"]'), "visible restore failure");
  assert.equal(view().value, "live"); assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /未能恢复本机索引连接.*仍保留本机索引视图.*Synthetic service offline/);
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0); assert.ok(!dom.document.body.textContent!.includes("Only local C# fixture"));
  assert.equal(fetcher.mock.callCount(), 1); assert.ok(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY));
  fail = false; await act(async () => button("重新读取索引").click());
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "retry live query");
  assert.equal(dom.document.querySelector('[role="alert"]'), null);
});

test("a failed explicit connection never saves the attempted token", async () => {
  installLegacyBackendFetch(async () => new Response("denied", { status: 401 }));
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify({ schemaVersion: 1, dataMode: "local" }));
  await mount(); await explicitConnect();
  await waitFor(() => !!dom.document.querySelector('[role="alert"]'), "rejected explicit connection");
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null); assert.match(dom.document.body.textContent!, /401/);
});

test("blocked session storage keeps the successful connection usable and explains that refresh will require reconnecting", async () => {
  installLegacyBackendFetch(async () => response());
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify({ schemaVersion: 1, dataMode: "local" }));
  mock.method(dom.sessionStorage, "setItem", () => { throw new Error("synthetic storage quota exceeded"); });
  await mount(); await explicitConnect();
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "live query despite blocked persistence");
  assert.equal(view().value, "live"); assert.match(dom.document.body.textContent!, /本次已连接；浏览器未允许保存标签页会话，刷新后需要重新连接/);
  assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
  await reload(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "default backend retry after unavailable session storage"); assert.equal(view().value, "live");
});

for (const mode of ["local", "demo"] as const) test(`choosing ${mode} clears persisted credentials, survives reload and does not reconnect`, async () => {
  seedLocal(); dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  const fetcher = installLegacyBackendFetch(async () => response());
  await mount(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "live index");
  await choose(mode); const stored = dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY)!;
  assert.deepEqual(JSON.parse(stored), { schemaVersion: 1, dataMode: mode }); assert.ok(!stored.includes(saved.token));
  await reload(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === (mode === "local" ? 1 : 22), "chosen view query");
  assert.equal(view().value, mode); assert.equal(fetcher.mock.callCount(), 1);
});

test("damaged, future and nonloopback records are discarded and only the default gateway is requested", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  installLegacyBackendFetch(async (url: RequestInfo | URL, options?: RequestInit) => { requests.push({ url: String(url), authorization: new Headers(options?.headers).get("Authorization") }); throw new Error("Synthetic gateway unavailable"); });
  for (const raw of ["{", JSON.stringify({ ...saved, schemaVersion: 99 }), JSON.stringify({ ...saved, endpoint: "https://untrusted.example.invalid" }), JSON.stringify({ ...saved, endpoint: "http://localhost:5178/foreign/path" }), JSON.stringify({ ...saved, token: "" }), "x".repeat(5001)]) {
    dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, raw); await mount();
    await waitFor(() => !!dom.document.querySelector('[role="alert"]'), "default gateway failure");
    assert.equal(view().value, "live"); assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
    await act(async () => root!.unmount()); root = undefined;
  }
  assert.equal(requests.length, 6);
  assert.ok(requests.every(request => request.url === `${dom.location.origin}/api/atlas/api/v1/dataset/export` && request.authorization === null));
});

for (const action of ["local", "demo", "endpoint", "token", "disconnect"] as const) test(`${action} cancels pending restoration and a late response cannot restore old credentials or change the view`, async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  let release: ((value: Response) => void) | undefined; let signal: AbortSignal | null | undefined;
  installLegacyBackendFetch(async (_url: RequestInfo | URL, options?: RequestInit) => { signal = options?.signal; return new Promise<Response>(resolve => { release = resolve; }); });
  await mount(); await waitFor(() => !!release, "pending restore");
  if (action === "local" || action === "demo") await choose(action);
  else {
    await act(async () => button("连接本机服务").click());
  await act(async () => { if (action === "disconnect") button("暂停自动读取").click(); else changeInput(input(action === "endpoint" ? "服务地址" : "访问令牌"), action === "endpoint" ? "http://127.0.0.1:5999" : "new-synthetic-token"); });
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
  const fetcher = installLegacyBackendFetch(async () => response());
  await mount(false, true); assert.equal(fetcher.mock.callCount(), 0); assert.equal(view().value, "live");
  await mount(true, true); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "active StrictMode restore");
  assert.equal(view().value, "live"); assert.equal(fetcher.mock.callCount(), 1);
});

test("active StrictMode may cancel its first setup but the second setup still restores the live snapshot", async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  installLegacyBackendFetch(async () => response());
  await mount(true, true); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "StrictMode restore after effect replay");
  assert.equal(view().value, "live");
});

for (const mode of ["local", "demo"] as const) test(`choosing ${mode} closes source tools and prevents its late snapshot from replacing the chosen view`, async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  let exportReads = 0; let release: ((value: Response) => void) | undefined; let panelSignal: AbortSignal | null | undefined;
  installLegacyBackendFetch(async (url: RequestInfo | URL, options?: RequestInit) => {
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
  installLegacyBackendFetch(async () => response());
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


test("first active visit reads only the default backend index without browser credentials or automatic acquisition", async () => {
  seedLocal(); const requests: Array<{ url: string; method?: string; authorization: string | null }> = [];
  installLegacyBackendFetch(async (url: RequestInfo | URL, options?: RequestInit) => {
    requests.push({ url: String(url), method: options?.method, authorization: new Headers(options?.headers).get("Authorization") }); return response();
  });
  await mount(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "default backend full index");
  assert.equal(view().value, "live");
  assert.equal(dom.document.querySelector('[aria-label="本机后端状态与高级设置"]')?.textContent, "本机后端 · 自动");
  assert.equal(requests.length, 1); assert.equal(requests[0]!.url, `${dom.location.origin}/api/atlas/api/v1/dataset/export`);
  assert.equal(requests[0]!.authorization, null); assert.equal(requests[0]!.method, undefined);
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY)!), { schemaVersion: 1, dataMode: "live", endpoint: "/api/atlas", token: "" });
  assert.equal(dom.document.querySelector('input[type="password"]'), null);
  assert.ok(!dom.document.body.textContent!.includes("Only local C# fixture"));
});

test("default backend unavailable is not a zero-job market result and retry recovers", async () => {
  let offline = true; const requests: string[] = [];
  installLegacyBackendFetch(async (url: RequestInfo | URL) => { requests.push(String(url)); return offline ? new Response("static site has no gateway", { status: 404 }) : response(); });
  await mount(); await waitFor(() => !!dom.document.querySelector('[role="alert"]'), "gateway unavailable");
  assert.equal(view().value, "live");
  assert.match(dom.document.querySelector(".atlas-data-banner")!.textContent!, /岗位数量未知/);
  assert.match(dom.document.querySelector(".atlas-empty")!.textContent!, /不能据此判断市场没有岗位/);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /GitHub 静态网页.*高级连接/);
  assert.doesNotMatch(dom.document.querySelector(".atlas-data-banner")!.textContent!, /0 个来源岗位/);
  offline = false; await act(async () => button("重新读取索引").click());
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "gateway retry");
  assert.equal(requests.length, 2); assert.equal(dom.document.querySelector('[role="alert"]'), null);
});

test("inactive first visit waits for activation and default retry discards manual connection credentials", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  installLegacyBackendFetch(async (url: RequestInfo | URL, options?: RequestInit) => { requests.push({ url: String(url), authorization: new Headers(options?.headers).get("Authorization") }); return response(); });
  await mount(false); assert.equal(view().value, "live"); assert.equal(requests.length, 0);
  await mount(true); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "activation default backend");
  await explicitConnect(); await waitFor(() => requests.some(request => request.authorization === `Bearer ${saved.token}`), "manual connection");
  await act(async () => button("连接本机服务").click());
  assert.equal(dom.document.querySelector("details")?.open, false, "advanced credentials start collapsed");
  await act(async () => button("使用自动后端").click());
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22 && requests.length === 3, "default backend reset");
  assert.equal(requests[2]!.authorization, null);
  assert.deepEqual(JSON.parse(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY)!), { schemaVersion: 1, dataMode: "live", endpoint: "/api/atlas", token: "" });
});


test("switching to an unavailable default backend discards the previous manual credentials", async () => {
  dom.sessionStorage.setItem(ATLAS_CONNECTION_SESSION_KEY, JSON.stringify(saved));
  installLegacyBackendFetch(async (url: RequestInfo | URL) => String(url).includes("/api/atlas/") ? new Response("unavailable", { status: 503 }) : response());
  await mount(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "saved direct connection");
  await act(async () => button("连接本机服务").click()); await act(async () => button("使用自动后端").click());
  await waitFor(() => !!dom.document.querySelector('[role="alert"]'), "default gateway rejection");
  assert.equal(view().value, "live"); assert.equal(dom.sessionStorage.getItem(ATLAS_CONNECTION_SESSION_KEY), null);
  assert.equal(input("访问令牌").value, ""); assert.equal(input("服务地址").value, "/api/atlas");
});
