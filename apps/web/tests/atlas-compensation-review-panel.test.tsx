import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import type { AtlasDataset, PreviewCompensationReviewInput } from "@better-me/opportunities";
import type { AtlasCompensationReviewProps } from "../src/components/atlas/AtlasCompensationReview.tsx";
import { compensationData, compensationDecision, compensationInput, compensationJobId, compensationObservationId, compensationPreview,
  compensationRead, compensationReceipt, compensationRevokeReceipt, compensationRoutes, compensationSnapshot, compensationSource, compensationText } from "./fixtures/atlas-compensation-review.ts";

const dom = new Window({ url: "http://synthetic-compensation-panel.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client");
const { AtlasCompensationReview } = await import("../src/components/atlas/AtlasCompensationReview.tsx");
let root: ReturnType<typeof createRoot> | undefined;
type Call = { path: string; init?: RequestInit; body?: Record<string, unknown>; key: string | null };
const respond = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-compensation-panel", value }));
const readLabel = "读取薪资依据与历史", previewLabel = "预览薪资变更", saveLabel = "确认保存薪资核对", retryLabel = "核对本次薪资保存回执";
function installFetch(handler?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: new URL(String(url)).pathname, init, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), key: new Headers(init?.headers).get("Idempotency-Key") };
    calls.push(call); if (handler) return handler(call);
    if (call.path === compensationRoutes.read) return respond(compensationRead());
    if (call.path === compensationRoutes.preview) return respond(compensationPreview(call.body as PreviewCompensationReviewInput));
    if (call.path === compensationRoutes.confirm) return respond(compensationReceipt);
    if (call.path === compensationRoutes.revoke) return respond(compensationRevokeReceipt);
    if (call.path === compensationRoutes.snapshot) return respond(compensationSnapshot);
    throw new Error(`Unexpected synthetic route ${call.path}`);
  });
  return calls;
}
function fixture(): AtlasCompensationReviewProps { return { endpoint: "http://127.0.0.1:5178", token: "synthetic-compensation-panel-token",
  jobId: compensationJobId, data: structuredClone(compensationData), onSnapshot() {}, onClose() {} }; }
async function render(props: AtlasCompensationReviewProps, strict = false) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(strict ? h(React.StrictMode, { children: h(AtlasCompensationReview, props) }) : h(AtlasCompensationReview, props)));
}
function button(label: string) { const entry = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label); assert.ok(entry, `Missing button ${label}`); return entry; }
async function click(label: string) { await act(async () => button(label).click()); }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function field(label: string) { const entry = dom.document.querySelector<Field>(`[aria-label="${label}"]`); assert.ok(entry, `Missing field ${label}`); return entry; }
async function change(label: string, value: string) {
  const entry = field(label);
  await act(async () => {
    const prototype = entry.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : entry.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value);
    entry.dispatchEvent(new dom.Event(entry.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function check(label = "确认本人已逐项核对薪资依据") { await act(async () => field(label).click()); }
async function fill(quote = compensationText) {
  const values: Array<[string, string]> = [["薪资下限", "20000"], ["薪资上限", "30000"], ["薪资币种", "cny"], ["薪资周期", "month"],
    ["税前税后口径", "gross"], ["薪资组成", "base"], ["每年保证发薪月数", "13"]];
  for (const [label, value] of values) {
    await change(label, value); await change(`${label}引用来源`, `observation:${compensationObservationId}`); await change(`${label}依据原句`, quote);
  }
  await change("薪资核对说明", compensationInput.reason);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren(); });
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("opening is inert, discloses every missing salary basis, and never defaults tax, base pay or guaranteed months", async () => {
  const calls = installFetch(), props = fixture(), before = structuredClone(props.data); await render(props, true);
  assert.equal(calls.length, 0); assert.equal(dom.document.querySelector("fieldset"), null);
  assert.match(dom.document.body.textContent!, /未明确属于固定.*未明确税前.*缺少明确金额.*缺少明确币种.*缺少明确计薪周期/s);
  await click(readLabel); assert.equal(calls.length, 1);
  assert.equal(field("税前税后口径").value, "unknown"); assert.equal(field("薪资组成").value, "unknown"); assert.equal(field("薪资周期").value, "unknown");
  assert.equal(field("薪资下限").value, ""); assert.equal(dom.document.querySelector('[aria-label="每年保证发薪月数"]'), null);
  assert.match(dom.document.body.textContent!, /本人核对.*不代表雇主或官方认证/s); assert.deepEqual(props.data, before);
});

test("preview, explicit unchecked review and save send exact evidence and refresh only after durable receipt", async () => {
  const calls = installFetch(), props = fixture(), snapshots: AtlasDataset[] = []; props.onSnapshot = value => snapshots.push(value);
  await render(props); await click(readLabel); await fill(); await click(previewLabel);
  assert.equal(button(saveLabel).disabled, true); assert.equal(calls.some(value => value.path === compensationRoutes.confirm), false);
  assert.match(dom.document.querySelector(".atlas-compensation-preview")!.textContent!, /260,000.*390,000/s);
  await check(); await click(saveLabel);
  assert.deepEqual(calls.map(value => value.path), [compensationRoutes.read, compensationRoutes.preview, compensationRoutes.confirm, compensationRoutes.snapshot]);
  assert.deepEqual(calls[1]!.body, compensationInput); assert.deepEqual(calls[2]!.body, { ...compensationInput, previewFingerprint: "c".repeat(64), reviewed: true });
  assert.match(calls[2]!.key!, /^salary-/); assert.deepEqual(snapshots, [compensationSnapshot]);
  assert.match(dom.document.querySelector(".atlas-compensation-saved")!.textContent!, /版本 12.*待核实/);
  assert.equal(props.data.revision, 11); assert.deepEqual(props.data.compensations[0], compensationSource);
});

test("each concrete field requires its own exact saved source quote before any preview request", async () => {
  const calls = installFetch(); await render(fixture()); await click(readLabel); await change("薪资下限", "20000");
  await change("薪资核对说明", "引用缺失测试"); await click(previewLabel);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /薪资下限需要选取/);
  await change("薪资下限引用来源", `observation:${compensationObservationId}`); await change("薪资下限依据原句", "补造了原文没有的句子"); await click(previewLabel);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /逐字引用/); assert.equal(calls.length, 1);
});

test("an existing quote about a different fact cannot manufacture gross tax or guaranteed months", async () => {
  const calls = installFetch(); await render(fixture()); await click(readLabel); await fill();
  await change("税前税后口径依据原句", "每年保证发放13个月工资。"); await click(previewLabel);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /税前税后口径的引用原句没有明确支持/);
  assert.equal(calls.length, 1);
});

test("a revision change invalidates an unsubmitted preview and discards late reads or previews", async () => {
  const calls = installFetch(), props = fixture(); await render(props); await click(readLabel); await fill(); await click(previewLabel); await check();
  await render({ ...props, data: { ...props.data, revision: 12 } });
  assert.equal(button(saveLabel).disabled, true); assert.match(dom.document.body.textContent!, /本次核对保留版本 11 的读取结果，未提交预览已失效/);
  assert.equal(calls.filter(value => value.path === compensationRoutes.confirm).length, 0);
});

test("a read replying after a revision advance cannot populate evidence or unlock a write", async () => {
  const late = deferred<Response>(), calls = installFetch(() => late.promise), props = fixture();
  await render(props); await click(readLabel); await render({ ...props, data: { ...props.data, revision: 12 } });
  await act(async () => late.resolve(respond(compensationRead())));
  assert.equal(dom.document.querySelector("fieldset"), null); assert.equal(dom.document.querySelector(".atlas-compensation-preview"), null); assert.equal(calls.length, 1);
});

test("a preview replying after a revision advance cannot introduce a stale confirmation", async () => {
  const late = deferred<Response>(), props = fixture(); installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead()) : late.promise);
  await render(props); await click(readLabel); await fill(); await click(previewLabel); await render({ ...props, data: { ...props.data, revision: 12 } });
  await act(async () => late.resolve(respond(compensationPreview()))); assert.equal(dom.document.querySelector(".atlas-compensation-preview"), null);
});

test("a lost save reply retains the exact body and key across an unrelated newer index version", async () => {
  let writes = 0;
  const calls = installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead()) : call.path === compensationRoutes.preview ? respond(compensationPreview())
    : call.path === compensationRoutes.confirm ? ++writes === 1 ? Promise.reject(new TypeError("Synthetic lost reply")) : respond(compensationReceipt)
    : respond({ ...compensationSnapshot, revision: 99 }));
  const props = fixture(); await render(props); await click(readLabel); await fill(); await click(previewLabel); await check(); await click(saveLabel);
  assert.equal(button(retryLabel).disabled, false); assert.equal(field("薪资下限").closest("fieldset")!.disabled, true);
  await render({ ...props, data: { ...props.data, revision: 99 } }); await click(retryLabel);
  const submitted = calls.filter(value => value.path === compensationRoutes.confirm);
  assert.equal(submitted.length, 2); assert.deepEqual(submitted[0]!.body, submitted[1]!.body); assert.equal(submitted[0]!.key, submitted[1]!.key);
  assert.equal(submitted[1]!.body?.expectedRevision, 11); assert.ok(dom.document.querySelector(".atlas-compensation-saved"));
});

test("a saved write followed by a failed snapshot can retry only the GET without saving again", async () => {
  let reads = 0;
  const calls = installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead()) : call.path === compensationRoutes.preview ? respond(compensationPreview())
    : call.path === compensationRoutes.confirm ? respond(compensationReceipt) : ++reads === 1 ? Promise.reject(new TypeError("Synthetic export unavailable")) : respond(compensationSnapshot));
  const props = fixture(), snapshots: AtlasDataset[] = []; props.onSnapshot = value => snapshots.push(value);
  await render(props); await click(readLabel); await fill(); await click(previewLabel); await check(); await click(saveLabel);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /已保存.*不要再次保存/); assert.equal(dom.document.querySelector(".atlas-compensation-pending"), null);
  await click("重新读取索引"); assert.equal(calls.filter(value => value.path === compensationRoutes.confirm).length, 1);
  assert.equal(calls.filter(value => value.path === compensationRoutes.snapshot).length, 2); assert.deepEqual(snapshots, [compensationSnapshot]);
});

test("an untrusted success response keeps the original write recoverable instead of clearing it", async () => {
  let writes = 0;
  const calls = installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead()) : call.path === compensationRoutes.preview ? respond(compensationPreview())
    : call.path === compensationRoutes.confirm ? respond(++writes === 1 ? { ...compensationReceipt, compensation: { ...compensationReceipt.compensation, min: 1 } } : compensationReceipt)
    : respond(compensationSnapshot));
  await render(fixture()); await click(readLabel); await fill(); await click(previewLabel); await check(); await click(saveLabel);
  assert.equal(dom.document.querySelector(".atlas-compensation-saved"), null); assert.equal(button(retryLabel).disabled, false);
  await click(retryLabel); const submitted = calls.filter(value => value.path === compensationRoutes.confirm);
  assert.deepEqual(submitted[0]!.body, submitted[1]!.body); assert.equal(submitted[0]!.key, submitted[1]!.key);
});

test("a definitive stale-version rejection discards the unusable preview and does not offer write recovery", async () => {
  installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead()) : call.path === compensationRoutes.preview ? respond(compensationPreview())
    : new Response(JSON.stringify({ ok: false, requestId: "synthetic-stale-write", error: { code: "stale-version", message: "Synthetic stale version" } }), { status: 409 }));
  await render(fixture()); await click(readLabel); await fill(); await click(previewLabel); await check(); await click(saveLabel);
  assert.equal(dom.document.querySelector(".atlas-compensation-pending"), null); assert.equal(dom.document.querySelector(".atlas-compensation-preview"), null);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /stale-version/);
});

test("a stale snapshot never overwrites a newer parent and remains independently retryable", async () => {
  const late = deferred<Response>(), props = fixture(), snapshots: AtlasDataset[] = []; props.onSnapshot = value => snapshots.push(value);
  installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead()) : call.path === compensationRoutes.preview ? respond(compensationPreview())
    : call.path === compensationRoutes.confirm ? respond(compensationReceipt) : late.promise);
  await render(props); await click(readLabel); await fill(); await click(previewLabel); await check(); await click(saveLabel);
  await render({ ...props, data: { ...props.data, revision: 99 } }); await act(async () => late.resolve(respond(compensationSnapshot)));
  assert.deepEqual(snapshots, []); assert.ok(dom.document.querySelector(".atlas-compensation-saved")); assert.equal(button("重新读取索引").disabled, false);
});

test("an active personal review displays its evidence history and can be explicitly revoked", async () => {
  const calls = installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead(true)) : call.path === compensationRoutes.revoke ? respond(compensationRevokeReceipt)
    : respond({ ...compensationData, revision: 13 }));
  const props = { ...fixture(), data: compensationSnapshot }; await render(props); await click(readLabel);
  assert.match(dom.document.querySelector(".atlas-compensation-history")!.textContent!, /当前有效的本人核对.*7 项字段依据/s);
  assert.equal(button("撤销当前薪资核对").disabled, true); await change("薪资核对说明", "原文核对测试的明确撤销原因"); await check("确认撤销当前薪资核对"); await click("撤销当前薪资核对");
  const submitted = calls.find(value => value.path === compensationRoutes.revoke)!;
  assert.equal(submitted.body?.decisionId, compensationDecision.id); assert.equal(submitted.body?.expectedRevision, 12); assert.equal(submitted.body?.reviewed, true);
  assert.match(submitted.key!, /^salary-revoke-/); assert.match(dom.document.querySelector(".atlas-compensation-saved")!.textContent!, /已恢复/);
});

test("after a confirmed snapshot the panel's current salary follows the parent while the read basis and draft retain their original version", async () => {
  installFetch(); const props = fixture(); await render(props); await click(readLabel); await fill(); await click(previewLabel); await check(); await click(saveLabel);
  await render({ ...props, data: compensationSnapshot });
  const status = dom.document.querySelector(".atlas-compensation-current-status")!.textContent!;
  assert.match(status, /当前索引版本 12.*260,000.*390,000.*可按税前固定工资比较/s);
  assert.doesNotMatch(status, /缺少明确金额|未明确税前口径|未明确属于固定/);
  assert.match(dom.document.querySelector(".atlas-compensation-current")!.textContent!, /读取时有效值 · 版本 11/);
  assert.equal(field("薪资下限").value, "20000"); assert.equal(field("税前税后口径").value, "gross");
  assert.match(dom.document.body.textContent!, /本次核对保留版本 11 的读取结果/);
});

test("after a revoked snapshot the panel's current status stops showing the old annual amount without silently replacing the read history", async () => {
  installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead(true)) : call.path === compensationRoutes.revoke ? respond(compensationRevokeReceipt)
    : respond({ ...compensationData, revision: 13 }));
  const props = { ...fixture(), data: compensationSnapshot }; await render(props); await click(readLabel);
  await change("薪资核对说明", "明确撤销当前核对，恢复来源未知字段。"); await check("确认撤销当前薪资核对"); await click("撤销当前薪资核对");
  await render({ ...props, data: { ...compensationData, revision: 13 } });
  const status = dom.document.querySelector(".atlas-compensation-current-status")!.textContent!;
  assert.match(status, /当前索引版本 13.*未明确属于固定.*未明确税前口径.*缺少明确金额/s);
  assert.doesNotMatch(status, /260,000|390,000|可按税前固定工资比较/);
  assert.match(dom.document.querySelector(".atlas-compensation-current")!.textContent!, /读取时有效值 · 版本 12/);
  assert.match(dom.document.querySelector(".atlas-compensation-history")!.textContent!, /读取时有效的本人核对 · 版本 12/);
  assert.match(dom.document.body.textContent!, /本次核对保留版本 12 的读取结果/);
});

test("a successful snapshot can read fresh history without remounting the panel or writing again", async () => {
  let reads = 0;
  const calls = installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead(++reads > 1)) : call.path === compensationRoutes.preview ? respond(compensationPreview())
    : call.path === compensationRoutes.confirm ? respond(compensationReceipt) : respond(compensationSnapshot));
  const props = fixture(); props.onSnapshot = value => { void render({ ...props, data: value }); };
  await render(props); await click(readLabel); await fill(); await click(previewLabel); await check(); await click(saveLabel); await click(readLabel);
  assert.match(dom.document.querySelector(".atlas-compensation-history")!.textContent!, /当前有效的本人核对/);
  assert.equal(field("税前税后口径").value, "unknown"); assert.equal(calls.filter(value => value.path === compensationRoutes.confirm).length, 1);
});

test("body Escape closes and aborts the review while prevented or composing Escape is ignored", async () => {
  const late = deferred<Response>(), calls = installFetch(() => late.promise), props = fixture(); let closes = 0; props.onClose = () => closes++;
  await render(props); await click(readLabel);
  await act(async () => dom.document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true })));
  assert.equal(closes, 0);
  const prevented = new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); prevented.preventDefault();
  await act(async () => dom.document.body.dispatchEvent(prevented)); assert.equal(closes, 0);
  await act(async () => dom.document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(closes, 1); assert.equal(calls[0]!.init?.signal?.aborted, true);
  await act(async () => late.resolve(respond(compensationRead()))); assert.equal(dom.document.querySelector(".atlas-compensation-review"), null);
});

test("connection or job changes cancel old pending work and cannot publish another job's late snapshot", async () => {
  const late = deferred<Response>(), props = fixture(), snapshots: AtlasDataset[] = []; props.onSnapshot = value => snapshots.push(value);
  const calls = installFetch(call => call.path === compensationRoutes.read ? respond(compensationRead()) : call.path === compensationRoutes.preview ? respond(compensationPreview())
    : call.path === compensationRoutes.confirm ? respond(compensationReceipt) : late.promise);
  await render(props); await click(readLabel); await fill(); await click(previewLabel); await check(); await click(saveLabel);
  await render({ ...props, token: "synthetic-different-identity", jobId: props.data.jobs[1]!.id });
  assert.equal(calls.at(-1)!.init?.signal?.aborted, true); await act(async () => late.resolve(respond(compensationSnapshot)));
  assert.deepEqual(snapshots, []); assert.equal(dom.document.querySelector(".atlas-compensation-saved"), null);
});

test("choosing another salary disclosure cancels the previous listing read rather than mixing its evidence", async () => {
  const props = fixture(), late = deferred<Response>();
  const other = props.data.compensations[1]!, otherJob = props.data.jobs[1]!, otherListing = props.data.listings[1]!;
  props.data.jobs[0]!.compensationIds.push(other.id); props.data.jobs[0]!.listingIds.push(otherListing.id); otherJob.compensationIds = [];
  otherListing.compensationIds = [other.id]; otherListing.canonicalJobId = props.jobId;
  const calls = installFetch(() => late.promise); await render(props); await click(readLabel); await change("选择薪资披露", other.id);
  assert.equal(calls[0]!.init?.signal?.aborted, true); await act(async () => late.resolve(respond(compensationRead())));
  assert.equal(dom.document.querySelector("fieldset"), null); assert.equal(dom.document.querySelector(".atlas-compensation-raw")!.textContent, other.raw);
  assert.equal(dom.document.querySelector(".atlas-compensation-history"), null);
});

test("source content is escaped and a job with no disclosed salary cannot start an invented write", async () => {
  const calls = installFetch(), props = fixture();
  props.data.compensations[0]!.raw = '<script>syntheticUnsafe()</script>';
  await render(props); assert.equal(dom.document.querySelector("script"), null); assert.match(dom.document.body.textContent!, /<script>/);
  const data = { ...props.data, jobs: props.data.jobs.map(value => value.id === props.jobId ? { ...value, compensationIds: [] } : value) };
  await render({ ...props, data }); assert.match(dom.document.body.textContent!, /没有可核对的薪资披露/); assert.equal(calls.length, 0);
});
