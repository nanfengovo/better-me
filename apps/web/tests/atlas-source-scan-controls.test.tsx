import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement } from "happy-dom";
import type { AtlasDataset } from "@better-me/opportunities";
import type { SourceScanProgress, SourceSyncResult } from "@better-me/source-adapters/browser-contracts";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { atlasSourceScanRecoveryScope, readAtlasSourceScanRecovery, writeAtlasSourceScanRecovery } from "../src/components/atlas/source-scan-recovery.ts";

const dom = new Window({ url: "http://synthetic-scan-controls.invalid" });
const React = await import("react"), { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client"), { AtlasSourceScanControls } = await import("../src/components/atlas/AtlasSourceScanControls.tsx");
type Props = React.ComponentProps<typeof AtlasSourceScanControls>;
type Call = { path: string; body: Record<string, any>; key: string | null; signal?: AbortSignal | null };
const at = "2026-10-22T08:00:00.000Z", sourceId = "synthetic-scan-controls", initialScope = { roles: ["TypeScript"], regions: ["Shanghai"], companyNames: ["Synthetic"], countryCodes: ["CN"] };
let root: ReturnType<typeof createRoot> | undefined, fixtureNumber = 0;
const scopes: string[] = [];
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-scan-controls", value }));
const rejection = (code: string) => new Response(JSON.stringify({ ok: false, requestId: "synthetic-scan-controls", error: { code, message: "Synthetic definitive rejection" } }), { status: 409 });
function progress(overrides: Partial<SourceScanProgress> = {}): SourceScanProgress {
  return { sourceId, scanId: "scan-synthetic", runId: "run-original", version: 2, scope: initialScope, state: "ready", running: false, canContinue: true,
    attemptedRecords: 1, pages: 1, hadErrors: false, updatedAt: at, ...overrides };
}
function receipt(call: Call, status: SourceSyncResult["run"]["status"] = "partial"): SourceSyncResult {
  const continued = call.path.endsWith("/continue-sync"), input = { sourceId, ...call.body }, savedScope = continued ? initialScope : call.body.scope;
  const runId = continued ? "run-continued" : "run-refresh", runFingerprint = createHash("sha256").update(JSON.stringify(continued ? { tool: "sources.continue-sync", input } : input)).digest("hex");
  return { run: { runId, sourceId, actorScope: "synthetic-owner", generation: continued ? 2 : 1, scanId: "scan-synthetic", requestFingerprint: runFingerprint,
      ...(continued ? { continuedFromRunId: call.body.fromRunId } : {}),
      scope: { keywords: savedScope.roles, regions: savedScope.regions, companies: savedScope.companyNames, ...(savedScope.countryCodes ? { countryCodes: savedScope.countryCodes } : {}), maxRecords: call.body.maxRecords, maxPages: call.body.maxPages },
      status, startedAt: at, ...(status === "running" ? {} : { finishedAt: at }), summary: { added: 1, records: 1, pages: 1, partial: true } },
    localFilters: savedScope, warnings: [], scanProgress: progress({ runId, version: continued ? call.body.expectedProgressVersion + 2 : 2, scope: savedScope, running: status === "running", canContinue: status !== "running" }) };
}
function snapshot(revision = 9): AtlasDataset { return { ...createAtlasDemo(), revision }; }
function fixture(): Props {
  const props: Props = { endpoint: "http://127.0.0.1:5178", token: `synthetic-scan-controls-token-${++fixtureNumber}`, sourceId, canEnumerate: true, disabled: false,
    scopeInput: () => ({ scope: initialScope, maxRecords: 10, maxPages: 1 }), onSnapshot() {}, onBusy() {} };
  scopes.push(atlasSourceScanRecoveryScope(props.endpoint, props.token)); return props;
}
function install(handler?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : {}, key: new Headers(init?.headers).get("Idempotency-Key"), signal: init?.signal };
    calls.push(call);
    if (handler) return handler(call);
    return response(call.path.endsWith("/scan-progress") ? { sourceId, progress: progress() } : call.path.endsWith("/export") ? snapshot() : receipt(call));
  }); return calls;
}
async function render(props: Props) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasSourceScanControls, props)));
  await act(async () => { await delay(1); });
}
function button(label: string) { const found = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label); assert.ok(found, `Missing button: ${label}`); return found; }
async function settle() { const deadline = performance.now() + 4000; while (dom.document.querySelector('[aria-busy="true"]')) { assert.ok(performance.now() < deadline, dom.document.body.textContent!); await act(async () => { await delay(5); }); } }
async function click(label: string) { await act(async () => button(label).click()); await settle(); }
async function unmount() { if (root) await act(async () => root!.unmount()); root = undefined; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { await unmount(); for (const scope of scopes.splice(0)) writeAtlasSourceScanRecovery(scope, {}); mock.restoreAll(); dom.document.body.replaceChildren(); });
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("a late opening progress read cannot replace the newer checkpoint returned after refresh", async () => {
  const opening = deferred<Response>(); let reads = 0;
  install(call => {
    if (call.path.endsWith("/scan-progress")) return ++reads === 1 ? opening.promise : response({ sourceId, progress: progress({ version: 8, attemptedRecords: 24, pages: 8 }) });
    if (call.path.endsWith("/export")) return response(snapshot());
    return response(receipt(call));
  });
  await render(fixture()); await click("手动刷新并更新地图");
  assert.match(dom.document.body.textContent!, /累计尝试记录: 24/);
  await act(async () => opening.resolve(response({ sourceId, progress: progress({ version: 2, attemptedRecords: 1 }) })));
  assert.match(dom.document.body.textContent!, /累计尝试记录: 24/);
});

test("lost refresh reply preserves exact body and key across remount; a saved receipt retries failed index reads only", async () => {
  let writes = 0, exports = 0;
  const calls = install(call => {
    if (call.path.endsWith("/scan-progress")) return response({ sourceId, progress: progress() });
    if (call.path.endsWith("/export")) { if (++exports === 1) throw new TypeError("Synthetic failed index read"); return response(snapshot()); }
    if (++writes === 1) throw new TypeError("Synthetic lost write reply"); return response(receipt(call));
  });
  const props = fixture(), snapshots: number[] = []; props.onSnapshot = value => snapshots.push(value.revision);
  await render(props); await click("手动刷新并更新地图");
  assert.ok(readAtlasSourceScanRecovery(scopes[0]!).pending); assert.equal(button("手动刷新并更新地图").disabled, true);
  await unmount(); await render({ ...props, scopeInput: () => ({ scope: { roles: ["Changed"], regions: [], companyNames: [] }, maxRecords: 5, maxPages: 2 }) });
  await click("核对原扫描回执"); assert.ok(readAtlasSourceScanRecovery(scopes[0]!).saved); assert.equal(writes, 2);
  await click("重新读取扫描与索引");
  const mutations = calls.filter(call => call.path.endsWith("/sync")); assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[1]!.body, mutations[0]!.body); assert.equal(mutations[1]!.key, mutations[0]!.key);
  assert.deepEqual(snapshots, [9]); assert.equal(exports, 2); assert.deepEqual(readAtlasSourceScanRecovery(scopes[0]!), {});
});

test("running receipt keeps the original command locked and recovery uses the same key", async () => {
  let writes = 0;
  const calls = install(call => response(call.path.endsWith("/scan-progress") ? { sourceId, progress: progress() } : call.path.endsWith("/export") ? snapshot() : receipt(call, ++writes === 1 ? "running" : "partial")));
  const props = fixture(); await render(props); await click("手动刷新并更新地图");
  assert.ok(readAtlasSourceScanRecovery(scopes[0]!).pending); assert.equal(button("继续上次扫描").disabled, true);
  assert.equal(calls.some(call => call.path.endsWith("/export")), false);
  await click("核对原扫描回执");
  const sent = calls.filter(call => call.path.endsWith("/sync")); assert.equal(sent.length, 2); assert.equal(sent[0]!.key, sent[1]!.key);
  assert.deepEqual(readAtlasSourceScanRecovery(scopes[0]!), {});
});

test("continue submits only saved run and progress identity plus current batch budgets; edited interests do not replace saved scope", async () => {
  const calls = install(), props = fixture(); await render(props);
  await render({ ...props, scopeInput: () => ({ scope: { roles: ["Rust"], regions: ["Berlin"], companyNames: ["Changed"] }, maxRecords: 7, maxPages: 3 }) });
  await click("继续上次扫描");
  const sent = calls.find(call => call.path.endsWith("/continue-sync")); assert.ok(sent);
  assert.deepEqual(sent.body, { fromRunId: "run-original", expectedProgressVersion: 2, maxRecords: 7, maxPages: 3 });
  assert.equal("scope" in sent.body, false); assert.equal("cursor" in sent.body, false); assert.match(sent.key!, /^scan-continue-/);
  assert.match(dom.document.body.textContent!, /TypeScript.*Shanghai.*Synthetic/s);
});

test("a trusted terminal receipt with a failed progress read preserves a reads-only recovery barrier", async () => {
  let progressReads = 0, exports = 0;
  const calls = install(call => {
    if (call.path.endsWith("/scan-progress")) { if (++progressReads === 2) throw new TypeError("Synthetic failed progress read"); return response({ sourceId, progress: progress() }); }
    if (call.path.endsWith("/export")) { exports++; return response(snapshot()); }
    return response(receipt(call));
  });
  const props = fixture(); await render(props); await click("继续上次扫描");
  assert.ok(readAtlasSourceScanRecovery(scopes[0]!).saved); await unmount(); await render(props); await click("重新读取扫描与索引");
  assert.equal(calls.filter(call => call.path.endsWith("/continue-sync")).length, 1); assert.equal(exports, 2);
  assert.deepEqual(readAtlasSourceScanRecovery(scopes[0]!), {});
});

test("definite stale-version rejection becomes read-only recovery and never retries the rejected write", async () => {
  const calls = install(call => call.path.endsWith("/continue-sync") ? rejection("stale-version") : response(call.path.endsWith("/export") ? snapshot() : { sourceId, progress: progress() }));
  const props = fixture(); await render(props); await click("继续上次扫描");
  assert.equal(readAtlasSourceScanRecovery(scopes[0]!).refreshOnly, sourceId); assert.equal(readAtlasSourceScanRecovery(scopes[0]!).pending, undefined);
  await click("重新读取扫描与索引"); assert.equal(calls.filter(call => call.path.endsWith("/continue-sync")).length, 1);
  assert.deepEqual(readAtlasSourceScanRecovery(scopes[0]!), {});
});

test("connection changes isolate late write responses while retaining the original identity's pending command", async () => {
  const late = deferred<Response>(); let write: Call | undefined;
  const calls = install(call => { if (call.path.endsWith("/sync")) { write = call; return late.promise; } return response(call.path.endsWith("/export") ? snapshot() : { sourceId, progress: progress() }); });
  const props = fixture(), snapshots: number[] = []; props.onSnapshot = value => snapshots.push(value.revision);
  await render(props); await act(async () => button("手动刷新并更新地图").click()); assert.ok(write);
  const other = fixture(); await render(other); assert.equal(write.signal?.aborted, true);
  assert.equal(button("手动刷新并更新地图").disabled, false); await act(async () => late.resolve(response(receipt(write!))));
  assert.deepEqual(snapshots, []); assert.ok(readAtlasSourceScanRecovery(scopes[0]!).pending); assert.deepEqual(readAtlasSourceScanRecovery(scopes[1]!), {});
  await render(props); assert.equal(button("手动刷新并更新地图").disabled, true); assert.ok(button("核对原扫描回执"));
  assert.equal(calls.filter(call => call.path.endsWith("/sync")).length, 1);
});

test("recovery preserves the original discovery-leads mode across a remount", async () => {
  let writes = 0, snapshots = 0, leads = 0;
  const calls = install(call => {
    if (call.path.endsWith("/sync") && ++writes === 1) throw new TypeError("Synthetic lost lead reply");
    if (call.path.endsWith("/export")) return response(snapshot());
    return response(call.path.endsWith("/scan-progress") ? { sourceId, progress: progress() } : receipt(call));
  });
  const props: Props = { ...fixture(), mode: "discovery-leads", onSnapshot: () => { snapshots++; }, onLeadsChanged: () => { leads++; } };
  await render(props); await click("采集线索 / 更新已保存线索");
  assert.equal(readAtlasSourceScanRecovery(scopes[0]!).mode, "discovery-leads");
  assert.ok(readAtlasSourceScanRecovery(scopes[0]!).pending);
  await unmount();
  await render({ ...props, mode: "jobs" });
  await click("核对原扫描回执");
  assert.equal(calls.filter(call => call.path.endsWith("/sync")).length, 2);
  assert.equal(snapshots, 0);
  assert.equal(leads, 1);
  assert.deepEqual(readAtlasSourceScanRecovery(scopes[0]!), {});
});
