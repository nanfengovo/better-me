import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement } from "happy-dom";
import type { AtlasDataset } from "@better-me/opportunities";
import { leadCapture, leadData, leadItem, leadPreview, leadQuery, leadRead, leadReceipt, originalSource } from "./fixtures/atlas-leads.ts";

const dom = new Window({ url: "http://synthetic-discovery-ui.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client");
const { AtlasDiscoveryLeads } = await import("../src/components/atlas/AtlasDiscoveryLeads.tsx");
const { atlasLeadRecoveryScope, readAtlasLeadRecovery } = await import("../src/components/atlas/lead-recovery.ts");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
let root: ReturnType<typeof createRoot> | undefined, serial = 0;
type Props = Parameters<typeof AtlasDiscoveryLeads>[0];
type Call = { path: string; body: Record<string, any>; key: string | null; signal?: AbortSignal | null };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-discovery-ui", value }));
function install(handler?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []; mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { path: new URL(String(url)).pathname, body: init.body ? JSON.parse(String(init.body)) : {}, key: new Headers(init.headers).get("Idempotency-Key"), signal: init.signal }; calls.push(call);
    if (handler) return handler(call);
    return response(call.path.endsWith("/query") ? leadQuery : call.path === "/api/v1/leads/read" ? leadRead
      : call.path.endsWith("/original/read") ? leadCapture : call.path.endsWith("/original/preview") ? leadPreview
        : call.path.endsWith("/original/import") ? leadReceipt : leadData());
  }); return calls;
}
function fixture(): Props { return { endpoint: "http://127.0.0.1:5178", token: `synthetic-lead-ui-${++serial}`, sources: [leadItem.source, originalSource], revision: 7, onSnapshot() {}, onClose() {} }; }
async function render(props: Props, locale: "zh" | "en" = "zh") {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale, theme: "light" }, children: h(AtlasDiscoveryLeads, props) })));
}
async function settle() { const deadline = performance.now() + 4000; while (dom.document.querySelector('[aria-busy="true"]')) { assert.ok(performance.now() < deadline, dom.document.body.textContent!); await act(async () => { await delay(5); }); } }
async function waitFor(condition: () => boolean) { const deadline = performance.now() + 4000; while (!condition()) { assert.ok(performance.now() < deadline, dom.document.body.textContent!); await act(async () => { await delay(5); }); } }
function button(label: string) { const node = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label); assert.ok(node, `Missing button ${label}`); return node; }
async function click(label: string) { await act(async () => button(label).click()); await settle(); }
function field(label: string) { const node = [...dom.document.querySelectorAll("label")].find(node => node.childNodes[0]?.textContent === label)?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select"); assert.ok(node, label); return node; }
async function fill(label: string, value: string) { const node = field(label); await act(async () => { const proto = node.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value); node.dispatchEvent(new dom.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
async function prepare() { await click("核对这条线索"); assert.equal(button("读取原岗位页面").disabled, true); await fill("原岗位来源", originalSource.sourceId); await click("读取原岗位页面"); await click("预览原岗位入库"); }
async function check() { const checkbox = dom.document.querySelector<HTMLInputElement>('.atlas-leads-confirm input[type="checkbox"]'); assert.ok(checkbox); await act(async () => checkbox.click()); }
async function unmount() { if (root) await act(async () => root!.unmount()); root = undefined; }
afterEach(async () => { await unmount(); mock.restoreAll(); dom.document.body.replaceChildren(); });
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("opening saved leads queries local records only and displays independent source/publication/observation evidence", async () => {
  const calls = install(); await render(fixture()); await settle();
  assert.deepEqual(calls.map(call => call.path), ["/api/v1/leads/query"]); assert.deepEqual(calls[0]!.body, { limit: 50 });
  assert.match(dom.document.body.textContent!, /未计入岗位数量或地图/); assert.match(dom.document.body.textContent!, /2020-01-02/);
  assert.match(dom.document.body.textContent!, /线索读取时间.*2026-10-22T12:00:00.000Z/);
  assert.equal(dom.document.querySelectorAll(".job-source-badge").length, 1); assert.equal(dom.document.querySelectorAll(".job-publication-badge").length, 1);
  assert.ok(dom.document.querySelector('.atlas-leads-list a[href="https://example.invalid/demo/0"]'));
  assert.equal(dom.document.querySelectorAll(".atlas-leads-confirm").length, 0);
});

test("search and paging send the actual frozen filter scope, and page replacement clears old selection", async () => {
  const calls = install(call => response(call.path === "/api/v1/leads/read" ? leadRead : { ...leadQuery, totalLeads: 101, nextCursor: "synthetic-next" }));
  await render(fixture()); await settle(); await fill("线索关键词", "  industrial engineer  "); await fill("线索来源", leadItem.source.sourceId); await fill("线索类型", "discovery-lead");
  await click("查询已保存线索"); await click("核对这条线索"); await fill("线索关键词", "unsent edits"); await click("下一页");
  const queryCalls = calls.filter(call => call.path.endsWith("/query"));
  assert.deepEqual(queryCalls[1]!.body, { limit: 50, sourceId: leadItem.source.sourceId, search: "industrial engineer", entityType: "discovery-lead" });
  assert.deepEqual(queryCalls[2]!.body, { ...queryCalls[1]!.body, cursor: "synthetic-next" });
  assert.equal(dom.document.querySelector(".atlas-leads-review"), null); assert.match(dom.document.body.textContent!, /第 2 页/);
  await click("上一页"); assert.deepEqual(calls.at(-1)!.body, queryCalls[1]!.body);
});

test("the complete explicit read-preview-confirm sequence preserves provenance and never generates office coordinates", async () => {
  const calls = install(), props = fixture(), snapshots: AtlasDataset[] = []; let selected = "";
  props.onSnapshot = snapshot => snapshots.push(snapshot); props.onOpenJob = id => { selected = id; };
  await render(props); await settle(); await prepare();
  assert.equal(button("确认保存原岗位").disabled, true); assert.match(dom.document.querySelector(".atlas-leads-capture")!.textContent!, /Synthetic discovery title/);
  assert.match(dom.document.querySelector(".atlas-leads-capture")!.textContent!, /北欧工业/);
  assert.equal(calls.filter(call => call.path.endsWith("/original/import")).length, 0);
  await check(); await click("确认保存原岗位");
  assert.deepEqual(calls.map(call => call.path), ["leads/query", "leads/read", "leads/original/read", "leads/original/preview", "leads/original/import", "dataset/export"].map(path => `/api/v1/${path}`));
  assert.equal(calls[4]!.body.reviewed, true); assert.equal(calls[4]!.body.capture.discoverySourceId, leadItem.source.sourceId); assert.match(calls[4]!.key!, /^lead-original-/);
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0]!.revision, 8); assert.equal(snapshots[0]!.locations[0]!.coordinates, undefined);
  assert.equal(selected, "", "saving alone does not change map filters or selection"); await click("查看规范岗位 · 清除地图筛选"); assert.equal(selected, leadPreview.canonicalJobId);
});

test("unknown import replies retain the exact command through unmount and recover before any new read", async () => {
  let writes = 0; const calls = install(call => {
    if (call.path.endsWith("/original/import") && ++writes === 1) throw new TypeError("Synthetic response lost after commit");
    return response(call.path.endsWith("/query") ? leadQuery : call.path === "/api/v1/leads/read" ? leadRead : call.path.endsWith("/original/read") ? leadCapture : call.path.endsWith("/original/preview") ? leadPreview : call.path.endsWith("/original/import") ? leadReceipt : leadData());
  });
  const props = fixture(); await render(props); await settle(); await prepare(); await check(); await click("确认保存原岗位");
  assert.match(dom.document.body.textContent!, /本次保存结果待确认/); assert.equal(button("读取原岗位页面").disabled, true);
  const pending = readAtlasLeadRecovery(atlasLeadRecoveryScope(props.endpoint, props.token)).pending; assert.ok(pending);
  await unmount(); const before = calls.length; await render(props); await settle(); assert.equal(calls.length, before, "remount with pending import does not query or read originals");
  await click("核对原保存回执");
  const sent = calls.filter(call => call.path.endsWith("/original/import")); assert.equal(sent.length, 2); assert.deepEqual(sent[1]!.body, sent[0]!.body); assert.equal(sent[1]!.key, sent[0]!.key);
  assert.equal(readAtlasLeadRecovery(atlasLeadRecoveryScope(props.endpoint, props.token)).pending, undefined); assert.match(dom.document.body.textContent!, /原岗位已保存/);
});

test("a known saved receipt followed by a failed index read retries only the index across remount", async () => {
  let exports = 0, writes = 0, snapshots = 0;
  const calls = install(call => {
    if (call.path.endsWith("/original/import")) writes++;
    if (call.path.endsWith("/export") && ++exports === 1) throw new TypeError("Synthetic index unavailable after save");
    return response(call.path.endsWith("/query") ? leadQuery : call.path === "/api/v1/leads/read" ? leadRead : call.path.endsWith("/original/read") ? leadCapture : call.path.endsWith("/original/preview") ? leadPreview : call.path.endsWith("/original/import") ? leadReceipt : leadData());
  });
  const props = fixture(); props.onSnapshot = () => { snapshots++; }; await render(props); await settle(); await prepare(); await check(); await click("确认保存原岗位");
  assert.match(dom.document.body.textContent!, /岗位已保存至版本 8/); assert.ok(readAtlasLeadRecovery(atlasLeadRecoveryScope(props.endpoint, props.token)).saved);
  await unmount(); const before = calls.length; await render(props); await settle(); assert.equal(calls.length, before); await click("重新读取已保存索引");
  assert.equal(writes, 1); assert.equal(exports, 2); assert.equal(snapshots, 1);
});

test("index changes invalidate confirmation and the absence of an eligible original reader leaves a lead unchanged", async () => {
  const calls = install(), props = fixture(); await render(props); await settle(); await prepare(); await check(); await render({ ...props, revision: 8 });
  assert.equal(button("确认保存原岗位").disabled, true); assert.match(dom.document.body.textContent!, /索引版本已改变/); assert.equal(calls.filter(call => call.path.endsWith("/original/import")).length, 0);
  await unmount(); mock.restoreAll(); const empty = { ...leadItem, eligibleOriginalSources: [] }; const next = install(call => response(call.path.endsWith("/query") ? { ...leadQuery, items: [empty] } : { ...leadRead, ...empty }));
  await render(fixture()); await settle(); await click("核对这条线索"); assert.equal(button("读取原岗位页面").disabled, true); assert.match(dom.document.body.textContent!, /线索不会自动变成岗位/);
  assert.equal(next.length, 2);
});

test("authoritative stale-version rejection clears a pending write and requires another preview", async () => {
  const calls = install(call => call.path.endsWith("/original/import") ? new Response(JSON.stringify({ ok: false, requestId: "synthetic-stale", error: { code: "stale-version", message: "Synthetic concurrent write" } }), { status: 409 })
    : response(call.path.endsWith("/query") ? leadQuery : call.path === "/api/v1/leads/read" ? leadRead : call.path.endsWith("/original/read") ? leadCapture : leadPreview));
  const props = fixture(); await render(props); await settle(); await prepare(); await check(); await click("确认保存原岗位");
  assert.equal(readAtlasLeadRecovery(atlasLeadRecoveryScope(props.endpoint, props.token)).pending, undefined); assert.equal(dom.document.querySelector(".atlas-leads-preview"), null);
  assert.equal(calls.filter(call => call.path.endsWith("/export")).length, 0);
});

test("the saved source identity resolves a newer canonical owner after an intervening merge", async () => {
  const merged = leadData(9), first = merged.jobs[0]!, second = merged.jobs[1]!;
  merged.jobs = merged.jobs.filter(job => job.id !== first.id); second.listingIds.push(...first.listingIds); merged.listings[0]!.canonicalJobId = second.id;
  const calls = install(call => response(call.path.endsWith("/query") ? leadQuery : call.path === "/api/v1/leads/read" ? leadRead : call.path.endsWith("/original/read") ? leadCapture : call.path.endsWith("/original/preview") ? leadPreview : call.path.endsWith("/original/import") ? leadReceipt : merged));
  const props = fixture(); let selected = ""; props.onOpenJob = id => { selected = id; };
  await render(props); await settle(); await prepare(); await check(); await click("确认保存原岗位");
  await click("查看规范岗位 · 清除地图筛选"); assert.equal(selected, second.id); assert.equal(calls.filter(call => call.path.endsWith("/original/import")).length, 1);
});

test("an already merged original previews its source delta but saves and opens the effective canonical job", async () => {
  const historicalId = "synthetic-historical-source-job", preview = { ...leadPreview, job: { ...leadPreview.job, id: historicalId },
    listings: leadPreview.listings.map(listing => ({ ...listing, canonicalJobId: historicalId })) };
  const calls = install(call => response(call.path.endsWith("/query") ? leadQuery : call.path === "/api/v1/leads/read" ? leadRead : call.path.endsWith("/original/read") ? leadCapture
    : call.path.endsWith("/original/preview") ? preview : call.path.endsWith("/original/import") ? leadReceipt : leadData()));
  const props = fixture(); let selected = ""; props.onOpenJob = id => { selected = id; };
  await render(props); await settle(); await prepare(); assert.match(dom.document.body.textContent!, /此原来源已归并/);
  await check(); await click("确认保存原岗位"); await click("查看规范岗位 · 清除地图筛选");
  assert.equal(selected, leadPreview.canonicalJobId); assert.notEqual(selected, historicalId);
  assert.equal(calls.filter(call => call.path.endsWith("/original/import")).length, 1);
});

for (const code of ["not-authorized", "unsupported-capability"]) test(`a ${code} recovery response retains the original uncertain command`, async () => {
  let writes = 0;
  const calls = install(call => {
    if (call.path.endsWith("/original/import")) {
      if (++writes === 1) throw new TypeError("Synthetic lost response after possible commit");
      if (writes === 2) return new Response(JSON.stringify({ ok: false, requestId: "synthetic-uncertain-auth", error: { code, message: "Synthetic runtime changed" } }), { status: 403 });
    }
    return response(call.path.endsWith("/query") ? leadQuery : call.path === "/api/v1/leads/read" ? leadRead : call.path.endsWith("/original/read") ? leadCapture
      : call.path.endsWith("/original/preview") ? leadPreview : call.path.endsWith("/original/import") ? leadReceipt : leadData());
  });
  const props = fixture(), scope = atlasLeadRecoveryScope(props.endpoint, props.token);
  await render(props); await settle(); await prepare(); await check(); await click("确认保存原岗位");
  const original = structuredClone(readAtlasLeadRecovery(scope).pending); assert.ok(original);
  await click("核对原保存回执"); assert.deepEqual(readAtlasLeadRecovery(scope).pending, original);
  await click("核对原保存回执"); assert.equal(readAtlasLeadRecovery(scope).pending, undefined);
  const sent = calls.filter(call => call.path.endsWith("/original/import")); assert.equal(sent.length, 3);
  for (const retry of sent.slice(1)) { assert.deepEqual(retry.body, sent[0]!.body); assert.equal(retry.key, sent[0]!.key); }
});

test("English source and publication badges remain translated and late closed reads do not populate another pane", async () => {
  let resolve!: (value: Response) => void; const late = new Promise<Response>(done => { resolve = done; });
  const calls = install(call => call.path.endsWith("/original/read") ? late : response(call.path.endsWith("/query") ? leadQuery : leadRead));
  const props = fixture(); await render(props, "en"); await settle(); assert.match(dom.document.body.textContent!, /Published 2020-01-02/);
  await click("Review this lead"); await fill("Original posting source", originalSource.sourceId); await act(async () => button("Read original posting").click());
  await waitFor(() => calls.some(call => call.path.endsWith("/original/read"))); const request = calls.at(-1)!; await unmount(); assert.equal(request.signal?.aborted, true);
  await render(fixture(), "en"); await settle(); await act(async () => resolve(response(leadCapture))); await delay(10);
  assert.equal(dom.document.querySelector(".atlas-leads-capture"), null); assert.equal(calls.filter(call => call.path.endsWith("/original/import")).length, 0);
});
