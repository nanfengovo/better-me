import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement } from "happy-dom";
import type { AtlasDataset } from "@better-me/opportunities";
import type { AtlasPrototypeProps } from "../src/components/atlas/prototypes/types.ts";
import { leadData, leadImport, leadPreview, leadReceipt } from "./fixtures/atlas-leads.ts";

const dom = new Window({ url: "http://synthetic-lead-workspace.invalid" });
Object.defineProperty(dom.HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value() {} });
const React = await import("react"), { act, createElement: h } = React;
let mapProps: AtlasPrototypeProps | undefined;
function MapProbe(props: AtlasPrototypeProps) { mapProps = props; return h("div", { "data-map-probe": true }); }
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  __atlasLeadWorkspaceMap: MapProbe };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.includes("MapLibrePrototype") ? { url: "data:text/javascript,export default globalThis.__atlasLeadWorkspaceMap", shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); },
});
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { default: AtlasWorkspace } = await import("../src/components/AtlasWorkspace.tsx");
const { atlasLeadRecoveryScope, writeAtlasLeadRecovery, readAtlasLeadRecovery } = await import("../src/components/atlas/lead-recovery.ts");
const endpoint = "http://127.0.0.1:5178", token = "synthetic-lead-workspace-token", scope = atlasLeadRecoveryScope(endpoint, token);
let root: ReturnType<typeof createRoot> | undefined;
const noAction = () => {};
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-lead-workspace", value }));
type Call = { path: string; body: unknown; key: string | null };
function install(snapshot: AtlasDataset) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, key: new Headers(init?.headers).get("Idempotency-Key") });
    if (path === "/api/v1/fx/state") return new Response("", { status: 404 });
    if (path === "/api/v1/sources") return response({ sources: snapshot.sources, adapters: [] });
    if (path === "/api/v1/dataset/export") return response(snapshot);
    if (path === "/api/v1/leads/original/import") return response(leadReceipt);
    if (path === "/api/v1/locations/map-references") return response({ schemaVersion: 1, snapshotRevision: body.expectedRevision,
      providerId: "synthetic-lead-unresolved-map", places: [], references: [],
      unresolved: snapshot.locations.map(location => ({ locationId: location.id, reason: location.coordinates ? "existing-coordinate" : "no-exact-match" })),
      totalLocations: snapshot.locations.length, processedLocations: snapshot.locations.length, truncated: false, warnings: [] });
    throw new Error(`Unexpected external operation ${path}`);
  });
  return calls;
}
async function waitFor(condition: () => boolean, description: string) {
  const deadline = performance.now() + 8000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `${description}: ${dom.document.body.textContent?.slice(-2500)}`);
    await act(async () => { await delay(10); });
  }
}
async function render() {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" },
    children: h(AtlasWorkspace, { active: true, onSaveOpportunity: noAction, onAnalyze: noAction }) })));
}
async function unmount() { if (root) await act(async () => root!.unmount()); root = undefined; }
function button(text: string) {
  const result = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text);
  assert.ok(result, `Missing button ${text}`); return result;
}
async function click(text: string) { await act(async () => button(text).click()); }
function beforeUnloadCancelled() {
  const event = new dom.Event("beforeunload", { cancelable: true }); dom.dispatchEvent(event); return event.defaultPrevented;
}
afterEach(async () => {
  await unmount(); writeAtlasLeadRecovery(scope, {}); mock.restoreAll(); dom.sessionStorage.clear(); dom.localStorage.clear(); mapProps = undefined;
});
after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

test("unknown lead writes mask the workspace, survive its root remount and restore connection, FX and canonical selection after recovery", async () => {
  const snapshot = leadData(), calls = install(snapshot);
  dom.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "live", endpoint, token }));
  await render(); await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === snapshot.jobs.length, "initial canonical query");
  assert.equal(dom.document.querySelector('[aria-label="本机后端状态与高级设置"]')?.textContent, "本机后端 · 手动直连");
  const search = dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(search, "does-not-match-any-job");
    search.dispatchEvent(new dom.Event("input", { bubbles: true }));
    writeAtlasLeadRecovery(scope, { pending: { input: leadImport, key: "synthetic-exact-lead-recovery-key", jobId: leadPreview.canonicalJobId } });
  });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.equal(mapProps?.buckets.length, 0); assert.equal(beforeUnloadCancelled(), true);
  const selector = dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!;
  await act(async () => { selector.value = "demo"; selector.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(selector.value, "live", "an unresolved lead command prevents switching data view");
  await waitFor(() => !!dom.document.querySelector('[aria-label="关闭来源工具"]'), "pending recovery source pane");
  await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭来源工具"]')!.click());
  assert.equal(dom.document.querySelector(".atlas-discovery-leads"), null);
  assert.equal(beforeUnloadCancelled(), true, "closing source tools keeps the root unload warning");
  await unmount(); const exportCount = calls.filter(call => call.path.endsWith("/export")).length;
  await render(); await waitFor(() => !!dom.document.querySelector(".atlas-leads-recovery"), "remounted pending recovery");
  assert.equal(calls.filter(call => call.path.endsWith("/export")).length, exportCount, "root remount does not replace the uncertain write with a new connection read");
  await click("核对原保存回执");
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === snapshot.jobs.length, "restored connection FX context and canonical query");
  assert.equal(dom.document.querySelector('[aria-label="本机后端状态与高级设置"]')?.textContent, "本机后端 · 手动直连");
  assert.ok(calls.filter(call => call.path.endsWith("/fx/state")).length >= 2, "FX is read again for the recovered root");
  const writes = calls.filter(call => call.path.endsWith("/original/import"));
  assert.equal(writes.length, 1); assert.deepEqual(writes[0]!.body, leadImport); assert.equal(writes[0]!.key, "synthetic-exact-lead-recovery-key");
  assert.deepEqual(readAtlasLeadRecovery(scope), {}); assert.equal(beforeUnloadCancelled(), false);
  assert.equal(mapProps?.selectedJobId, "", "synchronizing alone does not change selection");
  await click("查看规范岗位 · 清除地图筛选");
  await waitFor(() => mapProps?.selectedJobId === leadPreview.canonicalJobId, "explicit canonical job map selection");
  await waitFor(() => !!dom.document.querySelector("#atlas-job-detail")?.textContent?.includes(snapshot.jobs[0]!.title.value), "canonical job reading pane");
  assert.equal(mapProps?.focus, undefined, "a source street address does not fabricate office coordinates");
  assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')?.value, "");
  assert.equal(calls.filter(call => /geocod|original\/read|original\/preview/.test(call.path)).length, 0);
});
