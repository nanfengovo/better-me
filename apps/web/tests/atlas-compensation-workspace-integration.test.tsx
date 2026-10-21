import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import { AtlasDatasetSchema, type AtlasDataset } from "@better-me/opportunities";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { createJobApplication } from "../../job-service/src/application.ts";
import { createJobHttpServer } from "../../job-service/src/http.ts";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import type { AtlasPrototypeProps } from "../src/components/atlas/prototypes/types.ts";
import { getAtlasDataCoverage } from "../src/components/atlas/coverage.ts";
import { queryAtlasPage } from "../src/components/atlas/client.ts";

// Real workspace, review, client, authenticated HTTP, tools and SQLite. Only WebGL is replaced.
const dom = new Window({ url: "http://synthetic-compensation-workspace.invalid" });
const React = await import("react");
const { createElement: h, act } = React;
let mapProps: AtlasPrototypeProps | undefined;
function MapProbe(props: AtlasPrototypeProps) { mapProps = props; return h("div", { "data-synthetic-map": true }); }
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, localStorage: dom.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true, __salaryMapProbe: MapProbe };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("MapLibrePrototype")) return { url: "data:text/javascript,export default globalThis.__salaryMapProbe", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); },
});
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { default: AtlasWorkspace } = await import("../src/components/AtlasWorkspace.tsx");
const AT = "2026-10-21T12:00:00.000Z", TOKEN = "synthetic-compensation-workspace-token-12345";
const PAY = "税前固定月薪人民币20,000-30,000元。", MONTHS = "每年保证发放13个月固定工资。";

function fixture(): AtlasDataset {
  const data = createAtlasDemo(); data.revision = 0;
  for (const compensation of data.compensations) {
    const original = compensation.evidence[0]!;
    for (const key of ["min", "max", "currency", "monthsPerYear"] as const) delete compensation[key];
    compensation.period = "unknown"; compensation.tax = "unknown"; compensation.kind = "unknown";
    compensation.verification = "unverified"; compensation.raw = `${PAY}\n${MONTHS}`;
    compensation.evidence = [{ ...original, quote: PAY, observedAt: AT }];
    const observation = data.observations.find(value => value.id === original.observationId)!;
    observation.rawText = compensation.raw; observation.fetchedAt = AT;
    const owner = data.jobs.find(value => value.compensationIds.includes(compensation.id))!;
    data.listings.find(value => value.id === owner.listingIds[0])!.compensationIds = [compensation.id];
  }
  data.jobs[0]!.title.value = "Synthetic salary review target";
  return AtlasDatasetSchema.parse(data);
}
function button(label: string, scope: ParentNode = dom.document) {
  const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  assert.ok(value, `Missing button ${label}`); return value;
}
async function click(label: string, scope?: ParentNode) { await act(async () => button(label, scope).click()); }
async function settle(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 15_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `${label}: ${dom.document.body.textContent?.slice(-1800)}`);
    await act(async () => { await delay(15); });
  }
}
async function fill(label: string, value: string) {
  const entry = dom.document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  assert.ok(entry, label);
  await act(async () => {
    const prototype = entry.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : entry.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value);
    entry.dispatchEvent(new dom.Event(entry.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function check(label: string) {
  const input = dom.document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); assert.ok(input);
  await act(async () => input.click());
}
const pane = () => dom.document.querySelector('[aria-label="岗位薪资核对面板"]')!;
const salarySort = () => dom.document.querySelector<HTMLOptionElement>('[aria-label="岗位排序"] option[value="salary"]')!;

async function fillReview(compensation: AtlasDataset["compensations"][number], guaranteedMonths = true) {
  const document = `observation:${compensation.evidence[0]!.observationId}`;
  const entries = [["薪资下限", "20000", PAY], ["薪资上限", "30000", PAY], ["薪资币种", "CNY", PAY],
    ["薪资周期", "month", PAY], ["税前税后口径", "gross", PAY], ["薪资组成", "base", PAY]];
  if (guaranteedMonths) entries.push(["每年保证发薪月数", "13", MONTHS]);
  for (const [label, value, quote] of entries) {
    await fill(label!, value!); await fill(`${label}引用来源`, document); await fill(`${label}依据原句`, quote!);
  }
  await fill("薪资核对说明", "Synthetic user reviewed only the selected retained salary fields.");
}

after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test("source salary review and lost-receipt recovery update the real workspace, map, coverage, filtering and revocation together", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  await repository.importSnapshot(fixture(), { expectedRevision: 0, actorScope: "synthetic-seeder", idempotencyKey: "synthetic-salary-seed" });
  const before = await repository.readSnapshot(), beforeBase = await repository.readProjectionSnapshot();
  const target = before.jobs.find(value => value.id === "demo-0")!, compensation = before.compensations.find(value => value.id === target.compensationIds[0])!;
  const application = createJobApplication({ repository, now: () => AT });
  const server = createJobHttpServer({ registry: application.registry, token: TOKEN, allowedOrigins: [dom.location.origin], port: 0 });
  const { url } = await server.listen();
  const requests: Array<{ path: string; body: string; key: string | null }> = [];
  let loseConfirm = true, loseSavedSnapshot = true, confirmCommitted = false;
  const realFetch = globalThis.fetch;
  const mockedFetch = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.includes("/compensations/")) requests.push({ path, body: String(init?.body ?? ""), key: new Headers(init?.headers).get("Idempotency-Key") });
    const response = await realFetch(input, init);
    if (path.endsWith("/compensations/confirm") && response.ok) {
      confirmCommitted = true;
      if (loseConfirm) { loseConfirm = false; await response.arrayBuffer(); throw new TypeError("Synthetic committed response lost"); }
    }
    if (path.endsWith("/dataset/export") && confirmCommitted && loseSavedSnapshot) {
      loseSavedSnapshot = false; await response.arrayBuffer(); throw new TypeError("Synthetic snapshot refresh failed");
    }
    return response;
  });
  dom.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "live", endpoint: url, token: TOKEN }));
  dom.document.body.innerHTML = "<main></main>";
  const root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  try {
    await act(async () => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" }, children: h(AtlasWorkspace, { onSaveOpportunity() {}, onAnalyze() {} }) })));
    await settle(() => dom.document.querySelectorAll(".atlas-job-card").length === before.jobs.length, "initial index");
    assert.equal(salarySort().disabled, true);
    const card = [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")].find(value => value.textContent?.includes(target.title.value))!;
    await act(async () => card.click()); await click("核对来源薪资");
    await settle(() => !!pane()?.querySelector(".atlas-compensation-review"), "lazy review panel");
    await click("读取薪资依据与历史", pane());
    await settle(() => !!pane().querySelector("fieldset"), "review evidence");
    await fillReview(compensation);
    await click("预览薪资变更", pane()); await settle(() => !!pane().querySelector(".atlas-compensation-preview"), "salary preview");
    assert.match(pane().querySelector(".atlas-compensation-preview")!.textContent!, /260,000.*390,000/);
    assert.deepEqual(await repository.readSnapshot(), before, "preview never writes");
    assert.equal(button("确认保存薪资核对", pane()).disabled, true);
    await check("确认本人已逐项核对薪资依据"); await click("确认保存薪资核对", pane());
    await settle(() => !!pane().querySelector(".atlas-compensation-pending") && !pane().querySelector('[aria-busy="true"]'), "lost receipt");
    assert.equal((await repository.readSnapshot()).revision, before.revision + 1);
    await click("核对本次薪资保存回执", pane());
    await settle(() => !!pane().querySelector(".atlas-compensation-saved") && !pane().querySelector('[aria-busy="true"]'), "receipt recovered");
    assert.equal((await repository.backup()).compensationDecisions.length, 1);
    const writes = requests.filter(value => value.path.endsWith("/confirm"));
    assert.equal(writes.length, 2); assert.equal(writes[0]!.body, writes[1]!.body); assert.equal(writes[0]!.key, writes[1]!.key); assert.ok(writes[0]!.key);
    assert.equal(salarySort().disabled, true, "failed snapshot refresh retains the old page snapshot");
    assert.ok(pane().querySelector('.atlas-compensation-status [aria-label="薪资不可比较原因"]'), "an unrefreshed panel keeps the same old salary state as the list");
    await click("重新读取索引", pane());
    await settle(() => !salarySort().disabled && !dom.document.querySelector(".atlas-results .animate-spin"), "same-version workspace refresh");
    assert.ok(pane(), "review remains mounted when the parent index refresh clears the old selection");
    assert.match(pane().querySelector(".atlas-compensation-status")!.textContent!, /260,000.*390,000.*可按税前固定工资比较/);
    assert.equal(pane().querySelector('.atlas-compensation-status [aria-label="薪资不可比较原因"]'), null, "the panel adopts the same confirmed salary as the refreshed workspace");
    const confirmed = await repository.readSnapshot();
    assert.equal(getAtlasDataCoverage(confirmed).salary.jobs, 1);
    assert.deepEqual((await repository.readProjectionSnapshot()).compensations, beforeBase.compensations);
    assert.deepEqual(confirmed.observations, before.observations); assert.deepEqual(confirmed.snapshots, before.snapshots);
    const page = await queryAtlasPage(confirmed, { salary: { range: { min: 250000 }, includeUnknown: false }, page: { limit: 1 }, sort: { field: "salary", direction: "desc" } }, { now: AT });
    assert.equal(page.summary.totalJobs, 1); assert.equal(page.page.items[0]!.job.id, target.id);
    assert.deepEqual(page.page.items[0]!.salary?.cnyAnnual, { currency: "CNY", min: 260000, max: 390000 });
    assert.ok(page.summary.mapBuckets.some(value => value.jobIds.includes(target.id)));
    await click("筛选");
    const salaryInput = [...dom.document.querySelectorAll(".atlas-filters label")].find(value => value.textContent?.startsWith("最低年薪"))!.querySelector<HTMLInputElement>("input")!;
    assert.equal(salaryInput.disabled, false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(salaryInput, "25");
      salaryInput.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await settle(() => dom.document.querySelectorAll(".atlas-job-card").length === 1 && mapProps?.buckets.length === 1, "actual salary filter and map");
    assert.equal(pane(), null, "changing the filter ends the old review session");
    assert.deepEqual(mapProps!.buckets[0]!.jobIds, [target.id]);
    await fill("岗位排序", "salary");
    await settle(() => !dom.document.querySelector(".atlas-results .animate-spin"), "salary sorting");
    await act(async () => dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!.click());
    await click("核对来源薪资"); await settle(() => !!pane()?.querySelector(".atlas-compensation-review"), "review current filtered job");
    await click("读取薪资依据与历史", pane()); await settle(() => !!pane().querySelector(".atlas-compensation-revoke"), "current history");
    assert.match(pane().querySelector(".atlas-compensation-history")!.textContent!, /当前有效的本人核对/);
    await fill("薪资核对说明", "Synthetic explicit revocation restores source disclosure.");
    await check("确认撤销当前薪资核对"); await click("撤销当前薪资核对", pane());
    await settle(() => salarySort().disabled && !!pane().querySelector(".atlas-compensation-saved"), "revocation and coverage");
    assert.ok(pane().querySelector('.atlas-compensation-status [aria-label="薪资不可比较原因"]'), "revocation restores source blockers in the panel as well as the workspace");
    assert.doesNotMatch(pane().querySelector(".atlas-compensation-status")!.textContent!, /260,000|390,000|可按税前固定工资比较/);
    const revoked = await repository.readSnapshot();
    assert.equal(revoked.revision, confirmed.revision + 1); assert.deepEqual(revoked.compensations, before.compensations);
    assert.equal((await repository.backup()).compensationDecisions.length, 2);
    assert.equal(getAtlasDataCoverage(revoked).salary.jobs, 0);
    await settle(() => dom.document.querySelectorAll(".atlas-job-card").length === 0 && mapProps?.buckets.length === 0, "revoked salary exits both filtered list and map");
    assert.equal(requests.filter(value => value.path.endsWith("/confirm")).length, 2, "snapshot retries never submit another salary write");
  } finally {
    await act(async () => root.unmount()); mockedFetch.mock.restore(); await server.close(); await application.shutdown(); repository.close();
  }
});

test("reviewing monthly gross base pay without guaranteed months keeps panel, cards, coverage and salary controls non-comparable", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  const initial = fixture();
  // This source does not disclose guaranteed annual payment count.
  for (const value of initial.compensations) value.raw = PAY;
  for (const value of initial.observations) value.rawText = PAY;
  await repository.importSnapshot(initial, { expectedRevision: 0, actorScope: "synthetic-seeder", idempotencyKey: "synthetic-monthly-seed" });
  const application = createJobApplication({ repository, now: () => AT });
  const server = createJobHttpServer({ registry: application.registry, token: TOKEN, allowedOrigins: [dom.location.origin], port: 0 });
  const { url } = await server.listen();
  dom.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "live", endpoint: url, token: TOKEN }));
  dom.document.body.innerHTML = "<main></main>";
  const root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  try {
    await act(async () => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" }, children: h(AtlasWorkspace, { onSaveOpportunity() {}, onAnalyze() {} }) })));
    await settle(() => dom.document.querySelectorAll(".atlas-job-card").length === initial.jobs.length, "monthly index");
    const card = [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")].find(value => value.textContent?.includes("Synthetic salary review target"))!;
    await act(async () => card.click()); await click("核对来源薪资");
    await settle(() => !!pane()?.querySelector(".atlas-compensation-review"), "monthly review panel");
    await click("读取薪资依据与历史", pane()); await settle(() => !!pane().querySelector("fieldset"), "monthly review evidence");
    await fillReview(initial.compensations.find(value => value.id === "demo-0-salary")!, false);
    await click("预览薪资变更", pane()); await settle(() => !!pane().querySelector(".atlas-compensation-preview"), "monthly preview");
    assert.match(pane().querySelector(".atlas-compensation-preview")!.textContent!, /未披露每年保证发薪月数/);
    await check("确认本人已逐项核对薪资依据"); await click("确认保存薪资核对", pane());
    await settle(() => dom.document.querySelector(".atlas-data-banner")!.textContent!.includes("索引版本 2") && !!pane().querySelector(".atlas-compensation-saved"), "monthly snapshot");
    assert.equal(salarySort().disabled, true);
    assert.match(dom.document.querySelector('[aria-label="当前索引筛选覆盖"]')!.textContent!, /可比较年薪 0/);
    assert.ok([...dom.document.querySelectorAll(".atlas-job-salary")].every(value => value.textContent === "薪资待核实"));
    await click("筛选");
    const input = [...dom.document.querySelectorAll(".atlas-filters label")].find(value => value.textContent?.startsWith("最低年薪"))!.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.disabled, true, "the workspace does not silently estimate twelve guaranteed payments");
    const saved = await repository.readSnapshot();
    assert.equal(saved.compensations.find(value => value.id === "demo-0-salary")!.monthsPerYear, undefined);
    assert.equal(getAtlasDataCoverage(saved, { includeEstimates: false }).salary.jobs, 0);
  } finally {
    await act(async () => root.unmount()); await server.close(); await application.shutdown(); repository.close();
  }
});
