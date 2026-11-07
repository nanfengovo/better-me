import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import type { AtlasFxPanelProps } from "../src/components/atlas/AtlasFxPanel.tsx";
import { fxData, fxDraft, fxPreview, fxReceipt, fxState } from "./fixtures/atlas-fx.ts";

const dom = new Window({ url: "http://synthetic-fx-panel.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client"); const { AtlasFxPanel } = await import("../src/components/atlas/AtlasFxPanel.tsx");
let root: ReturnType<typeof createRoot> | undefined, fixtureId = 0;
type Call = { path: string; body: Record<string, unknown>; key: string | null; signal?: AbortSignal | null };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-fx-panel", value }));
function install(handler?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []; mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit) => {
    const call = { path: new URL(String(url)).pathname, body: init.body ? JSON.parse(String(init.body)) : {}, key: new Headers(init.headers).get("Idempotency-Key"), signal: init.signal }; calls.push(call);
    return handler ? handler(call) : response(call.path.endsWith("/reference") ? fxDraft : call.path.endsWith("/preview") ? fxPreview : call.path.endsWith("/export") ? fxData(2) : fxReceipt);
  }); return calls;
}
function fixture(): AtlasFxPanelProps { return { endpoint: "http://127.0.0.1:5178", token: `synthetic-fx-panel-token-${++fixtureId}`, data: fxData(), state: fxState(), onSnapshot() {}, onClose() {}, onRetry() {}, onWritePending() {} }; }
async function render(props: AtlasFxPanelProps) { if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); } await act(async () => root!.render(h(AtlasFxPanel, props))); }
function button(label: string) { const value = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label); assert.ok(value, `Missing button ${label}`); return value; }
async function click(label: string) { await act(async () => button(label).click()); }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function field(label: string) { const value = dom.document.querySelector<Field>(`[aria-label="${label}"]`); assert.ok(value, label); return value; }
async function fill(label: string, value: string) { const node = field(label); await act(async () => { const proto = node.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value); node.dispatchEvent(new dom.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
async function check(label: string) { await act(async () => field(label).click()); }
async function settle() { const deadline = performance.now() + 3000; while (dom.document.querySelector('[aria-busy="true"]')) { assert.ok(performance.now() < deadline, dom.document.body.textContent!); await act(async () => { await delay(5); }); } }
async function preview() { await click("读取公开参考汇率（Frankfurter）"); await settle(); await click("预览汇率快照"); await settle(); }
async function confirm() { await check("确认已核对汇率出处日期与换算方向"); await click("确认保存汇率快照"); await settle(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); dom.document.body.replaceChildren(); });
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("FX panel is inert until explicit read, previews exact source and never prechecks save or activation", async () => {
  const calls = install(), props = fixture(); await render(props); assert.equal(calls.length, 0);
  await preview(); assert.equal(calls.length, 2); assert.equal(button("确认保存汇率快照").disabled, true);
  assert.match(dom.document.querySelector(".atlas-fx-preview")!.textContent!, /本人导入.*非官方薪资认证/s);
  assert.match(dom.document.querySelector(".atlas-fx-preview")!.textContent!, /USD8/);
  await confirm(); assert.deepEqual(calls.map(value => value.path), ["/api/v1/fx/reference", "/api/v1/fx/preview", "/api/v1/fx/import", "/api/v1/dataset/export"]);
  assert.equal(calls[2]!.body.activate, false); assert.equal(calls[2]!.body.reviewed, true); assert.match(calls[2]!.key!, /^fx-import-/);
});

test("lost FX write receipt retains original body/key across remount and newer index; trusted receipt then failed export retries only GET", async () => {
  let writes = 0, exports = 0; const calls = install(call => response(call.path.endsWith("/reference") ? fxDraft : call.path.endsWith("/preview") ? fxPreview : call.path.endsWith("/import")
    ? ++writes === 1 ? (() => { throw new TypeError("synthetic lost reply"); })() : fxReceipt : ++exports === 1 ? (() => { throw new TypeError("synthetic failed export"); })() : fxData(9)));
  const props = fixture(), pending: boolean[] = [], snapshots: number[] = []; props.onWritePending = value => pending.push(value); props.onSnapshot = value => snapshots.push(value.revision);
  await render(props); await preview(); await confirm(); assert.ok(dom.document.querySelector(".atlas-fx-pending"));
  await act(async () => root!.unmount()); root = undefined;
  await render({ ...props, data: fxData(9), state: fxState(9) }); await click("核对本次汇率保存回执"); await settle();
  assert.ok(dom.document.querySelector(".atlas-fx-saved")); assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /不要再次保存/);
  await click("重新读取索引"); const sent = calls.filter(call => call.path.endsWith("/import"));
  assert.equal(sent.length, 2); assert.deepEqual(sent[0]!.body, sent[1]!.body); assert.equal(sent[0]!.key, sent[1]!.key); assert.equal(sent[1]!.body.expectedRevision, 1);
  assert.equal(exports, 2); assert.deepEqual(snapshots, [9]); assert.equal(pending.at(-1), false);
});

test("a changed index invalidates a draft preview and late source reads never populate another identity", async () => {
  const calls = install(), props = fixture(); await render(props); await preview(); await check("确认已核对汇率出处日期与换算方向");
  await render({ ...props, data: fxData(2), state: fxState(2) }); assert.equal(button("确认保存汇率快照").disabled, true); assert.equal(calls.length, 2);
  const late = deferred<Response>(); mock.restoreAll(); const reads = install(() => late.promise);
  await click("读取公开参考汇率（Frankfurter）"); await render({ ...fixture(), token: "synthetic-other-fx-identity" });
  assert.equal(reads[0]!.signal?.aborted, true); await act(async () => late.resolve(response(fxDraft))); assert.equal(field("汇率来源名称").value, "");
});

test("explicit snapshot selection and disabling each require independent review; unknown backend keeps mutations disabled", async () => {
  const calls = install(call => response(call.path.endsWith("/export") ? fxData(2) : { ...fxReceipt, snapshotId: null, activeSnapshotId: null }));
  const props = fixture(); await render({ ...props, state: fxState(1, true) }); assert.equal(button("应用汇率选择").disabled, true);
  await check("确认切换或停用汇率"); await click("应用汇率选择");
  assert.equal(calls[0]!.path, "/api/v1/fx/activate"); assert.deepEqual(calls[0]!.body, { snapshotId: null, expectedRevision: 1, reviewed: true });
  await render({ ...fixture(), state: undefined, unsupported: true }); assert.match(dom.document.body.textContent!, /升级岗位后端/); assert.equal(button("预览汇率快照").closest("fieldset")!.disabled, true);
});

test("public reference reads retain V2 format, failed fetch preserves manual draft, and Escape closes without a write", async () => {
  const v2 = { ...fxDraft, format: "frankfurter-v2-eur-json-v1", raw: '[{"date":"2026-10-20","base":"EUR","quote":"CNY","rate":8}]' };
  let fail = false; const calls = install(() => { if (fail) throw new TypeError("synthetic unavailable"); return response(v2); });
  const props = fixture(); let closed = 0; props.onClose = () => closed++; await render(props); await click("读取公开参考汇率（Frankfurter）");
  assert.equal(field("汇率原文格式").value, "frankfurter-v2-eur-json-v1"); fail = true; await fill("汇率来源名称", "My retained draft"); await click("读取公开参考汇率（Frankfurter）");
  assert.equal(field("汇率来源名称").value, "My retained draft"); await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); assert.equal(closed, 1);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.path.endsWith("/reference")));
});

test("snapshot age uses UTC calendar days: the thirtieth day stays usable through noon and day thirty-one is marked stale", async () => {
  const props = fixture(), within = fxState(); within.context.asOf = "2026-11-19T18:00:00.000Z";
  await render({ ...props, state: within }); assert.doesNotMatch(dom.document.querySelector(".atlas-fx-snapshot")!.textContent!, /已超过30天/);
  await render({ ...props, state: { ...within, context: { ...within.context, asOf: "2026-11-20T00:00:00.000Z" } } });
  assert.match(dom.document.querySelector(".atlas-fx-snapshot")!.textContent!, /已超过30天/);
});
