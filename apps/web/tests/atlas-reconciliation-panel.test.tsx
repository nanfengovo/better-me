import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import { explainMergeCandidate, type AtlasDataset, type MergeDecision, type MergeReviewPreview, type PreviewMergeReviewInput, type ReconciliationReceipt } from "@better-me/opportunities";
import type { AtlasReconciliationPanelProps } from "../src/components/atlas/AtlasReconciliationPanel.tsx";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";

const dom = new Window({ url: "http://reconciliation-fixture.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client");
const { AtlasReconciliationPanel } = await import("../src/components/atlas/AtlasReconciliationPanel.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const base = createAtlasDemo(); base.revision = 11;
const a = base.jobs[0]!, b = base.jobs[1]!;
const candidate = await explainMergeCandidate(base, { leftJobId: a.id, rightJobId: b.id });
const fp = "a".repeat(64), at = "2026-10-19T12:00:00.000Z";
function side(id: string): MergeReviewPreview["target"] {
  const job = base.jobs.find(entry => entry.id === id)!;
  const listings = base.listings.filter(entry => job.listingIds.includes(entry.id));
  return { requestedJobId: id, canonicalJobId: id, job, company: base.companies.find(entry => entry.id === job.companyId)!, listings,
    sources: base.sources.filter(source => listings.some(listing => listing.sourceId === source.sourceId)),
    locations: base.locations.filter(entry => job.locationIds.includes(entry.id)), compensations: base.compensations.filter(entry => job.compensationIds.includes(entry.id)) };
}
const reason = "已核对两个合成来源的岗位编号与雇主身份。";
function preview(input: PreviewMergeReviewInput): MergeReviewPreview {
  return { snapshotRevision: 11, expectedRevision: 11, previewFingerprint: fp, input, target: side(input.targetJobId), source: side(input.sourceJobId), candidate, warnings: [] };
}
function decision(kind: "merge" | "reject", input: Record<string, unknown>): MergeDecision {
  const common = { id: `synthetic-${kind}-decision`, actorScope: "synthetic-reviewer", at, revision: 12, reason: String(input.reason), candidate };
  return kind === "merge" ? { ...common, kind, targetJobId: String(input.targetJobId), sourceJobId: String(input.sourceJobId), companyIdentityConfirmed: input.companyIdentityConfirmed === true }
    : { ...common, kind, leftJobId: candidate.leftJobId, rightJobId: candidate.rightJobId };
}
const mergedDecision: MergeDecision = { ...decision("merge", { targetJobId: a.id, sourceJobId: b.id, reason, companyIdentityConfirmed: true }), revision: 10, candidate: { ...candidate, snapshotRevision: 9 } };
const receipt = (kind: "merge" | "reject", input: Record<string, unknown>): ReconciliationReceipt => ({ ok: true, revision: 12, decision: decision(kind, input), aliases: kind === "merge" ? [{ jobId: b.id, canonicalJobId: a.id }] : [] });
const candidates = { snapshotRevision: 11, candidates: [candidate], limit: 50, scannedCandidateLimit: 1000, truncated: false, warnings: [] };
const history = { snapshotRevision: 11, items: [{ decision: mergedDecision, status: "active" }], totalAvailable: 1, limit: 50, truncated: false, warnings: [] };
const updated: AtlasDataset = { ...base, revision: 12 };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-merge-request", value }));
type Call = { path: string; body: Record<string, unknown>; key: string | null; init: RequestInit };
function installFetch(handler?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { path: new URL(String(url)).pathname.split("/").at(-1)!, body: init.body ? JSON.parse(String(init.body)) : {}, key: new Headers(init.headers).get("Idempotency-Key"), init };
    calls.push(call); const custom = await handler?.(call); if (custom) return custom;
    if (call.path === "export") return response(calls.some(entry => ["merge", "reject", "revoke"].includes(entry.path)) ? updated : base);
    if (call.path === "candidates") return response(candidates);
    if (call.path === "history") return response(history);
    if (call.path === "preview") return response(preview(call.body as PreviewMergeReviewInput));
    if (call.path === "merge" || call.path === "reject") return response(receipt(call.path, call.body));
    if (call.path === "preview-revoke") return response({ snapshotRevision: 11, expectedRevision: 11, previewFingerprint: fp, input: call.body, decision: mergedDecision, before: [side(a.id)], after: [side(a.id), side(b.id)], counts: { beforeJobs: 1, afterJobs: 2 }, warnings: ["Synthetic latest source values retained."] });
    if (call.path === "revoke") return response({ ok: true, revision: 12, decision: { id: "synthetic-revocation", kind: "revoke", actorScope: "synthetic-reviewer", at, revision: 12, reason: call.body.reason, targetDecisionId: call.body.decisionId }, aliases: [] });
    throw new Error(`Unexpected route ${call.path}`);
  });
  return calls;
}
const fixture = (): AtlasReconciliationPanelProps => ({ endpoint: "http://127.0.0.1:5178", token: "synthetic-merge-token", data: structuredClone(base), onClose() {}, onSnapshot() {} });
async function render(props = fixture()) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasReconciliationPanel, props)));
}
function button(text: string) { const found = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(entry => entry.textContent?.trim() === text); assert.ok(found, `Missing button: ${text}`); return found; }
async function click(text: string) { await act(async () => button(text).click()); }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function field(label: string) { const found = dom.document.querySelector<Field>(`[aria-label="${label}"]`); assert.ok(found, `Missing field: ${label}`); return found; }
async function change(label: string, value: string) {
  const entry = field(label); const prototype = entry.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLSelectElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value); entry.dispatchEvent(new dom.Event(entry.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
}
async function check(label: string) { await act(async () => field(label).click()); }
async function prepare(confirmCompany = true) {
  await click("读取候选与记录"); await change("保留摘要的目标岗位", a.id); await change("并入的来源岗位", b.id); await change("岗位归并说明", reason);
  if (confirmCompany) await check("已核对为同一雇主");
  await click("预览来源与差异");
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren(); });
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, value] of descriptors) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

test("mount is inert; reads show finite candidates, both source labels, links and conflict summaries without writing", async () => {
  const calls = installFetch(); await render(); assert.equal(calls.length, 0); await prepare();
  assert.match(dom.document.body.textContent!, /有限候选.*空列表也不代表没有重复岗位/s);
  assert.equal(dom.document.querySelectorAll(".atlas-merge-side").length, 2);
  assert.ok(dom.document.querySelectorAll('.atlas-merge-side a[rel="noopener noreferrer"]').length >= 2);
  assert.match(dom.document.body.textContent!, /单字段最多 1000 字/);
  assert.equal(button("确认合并岗位").disabled, true); assert.ok(!calls.some(call => call.key));
});
test("explicit review submits exact preview body and selected direction, then refreshes the shared snapshot", async () => {
  const calls = installFetch(), snapshots: AtlasDataset[] = [], props = fixture(); props.onSnapshot = value => snapshots.push(value);
  await render(props); await prepare(); await check("已审阅岗位归并预览"); await click("确认合并岗位");
  const write = calls.find(call => call.path === "merge")!;
  assert.deepEqual(write.body, { targetJobId: a.id, sourceJobId: b.id, expectedRevision: 11, reason, companyIdentityConfirmed: true, previewFingerprint: fp, reviewed: true });
  assert.ok(write.key); assert.deepEqual(snapshots.map(value => value.revision), [11, 12]); assert.match(dom.document.body.textContent!, /已保存合并记录/);
});
test("company identity is an independent confirmation; reject remains available after reviewing", async () => {
  const calls = installFetch(); await render(); await prepare(false); await check("已审阅岗位归并预览");
  assert.equal(button("确认合并岗位").disabled, true); assert.equal(button("记录暂不合并").disabled, false);
  await click("记录暂不合并"); assert.ok(calls.some(call => call.path === "reject")); assert.ok(!calls.some(call => call.path === "merge"));
});
test("editing reason or swapping direction invalidates the prior preview and review", async () => {
  const calls = installFetch(); await render(); await prepare(); await check("已审阅岗位归并预览"); await change("岗位归并说明", "新说明");
  assert.equal(dom.document.querySelector(".atlas-merge-preview"), null); await click("预览来源与差异");
  assert.equal((field("已审阅岗位归并预览") as HTMLInputElement).checked, false); await click("交换摘要方向");
  assert.equal(field("保留摘要的目标岗位").value, b.id); assert.equal(field("并入的来源岗位").value, a.id); assert.equal(dom.document.querySelector(".atlas-merge-preview"), null);
  assert.ok(!calls.some(call => call.path === "merge"));
});
test("unknown write outcome preserves original body and key even after the external revision advances", async () => {
  let attempt = 0; const calls = installFetch(call => { if (call.path === "merge" && attempt++ === 0) throw new TypeError("Synthetic response lost"); });
  const props = fixture(); await render(props); await prepare(); await check("已审阅岗位归并预览"); await click("确认合并岗位");
  await render({ ...props, data: { ...base, revision: 20 } }); assert.equal(button("读取候选与记录").disabled, true);
  await click("重试本次处理 · 核对回执"); const writes = calls.filter(call => call.path === "merge");
  assert.equal(writes.length, 2); assert.deepEqual(writes[0]!.body, writes[1]!.body); assert.equal(writes[0]!.key, writes[1]!.key); assert.match(dom.document.body.textContent!, /已保存合并记录/);
});
test("definitive stale-version clears write retry and requires a fresh preview", async () => {
  installFetch(call => call.path === "merge" ? new Response(JSON.stringify({ ok: false, requestId: "synthetic-stale", error: { code: "stale-version", message: "Synthetic stale" } }), { status: 409 }) : undefined);
  await render(); await prepare(); await check("已审阅岗位归并预览"); await click("确认合并岗位");
  assert.equal(dom.document.querySelector(".atlas-merge-preview"), null); assert.ok(!dom.document.body.textContent!.includes("重试本次处理 · 核对回执")); assert.match(dom.document.body.textContent!, /stale-version/);
});
test("saved receipt plus snapshot failure offers read recovery without resubmitting the write", async () => {
  let merged = false; const calls = installFetch(call => { if (call.path === "merge") merged = true; if (call.path === "export" && merged) throw new TypeError("Synthetic read unavailable"); });
  await render(); await prepare(); await check("已审阅岗位归并预览"); await click("确认合并岗位");
  assert.match(dom.document.body.textContent!, /已保存到索引版本 12，页面读取尚未完成/); assert.ok(button("重新读取索引"));
  await click("重新读取索引"); assert.equal(calls.filter(call => call.path === "merge").length, 1);
});
test("cross-revision overview is rejected and external revision disables an older preview", async () => {
  installFetch(call => call.path === "candidates" ? response({ ...candidates, snapshotRevision: 12, candidates: [{ ...candidate, snapshotRevision: 12 }] }) : undefined);
  const props = fixture(); await render(props); await click("读取候选与记录"); assert.match(dom.document.body.textContent!, /读取期间索引发生变化/); assert.equal(dom.document.querySelector("fieldset"), null);
  mock.restoreAll(); installFetch(); await prepare(); await check("已审阅岗位归并预览"); await render({ ...props, data: { ...base, revision: 12 } }); assert.equal(button("确认合并岗位").disabled, true);
});
test("closing or changing connection aborts and discards a late preview and snapshot callback", async () => {
  const late = deferred<Response>(); let signal: AbortSignal | undefined; let snapshots = 0;
  installFetch(call => { if (call.path === "preview") { signal = call.init.signal as AbortSignal; return late.promise; } });
  const props = fixture(); props.onSnapshot = () => snapshots++;
  await render(props); await click("读取候选与记录"); await change("保留摘要的目标岗位", a.id); await change("并入的来源岗位", b.id); await change("岗位归并说明", reason);
  await act(async () => { button("预览来源与差异").click(); }); assert.ok(signal); await render({ ...props, token: "synthetic-other-token" }); assert.equal(signal.aborted, true);
  await act(async () => late.resolve(response(preview({ targetJobId: a.id, sourceJobId: b.id, expectedRevision: 11, reason, companyIdentityConfirmed: false }))));
  assert.equal(dom.document.querySelector(".atlas-merge-preview"), null); assert.equal(snapshots, 1); assert.equal(dom.document.querySelector("fieldset"), null);
});
test("revocation displays actual before and after groups, requires review and uses its fingerprint", async () => {
  const calls = installFetch(); await render(); await click("读取候选与记录"); await click("核对撤销这条合并记录"); await change("撤销岗位归并说明", "两个合成岗位其实不同"); await click("预览撤销影响");
  assert.match(dom.document.body.textContent!, /撤销前 1 个相关岗位组 → 撤销后 2 个相关岗位组/); assert.equal(button("确认撤销这条记录").disabled, true);
  await check("已审阅撤销影响"); await click("确认撤销这条记录"); const write = calls.find(call => call.path === "revoke")!;
  assert.deepEqual(write.body, { decisionId: mergedDecision.id, expectedRevision: 11, reason: "两个合成岗位其实不同", previewFingerprint: fp, reviewed: true }); assert.match(dom.document.body.textContent!, /已保存撤销记录/);
});
test("source HTML remains escaped text and no code from a posting can run", async () => {
  installFetch(call => { if (call.path !== "preview") return; const value = preview(call.body as PreviewMergeReviewInput); value.target = structuredClone(value.target); value.target.job.title.value = '<img src=x onerror="bad()"><script>bad()</script>'; return response(value); });
  await render(); await prepare(); assert.equal(dom.document.querySelector(".atlas-merge-preview img, .atlas-merge-preview script"), null); assert.match(dom.document.querySelector(".atlas-merge-preview")!.textContent!, /<script>bad/);
});

test("a limited empty candidate list still allows manual review of two stored jobs", async () => {
  installFetch(call => call.path === "candidates" ? response({ ...candidates, candidates: [], truncated: true }) : undefined);
  await render(); await prepare(); assert.equal(dom.document.querySelectorAll(".atlas-merge-candidates button").length, 0);
  assert.equal(dom.document.querySelectorAll(".atlas-merge-side").length, 2); assert.match(dom.document.body.textContent!, /空列表也不代表没有重复岗位/);
});

test("closing a pending write aborts waiting and prevents a late receipt from updating the parent", async () => {
  const late = deferred<Response>(); let request: Call | undefined; let snapshots = 0, closed = false;
  installFetch(call => { if (call.path === "merge") { request = call; return late.promise; } });
  const props = fixture(); props.onSnapshot = () => snapshots++; props.onClose = () => { closed = true; };
  await render(props); await prepare(); await check("已审阅岗位归并预览"); await act(async () => button("确认合并岗位").click());
  assert.ok(request); await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭重复岗位核对"]')!.click());
  assert.equal(closed, true); assert.equal(request.init.signal!.aborted, true);
  await act(async () => late.resolve(response(receipt("merge", request!.body)))); assert.equal(snapshots, 1); assert.ok(!dom.document.body.textContent!.includes("已保存合并记录"));
});

test("timeout keeps the original uncertain write available for receipt recovery", async () => {
  let request: Call | undefined;
  const calls = installFetch(call => { if (call.path === "merge" && !request) { request = call; return new Promise<Response>((_resolve, reject) => call.init.signal!.addEventListener("abort", () => reject(new Error("Synthetic timeout")), { once: true })); } });
  await render(); await prepare(); await check("已审阅岗位归并预览"); mock.timers.enable({ apis: ["setTimeout"] });
  await act(async () => button("确认合并岗位").click()); await act(async () => mock.timers.tick(25_001));
  assert.match(dom.document.body.textContent!, /已停止等待/); await click("重试本次处理 · 核对回执");
  const writes = calls.filter(call => call.path === "merge"); assert.equal(writes.length, 2); assert.equal(writes[0]!.key, writes[1]!.key); assert.deepEqual(writes[0]!.body, writes[1]!.body);
});
