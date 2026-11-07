import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLSelectElement, type HTMLTextAreaElement } from "happy-dom";
import type { AtlasDataset, JobLocation, LocationConfirmationPreview, PreviewLocationConfirmationInput } from "@better-me/opportunities";
import { ReviewedCardsCaptureSchema, type ReviewedCardsCapture, type ReviewedCardsPreview } from "@better-me/source-adapters/browser-contracts";
import type { AtlasReviewedCardImportProps } from "../src/components/atlas/AtlasReviewedCardImport.tsx";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";

const dom = new Window({ url: "http://reviewed-card-fixture.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { AtlasReviewedCardImport } = await import("../src/components/atlas/AtlasReviewedCardImport.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const at = "2026-10-19T12:00:00.000Z";
const pageUrl = "https://www.liepin.com/zhaopin/?key=C%23&city=020";
const previewPath = "/api/v1/jobs/reviewed-cards/preview";
const importPath = "/api/v1/jobs/reviewed-cards/import";
const snapshotPath = "/api/v1/dataset/export";
const previewLabel = "预览入库变化";
const importLabel = "确认加入统一索引";
const retryLabel = "重试本次写入 · 核对回执";
const locationLabel = "核对该岗位地区";
const locationPreviewPath = "/api/v1/locations/confirmations/preview";
const locationConfirmPath = "/api/v1/locations/confirmations";
const snapshot = { ...createAtlasDemo(), revision: 12 };
const receipt = { ok: true, revision: 12, jobIds: ["synthetic-reviewed-job"], snapshotIds: ["synthetic-reviewed-snapshot"],
  counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 1 } };

function capture(id = "1234567890"): ReviewedCardsCapture {
  const url = `https://www.liepin.com/job/${id}.shtml`, title = `Synthetic C# Engineer ${id}`, company = "Synthetic Employer";
  return ReviewedCardsCaptureSchema.parse({ provider: "liepin", pageUrl, capturedAt: at, cards: [{
    platform: "猎聘", url, title, company, cardText: `${title} ${company} 卡片可见摘要，没有读取完整任职要求。`,
    evidence: { pageUrl, cardSelector: ".job-card-pc-container", fields: [
      { field: "url", selector: "a[href]", text: url }, { field: "title", selector: ".job-title", text: title },
      { field: "company", selector: ".company-name", text: company },
    ] },
  }] });
}
function preview(value = capture(), revision = 11): ReviewedCardsPreview {
  return { expectedRevision: revision, previewFingerprint: "a".repeat(64), sourceId: "synthetic-reviewed-source", completeness: "excerpt", availability: "unknown",
    cards: value.cards.map(card => ({ jobId: "synthetic-reviewed-job", listingId: "synthetic-reviewed-listing", url: card.url, title: card.title, company: card.company, existing: false })),
    warnings: ["Synthetic card excerpt only; vacancy, salary and location remain unverified."] };
}
function fixture(): AtlasReviewedCardImportProps {
  return { endpoint: "http://127.0.0.1:5178", token: "synthetic-review-token", capture: capture(), revision: 11, onClose: () => {}, onSnapshot: () => {} };
}
type Call = { path: string; init?: RequestInit; body?: Record<string, unknown>; key: string | null };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-reviewed-request", value }));
function installFetch(handler?: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: new URL(String(url)).pathname, init, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), key: new Headers(init?.headers).get("Idempotency-Key") };
    calls.push(call);
    if (handler) return handler(call, calls);
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) return response(receipt);
    if (call.path === snapshotPath) return response(snapshot);
    throw new Error(`Unexpected synthetic route: ${call.path}`);
  });
  return calls;
}
async function render(props: AtlasReviewedCardImportProps) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasReviewedCardImport, props)));
}
function button(label: string) {
  const entry = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  assert.ok(entry, `Missing button: ${label}`); return entry;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function confirm() {
  const checkbox = dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(checkbox);
  await act(async () => checkbox.click());
}
async function close() { await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭卡片入库核对"]')!.click()); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const locationSection = () => dom.document.querySelector('[aria-label="核对并保存岗位地区"]');
async function openLocation() {
  await click(locationLabel);
  // The first real interaction loads the optional confirmation component.
  await act(async () => { await import("../src/components/atlas/AtlasLocationConfirmation.tsx"); });
  assert.ok(locationSection());
}
async function changeLocation(label: string, value: string) {
  const entry = locationSection()!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); assert.ok(entry);
  await act(async () => {
    const prototype = entry.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : entry.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value);
    entry.dispatchEvent(new dom.Event(entry.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function selectShanghai() {
  await changeLocation("确认国家地区", "CN"); await changeLocation("确认省级地区", "31"); await changeLocation("确认城市", "3101");
  await changeLocation("确认区县", "310115"); await changeLocation("确认地点性质", "office"); await changeLocation("地区核对说明", "已核对合成岗位原文，披露上海浦东，未披露办公坐标。");
}
async function confirmLocation() {
  const checkbox = locationSection()!.querySelector<HTMLInputElement>('.atlas-location-preview input[type="checkbox"]'); assert.ok(checkbox);
  await act(async () => checkbox.click()); await click("确认保存地区");
}
function importedSnapshot(revision = 12): AtlasDataset {
  const base = createAtlasDemo(), originalId = base.jobs[0]!.id;
  return { ...base, revision,
    jobs: base.jobs.map(job => job.id === originalId ? { ...job, id: receipt.jobIds[0]! } : job),
    listings: base.listings.map(listing => listing.canonicalJobId === originalId ? { ...listing, canonicalJobId: receipt.jobIds[0]! } : listing),
    locations: base.locations.map((location, i) => i === 0 ? { id: location.id, raw: "上海-浦东新区", kind: "unknown", precision: "unknown", verification: "unverified", evidence: location.evidence } : location),
  };
}
function resolvedLocation(original: JobLocation): JobLocation {
  return { ...original, countryCode: "CN", regionId: "CN-SH", region: "上海市", city: "上海市", district: "浦东新区", kind: "office", precision: "city",
    userResolution: { decisionId: "synthetic-reviewed-location-decision", method: "explicit-user-confirmation", at, originalLocationId: original.id,
      basis: { kind: "china-catalog", datasetId: "synthetic-catalog", version: "2023", provinceCode: "31", cityCode: "3101", districtCode: "310115" } } };
}
function locationPreview(input: PreviewLocationConfirmationInput, original = importedSnapshot().locations[0]!): LocationConfirmationPreview {
  return { expectedRevision: input.expectedRevision, previewFingerprint: "b".repeat(64), jobId: input.jobId, locationId: input.locationId,
    original, current: original, proposed: resolvedLocation(original), warnings: ["Synthetic administrative confirmation does not create office coordinates."] };
}
async function importCards(props = fixture()) { await render(props); await click(previewLabel); await confirm(); await click(importLabel); }
async function clean() { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); dom.document.body.replaceChildren(); }

afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined;
  mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren();
});
after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("mount and configuration changes are inert; unknown fields stay unknown and original excerpts remain plain text", async () => {
  const calls = installFetch(), props = fixture(), before = structuredClone(props.capture);
  props.capture.cards[0]!.cardText += ' <script>syntheticUnsafe()</script><img src=x onerror="bad()">';
  const renderedCapture = structuredClone(props.capture);
  await render(props); await render({ ...props, revision: 99, token: "synthetic-next-token" });
  assert.equal(calls.length, 0); assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent === importLabel), false);
  assert.match(dom.document.body.textContent!, /地点未披露.*薪资未披露.*发布时间未知/s);
  assert.match(dom.document.body.textContent!, /待核实的卡片摘录/);
  assert.equal(dom.document.querySelector("script,img"), null);
  assert.match(dom.document.querySelector("pre")!.textContent!, /<script>/);
  const original = dom.document.querySelector("article a")!;
  assert.equal(original.getAttribute("href"), before.cards[0]!.url); assert.equal(original.getAttribute("target"), "_blank");
  assert.equal(original.getAttribute("rel"), "noopener noreferrer");
  assert.equal(dom.document.body.textContent!.includes(props.token), false);
  assert.deepEqual(props.capture, renderedCapture);
});

test("only an explicit preview and checkbox allow import; success refreshes the strict snapshot once without upgrading card evidence", async () => {
  const calls = installFetch(), props = fixture(), snapshots: AtlasDataset[] = [];
  props.onSnapshot = value => { snapshots.push(value); };
  await render(props); await click(previewLabel);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.path, previewPath); assert.equal(calls[0]!.key, null);
  assert.deepEqual(calls[0]!.body, { ...props.capture, expectedRevision: 11 });
  assert.equal(button(importLabel).disabled, true);
  await click(importLabel); assert.equal(calls.length, 1);
  await confirm(); assert.equal(button(importLabel).disabled, false);
  await click(importLabel);
  assert.deepEqual(calls.map(call => call.path), [previewPath, importPath, snapshotPath]);
  assert.deepEqual(calls[1]!.body, { ...props.capture, expectedRevision: 11, previewFingerprint: "a".repeat(64), reviewed: true });
  assert.match(calls[1]!.key!, /^review-/);
  assert.equal(calls[1]!.init?.method, "POST"); assert.equal(calls[1]!.init?.credentials, "omit");
  assert.equal(new Headers(calls[1]!.init?.headers).get("Authorization"), "Bearer synthetic-review-token");
  assert.deepEqual(snapshots, [snapshot]); assert.match(dom.document.querySelector(".atlas-reviewed-success")!.textContent!, /版本 12，新增 1、更新 0/);
  assert.equal(props.capture.cards[0]!.locationText, undefined); assert.equal(props.capture.cards[0]!.salaryText, undefined);
  assert.equal(props.capture.cards[0]!.publicationText, undefined);
  assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
});

test("a lost import response preserves the exact body, preview revision and idempotency key across retry and unrelated revision changes", async () => {
  let imports = 0, closes = 0; const snapshots: AtlasDataset[] = [], pending: boolean[] = [];
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) { if (++imports === 1) throw new TypeError("Synthetic response lost"); return response(receipt); }
    assert.equal(call.path, snapshotPath); return response(snapshot);
  });
  const props = fixture(); props.onSnapshot = value => { snapshots.push(value); }; props.onClose = () => { closes++; }; props.onWritePendingChange = value => pending.push(value);
  await render(props); await click(previewLabel); await confirm(); await click(importLabel);
  assert.equal(imports, 1); assert.equal(snapshots.length, 0); assert.ok(dom.document.querySelector('[role="alert"]'));
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent === locationLabel), false, "an unknown receipt must not open administrative confirmation");
  assert.equal(button(previewLabel).disabled, true); assert.equal(dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, true);
  assert.deepEqual(pending, [true]);
  assert.equal(dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭卡片入库核对"]')!.disabled, true);
  await close(); assert.equal(closes, 0); assert.equal(calls.filter(call => call.path === importPath).length, 1);
  await render({ ...props, revision: 99 }); await click(retryLabel);
  const writes = calls.filter(call => call.path === importPath);
  assert.equal(writes.length, 2); assert.equal(writes[1]!.init!.body, writes[0]!.init!.body); assert.equal(writes[1]!.key, writes[0]!.key);
  assert.equal(writes[1]!.body!.expectedRevision, 11); assert.deepEqual(snapshots, [snapshot]);
  assert.equal(calls.filter(call => call.path === previewPath).length, 1);
  assert.deepEqual(pending, [true, true, false]);
  assert.equal(dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭卡片入库核对"]')!.disabled, false);
  await close(); assert.equal(closes, 1);
});

test("an authoritative stale-version rejection clears confirmation and requires a fresh preview before another write", async () => {
  let previews = 0, writes = 0; const pending: boolean[] = [];
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview(capture(), ++previews === 1 ? 11 : 12));
    assert.equal(call.path, importPath); writes++;
    return new Response(JSON.stringify({ ok: false, requestId: "synthetic-stale-receipt", error: { code: "stale-version", message: "Private server text must not surface" } }), { status: 409 });
  });
  const props = fixture(); props.onWritePendingChange = value => pending.push(value); await render(props); await click(previewLabel); await confirm(); await click(importLabel);
  assert.equal(writes, 1); assert.equal(button(previewLabel).disabled, false); assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
  assert.doesNotMatch(dom.document.body.textContent!, /Private server text/);
  await render({ ...props, revision: 12 }); await click(previewLabel);
  assert.equal(button(importLabel).disabled, true); assert.equal(writes, 1);
  assert.equal(calls.filter(call => call.path === previewPath).length, 2);
  assert.deepEqual(pending, [true, false]);
});

test("a failed snapshot after a successful receipt exposes committed status and retries only the index read", async () => {
  let reads = 0, snapshots = 0;
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) return response(receipt);
    assert.equal(call.path, snapshotPath); if (++reads === 1) throw new TypeError("Synthetic snapshot unavailable"); return response(importedSnapshot());
  });
  const props = fixture(); props.onSnapshot = () => { snapshots++; };
  await render(props); await click(previewLabel); await confirm(); await click(importLabel);
  assert.match(dom.document.querySelector(".atlas-reviewed-success")!.textContent!, /版本 12/);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /岗位已写入索引版本 12/); assert.equal(snapshots, 0);
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent === locationLabel), false);
  assert.match(dom.document.body.textContent!, /请先成功重新读取索引/);
  await click("重新读取索引");
  assert.equal(snapshots, 1); assert.equal(calls.filter(call => call.path === importPath).length, 1); assert.equal(reads, 2);
  await openLocation(); assert.equal(calls.length, 4, "opening the confirmed snapshot performs no extra write or fetch");
});

test("successful import exposes its unfiltered locations and real region confirmation publishes the refreshed snapshot to the original callback", async () => {
  const indexed = importedSnapshot(), original = structuredClone(indexed), location = indexed.locations[0]!, resolved = resolvedLocation(location);
  const updated = { ...indexed, revision: 13, locations: indexed.locations.map(entry => entry.id === location.id ? resolved : entry) };
  let reads = 0;
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) return response(receipt);
    if (call.path === snapshotPath) return response(++reads === 1 ? indexed : updated);
    if (call.path === locationPreviewPath) return response(locationPreview(call.body as PreviewLocationConfirmationInput, location));
    assert.equal(call.path, locationConfirmPath);
    return response({ ok: true, revision: 13, jobId: receipt.jobIds[0], locationId: location.id, decisionId: resolved.userResolution!.decisionId,
      activeDecisionId: resolved.userResolution!.decisionId, location: resolved });
  });
  const props = fixture(), snapshots: AtlasDataset[] = []; props.capture.cards[0]!.locationText = location.raw;
  props.capture.cards[0]!.cardText += ` ${location.raw}`;
  props.capture.cards[0]!.evidence.fields.push({ field: "locationText", selector: ".job-area", text: location.raw });
  const captureBefore = structuredClone(props.capture); props.onSnapshot = value => { snapshots.push(value); };
  await importCards(props);
  const imported = dom.document.querySelector('[aria-label="新加入岗位的地区"]')!;
  assert.match(imported.textContent!, /上海-浦东新区.*未确认行政范围.*坐标待定位/s);
  assert.match(dom.document.querySelector(".atlas-reviewed-success")!.textContent!, /行政归属未核实.*国内或地区筛选排除.*核对地区不会生成办公坐标/s);
  assert.equal(imported.querySelectorAll("article").length, 1, "only receipt jobs are shown, without the search result's filter");
  assert.equal(calls.length, 3); assert.equal(indexed.locations[0]!.countryCode, undefined);
  await openLocation(); assert.equal(calls.length, 3); await selectShanghai();
  await click("预览地区变更"); assert.equal(button("确认保存地区").disabled, true);
  await confirmLocation();
  assert.deepEqual(calls.map(call => call.path), [previewPath, importPath, snapshotPath, locationPreviewPath, locationConfirmPath, snapshotPath]);
  assert.equal(calls[3]!.body!.expectedRevision, 12); assert.equal(calls[4]!.body!.expectedRevision, 12);
  assert.equal(calls[4]!.body!.jobId, receipt.jobIds[0]); assert.equal(calls[4]!.body!.locationId, location.id);
  assert.deepEqual(snapshots, [indexed, updated]); assert.equal(locationSection(), null);
  assert.match(imported.textContent!, /CN \/ 上海市 \/ 上海市 \/ 浦东新区.*坐标待定位/s);
  assert.equal(updated.locations[0]!.coordinates, undefined); assert.deepEqual(indexed, original); assert.deepEqual(props.capture, captureBefore);
  await openLocation(); assert.equal(calls.length, 6); assert.equal((locationSection()!.querySelector('[aria-label="确认国家地区"]') as unknown as HTMLSelectElement).value, "CN");
  await act(async () => locationSection()!.querySelector<HTMLButtonElement>('[aria-label="关闭地区核对"]')!.click());
  assert.equal(locationSection(), null); assert.ok(button(locationLabel)); assert.equal(calls.length, 6);
});

test("receipt membership limits the panel to each imported job's referenced locations and reports absent records without guessing", async () => {
  const indexed = importedSnapshot(), first = indexed.jobs[0]!, second = indexed.jobs[1]!;
  indexed.jobs = indexed.jobs.map(job => job.id === first.id ? { ...job, locationIds: [indexed.locations[0]!.id, indexed.locations[1]!.id] } : job.id === second.id ? { ...job, locationIds: [] } : job);
  installFetch(call => {
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) return response({ ...receipt, jobIds: [first.id, second.id, "synthetic-absent-job"] });
    assert.equal(call.path, snapshotPath); return response(indexed);
  });
  await importCards();
  const section = dom.document.querySelector('[aria-label="新加入岗位的地区"]')!;
  assert.equal(section.querySelectorAll("article").length, 3); assert.equal(section.querySelectorAll("button").length, 2);
  assert.match(section.textContent!, /上海-浦东新区.*北京.*没有该岗位可核对的地点记录.*该岗位不在当前索引中/s);
  assert.doesNotMatch(section.textContent!, /深圳|新加坡|柏林/);
  const entries = section.querySelectorAll<HTMLButtonElement>("button");
  await act(async () => entries[1]!.click()); await act(async () => { await import("../src/components/atlas/AtlasLocationConfirmation.tsx"); });
  assert.match(locationSection()!.textContent!, /北京（演示城市中心）/);
});

test("a newer parent revision closes an active location request; only a fresh explicit index read reopens confirmation", async () => {
  const late = deferred<Response>(); let signal: AbortSignal | undefined, reads = 0;
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview());
    if (call.path === importPath) return response(receipt);
    if (call.path === snapshotPath) return response(importedSnapshot(++reads === 1 ? 12 : 13));
    assert.equal(call.path, locationPreviewPath); signal = call.init?.signal as AbortSignal; return late.promise;
  });
  const props = fixture(), snapshots: AtlasDataset[] = []; props.onSnapshot = value => { snapshots.push(value); };
  await importCards(props); await openLocation(); await selectShanghai(); await click("预览地区变更");
  assert.equal(signal?.aborted, false); await render({ ...props, revision: 13 });
  assert.equal(signal?.aborted, true); assert.equal(locationSection(), null); assert.match(dom.document.body.textContent!, /最新已知版本为 13.*重新读取索引后再核对地区/s);
  assert.equal([...dom.document.querySelectorAll("button")].some(node => node.textContent === locationLabel), false);
  await act(async () => late.resolve(response(locationPreview({ jobId: receipt.jobIds[0]!, locationId: importedSnapshot().locations[0]!.id, expectedRevision: 12,
    reason: "Synthetic late preview", proposal: { countryCode: "CN", locationKind: "office", area: { kind: "manual-area", city: "上海市" } } }))));
  assert.equal(snapshots.length, 1); assert.equal(calls.length, 4);
  await click("重新读取索引"); assert.equal(locationSection(), null); await openLocation();
  assert.equal(calls.length, 5); assert.match(dom.document.querySelector('[aria-label="新加入岗位的地区"]')!.textContent!, /索引版本 13/);
});

test("capture, endpoint, token and close isolate a pending post-import snapshot without repeating the completed write", async () => {
  const changes = [
    (props: AtlasReviewedCardImportProps) => render({ ...props, capture: capture("1234567891") }),
    (props: AtlasReviewedCardImportProps) => render({ ...props, endpoint: "http://127.0.0.1:6178" }),
    (props: AtlasReviewedCardImportProps) => render({ ...props, token: "synthetic-other-token" }),
    () => close(),
  ];
  for (const change of changes) {
    const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
    const calls = installFetch(call => {
      if (call.path === previewPath) return response(preview());
      if (call.path === importPath) return response(receipt);
      assert.equal(call.path, snapshotPath); signal = call.init?.signal as AbortSignal; return late.promise;
    });
    const props = fixture(); props.onSnapshot = () => { snapshots++; }; await importCards(props);
    assert.equal(signal?.aborted, false); await change(props); assert.equal(signal?.aborted, true);
    await act(async () => late.resolve(response(importedSnapshot())));
    assert.equal(snapshots, 0); assert.equal(locationSection(), null); assert.equal(dom.document.querySelector(".atlas-reviewed-success"), null);
    assert.equal(calls.filter(call => call.path === importPath).length, 1); assert.equal(calls.length, 3); await clean();
  }
});

test("closing, identity changes, or parent refresh abort a location snapshot and never publish its late result", async () => {
  const changes = [
    (props: AtlasReviewedCardImportProps) => render({ ...props, capture: capture("1234567891") }),
    (props: AtlasReviewedCardImportProps) => render({ ...props, endpoint: "http://127.0.0.1:6178" }),
    (props: AtlasReviewedCardImportProps) => render({ ...props, token: "synthetic-other-token" }),
    () => close(),
    () => click("重新读取索引"),
    (props: AtlasReviewedCardImportProps) => render({ ...props, revision: 14 }),
  ];
  for (const change of changes) {
    const late = deferred<Response>(), indexed = importedSnapshot(), original = indexed.locations[0]!, location = resolvedLocation(original);
    let signal: AbortSignal | undefined, reads = 0;
    const calls = installFetch(call => {
      if (call.path === previewPath) return response(preview());
      if (call.path === importPath) return response(receipt);
      if (call.path === locationPreviewPath) return response(locationPreview(call.body as PreviewLocationConfirmationInput));
      if (call.path === locationConfirmPath) return response({ ok: true, revision: 13, jobId: receipt.jobIds[0], locationId: location.id,
        decisionId: location.userResolution!.decisionId, activeDecisionId: location.userResolution!.decisionId, location });
      assert.equal(call.path, snapshotPath); if (++reads !== 2) return response(indexed);
      signal = call.init?.signal as AbortSignal; return late.promise;
    });
    const props = fixture(), snapshots: AtlasDataset[] = []; props.onSnapshot = value => { snapshots.push(value); };
    await importCards(props); await openLocation(); await selectShanghai(); await click("预览地区变更"); await confirmLocation();
    assert.equal(signal?.aborted, false); await change(props); assert.equal(signal?.aborted, true); assert.equal(locationSection(), null);
    const before = snapshots.length, callCount = calls.length;
    await act(async () => late.resolve(response({ ...indexed, revision: 13, locations: indexed.locations.map(entry => entry.id === location.id ? location : entry) })));
    assert.equal(snapshots.length, before); assert.equal(calls.length, callCount); assert.equal(calls.filter(call => call.path === importPath).length, 1);
    await clean();
  }
});

test("closing previews or unmounting aborts in-flight requests; ignored late responses cannot publish success, snapshots or pending release", async () => {
  for (const phase of ["preview", "import"] as const) for (const action of ["close", "unmount"] as const) {
    if (phase === "import" && action === "close") continue;
    const old = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0, closes = 0;
    const pending: boolean[] = [];
    const calls = installFetch(call => {
      if (phase === "import" && call.path === previewPath) return response(preview());
      assert.equal(call.path, phase === "preview" ? previewPath : importPath); signal = call.init?.signal as AbortSignal; return old.promise;
    });
    const props = fixture(); props.onSnapshot = () => { snapshots++; }; props.onClose = () => { closes++; }; props.onWritePendingChange = value => pending.push(value);
    await render(props); await click(previewLabel);
    if (phase === "import") { await confirm(); await click(importLabel); }
    assert.equal(signal?.aborted, false);
    if (action === "close") await close(); else { await act(async () => root!.unmount()); root = undefined; }
    assert.equal(signal?.aborted, true); assert.equal(closes, action === "close" ? 1 : 0);
    await act(async () => old.resolve(response(phase === "preview" ? preview() : receipt)));
    assert.equal(snapshots, 0); assert.equal(dom.document.querySelector(".atlas-reviewed-success"), null);
    assert.equal(calls.filter(call => call.path === snapshotPath).length, 0);
    assert.deepEqual(pending, phase === "import" ? [true] : []);
    if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); dom.document.body.replaceChildren();
  }
});

test("changing capture, endpoint or token aborts the old request, restores controls and ignores its late result without auto-reading", async () => {
  const changes = [
    (props: AtlasReviewedCardImportProps) => ({ ...props, capture: capture("1234567891") }),
    (props: AtlasReviewedCardImportProps) => ({ ...props, endpoint: "http://127.0.0.1:6178" }),
    (props: AtlasReviewedCardImportProps) => ({ ...props, token: "synthetic-next-review-token" }),
  ];
  for (const change of changes) {
    const old = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
    const props = fixture(); props.onSnapshot = () => { snapshots++; };
    const calls = installFetch(call => {
      if (calls.length === 1) { signal = call.init?.signal as AbortSignal; return old.promise; }
      assert.equal(call.path, previewPath); return response(preview(change(props).capture));
    });
    await render(props); await click(previewLabel); await render(change(props));
    assert.equal(signal?.aborted, true); assert.equal(calls.length, 1);
    assert.equal(button(previewLabel).disabled, false, "a changed capture must not inherit the old request's busy state");
    await act(async () => old.resolve(response(preview())));
    assert.equal(dom.document.querySelector('input[type="checkbox"]'), null); assert.equal(snapshots, 0);
    await click(previewLabel); assert.equal(calls.length, 2); assert.equal(button(importLabel).disabled, true);
    if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); dom.document.body.replaceChildren();
  }
});

test("the write deadline preserves its ambiguous request for explicit retry and cannot accept a late transport receipt", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const late = deferred<Response>(); let importSignal: AbortSignal | undefined, snapshots = 0;
  const calls = installFetch(call => {
    if (call.path === previewPath) return response(preview());
    assert.equal(call.path, importPath); importSignal = call.init?.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      importSignal!.addEventListener("abort", () => reject(importSignal!.reason), { once: true });
      void late.promise.then(resolve);
    });
  });
  const props = fixture(); props.onSnapshot = () => { snapshots++; };
  await render(props); await click(previewLabel); await confirm(); await click(importLabel);
  await act(async () => mock.timers.tick(24_999)); assert.equal(importSignal?.aborted, false);
  await act(async () => mock.timers.tick(1)); assert.equal(importSignal?.aborted, true);
  assert.equal(button(retryLabel).disabled, false); assert.equal(button(previewLabel).disabled, true);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /已提交的写入可能完成/);
  await act(async () => late.resolve(response(receipt)));
  assert.equal(snapshots, 0); assert.equal(dom.document.querySelector(".atlas-reviewed-success"), null);
  assert.equal(calls.filter(call => call.path === snapshotPath).length, 0);
});


test("default backend permits explicit reviewed-card preview without a browser token", async () => {
  const calls = installFetch(call => { assert.equal(call.path, `/api/atlas${previewPath}`); return response(preview()); });
  await render({ ...fixture(), endpoint: "/api/atlas", token: "" }); assert.equal(calls.length, 0);
  assert.equal(button(previewLabel).disabled, false); await click(previewLabel);
  assert.equal(calls.length, 1); assert.equal(new Headers(calls[0]!.init?.headers).has("Authorization"), false);
  assert.equal(button(importLabel).disabled, true, "manual review checkbox remains required");
});
