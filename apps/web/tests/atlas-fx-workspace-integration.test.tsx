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
import { queryAtlasPage } from "../src/components/atlas/client.ts";
import { createAtlasSourceClient } from "../src/components/atlas/service-client.ts";
import { getAtlasDataCoverage } from "../src/components/atlas/coverage.ts";
import type { AtlasPrototypeProps } from "../src/components/atlas/prototypes/types.ts";
import { fxAt, fxDraft } from "./fixtures/atlas-fx.ts";
const dom = new Window({ url: "http://synthetic-fx-workspace.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
let map: AtlasPrototypeProps | undefined;
function MapProbe(props: AtlasPrototypeProps) { map = props; return h("div", { "data-fx-map-probe": true }); }
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true, __fxWorkspaceMap: MapProbe };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.includes("MapLibrePrototype")) return { url: "data:text/javascript,export default globalThis.__fxWorkspaceMap", shortCircuit: true };
  return nextResolve(specifier, context);
}, load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client"); const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx"); const { default: AtlasWorkspace } = await import("../src/components/AtlasWorkspace.tsx");
function dataset(): AtlasDataset {
  const data = createAtlasDemo(), duplicate = structuredClone(data); const groups = ["companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const;
  const identities = new Map(groups.flatMap(group => duplicate[group].map(entry => [entry.id, `${entry.id}-second`] as const)));
  function rename(value: unknown): unknown { if (typeof value === "string") return identities.get(value) ?? value; if (Array.isArray(value)) return value.map(rename); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rename(entry)])); return value; }
  for (const group of groups) (data[group] as unknown[]) = [...data[group], ...rename(duplicate[group]) as unknown[]];
  data.revision = 0; data.jobs.forEach((job, index) => { job.title.value = `Synthetic FX role ${String(index).padStart(2, "0")}`; job.description = `Synthetic salary comparison ${index}`; });
  data.compensations.forEach((compensation, index) => { compensation.currency = index % 2 ? "USD" : "CNY"; compensation.min = 100000 + index * 1000; compensation.max = 150000 + index * 1000; compensation.raw = `Synthetic ${compensation.currency} gross annual base salary`; });
  return AtlasDatasetSchema.parse(data);
}
function button(label: string, scope: ParentNode = dom.document) { const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label); assert.ok(value, label); return value; }
async function click(label: string, scope?: ParentNode) { await act(async () => button(label, scope).click()); }
async function settle(predicate: () => boolean, label: string) { const deadline = performance.now() + 15000; while (!predicate()) { assert.ok(performance.now() < deadline, `${label}: ${dom.document.querySelector(".atlas-fx-panel")?.textContent?.slice(-1500) ?? dom.document.body.textContent?.slice(-1600)}`); await act(async () => { await delay(10); }); } }
async function fill(label: string, value: string) { const node = dom.document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); assert.ok(node, label); await act(async () => { const proto = node.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value); node.dispatchEvent(new dom.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
const cards = () => [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")];
const titles = () => cards().map(card => card.querySelector("strong")!.textContent!);
const ready = () => !dom.document.querySelector(".atlas-results .animate-spin") && dom.document.querySelector('[aria-label="当前索引筛选覆盖"]')?.getAttribute("aria-busy") === "false";
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("real HTTP FX import/activation keeps coverage, CNY/original salary, sort, filter, map and pagination on one current context", async () => {
  const repository = openJobRepository(":memory:", { now: () => fxAt });
  await repository.importSnapshot(dataset(), { expectedRevision: 0, actorScope: "synthetic-fx-seeder", idempotencyKey: "fx-workspace-seed" });
  const application = createJobApplication({ repository, now: () => fxAt }), token = "synthetic-fx-workspace-token-123456";
  const server = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [dom.location.origin], port: 0 }); const { url } = await server.listen();
  const originalFetch = globalThis.fetch; let holdState = true, release!: () => void; const held = new Promise<void>(done => { release = done; });
  const requests: { path: string; body: string }[] = []; let stateWaiting = false;
  const fetcher = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; requests.push({ path, body: String(init?.body ?? "") });
    if (path.endsWith("/fx/state") && JSON.parse(String(init?.body)).expectedRevision === 2 && holdState) { stateWaiting = true; await held; }
    return originalFetch(input, init);
  });
  dom.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "live", endpoint: url, token }));
  dom.document.body.innerHTML = "<main></main>"; const root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  try {
    await act(async () => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" }, children: h(AtlasWorkspace, { onSaveOpportunity() {}, onAnalyze() {} }) })));
    await settle(() => cards().length === 30 && ready(), "initial real data"); assert.match(dom.document.querySelector(".atlas-coverage")!.textContent!, /可比较年薪 22/);
    await click("参考汇率"); await settle(() => !!dom.document.querySelector(".atlas-fx-panel"), "FX panel");
    for (const [label, value] of [["汇率来源名称", fxDraft.provider], ["汇率原文出处", fxDraft.sourceUrl], ["汇率读取时间", fxDraft.retrievedAt], ["参考汇率JSON原文", fxDraft.raw]]) await fill(label!, value!);
    await click("预览汇率快照"); await settle(() => !!dom.document.querySelector(".atlas-fx-preview"), "source-bound preview");
    await act(async () => { dom.document.querySelector<HTMLInputElement>(".atlas-fx-preview input")!.click(); dom.document.querySelector<HTMLInputElement>('[aria-label="确认已核对汇率出处日期与换算方向"]')!.click(); });
    await click("确认保存汇率快照"); await settle(() => stateWaiting, "new revision blocked on FX");
    assert.equal(cards().length, 0); assert.equal(map!.buckets.length, 0); assert.ok([...dom.document.querySelectorAll(".atlas-stat-grid strong")].every(value => value.textContent === "—"));
    assert.equal(dom.document.querySelector(".atlas-load-more"), null); assert.match(dom.document.querySelector(".atlas-coverage")!.textContent!, /旧覆盖统计已隐藏/);
    holdState = false; await act(async () => release()); await settle(() => cards().length === 30 && ready(), "same-version recalculation");
    assert.match(dom.document.querySelector(".atlas-coverage")!.textContent!, /可比较年薪 44/);
    const client = createAtlasSourceClient(url, token), data = await client.snapshot(), state = await client.readFxState({ expectedRevision: 2 });
    const options = { now: state.context.asOf, fx: state.context.activeSnapshot!.fx }, expected = await queryAtlasPage(data, { sort: { field: "salary", direction: "desc" }, page: { limit: 30 } }, options);
    assert.equal(getAtlasDataCoverage(data, options).salary.jobs, 44);
    await fill("岗位排序", "salary"); await settle(() => ready() && titles()[0] === expected.page.items[0]!.job.title.value, "actual FX salary sorting");
    assert.deepEqual(titles(), expected.page.items.map(item => item.job.title.value)); assert.ok(cards()[0]!.querySelector(".atlas-job-salary")!.textContent!.startsWith("CNY"));
    await act(async () => cards()[0]!.click()); assert.match(dom.document.querySelector(".atlas-job-detail")!.textContent!, /Synthetic reference rates/);
    await act(async () => dom.document.querySelector<HTMLInputElement>(".atlas-sort input[type=checkbox]")!.click());
    assert.ok(cards()[0]!.querySelector(".atlas-job-salary")!.textContent!.startsWith("USD")); assert.match(dom.document.querySelector(".atlas-job-detail")!.textContent!, /USD/);
    await click("显示更多岗位"); await settle(() => cards().length === 44, "same-context pagination");
    const rest = await queryAtlasPage(data, { sort: { field: "salary", direction: "desc" }, page: { limit: 30 } }, options, { cursor: expected.page.nextCursor });
    assert.deepEqual(titles(), [...expected.page.items, ...rest.page.items].map(item => item.job.title.value));
    await click("筛选"); const input = [...dom.document.querySelectorAll(".atlas-filters label")].find(value => value.textContent?.startsWith("最低年薪"))!.querySelector<HTMLInputElement>("input")!;
    await act(async () => { Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "80"); input.dispatchEvent(new dom.Event("input", { bubbles: true })); });
    await settle(() => ready() && cards().length === 22, "salary filtering with same map");
    const expectedFiltered = await queryAtlasPage(data, { salary: { range: { min: 800000 }, metric: "min", includeUnknown: false, includeEstimates: false }, sort: { field: "salary", direction: "desc" }, page: { limit: 30 } }, options);
    assert.deepEqual(titles(), expectedFiltered.page.items.map(item => item.job.title.value)); assert.deepEqual(new Set(map!.buckets.flatMap(bucket => bucket.jobIds)), new Set(expectedFiltered.page.items.map(item => item.job.id)));
    assert.equal(requests.filter(value => value.path.endsWith("/fx/import")).length, 1); assert.equal((await repository.readSnapshot()).revision, 2);
  } finally { release(); await act(async () => root.unmount()); fetcher.mock.restore(); await server.close(); repository.close(); dom.sessionStorage.clear(); }
});

test("an uncertain committed FX write stays blocked through demo/local round trips and a whole workspace remount until its original receipt is recovered", async () => {
  const repository = openJobRepository(":memory:", { now: () => fxAt });
  await repository.importSnapshot(dataset(), { expectedRevision: 0, actorScope: "synthetic-fx-recovery-seeder", idempotencyKey: "fx-recovery-seed" });
  const application = createJobApplication({ repository, now: () => fxAt }), token = "synthetic-fx-remount-recovery-token-12345";
  const server = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [dom.location.origin], port: 0 }); const { url } = await server.listen();
  const originalFetch = globalThis.fetch, writes: { body: string; key: string | null }[] = []; let loseReply = true;
  const fetcher = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname.endsWith("/fx/import")) {
      writes.push({ body: String(init?.body), key: new Headers(init?.headers).get("Idempotency-Key") });
      if (response.ok && loseReply) { loseReply = false; await response.arrayBuffer(); throw new TypeError("Synthetic committed FX reply lost"); }
    }
    return response;
  });
  dom.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "live", endpoint: url, token }));
  dom.document.body.innerHTML = "<main></main>"; let root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  const mount = async () => act(async () => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" }, children: h(AtlasWorkspace, { onSaveOpportunity() {}, onAnalyze() {} }) })));
  try {
    await mount(); await settle(() => cards().length === 30 && ready(), "initial recovery data"); await click("参考汇率"); await settle(() => !!dom.document.querySelector(".atlas-fx-panel"), "recovery panel");
    for (const [label, value] of [["汇率来源名称", fxDraft.provider], ["汇率原文出处", fxDraft.sourceUrl], ["汇率读取时间", fxDraft.retrievedAt], ["参考汇率JSON原文", fxDraft.raw]]) await fill(label!, value!);
    await click("预览汇率快照"); await settle(() => !!dom.document.querySelector(".atlas-fx-preview"), "recovery preview");
    await act(async () => { dom.document.querySelector<HTMLInputElement>(".atlas-fx-preview input")!.click(); dom.document.querySelector<HTMLInputElement>('[aria-label="确认已核对汇率出处日期与换算方向"]')!.click(); });
    await click("确认保存汇率快照"); await settle(() => !!dom.document.querySelector(".atlas-fx-pending") && !dom.document.querySelector('.atlas-fx-panel[aria-busy="true"]'), "lost committed reply");
    assert.equal((await repository.readSnapshot()).revision, 2); assert.equal(cards().length, 0);
    for (const mode of ["demo", "local"] as const) {
      await fill("岗位数据视图", mode); await settle(() => dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')?.value === mode, `switch to ${mode}`);
      await fill("岗位数据视图", "live"); await settle(() => !!dom.document.querySelector(".atlas-fx-status")?.textContent?.includes("汇率写入结果待核对"), `restore live barrier after ${mode}`);
      assert.equal(dom.document.querySelector(".atlas-fx-panel"), null, "the panel remains closed during this check"); assert.equal(cards().length, 0); assert.equal(map!.buckets.length, 0); assert.equal(dom.document.querySelector(".atlas-load-more"), null);
      assert.match(dom.document.querySelector(".atlas-coverage")!.textContent!, /旧覆盖统计已隐藏/);
    }
    await act(async () => root.unmount()); dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); await mount();
    await settle(() => !!dom.document.querySelector(".atlas-data-banner")?.textContent?.includes("索引版本 2") && !!dom.document.querySelector(".atlas-fx-status")?.textContent?.includes("汇率写入结果待核对"), "same-scope whole workspace remount");
    assert.equal(dom.document.querySelector(".atlas-fx-panel"), null); assert.equal(cards().length, 0); assert.equal(map!.buckets.length, 0); assert.ok([...dom.document.querySelectorAll(".atlas-stat-grid strong")].every(value => value.textContent === "—"));
    await click("参考汇率"); await settle(() => !!dom.document.querySelector(".atlas-fx-pending"), "original request recovered on reopen"); await click("核对本次汇率保存回执");
    await settle(() => cards().length === 30 && ready() && !dom.document.querySelector(".atlas-fx-pending"), "trusted receipt and refreshed FX unlock");
    assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]); assert.equal(JSON.parse(writes[1]!.body).expectedRevision, 1); assert.equal((await repository.readSnapshot()).revision, 2);
    assert.match(dom.document.querySelector(".atlas-coverage")!.textContent!, /可比较年薪 44/);
  } finally { await act(async () => root.unmount()); fetcher.mock.restore(); await server.close(); repository.close(); dom.sessionStorage.clear(); }
});
