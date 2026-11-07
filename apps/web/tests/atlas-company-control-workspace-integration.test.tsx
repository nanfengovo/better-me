import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import { classifyCompany, resolveCompanyColor } from "@better-me/opportunities";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { createJobApplication } from "../../job-service/src/application.ts";
import { createJobHttpServer } from "../../job-service/src/http.ts";
import { createAtlasSourceClient } from "../src/components/atlas/service-client.ts";
import { getAtlasDataCoverage } from "../src/components/atlas/coverage.ts";
import type { AtlasPrototypeProps } from "../src/components/atlas/prototypes/types.ts";
import { companyControlAt, companyControlCompanyId, companyControlDataset, companyControlJobId, companyControlJobIds, companyControlProposal, companyControlReason } from "./fixtures/atlas-company-control.ts";

const dom = new Window({ url: "http://synthetic-company-workspace.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
let map: AtlasPrototypeProps | undefined;
function MapProbe(props: AtlasPrototypeProps) { map = props; return h("div", { "data-company-map-probe": true }); }
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true, __companyWorkspaceMap: MapProbe };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.includes("MapLibrePrototype")) return { url: "data:text/javascript,export default globalThis.__companyWorkspaceMap", shortCircuit: true };
  return nextResolve(specifier, context);
}, load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { default: AtlasWorkspace } = await import("../src/components/AtlasWorkspace.tsx");

const cards = () => [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")];
const ready = () => !dom.document.querySelector(".atlas-results .animate-spin") && dom.document.querySelector('[aria-label="当前索引筛选覆盖"]')?.getAttribute("aria-busy") === "false";
function button(label: string, scope: ParentNode = dom.document) {
  const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  assert.ok(value, `Missing button: ${label}`); return value;
}
async function click(label: string, scope?: ParentNode) { await act(async () => button(label, scope).click()); }
async function settle(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `${label}: ${dom.document.querySelector(".atlas-company-review")?.textContent?.slice(-1800) ?? dom.document.body.textContent?.slice(-1800)}`);
    await act(async () => { await delay(10); });
  }
}
async function fill(label: string, value: string) {
  const node = dom.document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  assert.ok(node, `Missing field: ${label}`);
  await act(async () => {
    const proto = node.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
    node.dispatchEvent(new dom.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function check(label: string) {
  const node = dom.document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`); assert.ok(node, label);
  await act(async () => node.click());
}
async function prepareReview() {
  const title = companyControlDataset().jobs.find(job => job.id === companyControlJobId)!.title.value;
  const card = cards().find(node => node.querySelector("strong")?.textContent === title); assert.ok(card, title);
  await act(async () => card.click()); await click("核对企业控制来源");
  await settle(() => !!dom.document.querySelector(".atlas-company-review"), "company review panel");
  await click("读取企业核对记录");
  await settle(() => dom.document.querySelector(".atlas-company-review")?.getAttribute("aria-busy") === "false"
    && dom.document.querySelector(".atlas-company-review fieldset")?.hasAttribute("disabled") === false, "bound company review read");
  const document = companyControlProposal.documents[0]!;
  await fill("文档 1 · 公开出处 URL", document.sourceUrl);
  await fill("文档 1 · 实际读取时间（ISO 8601）", document.retrievedAt);
  await fill("文档 1 · 完整原文", document.rawText);
  await fill("实际雇主法定名称", companyControlProposal.legalEntityName);
  await fill("企业核对状态", "resolved"); await fill("企业控制关系", "single");
  await fill("控制方 1 · 名称", companyControlProposal.controllers[0]!.name);
  await fill("控制方 1 · 性质", "private"); await fill("控制方 1 · 来源国家代码", "DE");
  const names: Record<string, string> = { legalEntityName: "实际雇主法定名称", status: "核对状态", controlMode: "控制关系",
    controllerName: "控制方 1 · 控制方名称", controllerControl: "控制方 1 · 最终控制关系", controllerKind: "控制方 1 · 控制方性质", controllerJurisdiction: "控制方 1 · 控制方来源国家／地区" };
  for (const support of companyControlProposal.supports) await fill(`${names[support.field]} · 引用原句`, support.quote);
  await fill("企业核对说明", companyControlReason);
  await click("预览企业控股核对");
  await settle(() => !!dom.document.querySelector(".atlas-company-preview"), "field-bound company preview");
  await check("确认已逐项核对企业证据");
}
function render(root: ReturnType<typeof createRoot>) {
  return act(async () => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" }, children: h(AtlasWorkspace, { onSaveOpportunity() {}, onAnalyze() {} }) })));
}
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("reviewing one employer through real HTTP changes every linked role, map color, coverage and filters together; revocation restores unknown", async () => {
  const repository = openJobRepository(":memory:", { now: () => companyControlAt });
  await repository.importSnapshot(companyControlDataset(), { expectedRevision: 0, actorScope: "synthetic-company-seeder", idempotencyKey: "company-seed" });
  const application = createJobApplication({ repository, now: () => companyControlAt }), token = "synthetic-company-workspace-token-123456";
  const server = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [dom.location.origin], port: 0 });
  const { url } = await server.listen(), originalFetch = globalThis.fetch;
  let holdSnapshot = true, writeCommitted = false, snapshotWaiting = false, release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const writes: string[] = [];
  const fetcher = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/dataset/export") && writeCommitted && holdSnapshot) { snapshotWaiting = true; await held; }
    const response = await originalFetch(input, init);
    if (path.endsWith("/control-review/confirm") && response.ok) { writeCommitted = true; writes.push(String(init?.body)); }
    return response;
  });
  dom.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "live", endpoint: url, token }));
  dom.document.body.innerHTML = "<main></main>"; const root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  try {
    await render(root); await settle(() => cards().length === 22 && ready(), "initial unclassified roles");
    assert.match(dom.document.querySelector(".atlas-coverage")!.textContent!, /已核实企业性质 0/);
    await prepareReview(); await click("确认保存企业核对");
    await settle(() => snapshotWaiting, "committed review waiting for current dataset");
    assert.equal(cards().length, 0); assert.equal(map!.buckets.length, 0); assert.equal(dom.document.querySelector(".atlas-load-more"), null);
    assert.ok([...dom.document.querySelectorAll(".atlas-stat-grid strong")].every(value => value.textContent === "—"));
    holdSnapshot = false; await act(async () => release());
    await settle(() => cards().length === 22 && ready(), "matching company dataset");
    const client = createAtlasSourceClient(url, token), snapshot = await client.snapshot();
    assert.equal(snapshot.revision, 2);
    const company = snapshot.companies.find(company => company.id === companyControlCompanyId)!;
    assert.deepEqual(classifyCompany(company).jurisdictions, ["DE"]); assert.equal(classifyCompany(company).ownership, "private");
    assert.equal(resolveCompanyColor(company).ruleId, "de-fr");
    assert.equal(getAtlasDataCoverage(snapshot).ownership.jobs, 2);
    assert.match(dom.document.querySelector(".atlas-coverage")!.textContent!, /已核实企业性质 2/);
    assert.equal(getAtlasDataCoverage(snapshot).source.options.length, 1, "company documents do not become job sources");
    const affectedBuckets = map!.buckets.filter(bucket => bucket.jobIds.some(id => companyControlJobIds.includes(id)));
    assert.equal(affectedBuckets.length, 2);
    assert.ok(affectedBuckets.every(bucket => bucket.categories.some(category => category.color === "#14532D")));
    await click("筛选"); await fill("筛选企业性质", "private");
    await settle(() => cards().length === 2 && ready(), "same-company classification filter");
    assert.deepEqual(new Set(map!.buckets.flatMap(bucket => bucket.jobIds)), new Set(companyControlJobIds));
    await act(async () => cards()[0]!.click()); await click("核对企业控制来源");
    await settle(() => !!dom.document.querySelector(".atlas-company-review"), "company panel after classification filter");
    assert.match(dom.document.querySelector(".atlas-company-review")!.textContent!, /本人核对/);
    await click("读取企业核对记录");
    await settle(() => !!dom.document.querySelector('[aria-label="企业撤销说明"]'), "persisted active review history");
    await fill("企业撤销说明", "Synthetic revocation retains the original source company and role facts.");
    await check("确认撤销企业核对"); await click("撤销当前企业核对");
    await settle(() => ready() && cards().length === 0, "revocation removes roles from private filter");
    const revoked = await client.snapshot(); assert.equal(revoked.revision, 3);
    assert.equal(classifyCompany(revoked.companies.find(company => company.id === companyControlCompanyId)!).status, "unknown");
    assert.equal(getAtlasDataCoverage(revoked).ownership.jobs, 0);
    const roleFacts = (jobs: typeof revoked.jobs) => jobs.map(job => [job.id, job.description, job.locationIds, job.compensationIds, job.listingIds]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    assert.deepEqual(roleFacts(revoked.jobs), roleFacts(companyControlDataset().jobs));
    assert.equal(writes.length, 1);
  } finally { release(); await act(async () => root.unmount()); fetcher.mock.restore(); await server.close(); repository.close(); dom.sessionStorage.clear(); dom.localStorage.clear(); }
});

test("a committed company write with a lost reply remains blocked across view changes and remount until its exact receipt is recovered", async () => {
  const repository = openJobRepository(":memory:", { now: () => companyControlAt });
  await repository.importSnapshot(companyControlDataset(), { expectedRevision: 0, actorScope: "synthetic-company-recovery", idempotencyKey: "company-recovery-seed" });
  const application = createJobApplication({ repository, now: () => companyControlAt }), token = "synthetic-company-recovery-token-123456";
  const server = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [dom.location.origin], port: 0 });
  const { url } = await server.listen(), originalFetch = globalThis.fetch;
  const writes: { body: string; key: string | null }[] = []; let loseReply = true;
  const fetcher = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname.endsWith("/control-review/confirm")) {
      writes.push({ body: String(init?.body), key: new Headers(init?.headers).get("idempotency-key") });
      if (response.ok && loseReply) { loseReply = false; await response.arrayBuffer(); throw new TypeError("Synthetic committed company reply lost"); }
    }
    return response;
  });
  dom.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "live", endpoint: url, token }));
  dom.document.body.innerHTML = "<main></main>"; let root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  try {
    await render(root); await settle(() => cards().length === 22 && ready(), "initial recovery roles");
    await prepareReview(); await click("确认保存企业核对");
    await settle(() => !!dom.document.querySelector(".atlas-company-pending") && dom.document.querySelector(".atlas-company-review")?.getAttribute("aria-busy") === "false", "uncertain company receipt");
    assert.equal((await repository.readSnapshot()).revision, 2); assert.equal(cards().length, 0);
    for (const mode of ["demo", "local"] as const) {
      await fill("岗位数据视图", mode); await settle(() => dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')?.value === mode, `switch to ${mode}`);
      await fill("岗位数据视图", "live");
      await settle(() => !!dom.document.querySelector(".atlas-company-recovery-status"), `company recovery barrier after ${mode}`);
      assert.equal(cards().length, 0); assert.equal(map!.buckets.length, 0);
    }
    await act(async () => root.unmount()); dom.document.body.innerHTML = "<main></main>";
    root = createRoot(dom.document.querySelector("main")! as unknown as Element); await render(root);
    await settle(() => !!dom.document.querySelector(".atlas-company-recovery-status"), "company recovery barrier after workspace remount");
    assert.equal(cards().length, 0); assert.equal(map!.buckets.length, 0);
    await click("恢复企业核对");
    await settle(() => !!dom.document.querySelector(".atlas-company-pending"), "original company command on reopen");
    await click("核对本次企业保存回执");
    await settle(() => cards().length === 22 && ready(), "trusted original company receipt");
    assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
    assert.equal(JSON.parse(writes[1]!.body).expectedRevision, 1);
    assert.equal((await repository.readSnapshot()).revision, 2);
    assert.match(dom.document.querySelector(".atlas-coverage")!.textContent!, /已核实企业性质 2/);
  } finally { await act(async () => root.unmount()); fetcher.mock.restore(); await server.close(); repository.close(); dom.sessionStorage.clear(); dom.localStorage.clear(); }
});
