import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLTextAreaElement } from "happy-dom";
import { queryJobs, type AtlasDataset, type JobLocation } from "@better-me/opportunities";
import { PlatformDetailLocationsSchema, ReviewedCardsCaptureSchema, parsePlatformJobLocations,
  type DetailLocationsPreview, type PlatformDetailLocations, type ReviewedCardsCapture } from "@better-me/source-adapters/browser-contracts";
import { createJobApplication } from "../../job-service/src/application.ts";
import { createJobHttpServer } from "../../job-service/src/http.ts";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { projectSourcePage } from "../../job-service/src/projection.ts";
import { reviewedCardsPage, reviewedCardsSource } from "../../job-service/src/reviewed-cards.ts";
import { extractPublicJobHtml } from "../server/jd-extractor.ts";
import type { AtlasDetailLocationsProps } from "../src/components/atlas/AtlasDetailLocations.tsx";
import { createAtlasSourceClient } from "../src/components/atlas/service-client.ts";
import { createJobMapFocus } from "../src/components/atlas/map-focus.ts";
import { jdBrowserCleanupTracker } from "../src/lib/jd-browser-cleanup.ts";
import type { AtlasPrototypeProps } from "../src/components/atlas/prototypes/types.ts";

const dom = new Window({ url: "http://synthetic-detail-address.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
let mapMounts = 0;
function MapProbe(_props: AtlasPrototypeProps) {
  React.useEffect(() => { mapMounts++; }, []);
  return h("div", { "data-detail-address-map-probe": true });
}
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  localStorage: dom.localStorage, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  __atlasDetailAddressMapProbe: MapProbe };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/MapLibrePrototype.tsx")) return { source: "export default globalThis.__atlasDetailAddressMapProbe;", format: "module", shortCircuit: true };
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { AtlasDetailLocations, detailLocationTargets } = await import("../src/components/atlas/AtlasDetailLocations.tsx");

const AT = "2026-10-19T12:00:00.000Z", DETAIL_AT = "2026-10-19T12:01:00.000Z", NOW = "2026-10-19T12:02:00.000Z";
const TOKEN = "synthetic-detail-location-token-123456789";
const JOB_URL = "https://www.liepin.com/job/1234567890.shtml";
const paths = { extract: "/api/jd/extract", browser: "/api/jd/browser-session", preview: "/api/v1/jobs/detail-locations/preview",
  write: "/api/v1/jobs/detail-locations/import", snapshot: "/api/v1/dataset/export" };
const labels = { read: "读取公开岗位页", preview: "预览地点变化", save: "确认保存来源地点", retry: "核对本次保存回执", refresh: "重新读取索引", office: "核对这个办公位置" };
const originalDescription = "Synthetic card excerpt only, not a complete job description. C# software development.";
const description = "Synthetic complete job description: develop C# services, design reliable integration tests and maintain technical documentation. This describes a fictional employer only.";
const address = { "@type": "Place", address: { "@type": "PostalAddress", streetAddress: "Synthetic Example Road 10", addressLocality: "Shanghai", addressRegion: "Shanghai", postalCode: "200000", addressCountry: "CN" } };

function cardCapture(): ReviewedCardsCapture {
  const title = "Synthetic detail-address engineer", company = "Synthetic detail-address employer", pageUrl = "https://www.liepin.com/zhaopin/?key=C%23";
  return ReviewedCardsCaptureSchema.parse({ provider: "liepin", pageUrl, capturedAt: AT, cards: [{ platform: "猎聘", url: JOB_URL,
    title, company, cardText: `${title} ${company} Shanghai Synthetic salary: 20-30k, unverified ${originalDescription}`, salaryText: "Synthetic salary: 20-30k, unverified", locationText: "Shanghai",
    evidence: { pageUrl, cardSelector: ".synthetic-card", fields: [
      { field: "url", selector: "a[href]", text: JOB_URL }, { field: "title", selector: ".title", text: title },
      { field: "company", selector: ".company", text: company }, { field: "locationText", selector: ".location", text: "Shanghai" },
      { field: "salaryText", selector: ".salary", text: "Synthetic salary: 20-30k, unverified" },
    ] } }] });
}
function detailCapture(url = JOB_URL): PlatformDetailLocations {
  const parsed = parsePlatformJobLocations({ jobLocation: address }); assert.ok(parsed);
  return PlatformDetailLocationsSchema.parse({ version: 1, provider: "liepin", url, capturedAt: DETAIL_AT, ...parsed });
}
function extractionPayload(capture: PlatformDetailLocations | undefined = detailCapture()) {
  return { text: description, method: "Synthetic accepted same-job JSON-LD", provenance: { kind: "link", platform: "猎聘", url: capture?.url ?? JOB_URL, observedAt: DETAIL_AT },
    ...(capture ? { detailLocations: capture } : {}) };
}
async function seededData(): Promise<AtlasDataset> {
  const repository = openJobRepository(":memory:", { now: () => NOW });
  try {
    const projected = await projectSourcePage(await repository.readProjectionSnapshot(), reviewedCardsSource("liepin"), reviewedCardsPage(cardCapture()), "synthetic-detail-seed", { mode: "user-reviewed-browser" });
    for (const location of projected.delta.locations) location.kind = "unknown";
    await repository.importSnapshot(projected.delta, { actorScope: "synthetic-seed", idempotencyKey: "seed", expectedRevision: 0 });
    return await repository.readSnapshot();
  } finally { repository.close(); }
}
const BASE = await seededData();
const JOB = BASE.jobs[0]!, LISTING = BASE.listings[0]!;
const CAPTURE = detailCapture();
const LOCATION: JobLocation = { ...CAPTURE.locations[0]!, id: "synthetic-detail-office-location", kind: "office", precision: "city", verification: "unverified",
  evidence: [{ observationId: "synthetic-detail-observation", sourceUrl: JOB_URL, observedAt: DETAIL_AT, ...CAPTURE.locations[0]!.evidence }] };
function preview(revision = BASE.revision): DetailLocationsPreview {
  return { jobId: JOB.id, listingId: LISTING.id, sourceId: LISTING.sourceId, expectedRevision: revision, previewFingerprint: "c".repeat(64),
    newLocations: [LOCATION], previousLocationIds: LISTING.locationIds!, warnings: ["Synthetic source location remains unverified; no office coordinates are created."] };
}
const RECEIPT = { ok: true, revision: BASE.revision + 1, jobIds: [JOB.id], snapshotIds: [],
  counts: { newJobs: 0, updatedJobs: 1, unchangedJobs: 0, newListings: 0, newObservations: 1, newSnapshots: 0 } };
function updatedData(revision = RECEIPT.revision): AtlasDataset {
  return { ...BASE, revision, jobs: BASE.jobs.map(job => job.id === JOB.id ? { ...job, locationIds: [LOCATION.id], revision: job.revision + 1 } : job),
    listings: BASE.listings.map(listing => listing.id === LISTING.id ? { ...listing, locationIds: [LOCATION.id], observationIds: [...listing.observationIds, "synthetic-detail-observation"] } : listing),
    locations: [...BASE.locations, LOCATION], observations: [...BASE.observations, { id: "synthetic-detail-observation", listingId: LISTING.id,
      fetchedAt: DETAIL_AT, detailFetchedAt: DETAIL_AT, result: "partial", availability: "unknown", completeness: "excerpt", warnings: [] }] };
}
let scopeNumber = 0;
function props(): AtlasDetailLocationsProps {
  return { endpoint: "http://127.0.0.1:5178", token: `${TOKEN}-${++scopeNumber}`, data: BASE, jobId: JOB.id, onClose() {}, onSnapshot() {}, onOfficeSnapshot() {} };
}

type Call = { path: string; init?: RequestInit; body?: Record<string, unknown>; key: string | null };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-detail-request", value }));
const rawResponse = (value: unknown) => new Response(JSON.stringify(value));
function defaultResponse(call: Call): Response {
  if (call.path === paths.extract) return rawResponse(extractionPayload());
  if (call.path === paths.preview) return response(preview(Number(call.body!.expectedRevision)));
  if (call.path === paths.write) return response(RECEIPT);
  if (call.path === paths.snapshot) return response(updatedData());
  throw new Error(`Unexpected synthetic route: ${call.path}`);
}
function installFetch(handler: (call: Call, calls: Call[]) => Response | Promise<Response> = defaultResponse) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: new URL(String(url), dom.location.href).pathname, init,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), key: new Headers(init?.headers).get("Idempotency-Key") };
    calls.push(call); return handler(call, calls);
  });
  return calls;
}
let root: ReturnType<typeof createRoot> | undefined;
async function render(value = props()) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasDetailLocations, value)));
}
function button(label: string) {
  const entry = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  assert.ok(entry, `Missing button ${label}: ${dom.document.body.textContent}`); return entry;
}
function hasButton(label: string) { return [...dom.document.querySelectorAll("button")].some(node => node.textContent?.trim() === label); }
async function click(label: string) { await act(async () => button(label).click()); }
async function confirm() { const input = dom.document.querySelector<HTMLInputElement>('.atlas-detail-address-preview input[type="checkbox"]'); assert.ok(input); await act(async () => input.click()); }
async function change(label: string, value: string) {
  const input = dom.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); assert.ok(input);
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}
async function prepare(value = props()) { await render(value); await click(labels.read); await click(labels.preview); }
async function save(value = props()) { await prepare(value); await confirm(); await click(labels.save); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function clean() {
  if (root) await act(async () => root!.unmount()); root = undefined;
  mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren(); dom.localStorage.clear(); dom.sessionStorage.clear(); mapMounts = 0;
}
async function settled(predicate: () => boolean) {
  for (let attempt = 0; attempt < 150; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    if (predicate()) return;
  }
  assert.fail(`Synthetic HTTP/React action did not settle: ${dom.document.body.textContent}`);
}
afterEach(clean);
after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("the original-listing reader is inert, keeps its source link and excludes guessed or foreign source identities", async () => {
  const calls = installFetch(), value = props(), before = structuredClone(value.data);
  await render(value);
  assert.equal(calls.length, 0); assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
  const link = dom.document.querySelector<HTMLAnchorElement>("a")!;
  assert.equal(link.href, JOB_URL); assert.equal(link.target, "_blank"); assert.equal(link.rel, "noopener noreferrer");
  assert.doesNotMatch(dom.document.body.textContent!, new RegExp(TOKEN));
  assert.deepEqual(value.data, before);
  assert.equal(detailLocationTargets(BASE, JOB.id).length, 1);
  for (const patch of [{ sourceId: "unrelated-source" }, { sourceRecordId: "another-job" }, { canonicalJobId: "another-job" }, { canonicalUrl: "https://www.liepin.com/job/9876543210.shtml" }]) {
    const data = { ...BASE, listings: BASE.listings.map(listing => ({ ...listing, ...patch })) };
    assert.deepEqual(detailLocationTargets(data, JOB.id), []);
  }
  await render({ ...value, data: { ...BASE, listings: [] } }); assert.equal(dom.document.querySelector("section"), null); assert.equal(calls.length, 0);
});

test("reading and preview remain read-only; explicit source review saves once and exposes the same-job office confirmation", async () => {
  const calls = installFetch(), snapshots: AtlasDataset[] = [], value = { ...props(), onSnapshot: (data: AtlasDataset) => snapshots.push(data) };
  await render(value); await click(labels.read);
  assert.deepEqual(calls.map(call => call.path), [paths.extract]); assert.equal(snapshots.length, 0);
  assert.deepEqual(calls[0]!.body, { input: JOB_URL });
  assert.match(dom.document.querySelector('[aria-label="读取到的地点证据"]')!.textContent!, /Synthetic Example Road 10.*CN.*Shanghai.*200000/s);
  assert.equal(dom.document.querySelector("script,img"), null); assert.equal(hasButton(labels.save), false);
  await click(labels.preview); assert.equal(button(labels.save).disabled, true);
  await click(labels.save); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.body, { jobId: JOB.id, listingId: LISTING.id, expectedRevision: BASE.revision, capture: CAPTURE });
  await confirm(); await click(labels.save);
  assert.deepEqual(calls.map(call => call.path), [paths.extract, paths.preview, paths.write, paths.snapshot]);
  const write = calls[2]!;
  assert.deepEqual(write.body, { jobId: JOB.id, listingId: LISTING.id, expectedRevision: BASE.revision, capture: CAPTURE, previewFingerprint: "c".repeat(64), reviewed: true });
  assert.match(write.key!, /^detail-address-/); assert.equal(write.init!.method, "POST"); assert.equal(write.init!.credentials, "omit");
  assert.equal(new Headers(write.init!.headers).get("Authorization"), `Bearer ${value.token}`);
  assert.deepEqual(snapshots, [updatedData()]); assert.match(dom.document.body.textContent!, /办公位置以当前核对记录为准/);
  assert.doesNotMatch(dom.document.body.textContent!, /尚未保存地址或坐标|尚未生成办公坐标/);
  assert.equal(dom.document.querySelector('input[type="checkbox"]'), null);
  await click(labels.office); await act(async () => { await import("../src/components/atlas/AtlasOfficeAddressConfirmation.tsx"); });
  assert.ok(dom.document.querySelector('[aria-label="核对并保存办公地址"]')); assert.equal(calls.length, 4);
});

test("missing, edited, other-job and remote-only disclosures never erase current source locations or start a write", async () => {
  const emptyRemote = PlatformDetailLocationsSchema.parse({ ...CAPTURE, locations: [], workMode: "remote", workModeEvidence: { selector: "jobLocationType", quote: '"TELECOMMUTE"' } });
  const withoutAddress = { text: description, method: "Synthetic visible text", provenance: { kind: "link", platform: "猎聘", url: JOB_URL, observedAt: DETAIL_AT } };
  const variants = [withoutAddress, { ...extractionPayload(), provenance: { ...extractionPayload().provenance, edited: true } },
    extractionPayload(detailCapture("https://www.liepin.com/job/9876543210.shtml")), extractionPayload(emptyRemote)];
  for (const payload of variants) {
    const calls = installFetch(call => { assert.equal(call.path, paths.extract); return rawResponse(payload); });
    const value = props(), before = structuredClone(value.data);
    await render(value); await click(labels.read);
    assert.equal(calls.length, 1); assert.equal(hasButton(labels.preview), false); assert.equal(hasButton(labels.save), false);
    assert.match(dom.document.body.textContent!, /当前地点保持不变/); assert.deepEqual(value.data, before);
    await clean();
  }
});

test("invalid address evidence is rejected at the extraction transport boundary before any index request", async () => {
  const capture = structuredClone(CAPTURE); capture.locations[0]!.streetAddress = "Forged unquoted office";
  const calls = installFetch(() => rawResponse(extractionPayload(capture)));
  await render(); await click(labels.read);
  assert.equal(calls.length, 1); assert.equal(hasButton(labels.preview), false);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /无效岗位来源/);
});

test("a preview for another job or forged coordinates is rejected by the strict client without enabling confirmation", async () => {
  for (const proposed of [{ ...preview(), jobId: "foreign-job" }, { ...preview(), newLocations: [{ ...LOCATION, coordinates: { latitude: 31, longitude: 121, coordinateSystem: "WGS84" } }] },
    { ...preview(), newLocations: [{ ...LOCATION, streetAddress: "Forged other office" }] },
    { ...preview(), newLocations: [{ ...LOCATION, evidence: LOCATION.evidence.map(ref => ({ ...ref, sourceUrl: "https://www.liepin.com/job/9876543210.shtml" })) }] }]) {
    const calls = installFetch(call => call.path === paths.preview ? response(proposed) : defaultResponse(call));
    await prepare(); assert.equal(calls.length, 2); assert.equal(hasButton(labels.save), false);
    assert.equal(dom.document.querySelector('input[type="checkbox"]'), null); assert.ok(dom.document.querySelector('[role="alert"]'));
    await clean();
  }
});

test("a changed index revision invalidates the preview and a fresh preview requires another explicit checkbox", async () => {
  const calls = installFetch(), value = props(); await prepare(value); await confirm();
  await render({ ...value, data: { ...BASE, revision: BASE.revision + 1 } });
  assert.equal(button(labels.save).disabled, true); assert.equal(dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, true);
  await click(labels.save); assert.equal(calls.filter(call => call.path === paths.write).length, 0);
  await click(labels.preview); assert.equal(button(labels.save).disabled, true);
  assert.equal(calls.at(-1)!.body!.expectedRevision, BASE.revision + 1);
  assert.equal(dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
});

test("a lost write response retries the original exact body and idempotency key despite an intervening index revision", async () => {
  let writes = 0; const snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => {
    if (call.path === paths.write && ++writes === 1) throw new TypeError("Synthetic response lost after commit");
    return defaultResponse(call);
  });
  const value = { ...props(), onSnapshot: (data: AtlasDataset) => snapshots.push(data) };
  await save(value); assert.equal(writes, 1); assert.equal(snapshots.length, 0);
  assert.equal(button(labels.preview).disabled, true); assert.equal(button(labels.retry).disabled, false);
  await render({ ...value, data: { ...BASE, revision: RECEIPT.revision } }); await click(labels.retry);
  const requests = calls.filter(call => call.path === paths.write);
  assert.equal(requests.length, 2); assert.equal(requests[1]!.init!.body, requests[0]!.init!.body); assert.equal(requests[1]!.key, requests[0]!.key);
  assert.equal(requests[1]!.body!.expectedRevision, BASE.revision); assert.deepEqual(snapshots, [updatedData()]);
  assert.equal(calls.filter(call => call.path === paths.preview).length, 1);
});

test("a committed receipt followed by a failed snapshot retries only the read before exposing office confirmation", async () => {
  let reads = 0; const snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => {
    if (call.path === paths.snapshot && ++reads === 1) throw new TypeError("Synthetic snapshot transport failure");
    return defaultResponse(call);
  });
  await save({ ...props(), onSnapshot: (data: AtlasDataset) => snapshots.push(data) });
  assert.equal(snapshots.length, 0); assert.equal(hasButton(labels.office), false);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /地点已保存至版本/);
  await click(labels.refresh); assert.deepEqual(snapshots, [updatedData()]); assert.equal(hasButton(labels.office), true);
  assert.equal(calls.filter(call => call.path === paths.write).length, 1); assert.equal(reads, 2);
});

test("closing and reopening an uncertain write preserves its exact request for explicit same-key receipt recovery", async () => {
  let writes = 0; const snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => {
    if (call.path === paths.write && ++writes === 1) throw new TypeError("Synthetic committed response lost");
    return defaultResponse(call);
  });
  const value = { ...props(), onSnapshot: (data: AtlasDataset) => snapshots.push(data) };
  await save(value); assert.equal(writes, 1);
  await act(async () => root!.unmount()); root = undefined;
  const beforeReopen = calls.length;
  await render({ ...value, data: { ...BASE, revision: RECEIPT.revision } });
  assert.equal(calls.length, beforeReopen, "reopening never retries or rereads automatically");
  assert.equal(button(labels.retry).disabled, false); assert.equal(button(labels.read).disabled, true);
  await click(labels.retry);
  const requests = calls.filter(call => call.path === paths.write);
  assert.equal(requests.length, 2); assert.equal(requests[1]!.init!.body, requests[0]!.init!.body); assert.equal(requests[1]!.key, requests[0]!.key);
  assert.deepEqual(snapshots, [updatedData()]);
});

test("reopening a known committed receipt after a failed refresh offers GET only and clears recovery after success", async () => {
  let reads = 0; const snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => {
    if (call.path === paths.snapshot && ++reads === 1) throw new TypeError("Synthetic GET unavailable");
    return defaultResponse(call);
  });
  const value = { ...props(), onSnapshot: (data: AtlasDataset) => snapshots.push(data) };
  await save(value); assert.equal(snapshots.length, 0);
  await act(async () => root!.unmount()); root = undefined;
  const beforeReopen = calls.length; await render(value);
  assert.equal(calls.length, beforeReopen); assert.equal(hasButton(labels.retry), false); assert.equal(hasButton(labels.save), false);
  assert.equal(hasButton(labels.read), false); assert.equal(hasButton(labels.office), false);
  await click(labels.refresh); assert.deepEqual(snapshots, [updatedData()]); assert.equal(hasButton(labels.office), true);
  assert.equal(calls.filter(call => call.path === paths.write).length, 1); assert.equal(reads, 2);
  await act(async () => root!.unmount()); root = undefined;
  await render({ ...value, data: updatedData() });
  assert.equal(hasButton(labels.read), true); assert.equal(hasButton(labels.retry), false); assert.equal(calls.length, beforeReopen + 1);
});

test("forged future revisions and inconsistent write counts remain ambiguous and cannot trigger a snapshot", async () => {
  const malformed = [
    { ...RECEIPT, revision: BASE.revision + 100 },
    { ...RECEIPT, counts: { ...RECEIPT.counts, newJobs: 1 } },
    { ...RECEIPT, counts: { ...RECEIPT.counts, unchangedJobs: 1 } },
    { ...RECEIPT, counts: { ...RECEIPT.counts, updatedJobs: 2 } },
    { ...RECEIPT, counts: { ...RECEIPT.counts, newObservations: 2 } },
    { ...RECEIPT, revision: BASE.revision },
    { ...RECEIPT, revision: BASE.revision, counts: { ...RECEIPT.counts, updatedJobs: 0, unchangedJobs: 1 } },
  ];
  for (const receipt of malformed) {
    const calls = installFetch(call => call.path === paths.write ? response(receipt) : defaultResponse(call));
    let snapshots = 0; await save({ ...props(), onSnapshot: () => { snapshots++; } });
    assert.equal(snapshots, 0); assert.equal(hasButton(labels.retry), true); assert.equal(hasButton(labels.office), false);
    assert.equal(calls.filter(call => call.path === paths.snapshot).length, 0);
    assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /回执与本次已有岗位不一致/);
    await clean();
  }
});

test("a successful write never publishes a snapshot older than its committed receipt", async () => {
  const snapshots: AtlasDataset[] = [];
  installFetch(call => call.path === paths.snapshot ? response(BASE) : defaultResponse(call));
  await save({ ...props(), onSnapshot: (data: AtlasDataset) => snapshots.push(data) });
  assert.equal(snapshots.length, 0, "a read below the committed receipt cannot become the current index");
  assert.equal(hasButton(labels.office), false); assert.ok(dom.document.querySelector('[role="alert"]'));
  await click(labels.refresh); assert.equal(snapshots.length, 0, "the explicit GET retry must keep the same minimum receipt revision");
});

test("an authoritative stale write rejection discards confirmation and requires a fresh preview", async () => {
  const calls = installFetch(call => call.path === paths.write ? new Response(JSON.stringify({ ok: false, requestId: "synthetic-stale", error: { code: "stale-version", message: "Synthetic private server details" } }), { status: 409 }) : defaultResponse(call));
  await save(); assert.equal(hasButton(labels.retry), false); assert.equal(hasButton(labels.save), false);
  assert.equal(dom.document.querySelector('input[type="checkbox"]'), null); assert.equal(button(labels.preview).disabled, false);
  assert.doesNotMatch(dom.document.body.textContent!, /Synthetic private server details/);
  await click(labels.preview); assert.equal(button(labels.save).disabled, true);
  assert.equal(calls.filter(call => call.path === paths.write).length, 1);
});

test("job, endpoint, token changes and unmount abort late reads and cannot publish the abandoned job", async () => {
  const alternate = { ...BASE, jobs: [{ ...JOB, id: "synthetic-other-job", listingIds: [LISTING.id] }], listings: [{ ...LISTING, canonicalJobId: "synthetic-other-job" }] };
  const changes = [
    (value: AtlasDetailLocationsProps) => ({ ...value, data: alternate, jobId: "synthetic-other-job" }),
    (value: AtlasDetailLocationsProps) => ({ ...value, endpoint: "http://127.0.0.1:6178" }),
    (value: AtlasDetailLocationsProps) => ({ ...value, token: "synthetic-replacement-token" }),
    (_value: AtlasDetailLocationsProps) => null,
  ];
  for (const change of changes) {
    const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
    const calls = installFetch(call => { signal = call.init?.signal as AbortSignal; return late.promise; });
    const value = { ...props(), onSnapshot: () => { snapshots++; } };
    await render(value); await click(labels.read); const next = change(value);
    if (next) await render(next); else { await act(async () => root!.unmount()); root = undefined; }
    assert.equal(signal?.aborted, true); assert.equal(calls.length, 1);
    await act(async () => late.resolve(rawResponse(extractionPayload())));
    assert.equal(snapshots, 0); assert.equal(hasButton(labels.preview), false);
    if (next) assert.equal(button(labels.read).disabled, false);
    await clean();
  }
});

test("changing the endpoint closes only this reader's exact browser session and ignores its late browser response", async () => {
  const sessionId = "synthetic_address_session_012345", late = deferred<Response>();
  let readSignal: AbortSignal | undefined;
  const calls = installFetch(call => {
    assert.equal(call.path, paths.browser);
    if (call.body!.action === "start") return rawResponse({ sessionId, platform: "猎聘", url: JOB_URL, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    if (call.body!.action === "read") { readSignal = call.init?.signal as AbortSignal; return late.promise; }
    assert.deepEqual(call.body, { action: "close", sessionId }); return rawResponse({ closed: true });
  });
  const value = props(); await render(value); await click("打开专用岗位页"); await click("读取当前岗位页");
  await render({ ...value, endpoint: "http://127.0.0.1:6178" });
  assert.equal(readSignal?.aborted, true);
  await act(async () => late.resolve(rawResponse(extractionPayload())));
  assert.deepEqual(calls.map(call => call.body!.action), ["start", "read", "close"]);
  assert.equal(hasButton(labels.preview), false); assert.equal(hasButton("读取当前岗位页"), false);
  assert.equal(calls[2]!.init!.keepalive, true);
});

test("changing the active job during an ambiguous save aborts it and never reads or publishes its late receipt", async () => {
  const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
  const calls = installFetch(call => {
    if (call.path === paths.write) { signal = call.init?.signal as AbortSignal; return late.promise; }
    return defaultResponse(call);
  });
  const value = { ...props(), onSnapshot: () => { snapshots++; } }; await save(value);
  const otherJob = { ...JOB, id: "synthetic-other-job", listingIds: [LISTING.id] };
  await render({ ...value, jobId: otherJob.id, data: { ...BASE, jobs: [otherJob], listings: [{ ...LISTING, canonicalJobId: otherJob.id }] } });
  assert.equal(signal?.aborted, true);
  await act(async () => late.resolve(response(RECEIPT)));
  assert.equal(snapshots, 0); assert.equal(hasButton(labels.retry), false); assert.equal(hasButton(labels.office), false);
  assert.equal(calls.filter(call => call.path === paths.snapshot).length, 0); assert.equal(button(labels.read).disabled, false);
});

test("an abandoned browser start seals only its original start request and cannot attach its late session", async () => {
  const late = deferred<Response>(); const calls = installFetch(call => {
    assert.equal(call.path, paths.browser);
    if (call.body!.action === "start") return late.promise;
    assert.equal(call.body!.action, "cancel-start"); return rawResponse({ cancelled: true, closed: true });
  });
  await render(); await click("打开专用岗位页"); await act(async () => root!.unmount()); root = undefined;
  await act(async () => late.resolve(rawResponse({ sessionId: "synthetic_late_session_123456", platform: "猎聘", url: JOB_URL, expiresAt: new Date(Date.now() + 600_000).toISOString() })));
  assert.deepEqual(calls.map(call => call.body!.action), ["start", "cancel-start"]);
  assert.equal(calls[1]!.body!.input, calls[0]!.body!.input); assert.equal(calls[1]!.body!.requestId, calls[0]!.body!.requestId);
});

test("a failed exact-session close survives unmount and is explicitly retried without stopping another browser", async () => {
  const sessionId = "synthetic_address_close_failure_012345"; let closes = 0;
  assert.equal(jdBrowserCleanupTracker.getSnapshot().pending, 0);
  const calls = installFetch(call => {
    assert.equal(call.path, paths.browser);
    if (call.body!.action === "start") return rawResponse({ sessionId, platform: "猎聘", url: JOB_URL, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    assert.deepEqual(call.body, { action: "close", sessionId });
    if (++closes === 1) throw new TypeError("Synthetic exact close response lost");
    return rawResponse({ closed: true });
  });
  const value = props(); await render(value); await click("打开专用岗位页");
  await act(async () => root!.unmount()); root = undefined;
  assert.equal(jdBrowserCleanupTracker.getSnapshot().pending, 1);
  await render(value); assert.equal(button("打开专用岗位页").disabled, true);
  await click("重试清理先前岗位页");
  assert.equal(jdBrowserCleanupTracker.getSnapshot().pending, 0); assert.equal(button("打开专用岗位页").disabled, false);
  assert.deepEqual(calls.map(call => call.body!.action), ["start", "close", "close"]);
  assert.deepEqual(calls[2]!.body, calls[1]!.body); assert.equal(calls.some(call => call.body!.action === "stop-browser"), false);
});

test("an abandoned start whose cancellation fails records exact cleanup after unmount and can be recovered in another pane", async () => {
  const late = deferred<Response>(); let cancellations = 0;
  assert.equal(jdBrowserCleanupTracker.getSnapshot().pending, 0);
  const calls = installFetch(call => {
    assert.equal(call.path, paths.browser);
    if (call.body!.action === "start") return late.promise;
    assert.equal(call.body!.action, "cancel-start");
    if (++cancellations === 1) throw new TypeError("Synthetic start cancellation unavailable");
    return rawResponse({ cancelled: true, closed: true });
  });
  await render(); await click("打开专用岗位页"); await act(async () => root!.unmount()); root = undefined;
  assert.equal(jdBrowserCleanupTracker.getSnapshot().pending, 1);
  await act(async () => late.resolve(rawResponse({ sessionId: "synthetic_failed_cancel_late_12345", platform: "猎聘", url: JOB_URL, expiresAt: new Date(Date.now() + 600_000).toISOString() })));
  await render(); assert.equal(button("打开专用岗位页").disabled, true);
  await click("重试清理先前岗位页");
  assert.equal(jdBrowserCleanupTracker.getSnapshot().pending, 0);
  assert.deepEqual(calls.map(call => call.body!.action), ["start", "cancel-start", "cancel-start"]);
  assert.deepEqual(calls[2]!.body, calls[1]!.body); assert.equal(calls[1]!.body!.requestId, calls[0]!.body!.requestId);
  assert.equal(calls[1]!.body!.input, JOB_URL); assert.equal(calls.some(call => call.body!.action === "stop-browser"), false);
});

test("the write deadline retains its ambiguous command for receipt recovery and rejects a late receipt", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const late = deferred<Response>(); let signal: AbortSignal | undefined, snapshots = 0;
  const calls = installFetch(call => {
    if (call.path !== paths.write) return defaultResponse(call);
    signal = call.init?.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); void late.promise.then(resolve);
    });
  });
  await save({ ...props(), onSnapshot: () => { snapshots++; } });
  await act(async () => mock.timers.tick(59_999)); assert.equal(signal?.aborted, false);
  await act(async () => mock.timers.tick(1)); assert.equal(signal?.aborted, true);
  assert.equal(button(labels.retry).disabled, false); assert.equal(button(labels.preview).disabled, true);
  await act(async () => late.resolve(response(RECEIPT)));
  assert.equal(snapshots, 0); assert.equal(hasButton(labels.office), false); assert.equal(calls.filter(call => call.path === paths.snapshot).length, 0);
});

test("desktop Escape respects handled and composing events, always closes the latest reader and removes its listener on unmount", async () => {
  let originalClosed = 0, latestClosed = 0;
  const value = { ...props(), onClose: () => { originalClosed++; } };
  installFetch(); await render(value);
  const consumed = new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true }); consumed.preventDefault();
  await act(async () => dom.dispatchEvent(consumed));
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
  assert.equal(originalClosed, 0);
  await render({ ...value, onClose: () => { latestClosed++; } });
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" })));
  assert.equal(originalClosed, 0); assert.equal(latestClosed, 1);
  await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭原岗位地址核对"]')!.click());
  assert.equal(latestClosed, 2);
  await act(async () => root!.unmount()); root = undefined;
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" })));
  assert.equal(latestClosed, 2);
});

test("desktop workspace exchanges its third reading column for address review while retaining the map, cards and scroll position", async () => {
  const { default: AtlasWorkspace } = await import("../src/components/AtlasWorkspace.tsx");
  const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
  mock.method(dom.HTMLElement.prototype, "getBoundingClientRect", () => ({ x: 0, y: 0, top: 0, left: 0, right: 1220, bottom: 800, width: 1220, height: 800, toJSON() {} }));
  const calls = installFetch(call => {
    if (call.path === paths.snapshot) return response(BASE);
    if (call.path === "/api/v1/sources") return response(BASE.sources);
    return defaultResponse(call);
  });
  dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  await act(async () => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" }, children: h(AtlasWorkspace, { onAnalyze() {}, onSaveOpportunity() {} }) })));
  await settled(() => hasButton("连接本机服务")); await click("连接本机服务");
  const token = dom.document.querySelector<HTMLInputElement>('input[type="password"]'); assert.ok(token);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(token, "synthetic-desktop-address-token");
    token.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
  await click("连接并读取索引"); await settled(() => dom.document.querySelectorAll(".atlas-job-card").length === 1 && !!dom.document.querySelector('[data-detail-address-map-probe]'));
  assert.equal(dom.document.querySelector(".atlas-workspace")!.getAttribute("data-pane-layout"), "wide");
  const card = dom.document.querySelector<HTMLButtonElement>(".atlas-job-card")!, list = dom.document.querySelector<HTMLDivElement>(".atlas-job-list")!, map = dom.document.querySelector('[data-detail-address-map-probe]')!;
  const mounts = mapMounts; list.scrollTop = 137;
  await act(async () => card.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, detail: 1, button: 0 })));
  assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]'));
  await click("读取原岗位办公地点"); await settled(() => !!dom.document.querySelector('[aria-label="原岗位办公地点读取"]'));
  const review = dom.document.querySelector('[aria-label="岗位办公地址核对面板"]')!;
  assert.equal(dom.document.querySelector('[aria-label="地图岗位详情"]'), null, "the address reader replaces the same reading column");
  assert.ok(dom.document.getElementById(card.getAttribute("aria-controls")!) === review, "the expanded card still controls the replacement reading pane");
  assert.equal(dom.document.querySelectorAll('#atlas-job-detail').length, 1);
  assert.equal(review.parentElement?.querySelectorAll(":scope > .atlas-job-detail").length, 1);
  assert.equal(review.getAttribute("role"), null); assert.equal(review.getAttribute("aria-modal"), null);
  assert.equal(dom.document.querySelector(".atlas-job-card"), card); assert.equal(dom.document.querySelector(".atlas-job-list"), list);
  assert.equal(dom.document.querySelector('[data-detail-address-map-probe]'), map); assert.equal(mapMounts, mounts); assert.equal(list.scrollTop, 137);
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" })));
  assert.equal(dom.document.querySelector('[aria-label="岗位办公地址核对面板"]'), null); assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]'));
  await click("读取原岗位办公地点"); await settled(() => !!dom.document.querySelector('[aria-label="原岗位办公地点读取"]'));
  await act(async () => card.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, detail: 1, button: 0 })));
  assert.equal(dom.document.querySelector('[aria-label="岗位办公地址核对面板"]'), null, "a card click returns to ordinary desktop reading");
  assert.ok(dom.document.querySelector('[aria-label="地图岗位详情"]')); assert.equal(mapMounts, mounts); assert.equal(list.scrollTop, 137);
  assert.equal(calls.some(call => [paths.extract, paths.preview, paths.write].includes(call.path)), false, "opening and closing a reader never captures or saves a location");
});

test("React extracts a same-job address then explicitly imports it through strict authenticated HTTP and SQLite without replacing JD or salary", async () => {
  const repository = openJobRepository(":memory:", { now: () => NOW });
  const application = createJobApplication({ repository, now: () => NOW });
  const server = createJobHttpServer({ registry: application.registry, token: TOKEN, allowedOrigins: [dom.location.origin], port: 0 });
  const { url } = await server.listen();
  const nativeFetch = globalThis.fetch;
  const sourceClient = createAtlasSourceClient(url, TOKEN), capture = cardCapture(), posting = { "@type": "JobPosting", title: capture.cards[0]!.title,
    url: JOB_URL, description, hiringOrganization: { "@type": "Organization", name: capture.cards[0]!.company }, jobLocation: address };
  const html = `<html><head><title>${posting.title}</title><link rel="canonical" href="${JOB_URL}"><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><h1>${posting.title}</h1><div class="job-intro-content">${description}</div></body></html>`;
  const extracted = extractPublicJobHtml(html, "猎聘", JOB_URL, { requireVisibleDescription: true, capturedAt: DETAIL_AT });
  assert.ok(extracted.detailLocations);
  const requestPaths: string[] = [], snapshots: AtlasDataset[] = [], officeSnapshots: Array<{ data: AtlasDataset; location: JobLocation }> = [];
  try {
    const cardPreview = await sourceClient.previewReviewedCards({ ...capture, expectedRevision: 0 });
    await sourceClient.importReviewedCards({ ...capture, expectedRevision: 0, previewFingerprint: cardPreview.previewFingerprint, reviewed: true }, { idempotencyKey: "synthetic-integrated-card" });
    const before = await repository.readSnapshot(), job = before.jobs[0]!, listing = before.listings[0]!;
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), dom.location.href).pathname; requestPaths.push(path);
      if (path === paths.extract) return rawResponse({ ...extracted, provenance: { kind: "link", platform: "猎聘", url: JOB_URL, observedAt: DETAIL_AT } });
      return nativeFetch(input, init);
    });
    const value = { ...props(), endpoint: url, token: TOKEN, data: before, jobId: job.id, onSnapshot: (data: AtlasDataset) => snapshots.push(data),
      onOfficeSnapshot: (data: AtlasDataset, location: JobLocation) => officeSnapshots.push({ data, location }) };
    await render(value); assert.deepEqual(await repository.readSnapshot(), before);
    await click(labels.read); assert.deepEqual(await repository.readSnapshot(), before);
    await click(labels.preview); await settled(() => !!dom.document.querySelector('.atlas-detail-address-preview'));
    assert.equal(button(labels.save).disabled, true); assert.deepEqual(await repository.readSnapshot(), before);
    await confirm(); await click(labels.save); await settled(() => snapshots.length === 1);
    const after = await repository.readSnapshot(), next = after.jobs.find(entry => entry.id === job.id)!;
    assert.equal(after.revision, before.revision + 1); assert.equal(after.jobs.length, 1); assert.equal(after.listings.length, 1);
    assert.equal(after.snapshots.length, before.snapshots.length); assert.deepEqual(after.snapshots, before.snapshots);
    assert.deepEqual(after.compensations, before.compensations); assert.deepEqual(next.description, job.description); assert.deepEqual(next.title, job.title);
    assert.deepEqual(next.compensationIds, job.compensationIds); assert.deepEqual(next.listingIds, job.listingIds);
    const location = after.locations.find(entry => next.locationIds.includes(entry.id))!;
    assert.equal(location.streetAddress, address.address.streetAddress); assert.equal(location.postalCode, "200000"); assert.equal(location.city, "Shanghai");
    assert.equal(location.countryCode, "CN"); assert.equal(location.kind, "office"); assert.equal(location.verification, "unverified");
    assert.equal(location.coordinates, undefined); assert.equal(location.precision, "city");
    assert.equal(location.evidence[0]!.sourceUrl, JOB_URL); assert.equal(location.evidence[0]!.quote, JSON.stringify(address));
    assert.equal(after.listings[0]!.id, listing.id); assert.deepEqual(after.listings[0]!.locationIds, [location.id]);
    assert.deepEqual(requestPaths, [paths.extract, paths.preview, paths.write, paths.snapshot]);
    const beforeOfficeQuery = await queryJobs(after, { search: { text: "C#" } });
    assert.equal(beforeOfficeQuery.items.length, 1); assert.equal(createJobMapFocus(beforeOfficeQuery.items[0]!, "synthetic-before-office"), null);
    await click(labels.office); await act(async () => { await import("../src/components/atlas/AtlasOfficeAddressConfirmation.tsx"); });
    assert.ok(dom.document.querySelector('[aria-label="核对并保存办公地址"]'));
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="办公街道门牌"]')!.value, address.address.streetAddress);
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="办公地址邮编"]')!.value, "200000");
    assert.deepEqual(await repository.readSnapshot(), after, "opening manual office review must not invent coordinates or write again");
    await change("完整办公地址", "Synthetic Example Road 10, Shanghai 200000, CN");
    await change("办公地址纬度", "31.123456"); await change("办公地址经度", "121.654321");
    await change("办公地址依据链接", JOB_URL); await change("办公地址核对说明", "Synthetic user explicitly checked this fictional same-job building address and WGS84 point.");
    await click("预览办公地址变更"); await settled(() => !!dom.document.querySelector(".atlas-office-preview"));
    assert.equal(button("确认保存办公地址").disabled, true); assert.deepEqual(await repository.readSnapshot(), after);
    const officeCheck = dom.document.querySelector<HTMLInputElement>('.atlas-office-preview input[type="checkbox"]'); assert.ok(officeCheck);
    await act(async () => officeCheck.click()); await click("确认保存办公地址"); await settled(() => officeSnapshots.length === 1);
    const final = officeSnapshots[0]!.data, finalLocation = final.locations.find(entry => entry.id === location.id)!;
    assert.equal(officeSnapshots[0]!.location.id, location.id); assert.equal(final.revision, after.revision + 1);
    assert.deepEqual(finalLocation.coordinates, { latitude: 31.123456, longitude: 121.654321, coordinateSystem: "WGS84" });
    assert.equal(finalLocation.precision, "address"); assert.equal(finalLocation.verification, "unverified");
    assert.deepEqual(finalLocation.evidence, location.evidence); assert.deepEqual(final.compensations, before.compensations); assert.deepEqual(final.snapshots, before.snapshots);
    const query = await queryJobs(final, { search: { text: "C#" } }); assert.equal(query.items.length, 1);
    const focus = createJobMapFocus(query.items[0]!, "synthetic-address-double-click", { locationId: location.id }); assert.ok(focus);
    assert.equal(focus.zoom, 16.5); assert.equal(focus.positionBasis, "office-confirmation"); assert.equal(focus.jobId, job.id); assert.equal(focus.locationId, location.id);
    assert.equal(focus.latitude, 31.123456); assert.equal(focus.longitude, 121.654321); assert.equal(focus.verification, "unverified");
    assert.match(dom.document.body.textContent!, /办公位置以当前核对记录为准/);
    assert.doesNotMatch(dom.document.body.textContent!, /尚未保存地址或坐标|尚未生成办公坐标/);
    assert.equal(requestPaths.filter(path => path === paths.write).length, 1);
    assert.equal(requestPaths.filter(path => path === "/api/v1/locations/office-address/confirmations").length, 1);
  } finally { await clean(); await server.close(); await application.shutdown(); repository.close(); }
});
