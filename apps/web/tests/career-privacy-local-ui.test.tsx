import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate as next } from "node:timers/promises";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import type { TrustRequest } from "../src/components/CareerTrustPanel.contracts";
const cssHook = registerHooks({ load(url, context, fallback) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : fallback(url, context); } });
const win = new Window(), React = await import("react"), originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement, HTMLSelectElement: win.HTMLSelectElement, HTMLTextAreaElement: win.HTMLTextAreaElement, Element: win.Element, Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client"), { CareerPrivacyLocalPanel } = await import("../src/components/CareerPrivacyLocalPanel");
const digest = "a".repeat(64), runtime = { model: "synthetic-embed", modelDigest: digest }, choice = { operationId: "committee-1", evidenceId: "source-2" };
const catalog = { contextId: "context-1", revision: 0, sources: [{ ...choice, sourceId: "local-1", path: "lease.ts", startLine: 4, endLine: 12, sourceHash: digest, excerptHash: "b".repeat(64), classification: "local_only" }], selected: [] as typeof choice[], privateTermCount: 0, maxSearchCalls: 4, brokerAvailable: true, limitations: [] };
let root: ReturnType<typeof createRoot> | undefined;
async function settle(fn = () => {}) { await React.act(async () => { fn(); await next(); await next(); }); }
async function mount(request: TrustRequest, onConfigured = () => {}) { const element = win.document.createElement("div"); win.document.body.append(element); root = createRoot(element as unknown as HTMLElement); await settle(() => root!.render(React.createElement(React.StrictMode, {}, React.createElement(CareerPrivacyLocalPanel, { contextId: "context-1", request, onConfigured })))); }
function field(label: RegExp) { const node = [...win.document.querySelectorAll("label")].find(item => label.test(item.textContent ?? ""))?.querySelector("input,select,textarea"); assert.ok(node, `missing field ${label}`); return node; }
async function fill(label: RegExp, value: string) { const node = field(label), prototype = node.tagName === "SELECT" ? win.HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype; await settle(() => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new win.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
async function check(label: RegExp) { await settle(() => (field(label) as InstanceType<typeof win.HTMLInputElement>).click()); }
function button(label: RegExp) { const node = [...win.document.querySelectorAll("button")].find(item => label.test(item.textContent ?? "")); assert.ok(node, `missing button ${label}`); return node; }
async function click(label: RegExp) { await settle(() => button(label).click()); }
afterEach(async () => { await settle(() => root?.unmount()); root = undefined; win.document.body.innerHTML = ""; });
after(() => { cssHook.deregister(); win.happyDOM.cancelAsync(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("normal private-source forms use opaque original references, exact separate embedding consent and no automatic reads/downloads", async () => {
  const calls: Array<{ route: string; body: unknown }> = []; let adopted = 0;
  await mount(async (route, body) => { calls.push({ route, body }); if (route === "/privacy/local/catalog") return catalog; if (route === "/runtimes") return { runtimes: [runtime], noCloudFallback: true };
    if (route === "/privacy/local/configure") return { ...catalog, revision: 1, selected: [choice], privateTermCount: 1, embeddingRuntime: runtime }; throw Error("unexpected"); }, () => adopted++);
  assert.equal(calls.length, 0); await click(/读取已完成审查/); assert.deepEqual(calls.map(call => call.route), ["/privacy/local/catalog", "/runtimes"]);
  assert.match(win.document.body.textContent ?? "", /Embedding 未配置/); assert.match(win.document.body.textContent ?? "", /不把生成结果当向量/);
  await check(/lease.ts/); await fill(/显式私有名称/, "InternalProject"); await fill(/独立本地 Embedding 模型/, `${runtime.model}:${runtime.modelDigest}`); await check(/我授权复验/);
  assert.equal(button(/复验并保存/).disabled, true); await check(/单独授权此精确/); await click(/复验并保存/);
  const body = calls.find(call => call.route === "/privacy/local/configure")!.body;
  assert.deepEqual(body, { contextId: "context-1", expectedRevision: 0, selections: [choice], privateTerms: ["InternalProject"], maxSearchCalls: 4, consent: true, embeddingRuntime: runtime, embeddingConsent: true }); assert.equal(adopted, 1);
  assert.equal(JSON.stringify(body).includes("lease.ts"), false); assert.equal(JSON.stringify(body).includes("root"), false);
});

test("unconfigured/unsupported embedding remains unavailable and source changes clear both source and model consent", async () => {
  const calls: string[] = [];
  await mount(async route => { calls.push(route); return route === "/runtimes" ? { runtimes: [], noCloudFallback: true } : catalog; });
  await click(/读取已完成审查/); assert.match(win.document.body.textContent ?? "", /Embedding 未配置：本地向量检索不可用/);
  assert.equal(field(/仅本地的检索问题/).closest("fieldset")!.disabled, true);
  await check(/我授权复验/); assert.equal((field(/我授权复验/) as InstanceType<typeof win.HTMLInputElement>).checked, true);
  await check(/lease.ts/); assert.equal((field(/我授权复验/) as InstanceType<typeof win.HTMLInputElement>).checked, false); assert.equal(button(/复验并保存/).disabled, true);
  assert.equal(calls.some(route => /search|download|generate|embed$/.test(route)), false);
});

test("retrieval has per-call consent, exact scope revision and visible non-proof result; editing policy blocks search until save", async () => {
  const calls: Array<{ route: string; body: unknown }> = [];
  await mount(async (route, body) => { calls.push({ route, body }); if (route === "/privacy/local/catalog") return { ...catalog, revision: 3, selected: [choice], embeddingRuntime: runtime }; if (route === "/runtimes") return { runtimes: [runtime], noCloudFallback: true };
    return { operation: { id: (body as { operationId: string }).operationId, phase: "completed", queryHash: digest, sourceSnapshotHash: digest, runtimeFingerprint: digest, results: [{ sourceId: "local-1", similarity: .75 }] }, usedCalls: 1, trust: "local_similarity_not_fact_verification", adopted: false, limitations: ["仅本地相似度"] }; });
  await click(/读取已完成审查/); await fill(/仅本地的检索问题/, "租约恢复"); assert.equal(button(/执行一次本地/).disabled, true); await check(/仅本次调用/); await click(/执行一次本地/);
  const sent = calls.find(call => call.route === "/privacy/local/search")!.body as Record<string, unknown>; assert.equal(sent["expectedRevision"], 3); assert.equal(sent["query"], "租约恢复"); assert.equal(sent["consent"], true); assert.equal(sent["runtime"], undefined);
  assert.match(win.document.body.textContent ?? "", /0.7500（非事实置信度）/); assert.match(win.document.body.textContent ?? "", /未写入事实/); assert.match(win.document.body.textContent ?? "", /查询摘要（不保存原查询）/);
  await fill(/显式私有名称/, "NewName"); assert.equal(field(/仅本地的检索问题/).closest("fieldset")!.disabled, true); assert.match(win.document.body.textContent ?? "", /先重新确认保存/);
});

test("StrictMode mount works and unmount aborts source-catalog reads without accepting a late scope", async () => {
  let resolve!: (value: unknown) => void, signal: AbortSignal | undefined; const pending = new Promise<unknown>(done => { resolve = done; }); let configured = 0;
  await mount(async (_route, _body, selectedSignal) => { signal = selectedSignal; return pending; }, () => configured++);
  await click(/读取已完成审查/); assert.equal(signal?.aborted, false); await settle(() => root?.unmount()); root = undefined; assert.equal(signal?.aborted, true);
  await settle(() => resolve(catalog)); assert.equal(configured, 0); assert.doesNotMatch(win.document.body.textContent ?? "", /lease.ts/);
});

test("editing the privacy source/name draft immediately cancels pending disclosure and blocks old-policy approval until saved or discarded", async () => {
  const { CareerTrustPrivacy } = await import("../src/components/CareerTrustPanel.privacy");
  let resolve!: (value: unknown) => void, signal: AbortSignal | undefined; const pending = new Promise<unknown>(done => { resolve = done; });
  const localBinding = { id: "local", version: "v1", location: "local", endpointFingerprint: digest, ...runtime }, budget = { revision: 1, maxLocalCalls: 4, maxCloudCalls: 1, maxInputBytes: 128000, maxOutputBytes: 32000, maxActiveMs: 60000 };
  const metadata = { taskRevision: 1, sourceSnapshotHash: digest, allowedFields: ["evidence_summary"], budget, runtime: { local: localBinding }, localRuntimeFingerprint: digest, recipientFingerprint: digest, cloudAvailable: false, localOnlySourceCount: 0 };
  const request: TrustRequest = async (route, _body, currentSignal) => { if (route === "/privacy/local/catalog") return catalog; if (route === "/runtimes") return { runtimes: [runtime], noCloudFallback: true }; if (route === "/privacy/context") return metadata; if (route === "/privacy/prepare") { signal = currentSignal; return pending; } throw Error(route); };
  const host = win.document.createElement("div"); win.document.body.append(host); root = createRoot(host as unknown as HTMLElement);
  await settle(() => root!.render(React.createElement(CareerTrustPrivacy, { contextId: "context-1", runtime, request })));
  await click(/读取已完成审查/); await click(/检查隐私与模型配置/); await check(/工程证据摘要/); await click(/仅本地生成披露草稿/); assert.equal(signal?.aborted, false);
  await fill(/显式私有名称/, "NewPrivateName"); assert.equal(signal?.aborted, true); assert.equal(button(/检查隐私与模型配置/).disabled, true);
  await settle(() => resolve({ operationId: "privacy-old", draft: { id: "draft-old", hash: digest, fields: [{ name: "evidence_summary", text: "LATE_OLD_POLICY_DRAFT", sourceIds: ["fact-1"] }], requestedFields: ["evidence_summary"], expiresAt: "2099-01-01T00:00:00.000Z", sources: [{ id: "fact-1", revision: "v1", hash: digest }], repairs: [], redactions: [] }, runtime: metadata.runtime, recipientFingerprint: digest, localRuntimeFingerprint: digest, budget, cloudAvailable: false }));
  assert.doesNotMatch(win.document.body.textContent ?? "", /LATE_OLD_POLICY_DRAFT/); assert.match(win.document.body.textContent ?? "", /先重新确认保存/);
});
