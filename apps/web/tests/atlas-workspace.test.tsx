import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement } from "happy-dom";
import { AtlasDatasetSchema, GeocodingRequestSchema, GeocodingResultSchema, applyOfficeAddressConfirmation, type AddressEnrichmentPlan, type AtlasDataset, type GeocodingRequest } from "@better-me/opportunities";
import { createOpportunity, OPPORTUNITY_STORAGE_KEY } from "../src/lib/opportunities.ts";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import type { AtlasPrototypeProps } from "../src/components/atlas/prototypes/types.ts";
import type { AtlasJobDetailProps } from "../src/components/atlas/AtlasJobDetail.tsx";
import type { AtlasOfficeAddressConfirmationProps } from "../src/components/atlas/AtlasOfficeAddressConfirmation.tsx";
import { queryAtlasPage } from "../src/components/atlas/client.ts";
import { officeProposal, officeAt } from "./fixtures/atlas-office-address.ts";
import { createMapReferenceFixture } from "./fixtures/atlas-map-references.ts";

// Exercise the real React workspace and shared queries. The map probe only replaces WebGL/network rendering.
const dom = new Window({ url: "http://atlas-workspace-fixture.invalid" });
// Layout scrolling is supplied by the real browser; keep this fixture local to happy-dom.
Object.defineProperty(dom.HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: () => {} });
const React = await import("react");
const { createElement: h, act, useEffect } = React;
let mapProps: AtlasPrototypeProps | undefined;
let mapMounts = 0;
let detailData: AtlasDataset | undefined;
let officeProps: AtlasOfficeAddressConfirmationProps | undefined;
let pauseRecovery: undefined | ((signal: AbortSignal) => Promise<void>);
async function workspacePage(...args: Parameters<typeof queryAtlasPage>) {
  if (args[1].page?.limit === 1 && args[3]?.selectedJobIds && pauseRecovery) await pauseRecovery(args[3].signal!);
  return queryAtlasPage(...args);
}
function OfficeProbe(props: AtlasOfficeAddressConfirmationProps) { officeProps = props; return h("p", { "data-office-probe": true }, "Synthetic office review"); }
function MapProbe(props: AtlasPrototypeProps) {
  mapProps = props;
  useEffect(() => { mapMounts++; }, []);
  return h("div", { "data-map-probe": true });
}
// Keep the real pane and its handlers, observing only the canonical data passed into it.
function DetailProbe(props: AtlasJobDetailProps) {
  detailData = props.data;
  return h(RealAtlasJobDetail, props);
}
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  __atlasMapProbe: MapProbe, __atlasDetailProbe: DetailProbe, __atlasOfficeProbe: OfficeProbe, __atlasWorkspacePage: workspacePage };
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("MapLibrePrototype")) return { url: "data:text/javascript,export default globalThis.__atlasMapProbe", shortCircuit: true };
    if (specifier === "./atlas/AtlasJobDetail") return { url: "data:text/javascript,export const AtlasJobDetail = globalThis.__atlasDetailProbe", shortCircuit: true };
    if (specifier === "./atlas/AtlasOfficeAddressConfirmation" || specifier === "./AtlasOfficeAddressConfirmation") return { url: "data:text/javascript,export const AtlasOfficeAddressConfirmation = globalThis.__atlasOfficeProbe", shortCircuit: true };
    if (specifier === "./atlas/client") return { url: `data:text/javascript,export {buildAtlasJobAction,readAtlasSnapshot} from ${JSON.stringify(new URL("../src/components/atlas/client.ts", import.meta.url).href)};export const queryAtlasPage=globalThis.__atlasWorkspacePage`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { source: "export {};", format: "module", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { AtlasJobDetail: RealAtlasJobDetail } = await import("../src/components/atlas/AtlasJobDetail.tsx");
const { default: AtlasWorkspace } = await import("../src/components/AtlasWorkspace.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const noAction = () => {};
async function waitFor(condition: () => boolean, description: string) {
  const deadline = performance.now() + 15_000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}: ${dom.document.querySelector(".atlas-workspace")?.textContent?.slice(-1500)}`);
    await act(async () => { await delay(20); });
  }
}
async function flush(action: () => void = () => {}) {
  await act(async () => { action(); });
  await waitFor(() => Boolean(dom.document.querySelector(".atlas-results-heading"))
    && !dom.document.querySelector(".atlas-workspace .animate-spin")
    && !dom.document.querySelector<HTMLButtonElement>(".atlas-load-more")?.disabled,
  "the current query, connection or next-page request to finish");
}
async function render(active = true, demo = true) {
  const firstRender = !root;
  if (!root && !dom.sessionStorage.getItem("better-me:atlas-connection-session:v1")) dom.sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "local" }));
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" },
    children: h(AtlasWorkspace, { active, onSaveOpportunity: noAction, onAnalyze: noAction }) })));
  if (firstRender && demo) await flush(() => {
    const dataView = dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!;
    assert.equal(dataView.value, "local", "this scenario explicitly starts in the local view");
    dataView.value = "demo"; dataView.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
  if (firstRender && demo) await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22,
    "the initial synthetic query's 22 job cards");
}
function button(text: string) {
  const found = text === "连接本机服务" ? dom.document.querySelector<HTMLButtonElement>('[aria-label="岗位后端设置"]') : [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text);
  assert.ok(found, `Missing button ${text}`); return found;
}
function resultsHeading() { return dom.document.querySelector(".atlas-results-heading h2")!.textContent!; }
function changeInput(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new dom.Event("input", { bubbles: true }));
}
async function connectFixture() {
  await flush(() => button("连接本机服务").click());
  await flush(() => changeInput([...dom.document.querySelectorAll("label")].find(node => node.textContent?.startsWith("服务地址"))!.querySelector<HTMLInputElement>("input")!, "http://127.0.0.1:5178"));
  await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('input[type="password"]')!, "synthetic-fixture-token"));
  await flush(() => button("连接并读取索引").click());
}
function searchFixture(empty = false): AtlasDataset {
  const data = createAtlasDemo();
  data.revision = empty ? 1 : 2;
  data.sources[0] = { ...data.sources[0]!, name: "Synthetic keyword source", attribution: { label: "合成关键词来源", usage: "metadata", requiresAttribution: true },
    adapterId: "synthetic-keyword", enabled: true, status: "active", capabilities: ["list-jobs"], remoteFilters: ["roles"], entryUrl: "https://example.invalid/jobs",
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 9, maxPages: 1, requestsPerMinute: 1 } };
  if (empty) {
    for (const group of ["companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const) data[group] = [];
  } else {
    data.jobs.forEach((job, index) => { job.title.value = index < 3 ? `C# 合成工程师 ${index}` : "C++ 合成工程师"; job.description = job.title.value; job.compensationIds = []; });
    data.compensations = [];
    data.locations.forEach((location) => { delete location.coordinates; delete location.regionId; delete location.region; location.precision = "unknown"; location.kind = "unknown"; });
    delete data.locations[2]!.countryCode;
    for (const company of data.companies) company.ultimateControllers = { value: [], evidence: [], method: "manual", verification: "unknown", revision: 0 };
  }
  return AtlasDatasetSchema.parse(data);
}
const sourceResponse = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-workspace-source-request", value }));
// Existing scenarios return an explicit unresolved projection; city-reference scenarios supply their own response.
function installWorkspaceFetch(handler: typeof fetch, mapReply?: (input: { expectedRevision: number }, init?: RequestInit) => Response | Promise<Response>) {
  let latest: AtlasDataset | undefined;
  return mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/locations/map-references") {
      const input = JSON.parse(String(init!.body));
      if (mapReply) return mapReply(input, init);
      const locations = latest?.locations ?? [];
      return sourceResponse({ schemaVersion: 1, snapshotRevision: input.expectedRevision, providerId: "synthetic-unresolved-map",
        places: [], references: [], unresolved: locations.map(location => ({ locationId: location.id, reason: location.coordinates ? "existing-coordinate" : "no-exact-match" })),
        totalLocations: locations.length, processedLocations: locations.length, truncated: false, warnings: ["No synthetic city reference in this scenario."] });
    }
    const response = await handler(url, init);
    if (path === "/api/v1/dataset/export" && response.ok) {
      try { const payload = await response.clone().json(); latest = payload.value; } catch { /* Failure fixtures remain failures. */ }
    }
    return response;
  });
}
const sourceReceipt = (scope: unknown) => ({ run: { runId: "synthetic-main-search-run", sourceId: "atlas-demo", actorScope: "local-owner", generation: 1,
  scope: {}, status: "partial", startedAt: "2026-10-18T12:00:00.000Z", summary: { records: 9, pages: 1, partial: true } }, localFilters: scope, warnings: ["Synthetic bounded fixture, not real recruitment coverage"] });
function pointerClick(card: HTMLButtonElement, detail: number) {
  card.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, detail, button: 0 }));
}
function pointerDoubleClick(card: HTMLButtonElement) {
  pointerClick(card, 1); pointerClick(card, 2);
  card.dispatchEvent(new dom.MouseEvent("dblclick", { bubbles: true, detail: 2, button: 0 }));
}
function jobCard(title: string) {
  const card = [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")].find((entry) => entry.textContent?.includes(title));
  assert.ok(card, `Missing synthetic job card ${title}`); return card;
}

test("double-clicking a job with multiple workplaces asks for a location and focuses only the chosen office", async () => {
  const data = createAtlasDemo();
  const first = data.jobs[0]!, original = data.locations.find(location => location.id === first.locationIds[0])!;
  const second = { ...structuredClone(original), id: "synthetic-second-office", raw: "Synthetic second office address", city: "Synthetic city", precision: "address" as const,
    coordinates: { coordinateSystem: "WGS84" as const, latitude: 40, longitude: 116 } };
  data.locations.push(second); first.locationIds.push(second.id);
  data.listings[0]!.locationIds = [...first.locationIds];
  installWorkspaceFetch(async () => sourceResponse(AtlasDatasetSchema.parse(data)));
  await render(true, false); await connectFixture();
  await flush(() => pointerDoubleClick(jobCard(first.title.value)));
  assert.ok(dom.document.querySelector('[aria-label="选择要定位的工作地点"]'));
  assert.equal(mapProps?.focus, undefined, "no arbitrary first-office focus");
  await flush(() => button(second.raw).click());
  assert.equal(mapProps?.focus?.locationId, second.id); assert.equal(mapProps?.focus?.latitude, 40);
  assert.equal(mapProps?.focus?.zoom, 16.5); assert.deepEqual(mapProps?.focus?.viewportOffset, [0, 0]);
});
function cityCandidates(request: GeocodingRequest) {
  return GeocodingResultSchema.parse({
    schemaVersion: 1, providerId: "synthetic-workspace-gazetteer", request,
    status: "candidates", reason: "ambiguous-place-name", totalCandidates: 2, truncated: false, requiresConfirmation: true,
    searchedCountryCodes: [request.countryCodes[0] ?? "CN"], datasetVersion: "synthetic-v1", warnings: ["Synthetic test candidates, not real employer offices."],
    candidates: [1, 2].map((index) => ({ id: `candidate.synthetic${index}`, providerId: "synthetic-workspace-gazetteer", matchedName: request.raw, match: "exact-alias", countryBiasMatched: false,
      precision: "city", estimated: true, coordinateMeaning: "populated-place-reference-point", verification: "unverified",
      place: { id: `place.synthetic${index}`, name: `Synthetic place ${index}`, aliases: [request.raw], sourceRecordUrl: `https://places.example.invalid/${index}`,
        countryCode: request.countryCodes[0] ?? "CN", alternateCountryCodes: [], administrativeCodes: { admin1: `synthetic-region-${index}` },
        coordinates: { latitude: 31 + index / 10, longitude: 121 + index / 10, coordinateSystem: "WGS84" }, featureCode: "PPL", population: 20000, sourceModifiedDate: "2026-10-19" },
      evidence: { shardSha256: "b".repeat(64), sourceRecordUrl: `https://places.example.invalid/${index}`, provenance: {
        datasetId: "synthetic", version: "synthetic-v1", sourceUrl: "https://places.example.invalid/data.zip", sourceArchiveSha256: "a".repeat(64),
        retrievedAt: "2026-10-19T00:00:00Z", license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "Synthetic workspace candidate fixture", coordinateSystem: "WGS84", coverage: "Finite synthetic city points.",
      } },
    })),
  });
}
function unresolvedOfficeFixture() {
  const data = searchFixture();
  data.locations.forEach((location) => { location.kind = "office"; });
  return AtlasDatasetSchema.parse(data);
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mapProps = undefined; detailData = undefined; officeProps = undefined; pauseRecovery = undefined; dom.localStorage.clear(); dom.sessionStorage.clear(); mock.restoreAll(); });
after(() => {
  hooks.deregister(); dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test("city selection uses exact matching jobs while the map still holds the complete search", async () => {
  await render();
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 22);
  const city = mapProps!.buckets.find((bucket) => bucket.label === "上海")!;
  await flush(() => mapProps!.onPick!(city));
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
  assert.ok(resultsHeading().startsWith("上海"));
  assert.equal(mapProps!.buckets.length, 22);
  await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="取消城市选择"]')!.click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 22);
});

test("domestic mode exposes only province-city-district controls and never invents a district for a city-only job", async () => {
  await render();
  await flush(() => button("国内").click());
  assert.equal(dom.document.querySelector('[aria-label="工作国家或地区"]'), null);
  assert.equal(dom.document.querySelector('[aria-label="工作城市或地区关键词"]'), null);
  const province = dom.document.querySelector<HTMLSelectElement>('[aria-label="工作省份"]')!;
  const city = dom.document.querySelector<HTMLSelectElement>('[aria-label="工作城市"]')!;
  const district = dom.document.querySelector<HTMLSelectElement>('[aria-label="工作区县"]')!;
  assert.equal(province.disabled, false); assert.equal(city.disabled, true); assert.equal(district.disabled, true);
  assert.ok([...province.options].some((option) => option.value === "44"));
  assert.ok(![...province.options].some((option) => option.value === "US"));
  await flush(() => { province.value = "44"; province.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(city.disabled, false); assert.equal(district.disabled, true);
  assert.ok([...city.options].some((option) => option.value === "4403"));
  await flush(() => { city.value = "4403"; city.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
  assert.equal(district.disabled, false);
  await flush(() => { district.value = "440305"; district.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0, "unknown district is not a match");
  await flush(() => { province.value = "11"; province.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(city.value, ""); assert.equal(district.value, ""); assert.equal(district.disabled, true);
  assert.ok(![...city.options].some((option) => option.value === "4403"));
  await flush(() => button("全球").click());
  assert.ok(dom.document.querySelector('[aria-label="工作国家或地区"]'));
  assert.equal(dom.document.querySelector('[aria-label="国内省市区筛选"]'), null);
});

test("switching workspace active state preserves search inputs and selected city", async () => {
  await render();
  const city = mapProps!.buckets.find((bucket) => bucket.label === "上海")!;
  await flush(() => mapProps!.onPick!(city));
  const before = mapMounts;
  await render(false); await render(true);
  assert.ok(mapMounts >= before);
  assert.ok(resultsHeading().startsWith("上海"));
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
});

test("sorting within a selected city keeps the city selection", async () => {
  await render();
  const city = mapProps!.buckets.find((bucket) => bucket.label === "上海")!;
  await flush(() => mapProps!.onPick!(city));
  const select = dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位排序"]')!;
  await flush(() => { select.value = "salary"; select.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.ok(resultsHeading().startsWith("上海"), resultsHeading());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
});

test("resetting the map clears a previous explicit job focus", async () => {
  await render();
  await flush(() => dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!.click());
  await flush(() => button("地图定位").click());
  assert.ok(mapProps!.focus);
  await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="重置地图视角"]')!.click());
  assert.equal(mapProps!.focus, undefined);
});

test("changing from an overseas location to domestic mode clears the foreign focus", async () => {
  await render();
  const card = [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")].find((node) => node.textContent?.includes("西雅图"))!;
  await flush(() => card.click());
  await flush(() => button("地图定位").click());
  assert.equal(mapProps!.focus!.longitude, -122.33);
  await flush(() => button("国内").click());
  assert.equal(mapProps!.mode, "domestic");
  assert.equal(mapProps!.focus, undefined);
});

test("the last street camera is passed back after workspace deactivation and does not discard city selection", async () => {
  await render();
  const city = mapProps!.buckets.find((bucket) => bucket.label === "上海")!;
  await flush(() => mapProps!.onPick!(city));
  const view = { center: [121.47, 31.23] as [number, number], zoom: 13.4, bearing: 24, pitch: 42, bounds: [121.4, 31.2, 121.5, 31.3] as [number, number, number, number] };
  await flush(() => mapProps!.onViewChange!(view));
  const before = mapMounts;
  await render(false); await render(true);
  assert.ok(mapMounts > before);
  assert.deepEqual(mapProps!.initialView, view);
  assert.ok(resultsHeading().startsWith("上海"));
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
});

test("live snapshot list loads beyond the first page and keeps loaded jobs after leaving and returning", async () => {
  const base = createAtlasDemo();
  const groups = ["companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const;
  const data = structuredClone(base);
  for (const group of groups) data[group] = [];
  for (let n = 0; n < 3; n++) {
    const renamed = new Map(groups.flatMap((group) => base[group].map((entity) => [entity.id, `${entity.id}-copy${n}`])));
    const copy = JSON.parse(JSON.stringify(base, (_key, value: unknown) => typeof value === "string" && renamed.has(value) ? renamed.get(value) : value)) as AtlasDataset;
    for (const group of groups) (data[group] as unknown[]).push(...copy[group]);
  }
  const corrected = data.companies[0]!;
  corrected.manualOverrides.push({ id: "controller-correction", field: "ultimateControllers", basedOnRevision: 0,
    at: "2026-10-18T08:00:00.000Z", reason: "合成来源证据校正，用于验证有效控股来源筛选。",
    value: { ...corrected.ultimateControllers, revision: 1, method: "manual", verification: "verified",
      value: [{ name: "合成瑞士控股方", jurisdictionCode: "CH", kind: "private" }] } });
  installWorkspaceFetch(async () => new Response(JSON.stringify({ ok: true, requestId: "workspace-live-fixture", value: AtlasDatasetSchema.parse(data) })));
  await render();
  await flush(() => button("连接本机服务").click());
  await flush(() => changeInput([...dom.document.querySelectorAll("label")].find(node => node.textContent?.startsWith("服务地址"))!.querySelector<HTMLInputElement>("input")!, "http://127.0.0.1:5178"));
  const token = dom.document.querySelector('input[type="password"]')!;
  await flush(() => { Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(token, "synthetic-fixture-token"); token.dispatchEvent(new dom.Event("input", { bubbles: true })); });
  await flush(() => button("连接并读取索引").click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 30);
  await flush(() => button("筛选").click());
  const origin = [...dom.document.querySelectorAll<HTMLSelectElement>(".atlas-filters select")].find((node) => node.parentElement?.textContent?.startsWith("控股方国家 / 地区"))!;
  assert.ok([...origin.options].some((option) => option.value === "CH"), "manual controller origin must be selectable even when absent from raw controllers");
  await flush(() => { origin.value = "CH"; origin.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, data.jobs.filter((job) => job.companyId === corrected.id).length);
  assert.ok(dom.document.querySelector(".atlas-job-classification")!.textContent!.includes("瑞士"));
  await flush(() => { origin.value = ""; origin.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 30);
  await flush(() => button("显示更多岗位").click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 60);
  await render(false); await render(true);
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 60);
  await flush(() => button("显示更多岗位").click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 66);
  assert.equal(dom.document.querySelector(".atlas-load-more"), null);
});

function pagedOfficeFixture() {
  const base = createAtlasDemo(), data = structuredClone(base);
  const groups = ["companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const;
  for (const group of groups) data[group] = [];
  for (let n = 0; n < 3; n++) {
    const renamed = new Map(groups.flatMap(group => base[group].map(entity => [entity.id, `${entity.id}-page${n}`])));
    const copy = JSON.parse(JSON.stringify(base, (_key, value: unknown) => typeof value === "string" && renamed.has(value) ? renamed.get(value) : value)) as AtlasDataset;
    for (const group of groups) (data[group] as unknown[]).push(...copy[group]);
  }
  data.jobs.forEach((job, index) => { job.title.value = `Synthetic office role ${String(index).padStart(2, "0")}`; job.workMode = "on-site"; });
  data.locations.forEach(location => { location.kind = "office"; location.countryCode = "CN"; location.city = "Shanghai"; location.precision = "city"; delete location.coordinates; });
  for (const job of data.jobs) {
    const reference = { ...structuredClone(data.locations.find(location => location.id === job.locationIds[0])!), id: `${job.id}-reference-office` };
    data.locations.push(reference); job.locationIds.push(reference.id);
    const listing = data.listings.find(value => value.id === job.listingIds[0])!; listing.locationIds = [...job.locationIds];
  }
  return AtlasDatasetSchema.parse(data);
}
async function saveSecondPageOffice(data: AtlasDataset, mutate?: (saved: AtlasDataset) => void) {
  await render(true, false); await connectFixture();
  await flush(() => button("显示更多岗位").click());
  const card = dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")[40]!;
  await flush(() => pointerClick(card, 0)); await flush(() => button("核对办公地址").click());
  await waitFor(() => Boolean(officeProps), "synthetic office panel callback");
  const props = officeProps!, saved = structuredClone(data); saved.revision++;
  const job = saved.jobs.find(value => value.id === props.jobId)!, source = saved.locations.find(value => value.id === props.location.id)!;
  const confirmed = applyOfficeAddressConfirmation(source, { id: "synthetic-page2-office", kind: "confirm", jobId: job.id, listingId: job.listingIds[0]!,
    locationId: source.id, actorScope: "synthetic-owner", at: officeAt, revision: saved.revision, reason: "Synthetic explicit office review", sourceLocation: source, proposal: officeProposal });
  saved.locations[saved.locations.indexOf(source)] = confirmed; mutate?.(saved);
  await act(async () => props.onSnapshot(AtlasDatasetSchema.parse(saved)));
  return { saved, jobId: job.id, locationId: source.id };
}

test("saved second-page office is rechecked outside pagination, remains selected after late city references, and focuses exactly once", async () => {
  const data = pagedOfficeFixture();
  const pending: Array<{ revision: number; resolve: (response: Response) => void }> = [];
  installWorkspaceFetch(async () => sourceResponse(data), async input => input.expectedRevision === data.revision ? sourceResponse(await createMapReferenceFixture(data)) : new Promise(resolve => pending.push({ revision: input.expectedRevision, resolve })));
  const saved = await saveSecondPageOffice(data);
  await waitFor(() => mapProps?.focus?.locationId === saved.locationId, "the saved second-page office focus");
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 30, "the new snapshot's first page");
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 30, "the list resets to its first page");
  assert.equal(mapProps!.selectedJobId, saved.jobId); assert.equal(mapProps!.focus!.positionBasis, "office-confirmation");
  assert.equal(detailData!.revision, saved.saved.revision); const firstRequest = mapProps!.focus!.requestId;
  await waitFor(() => pending.some(value => value.revision === saved.saved.revision), "the new snapshot's city projection");
  const batch = await createMapReferenceFixture(saved.saved);
  await act(async () => pending.find(value => value.revision === saved.saved.revision)!.resolve(sourceResponse(batch)));
  await waitFor(() => Boolean(mapProps!.buckets.some(bucket => bucket.positionBasis === "city-reference")), "late city references");
  await flush(); assert.equal(mapProps!.selectedJobId, saved.jobId); assert.equal(mapProps!.focus!.requestId, firstRequest);
  assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]'));
  await flush(() => button("显示更多岗位").click());
  const recoveredCard = dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")[40]!;
  assert.match(recoveredCard.querySelector(".atlas-job-meta")!.textContent!, /Synthetic Example Road 10, Shanghai/);
});

test("source-disclosed office street is shown directly in the job card", async () => {
  const data = createAtlasDemo(); data.locations[0]!.streetAddress = "Synthetic source street 10";
  installWorkspaceFetch(async () => sourceResponse(data)); await render(true, false); await connectFixture();
  assert.match(jobCard(data.jobs[0]!.title.value).querySelector(".atlas-job-meta")!.textContent!, /Synthetic source street 10/);
});

test("a saved job which no longer matches the active filters is never recovered", async () => {
  const data = pagedOfficeFixture(); installWorkspaceFetch(async () => sourceResponse(data));
  await render(true, false); await connectFixture();
  await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "Synthetic office role"));
  const saved = await saveSecondPageOffice(data, snapshot => { snapshot.jobs.find(job => job.id === officeProps!.jobId)!.title.value = "No longer matches"; snapshot.jobs.find(job => job.id === officeProps!.jobId)!.description = "Unrelated"; });
  await flush(); assert.equal(mapProps!.focus, undefined); assert.notEqual(mapProps!.selectedJobId, saved.jobId);
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
});

for (const action of ["filter", "identity", "inactive", "different-job", "close"] as const) test(`late saved office query is cancelled after ${action}`, async () => {
  const data = pagedOfficeFixture(); installWorkspaceFetch(async () => sourceResponse(data));
  let signal: AbortSignal | undefined, release: (() => void) | undefined;
  pauseRecovery = async value => { signal = value; await new Promise<void>(resolve => { release = resolve; }); };
  const saved = await saveSecondPageOffice(data);
  await waitFor(() => Boolean(release), "independent office query to start");
  if (action === "filter") await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "No match anywhere"));
  if (action === "identity") { await flush(() => button("连接本机服务").click()); await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('input[type="password"]')!, "different-synthetic-token")); }
  if (action === "inactive") await render(false, false);
  if (action === "different-job") { await flush(); await flush(() => pointerClick(dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!, 0)); }
  if (action === "close") {
    // The saved snapshot clears the old pane while the independent read is pending;
    // explicitly opening and closing another card must cancel that pending focus.
    await flush(); await flush(() => pointerClick(dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!, 0));
    await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭岗位详情"]')!.click());
  }
  assert.equal(signal!.aborted, true);
  await act(async () => release!()); await flush();
  assert.notEqual(mapProps?.selectedJobId, saved.jobId); assert.notEqual(mapProps?.focus?.locationId, saved.locationId);
});

for (const kind of ["remote", "unknown"] as const) test(`${kind} location facts cannot become an office focus or office choice`, async () => {
  const data = createAtlasDemo(), job = data.jobs[0]!, location = data.locations.find(value => value.id === job.locationIds[0])!;
  job.workMode = kind === "remote" ? "remote" : "on-site";
  location.kind = kind === "unknown" ? "unknown" : "office"; location.precision = "address";
  location.coordinates = { latitude: 31, longitude: 121, coordinateSystem: "WGS84" };
  installWorkspaceFetch(async () => sourceResponse(data)); await render(true, false); await connectFixture();
  await flush(() => pointerDoubleClick(jobCard(job.title.value)));
  assert.equal(mapProps!.focus, undefined); assert.equal(dom.document.querySelector('[aria-label="选择要定位的工作地点"]'), null);
  assert.match(dom.document.querySelector('[aria-label="城市定位候选"]')!.textContent!, /不能将远程资格或未知地点标成办公地址/);
});


test("explicit local view shows only saved real-source records with separate source/publication badges and never changes the private library", async () => {
  const published = createOpportunity({ company: "合成测试雇主", title: "本地来源测试岗", description: "合成测试正文", sourcePlatform: "51JOB", sourceUrl: "https://jobs.51job.com/shanghai/123456789.html", sourcePublishedAt: "2025-01-01T10:00:00+08:00", collectedAt: "2026-10-18T00:00:00Z" });
  const unknown = createOpportunity({ company: "合成测试雇主", title: "未知发布时间测试岗", description: "合成测试正文", sourcePlatform: "BOSS直聘", sourceUrl: "https://www.zhipin.com/job_detail/synthetic.html", collectedAt: "2026-10-18T00:00:00Z" });
  published.application.notes = "private fixture must stay in old library";
  const raw = JSON.stringify({ schemaVersion: 1, revision: 8, updatedAt: "2026-10-18T00:00:00Z", jobs: [published, unknown] });
  dom.localStorage.setItem(OPPORTUNITY_STORAGE_KEY, raw);
  await render(true, false);
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 2, "real-source projection");
  assert.equal(dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!.value, "local");
  const cards = [...dom.document.querySelectorAll(".atlas-job-card")];
  const old = cards.find((card) => card.textContent!.includes("本地来源测试岗"))!;
  assert.ok(old.querySelector('[data-publication-status="older"]')!.textContent!.includes("2025-01-01"));
  const noDate = cards.find((card) => card.textContent!.includes("未知发布时间测试岗"))!;
  assert.equal(noDate.querySelector('[data-publication-status="unknown"]')!.textContent, "发布时间未知");
  assert.notEqual(old.querySelector(".job-source-badge")!.getAttribute("style"), noDate.querySelector(".job-source-badge")!.getAttribute("style"));
  assert.equal(mapProps!.buckets.length, 0, "raw city labels cannot acquire invented coordinates");
  assert.equal(dom.localStorage.getItem(OPPORTUNITY_STORAGE_KEY), raw);
  assert.ok(!dom.document.querySelector(".atlas-workspace")!.textContent!.includes(published.application.notes));
});


test("leaving demo mode hides all synthetic results before the real-source query completes", async () => {
  await render();
  await flush(() => dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!.click());
  const dataView = dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!;
  await act(async () => { dataView.value = "local"; dataView.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
  assert.equal(mapProps!.buckets.length, 0);
});

function confirmedAreaFixture(confirmed: boolean): AtlasDataset {
  const data = createAtlasDemo(), job = data.jobs[0]!, location = data.locations[0]!;
  data.revision = confirmed ? 25 : 26;
  data.jobs = [job]; data.companies = data.companies.filter(company => company.id === job.companyId);
  data.locations = [{ id: location.id, raw: "上海-浦东新区（合成来源）", kind: "unknown", precision: "unknown", verification: "unverified", evidence: location.evidence,
    ...(confirmed ? { countryCode: "CN", regionId: "CN-SH", region: "上海市", city: "上海市", district: "浦东新区", precision: "city" as const,
      userResolution: { decisionId: "synthetic-active-area", method: "explicit-user-confirmation" as const, at: "2026-10-19T12:00:00.000Z", originalLocationId: location.id,
        basis: { kind: "china-catalog" as const, datasetId: "synthetic-region-catalog", version: "2023", provinceCode: "31", cityCode: "3101", districtCode: "310115" } } } : {}) }];
  data.compensations = data.compensations.filter(compensation => job.compensationIds.includes(compensation.id));
  data.listings = data.listings.filter(listing => job.listingIds.includes(listing.id));
  data.observations = data.observations.filter(observation => data.listings.some(listing => listing.id === observation.listingId));
  data.snapshots = data.snapshots.filter(snapshot => data.listings.some(listing => listing.id === snapshot.listingId));
  return AtlasDatasetSchema.parse(data);
}

async function selectConfirmedDomesticCard() {
  await render(true, false); await connectFixture(); await flush(() => button("国内").click());
  const province = dom.document.querySelector<HTMLSelectElement>('[aria-label="工作省份"]')!;
  const city = dom.document.querySelector<HTMLSelectElement>('[aria-label="工作城市"]')!;
  const district = dom.document.querySelector<HTMLSelectElement>('[aria-label="工作区县"]')!;
  await flush(() => { province.value = "31"; province.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await flush(() => { city.value = "3101"; city.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await flush(() => { district.value = "310115"; district.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
  await flush(() => pointerClick(dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!, 0));
  const detail = dom.document.querySelector('[aria-label="地图岗位详情"]'); assert.ok(detail);
  assert.match(detail.textContent!, /本人确认的行政范围.*浦东新区/);
  assert.equal(mapProps!.buckets.length, 0, "a confirmed administrative area still has no office point");
}

test("refreshing a live index after area revocation removes the domestic result and closes its cached detail", async () => {
  let revoked = false, reads = 0;
  installWorkspaceFetch(async (url: RequestInfo | URL) => {
    assert.equal(new URL(String(url)).pathname, "/api/v1/dataset/export"); reads++;
    return sourceResponse(confirmedAreaFixture(!revoked));
  });
  await selectConfirmedDomesticCard(); revoked = true;
  await flush(() => button("重新读取索引").click());
  assert.equal(reads, 2); assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.match(resultsHeading(), /0/); assert.match(dom.document.querySelector(".atlas-data-banner")!.textContent!, /索引版本 26/);
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
  assert.equal(mapProps!.selectedJobId, ""); assert.equal(mapProps!.focus, undefined);
});

test("revoking the selected area closes a now-excluded domestic detail and retains the saved outcome outside the pane", async () => {
  let revoked = false; const writes: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") return sourceResponse(confirmedAreaFixture(!revoked));
    assert.equal(path, "/api/v1/locations/confirmations/revoke");
    writes.push({ body: JSON.parse(String(init!.body)), key: new Headers(init?.headers).get("Idempotency-Key") }); revoked = true;
    const data = confirmedAreaFixture(false);
    return sourceResponse({ ok: true, revision: 26, jobId: data.jobs[0]!.id, locationId: data.locations[0]!.id,
      decisionId: "synthetic-area-revocation", location: data.locations[0] });
  });
  await selectConfirmedDomesticCard();
  await flush(() => button("核对并保存地区").click());
  await waitFor(() => Boolean(dom.document.querySelector('[aria-label="地区核对说明"]')), "the lazy area confirmation panel");
  await act(async () => {
    const reason = dom.document.querySelector('[aria-label="地区核对说明"]')!;
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(reason, "合成原文无法确认国家，撤销本人地区选择。");
    reason.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  await act(async () => dom.document.querySelector<HTMLInputElement>('.atlas-location-revoke input[type="checkbox"]')!.click());
  await flush(() => button("撤销当前地区确认").click());
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 0, "the revoked source to leave domestic search");
  assert.equal(writes.length, 1); assert.deepEqual(writes[0]!.body, { jobId: "demo-0", locationId: "demo-0-location", decisionId: "synthetic-active-area", expectedRevision: 25,
    reason: "合成原文无法确认国家，撤销本人地区选择。", reviewed: true });
  assert.match(writes[0]!.key!, /^location-revoke-/); assert.match(resultsHeading(), /0/);
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null, "cached selectedCard must not retain the revoked confirmation after its current query excludes the job");
  assert.equal(dom.document.querySelector('.atlas-job-card[aria-expanded="true"]'), null); assert.equal(mapProps!.selectedJobId, "");
  assert.match(dom.document.querySelector(".atlas-search-notice")!.textContent!, /已读取地区记录.*索引版本 26/);
  await flush(() => button("全球").click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1, "the real source record still exists globally");
  await flush(() => pointerClick(dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!, 0));
  const freshDetail = dom.document.querySelector('[aria-label="地图岗位详情"]'); assert.ok(freshDetail);
  assert.doesNotMatch(freshDetail.textContent!, /本人确认的行政范围/); assert.equal(detailData!.revision, 26);
});

test("main search without a connection opens connection settings and never sends a source or snapshot request", async () => {
  const fetcher = installWorkspaceFetch(async () => { throw new Error("An unconnected search must never request a service"); });
  await render(true, false);
  await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "C#"));
  await flush(() => button("查看后端状态").click());
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal(dom.document.querySelector(".atlas-settings h2")!.textContent, "岗位后端状态");
  assert.match(dom.document.querySelector(".atlas-search-notice")!.textContent!, /本机岗位后端当前不可用/);
  assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!.value, "C#");
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
});

test("connected main search calls the selected source with exact C# and bounded limits, then rebuilds real coverage and filters", async () => {
  const initial = searchFixture(true), updated = searchFixture();
  for (const data of [initial, updated]) data.sources.unshift({ ...data.sources[0]!, sourceId: "synthetic-other-source", attribution: { ...data.sources[0]!.attribution, label: "另一个合成来源" } });
  const requests: Array<{ path: string; body?: any; init?: RequestInit }> = [];
  let synced = false;
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body, init });
    if (path === "/api/v1/sources/atlas-demo/sync") { synced = true; return sourceResponse(sourceReceipt(body.scope)); }
    assert.equal(path, "/api/v1/dataset/export");
    return sourceResponse(synced ? updated : initial);
  });
  await render(true, false); await connectFixture();
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.equal(dom.document.querySelector<HTMLSelectElement>('[aria-label="工作国家或地区"]')!.disabled, false);
  const selectedSource = dom.document.querySelector<HTMLSelectElement>('[aria-label="搜索原始来源"]')!;
  assert.equal(selectedSource.value, "", "all enabled sources are the default");
  await flush(() => { selectedSource.value = "atlas-demo"; selectedSource.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "  C#  "));
  await flush(() => button("从来源获取岗位").click());
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 3, "source snapshot to replace the empty index and apply C# filtering");
  assert.deepEqual(requests.map((request) => request.path), ["/api/v1/dataset/export", "/api/v1/sources/atlas-demo/sync", "/api/v1/dataset/export"]);
  const request = requests[1]!;
  assert.deepEqual(request.body, { scope: { roles: ["C#"], regions: [], companyNames: [] }, maxRecords: 9, maxPages: 1 });
  const headers = new Headers(request.init!.headers);
  assert.equal(headers.get("Authorization"), "Bearer synthetic-fixture-token"); assert.ok(headers.get("Idempotency-Key"));
  assert.equal(request.init!.method, "POST");
  assert.match(dom.document.querySelector('[aria-label="真实来源读取进度"]')!.textContent!, /合成关键词来源/);
  assert.match(dom.document.querySelector(".atlas-search-notice")!.textContent!, /1\/1 个来源返回回执，原始返回 9 条/);
  assert.match(dom.document.querySelector(".atlas-search-notice")!.textContent!, /原始条数不代表匹配岗位数/);
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 3, "C++ jobs must not match C#");
  assert.ok([...dom.document.querySelectorAll(".atlas-job-card strong")].every((title) => title.textContent!.startsWith("C#")));
  assert.match(dom.document.querySelector('[aria-label="当前索引筛选覆盖"]')!.textContent!, /当前视图 22 岗/);
  assert.match(dom.document.querySelector('[aria-label="当前索引筛选覆盖"]')!.textContent!, /可比较年薪 0可计算距离 0已核实企业性质 0已定位 0/);
  assert.equal(mapProps!.buckets.length, 0);
  const sort = dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位排序"]')!;
  assert.equal([...sort.options].find((option) => option.value === "salary")!.disabled, true);
  assert.equal([...sort.options].find((option) => option.value === "distance")!.disabled, true);
  await flush(() => button("筛选").click());
  const numeric = [...dom.document.querySelectorAll<HTMLInputElement>('.atlas-filters input[type="number"]')];
  assert.equal(numeric.length, 3); assert.ok(numeric.every((input) => input.disabled));
  const ownership = dom.document.querySelector<HTMLSelectElement>('[aria-label="筛选企业性质"]')!;
  assert.ok([...ownership.options].filter((option) => ["private", "state", "joint", "dispersed"].includes(option.value)).every((option) => option.disabled));
  assert.equal([...ownership.options].find((option) => option.value === "unknown")!.disabled, false);
  const origin = [...dom.document.querySelectorAll<HTMLSelectElement>(".atlas-filters select")].find((select) => select.parentElement!.textContent!.startsWith("控股方国家 / 地区"))!;
  assert.deepEqual([...origin.options].map((option) => option.value), ["", "unknown"], "missing controller evidence never creates selectable countries");
  const region = dom.document.querySelector<HTMLSelectElement>('[aria-label="筛选工作地区"]')!;
  assert.equal(region.disabled, false); assert.ok([...region.options].some((option) => option.value === "上海"));
  await flush(() => { region.value = "上海"; region.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1, "saved city text really filters without pretending it has coordinates");
  assert.match(dom.document.querySelector(".atlas-job-card")!.textContent!, /上海/);
  await flush(() => { region.value = ""; region.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await flush(() => button("国内").click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 2, "unknown country is excluded from domestic by default");
  const unknown = dom.document.querySelector<HTMLInputElement>('.atlas-unknown-toggle input[type="checkbox"]')!;
  assert.equal(unknown.checked, false);
  await flush(() => unknown.click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 3);
  await flush(() => unknown.click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 2);
});

test("source review opens without rereading and a new search closes candidates bound to the previous query", async () => {
  let previews = 0;
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") return sourceResponse(searchFixture());
    if (path.endsWith("/preview")) { previews++; throw new Error("Opening review must not automatically reread"); }
    assert.equal(path, "/api/v1/sources/atlas-demo/sync");
    const receipt = sourceReceipt(JSON.parse(String(init!.body)).scope);
    return sourceResponse({ ...receipt, run: { ...receipt.run, summary: { ...receipt.run.summary, needsHuman: 2 } } });
  });
  await render(true, false); await connectFixture();
  await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "C#"));
  await flush(() => button("从来源获取岗位").click());
  await flush(() => button("查看 合成关键词来源 未核对候选").click());
  await waitFor(() => Boolean(dom.document.querySelector(".atlas-source-review")), "lazy candidate review");
  assert.equal(previews, 0);
  await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "Java"));
  await flush(() => button("从来源获取岗位").click());
  assert.equal(dom.document.querySelector(".atlas-source-review"), null, "C# candidates cannot appear as Java results");
  assert.equal(previews, 0);
});

test("an unknown main-search response retries the same write key and a completed refresh starts a fresh bounded request", async () => {
  const initial = searchFixture(true), updated = searchFixture();
  for (const data of [initial, updated]) { data.sources[0]!.refreshPolicy.maxRecords = 100; data.sources[0]!.refreshPolicy.maxPages = 10; }
  const writes: Array<{ body: any; key: string | null }> = []; let snapshots = 0;
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") { snapshots++; return sourceResponse(writes.length >= 2 ? updated : initial); }
    assert.equal(path, "/api/v1/sources/atlas-demo/sync");
    const body = JSON.parse(String(init!.body)); writes.push({ body, key: new Headers(init!.headers).get("Idempotency-Key") });
    if (writes.length === 1) throw new TypeError("Synthetic connection lost after source accepted the request");
    return sourceResponse(sourceReceipt(body.scope));
  });
  await render(true, false); await connectFixture();
  await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "C#"));
  await flush(() => button("从来源获取岗位").click());
  assert.equal(writes.length, 1); assert.equal(snapshots, 1);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /未收到本机服务回执/);
  assert.deepEqual(writes[0]!.body, { scope: { roles: ["C#"], regions: [], companyNames: [] }, maxRecords: 100, maxPages: 10 });
  assert.ok(writes[0]!.key);
  await flush(() => button("从来源获取岗位").click());
  assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]); assert.equal(snapshots, 2);
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 3, "the successful retry snapshot query");
  await flush(() => button("从来源获取岗位").click());
  assert.equal(writes.length, 3); assert.equal(snapshots, 3);
  assert.deepEqual(writes[2]!.body, writes[1]!.body); assert.notEqual(writes[2]!.key, writes[1]!.key);
  assert.equal(dom.document.querySelector('[role="alert"]'), null);
});

test("searching the configured employer enumerates that company and sends the selected country code unchanged", async () => {
  const data = searchFixture();
  data.sources[0]!.options = { companyName: "UniqueEmployerOnly" };
  data.companies[0]!.names = ["UniqueEmployerOnly"];
  data.locations[0]!.countryCode = "US";
  data.sources.unshift({ ...data.sources[0]!, sourceId: "synthetic-different-employer", options: { companyName: "DifferentEmployer" } });
  const writes: Array<{ scope: unknown }> = [];
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") return sourceResponse(data);
    assert.equal(path, "/api/v1/sources/atlas-demo/sync");
    const body = JSON.parse(String(init!.body)); writes.push(body); return sourceResponse(sourceReceipt(body.scope));
  });
  await render(true, false); await connectFixture();
  await flush(() => { const selectedSource = dom.document.querySelector<HTMLSelectElement>('[aria-label="搜索原始来源"]')!; selectedSource.value = "atlas-demo"; selectedSource.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await flush(() => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "  uniqueemployeronly  "));
  const country = dom.document.querySelector<HTMLSelectElement>('[aria-label="工作国家或地区"]')!;
  await flush(() => { country.value = "US"; country.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
  await flush(() => button("从来源获取岗位").click());
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.scope, { roles: [], regions: ["US"], companyNames: ["UniqueEmployerOnly"] });
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
});

test("empty index allows country and city preselection and preserves the same-location scope through fetch", async () => {
  const initial = searchFixture(true), updated = searchFixture();
  updated.locations.forEach((location) => { location.countryCode = "US"; location.city = "北京"; location.raw = "北京"; });
  updated.locations[0]!.countryCode = "CN";
  const writes: any[] = []; let synced = false;
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") return sourceResponse(synced ? updated : initial);
    assert.equal(path, "/api/v1/sources/atlas-demo/sync");
    const body = JSON.parse(String(init!.body)); writes.push(body); synced = true; return sourceResponse(sourceReceipt(body.scope));
  });
  await render(true, false);
  const country = dom.document.querySelector<HTMLSelectElement>('[aria-label="工作国家或地区"]')!;
  const city = dom.document.querySelector<HTMLInputElement>('[aria-label="工作城市或地区关键词"]')!;
  assert.equal(country.disabled, false); assert.equal(city.disabled, false);
  assert.ok([...country.options].some((entry) => entry.value === "DE"), "unindexed countries remain searchable");
  await flush(() => { country.value = "CN"; country.dispatchEvent(new dom.Event("change", { bubbles: true })); changeInput(city, "北京"); });
  await connectFixture();
  assert.equal(country.value, "CN"); assert.equal(city.value, "北京");
  await flush(() => button("从来源获取岗位").click());
  assert.deepEqual(writes[0].scope, { roles: [], regions: ["北京"], countryCodes: ["CN"], companyNames: [] });
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 1, "country AND city result");
  assert.equal(city.value, "北京");
  await flush(() => button("筛选").click());
  await flush(() => button("清除筛选").click());
  assert.equal(city.value, "");
});

test("switching data view during a source request prevents its late response from replacing the chosen view", async () => {
  const data = searchFixture();
  let releaseSync: ((response: Response) => void) | undefined;
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") return sourceResponse(data);
    assert.equal(path, "/api/v1/sources/atlas-demo/sync"); assert.ok(init?.signal);
    return new Promise<Response>((resolve) => { releaseSync = resolve; });
  });
  await render(true, false); await connectFixture();
  await act(async () => button("从来源获取岗位").click());
  await waitFor(() => Boolean(releaseSync), "the deferred source request");
  const view = dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!;
  await act(async () => { view.value = "local"; view.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(view.value, "local");
  await act(async () => releaseSync!(sourceResponse(sourceReceipt({ roles: [], regions: [], companyNames: [] }))));
  await flush();
  assert.equal(view.value, "local", "a request started in live mode must not override an explicit later view choice");
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.equal(dom.document.querySelector(".atlas-data-banner strong")!.textContent, "真实来源 · 当前机会库");
});


test("details occupy a third grid pane while the list, map instance and keyboard focus remain available", async () => {
  await render();
  const card = dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!;
  const grid = dom.document.querySelector(".atlas-main-grid")!;
  const map = grid.querySelector("[data-map-probe]");
  const list = grid.querySelector(".atlas-results");
  const before = mapMounts;
  card.focus();
  await act(async () => pointerClick(card, 0));
  const detail = dom.document.querySelector('[aria-label="地图岗位详情"]')!;
  assert.equal(detail.parentElement, grid, "the reading pane must reserve a grid column instead of floating over the map");
  assert.deepEqual([...grid.children].map(element => element.classList[0]), ["atlas-map-column", "atlas-results", "atlas-job-detail"]);
  assert.equal(grid.classList.contains("has-detail"), true);
  assert.equal(grid.querySelector("[data-map-probe]"), map); assert.equal(grid.querySelector(".atlas-results"), list);
  assert.equal(mapMounts, before, "opening the right column resizes the existing map without remounting its camera");
  assert.equal(dom.document.activeElement, card);
  await act(async () => pointerDoubleClick(card));
  assert.ok(mapProps!.focus?.requestId); assert.equal(mapProps!.selectedJobId, mapProps!.focus?.jobId);
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" })));
  assert.equal(grid.classList.contains("has-detail"), false); assert.equal(grid.children.length, 2);
  assert.equal(grid.querySelector("[data-map-probe]"), map); assert.equal(dom.document.activeElement, card);
});

test("desktop keeps a reading column and opens mouse clicks immediately without replacing the map, list or double-click target", async () => {
  mock.method(dom.HTMLElement.prototype, "getBoundingClientRect", () => new dom.DOMRect(0, 0, 1000, 600));
  await render();
  assert.equal(dom.document.querySelector(".atlas-workspace")!.getAttribute("data-pane-layout"), "wide");
  const grid = dom.document.querySelector(".atlas-main-grid")!, map = grid.querySelector("[data-map-probe]"), list = grid.querySelector(".atlas-results");
  const [first, second] = [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")];
  assert.deepEqual([...grid.children].map(element => element.classList[0]), ["atlas-map-column", "atlas-results", "atlas-detail-placeholder"]);
  assert.match(grid.children[2]!.textContent!, /单击阅读.*双击在地图中定位/);
  const mounts = mapMounts; first!.focus();
  await act(async () => pointerClick(first!, 1));
  assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]'), "desktop mouse reading must not wait for a double-click timer");
  assert.equal(grid.children.length, 3); assert.equal(grid.querySelector("[data-map-probe]"), map); assert.equal(grid.querySelector(".atlas-results"), list);
  assert.equal(dom.document.querySelector(".atlas-job-card"), first); assert.equal(dom.document.activeElement, first); assert.equal(mapProps!.focus, undefined);
  await act(async () => { pointerClick(first!, 2); first!.dispatchEvent(new dom.MouseEvent("dblclick", { bubbles: true, detail: 2 })); });
  assert.equal(mapProps!.selectedJobId, mapProps!.focus!.jobId); assert.equal(mapMounts, mounts);
  await act(async () => pointerClick(second!, 1));
  assert.equal(second!.getAttribute("aria-expanded"), "true"); assert.equal(first!.getAttribute("aria-expanded"), "false");
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" })));
  assert.deepEqual([...grid.children].map(element => element.classList[0]), ["atlas-map-column", "atlas-results", "atlas-detail-placeholder"]);
  assert.equal(grid.querySelector("[data-map-probe]"), map); assert.equal(grid.querySelector(".atlas-results"), list); assert.equal(mapMounts, mounts);
});

for (const width of [750, 390]) test(`${width}px layout delays the first mouse click while keyboard activation opens immediately`, async (t) => {
  mock.method(dom.HTMLElement.prototype, "getBoundingClientRect", () => new dom.DOMRect(0, 0, width, 600));
  await render();
  assert.equal(dom.document.querySelector(".atlas-detail-placeholder"), null, "smaller layouts must not reserve a desktop reading column");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const card = dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!;
  await act(async () => pointerClick(card, 1));
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
  assert.equal(card.getAttribute("aria-expanded"), "false");
  await act(async () => t.mock.timers.tick(519));
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null, "the first click must leave the card exposed during the double-click window");
  await act(async () => t.mock.timers.tick(1));
  assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]'));
  assert.equal(mapProps!.focus, undefined, "single click opens reading only");
  await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭岗位详情"]')!.click());
  await act(async () => pointerClick(card, 0));
  assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]'), "keyboard/assistive click is not delayed");
});

test("double-click leaves a visible map in place and scrolls to it only when the map is outside the viewport", async () => {
  mock.method(dom.HTMLElement.prototype, "getBoundingClientRect", () => new dom.DOMRect(0, 0, 1000, 600));
  const scrolling = mock.method(dom.HTMLElement.prototype, "scrollIntoView");
  await render();
  const scene = dom.document.querySelector<HTMLElement>(".atlas-scene")!, card = dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!;
  const rect = mock.method(scene, "getBoundingClientRect", () => new dom.DOMRect(10, 50, 500, 400));
  await act(async () => pointerDoubleClick(card));
  assert.ok(mapProps!.focus); assert.equal(scrolling.mock.callCount(), 0, "the desktop selection must not move a visible map and list");
  rect.mock.mockImplementation(() => new dom.DOMRect(10, 2000, 500, 400));
  await act(async () => pointerDoubleClick(card));
  assert.equal(scrolling.mock.callCount(), 1); assert.equal(scrolling.mock.calls[0]!.this, scene);
  assert.deepEqual(scrolling.mock.calls[0]!.arguments, [{ block: "center", behavior: "smooth" }]);
});

test("a map inside the browser viewport still scrolls into view when clipped by the workspace scrollport", async () => {
  mock.method(dom.HTMLElement.prototype, "getBoundingClientRect", () => new dom.DOMRect(0, 0, 1000, 600));
  const scrolling = mock.method(dom.HTMLElement.prototype, "scrollIntoView");
  await render();
  const workspace = dom.document.querySelector<HTMLElement>(".atlas-workspace")!, scene = dom.document.querySelector<HTMLElement>(".atlas-scene")!;
  const card = dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!;
  mock.method(workspace, "getBoundingClientRect", () => new dom.DOMRect(100, 100, 900, 500));
  const rect = mock.method(scene, "getBoundingClientRect", () => new dom.DOMRect(120, 10, 500, 50));
  const clipped = [new dom.DOMRect(120, 10, 500, 50), new dom.DOMRect(120, 650, 500, 30),
    new dom.DOMRect(10, 120, 50, 400), new dom.DOMRect(1005, 120, 10, 400)];
  for (const [index, bounds] of clipped.entries()) {
    rect.mock.mockImplementation(() => bounds);
    await act(async () => pointerDoubleClick(card));
    assert.equal(scrolling.mock.callCount(), index + 1, "a window intersection must not hide workspace clipping on any edge");
    assert.equal(scrolling.mock.calls[index]!.this, scene);
  }
  rect.mock.mockImplementation(() => new dom.DOMRect(120, 50, 500, 100));
  await act(async () => pointerDoubleClick(card));
  assert.equal(scrolling.mock.callCount(), clipped.length, "a map still partly visible inside both rectangles keeps the user's scroll position");
});

for (const position of ["city-reference", "city-coordinate", "address"] as const) test(`published street takes priority over ${position} during live job location`, async () => {
  const data = unresolvedOfficeFixture(), location = data.locations[0]!;
  location.streetAddress = "Synthetic published office street 10";
  if (position !== "city-reference") {
    location.coordinates = { latitude: 31.2, longitude: 121.4, coordinateSystem: "WGS84" };
    location.precision = position === "address" ? "address" : "city";
  }
  const references = await createMapReferenceFixture(data), before = structuredClone(data), routes: string[] = [];
  installWorkspaceFetch(async (url: RequestInfo | URL) => { const path = new URL(String(url)).pathname; routes.push(path);
    assert.equal(path, "/api/v1/dataset/export", "locating a source address must not guess an office point or write to the index"); return sourceResponse(data);
  }, () => sourceResponse(references));
  await render(true, false); await connectFixture();
  await flush(() => pointerDoubleClick(jobCard(data.jobs[0]!.title.value)));
  if (position === "address") {
    assert.equal(officeProps, undefined, "a usable address point can be focused directly");
    assert.equal(mapProps!.focus!.locationId, location.id); assert.equal(mapProps!.focus!.zoom, 16.5);
  } else {
    await waitFor(() => Boolean(officeProps), "the published street to open office review instead of a coarse focus");
    assert.equal(officeProps!.location.streetAddress, location.streetAddress); assert.equal(mapProps!.focus, undefined);
  }
  assert.deepEqual(routes, ["/api/v1/dataset/export"]); assert.deepEqual(data, before);
});

test("a detail=1, detail=2 and dblclick event sequence focuses once and never reopens after closing", async (t) => {
  await render();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const card = dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!;
  await act(async () => pointerClick(card, 1));
  await act(async () => t.mock.timers.tick(200));
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
  await act(async () => { pointerClick(card, 2); card.dispatchEvent(new dom.MouseEvent("dblclick", { bubbles: true, detail: 2 })); });
  assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]'), "the second click must not toggle details shut");
  assert.equal(mapProps!.selectedJobId, mapProps!.focus?.jobId);
  assert.ok(mapProps!.focus?.requestId);
  const previousRequest = mapProps!.focus!.requestId;
  await act(async () => pointerDoubleClick(card));
  assert.notEqual(mapProps!.focus!.requestId, previousRequest, "repeat double click can re-focus the same job");
  await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭岗位详情"]')!.click());
  await act(async () => t.mock.timers.tick(1000));
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null, "a leftover first-click task cannot reopen the pane");
  assert.equal(mapProps!.selectedJobId, ""); assert.equal(mapProps!.focus, undefined);
});

test("closing an existing pane cancels a pending first click on another card", async (t) => {
  await render();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const [first, second] = [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-card")];
  await act(async () => pointerClick(first!, 0));
  await act(async () => pointerClick(second!, 1));
  await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭岗位详情"]')!.click());
  await act(async () => t.mock.timers.tick(600));
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
  assert.equal(mapProps!.selectedJobId, "");
});

for (const cancellation of ["filter", "data-mode", "inactive"] as const) {
  test(`${cancellation} cancels a pending first pointer click before it can select a stale job`, async (t) => {
    await render();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const card = dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!;
    await act(async () => pointerClick(card, 1));
    if (cancellation === "filter") await act(async () => changeInput(dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]')!, "NO_SYNTHETIC_JOB_SHOULD_MATCH"));
    else if (cancellation === "data-mode") await act(async () => {
      const view = dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!;
      view.value = "local"; view.dispatchEvent(new dom.Event("change", { bubbles: true }));
    });
    else await render(false);
    await act(async () => t.mock.timers.tick(600));
    assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
    assert.equal(dom.document.querySelector('.atlas-job-card[aria-expanded="true"]'), null);
    assert.equal(mapProps!.selectedJobId, "");
  });
}

test("unmount explicitly clears the scheduled pointer intent", async (t) => {
  await render();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = t.mock.method(globalThis, "setTimeout"); const cleared = t.mock.method(globalThis, "clearTimeout");
  await act(async () => pointerClick(dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!, 1));
  const pending = scheduled.mock.calls.find((call) => call.arguments[1] === 520);
  assert.ok(pending, "the real click scheduled a bounded reading intent");
  await act(async () => root!.unmount()); root = undefined;
  assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === pending.result), "cleanup must cancel the real scheduled handle");
  await act(async () => t.mock.timers.tick(600));
  assert.equal(dom.document.querySelector(".atlas-workspace"), null);
});

test("unresolved office double-click queries once, requires explicit city choice and never changes the canonical dataset", async () => {
  const data = unresolvedOfficeFixture(); const requests: GeocodingRequest[] = [];
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") return sourceResponse(data);
    assert.equal(path, "/api/v1/locations/geocode-candidates", "candidate browsing performs no source or location write");
    const request = GeocodingRequestSchema.parse(JSON.parse(String(init!.body))); requests.push(request);
    return sourceResponse(cityCandidates(request));
  });
  await render(true, false); await connectFixture();
  await flush(() => pointerDoubleClick(jobCard("C# 合成工程师 0")));
  assert.equal(requests.length, 1, "click2 and dblclick must not both query geocoding");
  assert.equal(requests[0]!.raw, "上海"); assert.deepEqual(requests[0]!.countryCodes, ["CN"]); assert.equal(requests[0]!.kind, "office");
  assert.equal(mapProps!.focus, undefined, "even a returned candidate cannot automatically become an office point");
  const candidates = dom.document.querySelector('[aria-label="城市定位候选"]')!;
  assert.ok(candidates); assert.match(candidates.textContent!, /仅用于本次地图浏览.*不会写入岗位地址/);
  const choices = candidates.querySelectorAll<HTMLButtonElement>("button"); assert.equal(choices.length, 2);
  assert.match(choices[1]!.textContent!, /城市估算.*非办公地址/);
  assert.ok(detailData); const canonical = structuredClone(detailData);
  await flush(() => choices[1]!.click());
  assert.equal(mapProps!.focus!.jobId, data.jobs[0]!.id); assert.equal(mapProps!.focus!.locationId, data.locations[0]!.id);
  assert.equal(mapProps!.focus!.latitude, 31.2); assert.equal(mapProps!.focus!.longitude, 121.2);
  assert.equal(mapProps!.focus!.precision, "city"); assert.equal(mapProps!.focus!.estimated, true); assert.equal(mapProps!.focus!.verification, "unverified");
  assert.deepEqual(detailData, canonical, "transient choice must not alter coordinates, precision, evidence or other canonical facts");
  assert.equal(mapProps!.buckets.length, 0, "an estimated focus is not an indexed job marker");
  await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="重置地图视角"]')!.click());
  assert.equal(mapProps!.focus, undefined); assert.deepEqual(detailData, canonical);
});

test("live city distribution references share the real filters and bucket selection, and double-click focuses at city precision without a geocoding request", async () => {
  const data = searchFixture(), before = structuredClone(data), batch = await createMapReferenceFixture(data);
  let mapReads = 0; const routes: string[] = [];
  installWorkspaceFetch(async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname; routes.push(path); assert.equal(path, "/api/v1/dataset/export"); return sourceResponse(data);
  }, input => { mapReads++; assert.equal(input.expectedRevision, data.revision); return sourceResponse(batch); });
  await render(true, false); await connectFixture();
  assert.equal(mapReads, 1); assert.ok(mapProps!.buckets.length > 0); assert.equal(mapProps!.buckets.every(bucket => bucket.positionBasis === "city-reference"), true);
  assert.match(dom.document.querySelector('[aria-label="地图位置口径"]')!.textContent!, /有效岗位坐标 0 岗.*城市分布参考 21 岗.*不参与离家距离/);
  const keyword = dom.document.querySelector<HTMLInputElement>('[aria-label="搜索地图岗位"]'); assert.ok(keyword);
  await flush(() => changeInput(keyword, "C#"));
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 3); assert.equal(mapReads, 1, "filters reuse this snapshot's projection");
  assert.equal(mapProps!.buckets.reduce((count, bucket) => count + bucket.jobCount, 0), 2);
  assert.match(dom.document.querySelector('[aria-label="地图位置口径"]')!.textContent!, /城市分布参考 2 岗/);
  await flush(() => pointerDoubleClick(jobCard("C# 合成工程师 0")));
  assert.equal(mapProps!.focus!.positionBasis, "city-reference"); assert.equal(mapProps!.focus!.precision, "city"); assert.equal(mapProps!.focus!.zoom, 9);
  assert.match(dom.document.querySelector('[aria-label="地图岗位详情"]')!.textContent!, /城市级估算，非办公地址；不用于离家距离.*地名数据出处/s);
  assert.deepEqual(routes, ["/api/v1/dataset/export"]); assert.deepEqual(detailData, before);
  const city = mapProps!.buckets.find(bucket => bucket.label === "上海")!; assert.ok(city);
  await flush(() => mapProps!.onPick!(city)); assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 1);
  assert.ok(resultsHeading().startsWith("上海")); assert.equal(mapProps!.buckets.length, 2, "selected list remains a subset of the base map query");
  assert.equal(mapReads, 1); assert.deepEqual(data, before);
  await render(false, false); await render(true, false);
  assert.equal(mapReads, 1, "completed references reuse the same snapshot cache after activation");
  assert.equal(mapProps!.selectedBucketId, undefined); assert.equal(mapProps!.focus, undefined); assert.equal(mapProps!.selectedJobId, "");
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 3, "a retired city-reference bucket must not continue filtering the list");
});

test("city-reference errors preserve the live list and explicit retry adds estimates without reconnecting or writing jobs", async () => {
  const data = unresolvedOfficeFixture(), batch = await createMapReferenceFixture(data); let reads = 0, snapshots = 0;
  installWorkspaceFetch(async (url: RequestInfo | URL) => {
    assert.equal(new URL(String(url)).pathname, "/api/v1/dataset/export"); snapshots++; return sourceResponse(data);
  }, () => ++reads === 1 ? new Response(JSON.stringify({ ok: false, requestId: "synthetic-missing-map-route", error: { code: "not-found", message: "Private service text" } }), { status: 404 }) : sourceResponse(batch));
  await render(true, false); await connectFixture();
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 22); assert.equal(mapProps!.buckets.length, 0);
  assert.match(dom.document.body.textContent!, /尚不支持城市分布参考.*更新并重启/); assert.doesNotMatch(dom.document.body.textContent!, /Private service text/);
  await flush(() => button("重新读取城市参考").click()); assert.equal(reads, 2); assert.equal(snapshots, 1);
  assert.ok(mapProps!.buckets.some(bucket => bucket.positionBasis === "city-reference"));
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 22);
});

test("switching jobs and closing details abort geocoding and suppress both late responses", async () => {
  const data = unresolvedOfficeFixture();
  const pending: Array<{ request: GeocodingRequest; signal: AbortSignal; resolve: (response: Response) => void }> = [];
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") return sourceResponse(data);
    assert.equal(path, "/api/v1/locations/geocode-candidates");
    const request = GeocodingRequestSchema.parse(JSON.parse(String(init!.body)));
    return new Promise<Response>((resolve) => pending.push({ request, signal: init!.signal as AbortSignal, resolve }));
  });
  await render(true, false); await connectFixture();
  await act(async () => pointerDoubleClick(jobCard("C# 合成工程师 0")));
  await waitFor(() => pending.length === 1, "the first city request");
  assert.equal(pending[0]!.signal.aborted, false);
  await act(async () => pointerClick(jobCard("C# 合成工程师 1"), 0));
  assert.equal(pending[0]!.signal.aborted, true);
  assert.match(dom.document.querySelector(".atlas-job-detail h2")!.textContent!, /合成工程师 1/);
  await act(async () => pending[0]!.resolve(sourceResponse(cityCandidates(pending[0]!.request))));
  assert.equal(dom.document.querySelector('[aria-label="城市定位候选"]'), null, "the old response cannot appear in another job's pane");
  assert.equal(mapProps!.focus, undefined);
  await act(async () => button("查找城市位置").click());
  await waitFor(() => pending.length === 2, "the replacement city's request");
  await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭岗位详情"]')!.click());
  assert.equal(pending[1]!.signal.aborted, true);
  await act(async () => pending[1]!.resolve(sourceResponse(cityCandidates(pending[1]!.request))));
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
  assert.equal(dom.document.querySelector('[aria-label="城市定位候选"]'), null);
  assert.equal(mapProps!.focus, undefined); assert.equal(mapProps!.selectedJobId, "");
});

test("default aggregate search exposes fast source results before a slow source returns, and cancellation preserves them", async () => {
  const initial = searchFixture(true), updated = searchFixture();
  for (const dataset of [initial, updated]) dataset.sources.unshift({ ...dataset.sources[0]!, sourceId: "synthetic-slow", attribution: { ...dataset.sources[0]!.attribution, label: "慢速合成来源" } });
  const writes: string[] = []; let synced = false;
  installWorkspaceFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/v1/dataset/export") return sourceResponse(synced ? updated : initial);
    writes.push(path);
    if (path === "/api/v1/sources/synthetic-slow/sync") return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    assert.equal(path, "/api/v1/sources/atlas-demo/sync"); synced = true;
    return sourceResponse(sourceReceipt({ roles: [], regions: [], companyNames: [] }));
  });
  await render(true, false); await connectFixture();
  await act(async () => button("从来源获取岗位").click());
  await waitFor(() => dom.document.querySelectorAll(".atlas-job-card").length === 22, "the fast source to publish while the slow source is pending");
  assert.equal(writes.length, 2); assert.equal(button("从来源获取岗位").disabled, true);
  assert.ok(dom.document.querySelector('[aria-busy="true"]'));
  await flush(() => button("取消等待").click());
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 22, "cancel must keep confirmed results");
  assert.match(dom.document.querySelector(".atlas-search-notice")!.textContent!, /已停止等待/);
});


test("an empty real opportunity library offers acquisition instead of a vacant reading column or clear-only loop", async () => {
  const external = mock.method(globalThis, "fetch", async () => { throw new Error("No external request before explicit connection"); });
  await render(true, false);
  await waitFor(() => !!dom.document.querySelector(".atlas-main-grid.is-empty-index"), "empty local projection");
  assert.equal(dom.document.querySelectorAll(".atlas-job-card").length, 0);
  assert.equal(dom.document.querySelector(".atlas-detail-placeholder"), null);
  assert.match(dom.document.querySelector(".atlas-empty")!.textContent!, /先把真实岗位接入地图/);
  assert.ok(button("查看后端状态"));
  assert.equal([...dom.document.querySelectorAll(".atlas-empty button")].some(node => node.textContent === "清除筛选"), false);
  await flush(() => button("查看后端状态").click());
  assert.ok(dom.document.querySelector(".atlas-settings input[type=password]"));
  assert.equal(external.mock.callCount(), 0, "opening connection never collects or fabricates jobs");
  assert.equal(dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!.value, "local");
});

test("selecting the live view requests the default backend and keeps connection failure actionable", async () => {
  const external = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external request"); });
  await render(true, false);
  const view = dom.document.querySelector<HTMLSelectElement>('[aria-label="岗位数据视图"]')!;
  assert.ok([...view.options].some(option => option.value === "live"));
  await flush(() => { view.value = "live"; view.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  assert.equal(external.mock.callCount(), 1);
  assert.equal(view.value, "live");
  assert.match(dom.document.querySelector(".atlas-empty")!.textContent!, /岗位数量未知/);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /默认后端不可用/);
});

test("desktop batches occupy only the reading column and leave the card's native single and double click targets stable", async () => {
  mock.method(dom.HTMLElement.prototype, "getBoundingClientRect", () => new dom.DOMRect(0, 0, 1100, 650));
  const routes: string[] = [], data = createAtlasDemo();
  installWorkspaceFetch(async url => { routes.push(new URL(String(url)).pathname); return sourceResponse(data); });
  await render(true, false); await connectFixture();
  const grid = dom.document.querySelector(".atlas-main-grid")!, map = grid.querySelector("[data-map-probe]");
  const list = grid.querySelector<HTMLElement>(".atlas-job-list")!, listPane = grid.querySelector(".atlas-results");
  const first = dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!, mounts = mapMounts;
  const readCount = routes.length; list.scrollTop = 87;
  await flush(() => button("补全当前结果办公地点").click());
  await waitFor(() => !!dom.document.querySelector('[aria-label="关闭批量地址核对"]'), "batch reading column");
  const pane = dom.document.querySelector('[aria-label="岗位办公地点批量核对面板"]')!;
  assert.equal(pane.parentElement, grid); assert.equal(pane.id, "atlas-job-detail");
  assert.deepEqual([...grid.children].map(element => element.classList[0]), ["atlas-map-column", "atlas-results", "atlas-job-detail"]);
  assert.equal(grid.querySelector("[data-map-probe]"), map); assert.equal(grid.querySelector(".atlas-results"), listPane);
  assert.equal(list.scrollTop, 87); assert.equal(mapMounts, mounts);
  assert.equal(routes.length, readCount, "opening the review is inert until explicit source reading");
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null);
  assert.equal(dom.document.querySelector('.atlas-detail-placeholder'), null);
  first.focus(); await act(async () => pointerClick(first, 1));
  assert.equal(dom.document.querySelector('[aria-label="岗位办公地点批量核对面板"]'), null);
  assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]'));
  assert.equal(dom.document.querySelector(".atlas-job-card"), first); assert.equal(dom.document.activeElement, first);
  await act(async () => { pointerClick(first, 2); first.dispatchEvent(new dom.MouseEvent("dblclick", { bubbles: true, detail: 2 })); });
  assert.ok(mapProps!.focus?.requestId); assert.equal(mapProps!.selectedJobId, mapProps!.focus!.jobId);
  assert.equal(grid.querySelector("[data-map-probe]"), map); assert.equal(grid.querySelector(".atlas-results"), listPane);
  assert.equal(list.scrollTop, 87); assert.equal(mapMounts, mounts);
});

test("batch Escape and explicit close restore the reserved desktop reading pane", async () => {
  mock.method(dom.HTMLElement.prototype, "getBoundingClientRect", () => new dom.DOMRect(0, 0, 1100, 650));
  installWorkspaceFetch(async () => sourceResponse(createAtlasDemo()));
  await render(true, false); await connectFixture();
  const grid = dom.document.querySelector(".atlas-main-grid")!, map = grid.querySelector("[data-map-probe]"), mounts = mapMounts;
  await flush(() => button("补全当前结果办公地点").click());
  await waitFor(() => !!dom.document.querySelector('[aria-label="关闭批量地址核对"]'), "batch close action");
  const consumed = new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true }); consumed.preventDefault();
  await act(async () => dom.dispatchEvent(consumed));
  assert.ok(dom.document.querySelector('[aria-label="岗位办公地点批量核对面板"]'), "an inner control can consume Escape");
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
  assert.ok(dom.document.querySelector('[aria-label="岗位办公地点批量核对面板"]'), "IME cancellation keeps the pane");
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" })));
  assert.equal(dom.document.querySelector('[aria-label="岗位办公地点批量核对面板"]'), null);
  assert.ok(grid.querySelector(".atlas-detail-placeholder")); assert.equal(grid.children.length, 3);
  await flush(() => button("补全当前结果办公地点").click());
  await waitFor(() => !!dom.document.querySelector('[aria-label="关闭批量地址核对"]'), "batch reopen");
  await flush(() => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭批量地址核对"]')!.click());
  assert.ok(grid.querySelector(".atlas-detail-placeholder")); assert.equal(grid.children.length, 3);
  assert.equal(grid.querySelector("[data-map-probe]"), map); assert.equal(mapMounts, mounts);
});

test("entering a batch cancels an earlier in-flight office focus instead of moving its map after review begins", async () => {
  const data = pagedOfficeFixture(); installWorkspaceFetch(async () => sourceResponse(data));
  let signal: AbortSignal | undefined, release: (() => void) | undefined;
  pauseRecovery = async value => { signal = value; await new Promise<void>(resolve => { release = resolve; }); };
  const saved = await saveSecondPageOffice(data);
  await waitFor(() => Boolean(release), "earlier independent office focus query");
  await flush();
  await flush(() => button("补全当前结果办公地点").click());
  await waitFor(() => !!dom.document.querySelector('[aria-label="关闭批量地址核对"]'), "next batch review");
  assert.equal(signal!.aborted, true, "the explicit next review supersedes a prior pending focus");
  await act(async () => release!()); await flush();
  assert.notEqual(mapProps?.focus?.locationId, saved.locationId);
  assert.ok(dom.document.querySelector('[aria-label="岗位办公地点批量核对面板"]'));
});

test("a batch's exact saved office is rechecked and highlighted while its reading column and map stay mounted", async () => {
  mock.method(dom.HTMLElement.prototype, "getBoundingClientRect", () => new dom.DOMRect(0, 0, 1100, 650));
  const data = createAtlasDemo();
  data.jobs.forEach(job => { job.workMode = "on-site"; });
  data.locations.forEach((location, index) => { location.kind = "office"; location.precision = "address";
    location.coordinates = { latitude: 31 + index / 1000, longitude: 121 + index / 1000, coordinateSystem: "WGS84" }; });
  installWorkspaceFetch(async (url, init) => {
    if (new URL(String(url)).pathname !== "/api/v1/jobs/address-enrichment/plan") return sourceResponse(data);
    const input = JSON.parse(String(init!.body)) as { jobIds: string[]; expectedRevision: number };
    const items = input.jobIds.map(id => {
      const job = data.jobs.find(value => value.id === id)!, company = data.companies.find(value => value.id === job.companyId)!;
      return { jobId: id, title: job.title.value, companyId: company.id, companyName: company.names[0]!, status: "office-ready" as const,
        currentOffice: data.locations.filter(location => job.locationIds.includes(location.id)), pendingLocationIds: [], sourceStreetTargets: [],
        exactPlatformTargets: [], ownedOfficialTargets: [], companyLookup: { companyName: company.names[0]!, association: "unverified" as const, strength: "weak" as const },
        truncated: false, warnings: [] };
    });
    const plan: AddressEnrichmentPlan = { schemaVersion: 1, snapshotRevision: input.expectedRevision, requestedJobs: items.length,
      processedJobs: items.length, truncated: false, items, warnings: [] };
    return sourceResponse(plan);
  });
  await render(true, false); await connectFixture();
  const grid = dom.document.querySelector(".atlas-main-grid")!, map = grid.querySelector("[data-map-probe]"), mounts = mapMounts;
  await flush(() => button("补全当前结果办公地点").click());
  await waitFor(() => !!dom.document.querySelector('[aria-label="关闭批量地址核对"]'), "batch reading");
  await flush(() => button("读取所选岗位的办公地点").click());
  await flush(() => button("核对具体办公点").click());
  await waitFor(() => Boolean(officeProps), "batch nested office review");
  const props = officeProps!, saved = structuredClone(data); saved.revision++;
  const job = saved.jobs.find(value => value.id === props.jobId)!, source = saved.locations.find(value => value.id === props.location.id)!;
  saved.locations[saved.locations.indexOf(source)] = applyOfficeAddressConfirmation(source, { id: "synthetic-batch-office-save", kind: "confirm",
    jobId: job.id, listingId: job.listingIds[0]!, locationId: source.id, actorScope: "synthetic-owner", at: officeAt, revision: saved.revision,
    reason: "Synthetic batch explicit office review", sourceLocation: source, proposal: officeProposal });
  await act(async () => props.onSnapshot(AtlasDatasetSchema.parse(saved)));
  await waitFor(() => mapProps?.focus?.locationId === source.id, "batch saved office focus");
  assert.equal(mapProps!.focus!.jobId, job.id); assert.equal(mapProps!.focus!.zoom, 16.5);
  assert.equal(mapProps!.focus!.positionBasis, "office-confirmation"); assert.equal(mapProps!.selectedJobId, job.id);
  assert.equal(mapProps!.focus!.latitude, officeProposal.coordinates.latitude);
  assert.equal(mapProps!.focus!.longitude, officeProposal.coordinates.longitude);
  assert.ok(dom.document.querySelector('[aria-label="岗位办公地点批量核对面板"]'));
  assert.equal(grid.querySelector("[data-map-probe]"), map); assert.equal(mapMounts, mounts); assert.equal(grid.children.length, 3);
});
