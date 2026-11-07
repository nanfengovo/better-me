import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import { validateCompanyControlReviewProposal, type CompanyControlReviewProposal } from "@better-me/opportunities";
import type { AtlasCompanyControlReviewProps } from "../src/components/atlas/AtlasCompanyControlReview.tsx";
import { companyControlCompanyId, companyControlJobId, companyControlProposal, companyControlReason } from "./fixtures/atlas-company-control.ts";
import { companyData, companyRead, companyPreview, companyReceipt, companySavedData, companySavedRead } from "./fixtures/atlas-company-control-web.ts";

const dom = new Window({ url: "http://synthetic-company-review.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client"); const { AtlasCompanyControlReview } = await import("../src/components/atlas/AtlasCompanyControlReview.tsx");
let root: ReturnType<typeof createRoot> | undefined, fixtureId = 0;
type Call = { path: string; body: Record<string, unknown>; key: string | null; signal?: AbortSignal | null };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-company-panel", value }));
const previewFor = (call: Call) => ({ ...companyPreview, proposed: validateCompanyControlReviewProposal(companyData, {
  jobId: companyControlJobId, companyId: companyControlCompanyId, sourceCompany: companyRead.sourceCompany, proposal: call.body.proposal as CompanyControlReviewProposal,
}) });
function install(handler?: (call: Call) => Response | Promise<Response>) { const calls: Call[] = []; mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit) => {
  const call = { path: new URL(String(url)).pathname, body: init.body ? JSON.parse(String(init.body)) : {}, key: new Headers(init.headers).get("Idempotency-Key"), signal: init.signal }; calls.push(call);
  return handler ? handler(call) : response(call.path.endsWith("/read") ? companyRead : call.path.endsWith("/preview") ? previewFor(call) : call.path.endsWith("/export") ? companySavedData : companyReceipt);
}); return calls; }
function fixture(): AtlasCompanyControlReviewProps { return { endpoint: "http://127.0.0.1:5178", token: `synthetic-company-token-${++fixtureId}`,
  data: companyData, jobId: companyControlJobId, companyId: companyControlCompanyId, onSnapshot() {}, onClose() {} }; }
async function render(props: AtlasCompanyControlReviewProps) { if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); } await act(async () => root!.render(h(AtlasCompanyControlReview, props))); }
function button(label: string) { const value = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label); assert.ok(value, `Missing button ${label}`); return value; }
async function click(label: string) { await act(async () => button(label).click()); await settle(); }
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function field(label: string) { const value = dom.document.querySelector<Field>(`[aria-label="${label}"]`); assert.ok(value, label); return value; }
async function fill(label: string, value: string) { const node = field(label); await act(async () => { const proto = node.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value); node.dispatchEvent(new dom.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
async function check(label: string) { await act(async () => field(label).click()); }
async function settle() { const deadline = performance.now() + 4000; while (dom.document.querySelector('[aria-busy="true"]')) { assert.ok(performance.now() < deadline, dom.document.body.textContent!); await act(async () => { await delay(5); }); } }
async function fillProposal() {
  const document = companyControlProposal.documents[0]!;
  await fill("文档 1 · 公开出处 URL", document.sourceUrl); await fill("文档 1 · 实际读取时间（ISO 8601）", document.retrievedAt); await fill("文档 1 · 完整原文", document.rawText);
  await fill("实际雇主法定名称", companyControlProposal.legalEntityName); await fill("企业核对状态", "resolved"); await fill("企业控制关系", "single");
  await fill("控制方 1 · 名称", companyControlProposal.controllers[0]!.name); await fill("控制方 1 · 性质", "private"); await fill("控制方 1 · 来源国家代码", "DE");
  const labels = { legalEntityName: "实际雇主法定名称", status: "核对状态", controlMode: "控制关系", controllerName: "控制方名称", controllerKind: "控制方性质", controllerControl: "最终控制关系", controllerJurisdiction: "控制方来源国家／地区" };
  for (const support of companyControlProposal.supports) await fill(`${support.field.startsWith("controller") ? "控制方 1 · " : ""}${labels[support.field]} · 引用原句`, support.quote);
  await fill("企业核对说明", companyControlReason);
}
async function preview() { await click("读取企业核对记录"); await fillProposal(); await click("预览企业控股核对"); assert.ok(dom.document.querySelector(".atlas-company-preview"), dom.document.querySelector('[role="alert"]')?.textContent ?? dom.document.body.textContent!); }
async function confirm() { await check("确认已逐项核对企业证据"); await click("确认保存企业核对"); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); dom.document.body.replaceChildren(); });
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("company panel reads explicitly, uses structured citations, previews shared impact and requires personal confirmation", async () => {
  const calls = install(), props = fixture(), snapshots: number[] = []; props.onSnapshot = value => snapshots.push(value.revision);
  await render(props); assert.equal(calls.length, 0); await preview();
  assert.equal(button("确认保存企业核对").disabled, true); assert.match(dom.document.querySelector(".atlas-company-preview")!.textContent!, /本人核对，非发布机构认证/);
  assert.match(dom.document.querySelector(".atlas-company-preview")!.textContent!, /影响 2 个当前岗位/); await confirm();
  assert.deepEqual(calls.map(call => call.path), ["companies/control-review/read", "companies/control-review/preview", "companies/control-review/confirm", "dataset/export"].map(path => `/api/v1/${path}`));
  assert.deepEqual(calls[2]!.body.proposal, calls[1]!.body.proposal); assert.equal(calls[2]!.body.reviewed, true); assert.deepEqual(snapshots, [1]);
});

test("lost company receipt survives a remount with the original body/key; after trusted receipt only index GET retries", async () => {
  let writes = 0, exports = 0; const calls = install(call => response(call.path.endsWith("/read") ? companyRead : call.path.endsWith("/preview") ? previewFor(call)
    : call.path.endsWith("/confirm") ? ++writes === 1 ? (() => { throw new TypeError("synthetic lost reply"); })() : companyReceipt
      : ++exports === 1 ? (() => { throw new TypeError("synthetic failed export"); })() : { ...companySavedData, revision: 5 }));
  const props = fixture(); await render(props); await preview(); await confirm(); assert.ok(dom.document.querySelector(".atlas-company-pending"));
  await act(async () => root!.unmount()); root = undefined; await render({ ...props, data: { ...companySavedData, revision: 5 } });
  await click("核对本次企业保存回执"); assert.ok(dom.document.querySelector(".atlas-company-saved")); assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /不要再次保存/);
  await click("重新读取索引"); const sent = calls.filter(call => call.path.endsWith("/confirm")); assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.body, sent[1]!.body); assert.equal(sent[0]!.key, sent[1]!.key); assert.equal(sent[1]!.body.expectedRevision, 0); assert.equal(exports, 2);
});

test("current revision changes invalidate previews; a late read cannot populate another company's panel", async () => {
  install(); const props = fixture(); await render(props); await preview(); await check("确认已逐项核对企业证据");
  await render({ ...props, data: { ...companyData, revision: 1 } }); assert.equal(button("确认保存企业核对").disabled, true);
  mock.restoreAll(); const late = deferred<Response>(), calls = install(() => late.promise);
  await act(async () => button("读取企业核对记录").click()); await render({ ...fixture(), companyId: "demo-company-1" });
  assert.equal(calls[0]!.signal?.aborted, true); await act(async () => late.resolve(response(companyRead))); assert.equal(field("实际雇主法定名称").value, "");
});

test("history preserves original evidence and revocation requires an independent reason and confirmation", async () => {
  const calls = install(call => response(call.path.endsWith("/read") ? companySavedRead : call.path.endsWith("/revoke")
    ? { ...companyReceipt, revision: 2, decisionId: "synthetic-company-revoke", activeDecisionId: undefined, company: companyRead.sourceCompany } : { ...companyData, revision: 2 }));
  await render({ ...fixture(), data: companySavedData }); await click("读取企业核对记录");
  assert.match(dom.document.querySelector(".atlas-company-history")!.textContent!, /SYNTHETIC EVIDENCE/); assert.equal(button("撤销当前企业核对").disabled, true);
  await fill("企业撤销说明", "Synthetic revocation reviewed"); await check("确认撤销企业核对"); await click("撤销当前企业核对");
  assert.equal(calls.filter(call => call.path.endsWith("/revoke")).length, 1); assert.equal(calls.at(-1)!.path, "/api/v1/dataset/export");
});

test("old backend disables company review capability without any mutation; Escape closes", async () => {
  const calls = install(() => new Response(JSON.stringify({ ok: false, requestId: "synthetic-unsupported", error: { code: "not-found", message: "Unavailable" } }), { status: 404 }));
  const props = fixture(); let closed = 0; props.onClose = () => closed++; await render(props); await click("读取企业核对记录");
  assert.match(dom.document.body.textContent!, /升级岗位后端/); assert.equal(button("预览企业控股核对").closest("fieldset")!.disabled, true);
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); assert.equal(closed, 1); assert.equal(calls.length, 1);
});

test("missing ultimate-control citation blocks the preview before HTTP, and ownership has no private default", async () => {
  const calls = install(); await render(fixture()); await click("读取企业核对记录");
  await fill("企业核对状态", "resolved"); await fill("企业控制关系", "single"); assert.equal(field("控制方 1 · 性质").value, "");
  await fillProposal(); await fill("控制方 1 · 最终控制关系 · 引用原句", ""); await click("预览企业控股核对");
  assert.equal(calls.filter(call => call.path.endsWith("/preview")).length, 0);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /每个字段的逐字引用/);
});

test("unknown and no-actual-controller reviews omit hidden controller drafts and preserve their distinct classification", async () => {
  const calls = install(); await render(fixture()); await click("读取企业核对记录"); await fillProposal();
  const raw = `${companyControlProposal.documents[0]!.rawText}\nThe control origin is unknown.\nControl structure is unknown.\nNo actual controlling party exists; ownership is dispersed.`;
  await fill("文档 1 · 完整原文", raw); await fill("企业核对状态", "unknown");
  await fill("核对状态 · 引用原句", "The control origin is unknown."); await fill("控制关系 · 引用原句", "Control structure is unknown."); await click("预览企业控股核对");
  let proposal = calls.filter(call => call.path.endsWith("/preview")).at(-1)!.body.proposal as CompanyControlReviewProposal;
  assert.deepEqual(proposal.controllers, []); assert.ok(proposal.supports.every(support => !support.field.startsWith("controller")));
  assert.match(dom.document.querySelector(".atlas-company-preview")!.textContent!, /待核实/);
  await fill("企业核对状态", "resolved"); await fill("企业控制关系", "dispersed");
  await fill("控制关系 · 引用原句", "No actual controlling party exists; ownership is dispersed."); await click("预览企业控股核对");
  proposal = calls.filter(call => call.path.endsWith("/preview")).at(-1)!.body.proposal as CompanyControlReviewProposal;
  assert.equal(proposal.controlMode, "dispersed"); assert.deepEqual(proposal.controllers, []);
  assert.match(dom.document.querySelector(".atlas-company-preview")!.textContent!, /股权分散／无实际控制人/);
});

test("joint control keeps independent names, ownership and relationship citations for each controller", async () => {
  const calls = install(); await render(fixture()); await click("读取企业核对记录"); await fillProposal(); await fill("企业控制关系", "joint"); await click("添加共同控制方");
  const quote = "Synthetic State Holding and Synthetic Controls Holding SE jointly control the employer.";
  await fill("文档 1 · 完整原文", `${companyControlProposal.documents[0]!.rawText}\n${quote}`); await fill("控制关系 · 引用原句", quote);
  await fill("控制方 2 · 名称", "Synthetic State Holding"); await fill("控制方 2 · 性质", "state");
  for (const label of ["控制方名称", "控制方性质", "最终控制关系"]) await fill(`控制方 2 · ${label} · 引用原句`, quote);
  await click("预览企业控股核对"); const proposal = calls.filter(call => call.path.endsWith("/preview")).at(-1)!.body.proposal as CompanyControlReviewProposal;
  assert.equal(proposal.controllers.length, 2); assert.equal(proposal.controllers[1]!.kind, "state");
  assert.equal(proposal.supports.filter(support => support.controllerIndex === 1).length, 3);
  assert.match(dom.document.querySelector(".atlas-company-preview")!.textContent!, /共同控制/);
});

test("an index at the receipt revision must contain the exact company projection before old queries resume", async () => {
  let exports = 0; const calls = install(call => response(call.path.endsWith("/read") ? companyRead : call.path.endsWith("/preview") ? previewFor(call)
    : call.path.endsWith("/confirm") ? companyReceipt : ++exports === 1 ? { ...companyData, revision: 1 } : companySavedData));
  const props = fixture(), snapshots: number[] = []; props.onSnapshot = value => snapshots.push(value.revision);
  await render(props); await preview(); await confirm(); assert.ok(dom.document.querySelector(".atlas-company-saved")); assert.deepEqual(snapshots, []);
  await click("重新读取索引"); assert.deepEqual(snapshots, [1]); assert.equal(calls.filter(call => call.path.endsWith("/confirm")).length, 1);
});
