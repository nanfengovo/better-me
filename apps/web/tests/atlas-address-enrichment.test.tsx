import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLTextAreaElement } from "happy-dom";
import { applyOfficeAddressConfirmation, type AddressEnrichmentPlan, type AddressEnrichmentPlanItem, type AtlasDataset,
  SourceDefinitionSchema, queryJobs, type JobLocation, type OfficeAddressCandidatesResult, type OfficeAddressProposal } from "@better-me/opportunities";
import { PlatformDetailLocationsSchema, ReviewedCardsCaptureSchema, parsePlatformJobLocations,
  type CompanyCareerDiscoveryResult, type PlatformDetailLocations } from "@better-me/source-adapters/browser-contracts";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { projectSourcePage } from "../../job-service/src/projection.ts";
import { reviewedCardsPage, reviewedCardsSource } from "../../job-service/src/reviewed-cards.ts";
import { createJobApplication } from "../../job-service/src/application.ts";
import { createJobHttpServer } from "../../job-service/src/http.ts";
import { readJobPostingJsonLd } from "@better-me/source-adapters";
import type { AtlasAddressEnrichmentProps } from "../src/components/atlas/AtlasAddressEnrichment.tsx";

const dom = new Window({ url: "http://synthetic-address-batch.invalid" });
const nativeHttpFetch = globalThis.fetch;
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
const { AtlasAddressEnrichment } = await import("../src/components/atlas/AtlasAddressEnrichment.tsx");
const AT = "2026-10-19T12:00:00.000Z", DETAIL_AT = "2026-10-19T12:01:00.000Z", NOW = "2026-10-19T12:02:00.000Z";
const paths = { plan: "/api/v1/jobs/address-enrichment/plan", extract: "/api/jd/extract", candidates: "/api/v1/locations/office-address/candidates",
  company: "/api/v1/companies/discover-careers", preview: "/api/v1/jobs/detail-locations/preview", write: "/api/v1/jobs/detail-locations/import", snapshot: "/api/v1/dataset/export" };
const labels = { read: "读取所选岗位的办公地点", save: "确认保存选中来源地址", retry: "核对本次保存回执", refresh: "重新读取已保存索引", cancel: "取消本轮读取" };
const companyName = "Synthetic address-batch employer";
const address = { "@type": "Place", address: { "@type": "PostalAddress", streetAddress: "Synthetic Batch Road 10", addressLocality: "Shanghai", addressRegion: "Shanghai", postalCode: "200000", addressCountry: "CN" } };
async function seededData(): Promise<AtlasDataset> {
  const repository = openJobRepository(":memory:", { now: () => NOW });
  const pageUrl = "https://www.liepin.com/zhaopin/?key=Synthetic";
  const capture = ReviewedCardsCaptureSchema.parse({ provider: "liepin", pageUrl, capturedAt: AT, cards: Array.from({ length: 4 }, (_, index) => {
    const title = `Synthetic batch engineer ${index}`, url = `https://www.liepin.com/job/${1234567890 + index}.shtml`;
    return { platform: "猎聘", url, title, company: companyName, locationText: "Shanghai", cardText: `${title} ${companyName} Shanghai Synthetic source excerpt only.`,
      evidence: { pageUrl, cardSelector: `.synthetic-card-${index}`, fields: [{ field: "url", selector: "a[href]", text: url },
        { field: "title", selector: ".title", text: title }, { field: "company", selector: ".company", text: companyName }, { field: "locationText", selector: ".location", text: "Shanghai" }] } };
  }) });
  try {
    const projected = await projectSourcePage(await repository.readProjectionSnapshot(), reviewedCardsSource("liepin"), reviewedCardsPage(capture), "synthetic-batch-seed", { mode: "user-reviewed-browser" });
    for (const location of projected.delta.locations) location.kind = "unknown";
    await repository.importSnapshot(projected.delta, { actorScope: "synthetic-seed", idempotencyKey: "seed", expectedRevision: 0 });
    return await repository.readSnapshot();
  } finally { repository.close(); }
}
const BASE = await seededData(), JOB = BASE.jobs[0]!;
function listing(jobId = JOB.id) { const result = BASE.listings.find(value => value.canonicalJobId === jobId); assert.ok(result); return result; }
function capture(url = listing().canonicalUrl): PlatformDetailLocations {
  const parsed = parsePlatformJobLocations({ jobLocation: address }); assert.ok(parsed);
  return PlatformDetailLocationsSchema.parse({ version: 1, provider: "liepin", url, capturedAt: DETAIL_AT, ...parsed });
}
function extraction(value = capture()) {
  return { text: "Synthetic complete description for a fictional employer: software delivery, maintain systems, test reliability and write documentation.",
    method: "Synthetic JSON-LD", provenance: { kind: "link", platform: "猎聘", url: value.url, observedAt: DETAIL_AT }, detailLocations: value };
}
function location(jobId = JOB.id): JobLocation {
  return { ...capture(listing(jobId).canonicalUrl).locations[0]!, id: `${jobId}-source-street`, kind: "office", precision: "city", verification: "unverified",
    evidence: [{ observationId: `${jobId}-detail-observation`, sourceUrl: listing(jobId).canonicalUrl, observedAt: DETAIL_AT, ...capture().locations[0]!.evidence }] };
}
function item(jobId = JOB.id, overrides: Partial<AddressEnrichmentPlanItem> = {}): AddressEnrichmentPlanItem {
  const job = BASE.jobs.find(value => value.id === jobId) ?? { ...JOB, id: jobId };
  const source = listing(BASE.jobs.some(value => value.id === jobId) ? jobId : JOB.id);
  return { jobId, title: job.title.value, companyId: job.companyId, companyName, status: "platform-detail", currentOffice: [], sourceStreetTargets: [],
    pendingLocationIds: ["remote-only", "office-ready"].includes(overrides.status ?? "") ? [] : overrides.sourceStreetTargets?.map(target => target.locationId) ?? job.locationIds,
    exactPlatformTargets: [{ listingId: source.id, sourceId: source.sourceId, provider: "liepin", url: source.canonicalUrl, label: "Synthetic original listing" }],
    ownedOfficialTargets: [], companyLookup: { companyName, association: "unverified", strength: "weak" }, truncated: false, warnings: [], ...overrides };
}
function streetTarget(sourceLocation = location()) {
  return { listingId: listing().id, sourceId: listing().sourceId, locationId: sourceLocation.id,
    sourceUrl: listing().canonicalUrl, sourceLocation };
}
function streetResult(sourceLocation = location(), matched = false): OfficeAddressCandidatesResult {
  return { revision: BASE.revision, jobId: JOB.id, locationId: sourceLocation.id, sourceLocation, configured: true,
    status: matched ? "candidates" : "no-address-match", warnings: [], candidates: matched ? [{ id: `${sourceLocation.id}-candidate`,
      providerId: "synthetic-provider", estimated: true, verification: "unverified", attribution: "Synthetic geocoder",
      evidenceUrl: "https://maps.example.invalid/candidate", proposal: { basis: "manual-user-confirmation", countryCode: "CN",
        formattedAddress: "Synthetic Batch Road 10, Shanghai", streetAddress: "Synthetic Batch Road 10", postalCode: "200000",
        evidenceUrl: "https://maps.example.invalid/candidate", coordinateMeaning: "building",
        coordinates: { latitude: 31.123456, longitude: 121.654321, coordinateSystem: "WGS84" } } }] : [] };
}
function plan(items = [item()], revision = BASE.revision): AddressEnrichmentPlan {
  return { schemaVersion: 1, snapshotRevision: revision, requestedJobs: items.length, processedJobs: items.length,
    truncated: items.some(value => value.truncated), items, warnings: [] };
}
function discovery(name = companyName): CompanyCareerDiscoveryResult {
  return { status: "matched-existing", companyName: name, observedAt: DETAIL_AT, candidates: [], proposals: [], visitedUrls: [], partial: true, warnings: [],
    matchedSources: [{ sourceId: "synthetic-careers", name: "Synthetic careers", matchedBy: "company-name", enabled: true, status: "active", entryUrl: "https://careers.example.invalid/" }] };
}
let scopeNumber = 0;
function props(overrides: Partial<AtlasAddressEnrichmentProps> = {}): AtlasAddressEnrichmentProps {
  return { endpoint: "http://127.0.0.1:5178", token: `synthetic-batch-token-123456789-${++scopeNumber}`, data: BASE, jobIds: [JOB.id], onSnapshot() {}, onClose() {}, onReviewJob() {}, onReviewOffice() {}, ...overrides };
}
type Call = { path: string; init?: RequestInit; body: Record<string, unknown>; key: string | null };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-batch-request", value }));
const raw = (value: unknown) => new Response(JSON.stringify(value));
function installFetch(handler: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: new URL(String(url), dom.location.href).pathname, init, body: init?.body ? JSON.parse(String(init.body)) : {}, key: new Headers(init?.headers).get("Idempotency-Key") };
    calls.push(call); return handler(call, calls);
  });
  return calls;
}
let root: ReturnType<typeof createRoot> | undefined;
async function render(value = props(), strict = false) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(strict ? h(React.StrictMode, null, h(AtlasAddressEnrichment, value)) : h(AtlasAddressEnrichment, value)));
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === label);
  assert.ok(found, `Missing ${label}: ${dom.document.body.textContent}`); return found;
}
async function click(label: string) { await act(async () => button(label).click()); }
function checks() { return [...dom.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; }
async function check(index = 0) { const entry = checks()[index]; assert.ok(entry); await act(async () => entry.click()); }
async function change(label: string, value: string) {
  const entry = dom.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); assert.ok(entry);
  await act(async () => {
    const prototype = entry.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value);
    entry.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}
async function clean() {
  if (root) await act(async () => root!.unmount()); root = undefined;
  mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren(); dom.localStorage.clear(); dom.sessionStorage.clear();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settled(predicate: () => boolean) {
  for (let attempt = 0; attempt < 150; attempt++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); if (predicate()) return; }
  assert.fail(`Synthetic batch action did not settle: ${dom.document.body.textContent}`);
}
afterEach(clean);
after(() => { hooks.deregister(); void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
} });

test("batch opening is inert, discloses provider data and scopes at most fifty unique loaded selections", async () => {
  const ids = Array.from({ length: 55 }, (_, index) => `synthetic-batch-${index}`), value = props({ jobIds: [ids[0]!, ...ids] });
  const calls = installFetch(call => { assert.equal(call.path, paths.plan); return response(plan((call.body.jobIds as string[]).map(id => item(id, { status: "remote-only", exactPlatformTargets: [] })))); });
  await render(value, true); assert.equal(calls.length, 0);
  assert.match(dom.document.body.textContent!, /当前已加载 55 岗.*选择前 50 岗/s);
  assert.match(dom.document.body.textContent!, /街道、城市和邮编会发送给已配置的地址服务/);
  assert.equal(checks().length, 0); await click(labels.read);
  assert.deepEqual(calls[0]!.body, { jobIds: ids.slice(0, 50), expectedRevision: BASE.revision });
  assert.equal(calls.length, 1); assert.equal(dom.document.querySelectorAll('article [data-status="skipped"]').length, 50);
  assert.equal(dom.localStorage.length, 0); assert.equal(dom.sessionStorage.length, 0);
});

test("two-job read queue is bounded, skips office-ready and remote jobs, and preserves partial results", async () => {
  const selected = BASE.jobs.map(value => value.id), waiting = deferred<Response>(); let inFlight = 0, maximum = 0, extracts = 0;
  const ready = { ...location(selected[2]), coordinates: { latitude: 31, longitude: 121, coordinateSystem: "WGS84" as const }, precision: "address" as const };
  const items = selected.map(id => item(id)); items[2] = item(selected[2], { status: "office-ready", currentOffice: [ready] });
  items[3] = item(selected[3], { status: "remote-only", exactPlatformTargets: [] });
  const calls = installFetch(async call => {
    if (call.path === paths.plan) return response(plan(items));
    if (call.path === paths.company) return response(discovery());
    assert.equal(call.path, paths.extract); inFlight++; maximum = Math.max(maximum, inFlight); extracts++;
    if (extracts === 2) { inFlight--; throw new Error("Synthetic one-source failure"); }
    const result = await waiting.promise; inFlight--; return result;
  });
  await render(props({ jobIds: selected })); await click(labels.read); await settled(() => extracts === 2);
  assert.equal(maximum, 2); await act(async () => waiting.resolve(raw(extraction(capture(listing(selected[0]).canonicalUrl)))));
  await settled(() => dom.document.querySelector('section')?.getAttribute("aria-busy") === "false");
  assert.equal(calls.filter(call => call.path === paths.extract).length, 2); assert.equal(checks().length, 1);
  assert.equal(dom.document.querySelectorAll('[data-status="skipped"]').length, 2); assert.equal(dom.document.querySelectorAll('[data-status="error"]').length, 1);
  assert.match(dom.document.body.textContent!, /无法连接岗位读取服务/);
});

test("street candidates receive only the explicit source street constraints and remain read-only until manual continuation", async () => {
  const source = location(), row = item(JOB.id, { status: "source-street", exactPlatformTargets: [], sourceStreetTargets: [{ listingId: listing().id,
    sourceId: listing().sourceId, locationId: source.id, sourceUrl: listing().canonicalUrl, sourceLocation: source }] });
  const result: OfficeAddressCandidatesResult = { revision: BASE.revision, jobId: JOB.id, locationId: source.id, sourceLocation: source, configured: true, status: "candidates", warnings: [],
    candidates: [{ id: "synthetic-candidate", providerId: "synthetic-provider", estimated: true, verification: "unverified", attribution: "Synthetic geocoder",
      evidenceUrl: "https://maps.example.invalid/candidate", proposal: { basis: "manual-user-confirmation", countryCode: "CN", formattedAddress: "Synthetic Batch Road 10, Shanghai",
        streetAddress: "Synthetic Batch Road 10", postalCode: "200000", evidenceUrl: "https://maps.example.invalid/candidate", coordinateMeaning: "building",
        coordinates: { latitude: 31.123456, longitude: 121.654321, coordinateSystem: "WGS84" } } }] };
  const continued: string[][] = [], snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => call.path === paths.plan ? response(plan([row])) : response(result));
  await render(props({ onReviewOffice: (...args) => continued.push(args), onSnapshot: data => snapshots.push(data) })); await click(labels.read);
  assert.deepEqual(calls.map(call => call.path), [paths.plan, paths.candidates]);
  assert.deepEqual(calls[1]!.body, { jobId: JOB.id, locationId: source.id, expectedRevision: BASE.revision, query: source.streetAddress, locality: source.city, postalCode: source.postalCode });
  assert.match(dom.document.body.textContent!, /办公地址候选 · 尚未采用/); assert.equal(checks().length, 0); assert.equal(snapshots.length, 0);
  await click("核对具体办公点"); assert.deepEqual(continued, [[JOB.id, source.id]]); assert.equal(calls.length, 2);
});

for (const outcome of ["no-match", "unconfigured", "failure"] as const) test(`unresolved source street continues to weak company discovery after ${outcome}`, async () => {
  const source = location(), row = item(JOB.id, { status: "source-street", exactPlatformTargets: [], sourceStreetTargets: [streetTarget(source)] });
  const snapshots: AtlasDataset[] = [], calls = installFetch(call => {
    if (call.path === paths.plan) return response(plan([row]));
    if (call.path === paths.company) return response(discovery());
    assert.equal(call.path, paths.candidates);
    if (outcome === "failure") throw new Error("Synthetic geocoder unavailable");
    return response({ ...streetResult(source), ...(outcome === "unconfigured" ? { configured: false, status: "not-configured" } : {}) });
  });
  await prepared(props({ onSnapshot: snapshot => snapshots.push(snapshot) }));
  assert.deepEqual(calls.map(call => call.path), [paths.plan, paths.candidates, paths.company]);
  assert.match(dom.document.body.textContent!, /企业招聘入口 · 关联待核实/);
  assert.match(dom.document.body.textContent!, /此处未确认同一岗位或办公地址/);
  assert.equal(checks().length, 0); assert.equal(snapshots.length, 0); assert.equal(dom.localStorage.length, 0); assert.equal(dom.sessionStorage.length, 0);
  assert.equal(dom.document.querySelector('[data-status="error"]') !== null, outcome === "failure");
});

test("a candidate for one workplace cannot suppress fallback for another unmatched or unsearched workplace", async () => {
  const sources = [location(), { ...location(), id: "synthetic-second-street" }, { ...location(), id: "synthetic-third-street" }];
  for (const mode of ["all-matched", "second-unmatched", "pending-city", "capped-third-street"] as const) {
    const selected = sources.slice(0, mode === "capped-third-street" ? 3 : 2), pending = selected.map(source => source.id);
    const row = item(JOB.id, { status: "source-street", exactPlatformTargets: [], sourceStreetTargets: selected.map(streetTarget),
      pendingLocationIds: mode === "pending-city" ? [...pending, "synthetic-city-only-workplace"] : pending });
    const calls = installFetch(call => {
      if (call.path === paths.plan) return response(plan([row]));
      if (call.path === paths.company) return response(discovery());
      assert.equal(call.path, paths.candidates);
      const source = selected.find(source => source.id === call.body.locationId); assert.ok(source);
      return response(streetResult(source, mode !== "second-unmatched" || source.id !== selected[1]!.id));
    });
    await prepared(); assert.equal(calls.filter(call => call.path === paths.candidates).length, 2);
    assert.equal(calls.filter(call => call.path === paths.company).length, mode === "all-matched" ? 0 : 1, mode);
    assert.equal(checks().length, 0); assert.equal(calls.some(call => call.path === paths.write || call.path === paths.preview), false);
    assert.match(dom.document.body.textContent!, /办公地址候选 · 尚未采用/);
    if (mode === "capped-third-street") assert.match(dom.document.body.textContent!, /本轮每岗最多读取 2 个街址/);
    await clean();
  }
});

test("cancelling an unresolved street search never starts a late company fallback", async () => {
  const waiting = deferred<Response>(), source = location();
  const row = item(JOB.id, { status: "source-street", exactPlatformTargets: [], sourceStreetTargets: [streetTarget(source)] });
  const calls = installFetch(call => call.path === paths.plan ? response(plan([row])) : waiting.promise);
  await prepared(); await settled(() => calls.length === 2); await click(labels.cancel);
  await act(async () => waiting.resolve(response(streetResult(source))));
  await settled(() => dom.document.querySelector('section')?.getAttribute("aria-busy") === "false");
  assert.deepEqual(calls.map(call => call.path), [paths.plan, paths.candidates]);
  assert.equal(checks().length, 0); assert.equal(dom.document.querySelector('.atlas-enrichment-company'), null);
  assert.equal(dom.document.querySelector('[data-status="cancelled"]')?.textContent, "已取消");
});

test("company lookups deduplicate per company and expose weak entry links without borrowing office addresses", async () => {
  const ids = BASE.jobs.slice(0, 3).map(value => value.id), items = ids.map(id => item(id, { status: "company-discovery", exactPlatformTargets: [] }));
  items[0] = { ...items[0]!, status: "official-source", ownedOfficialTargets: [{ listingId: listing(ids[0]).id, sourceId: "synthetic-official", adapterId: "jsonld", url: "https://careers.example.invalid/jobs/one", label: "Synthetic official job" }] };
  const calls = installFetch(call => call.path === paths.plan ? response(plan(items)) : response(discovery()));
  await render(props({ jobIds: ids })); await click(labels.read);
  assert.equal(calls.filter(call => call.path === paths.company).length, 1);
  assert.deepEqual(calls[1]!.body, { request: { companyName, limit: 5, maxPages: 2 } });
  assert.equal(checks().length, 0); assert.equal(dom.document.querySelectorAll('.atlas-enrichment-company').length, 3);
  assert.match(dom.document.body.textContent!, /企业招聘入口 · 关联待核实/); assert.match(dom.document.body.textContent!, /此处未确认同一岗位或办公地址/);
  assert.ok(dom.document.querySelector('a[href="https://careers.example.invalid/jobs/one"]'));
  assert.equal(dom.document.querySelectorAll('[href="https://careers.example.invalid/"]').length, 3);
});

test("edited, other-job, undisclosed, remote-only and malformed source captures cannot be selected or saved", async () => {
  const remote = PlatformDetailLocationsSchema.parse({ ...capture(), locations: [], workMode: "remote", workModeEvidence: { selector: "jobLocationType", quote: '"TELECOMMUTE"' } });
  const forged = structuredClone(capture()); forged.locations[0]!.streetAddress = "Unquoted fabricated office";
  const city = parsePlatformJobLocations({ jobLocation: { address: { addressCountry: "CN", addressLocality: "Shanghai" } } }); assert.ok(city);
  const cityCapture = PlatformDetailLocationsSchema.parse({ version: 1, provider: "liepin", url: listing().canonicalUrl, capturedAt: DETAIL_AT, ...city });
  const variants = [{ ...extraction(), provenance: { ...extraction().provenance, edited: true } }, extraction(capture("https://www.liepin.com/job/9876543210.shtml")),
    extraction(remote), extraction(cityCapture), extraction(forged)];
  for (const payload of variants) {
    const calls = installFetch(call => call.path === paths.plan ? response(plan()) : call.path === paths.company ? response(discovery()) : raw(payload));
    await render(); await click(labels.read); assert.equal(checks().length, 0); assert.equal(calls.length, 3);
    assert.equal(dom.document.querySelector('.atlas-enrichment-save'), null); await clean();
  }
});

test("cancelled reads retain completed rows but ignore late captures and do not write or publish", async () => {
  const waiting = deferred<Response>(), snapshots: AtlasDataset[] = [];
  const calls = installFetch(call => call.path === paths.plan ? response(plan()) : waiting.promise);
  await render(props({ onSnapshot: data => snapshots.push(data) })); await click(labels.read); await settled(() => calls.length === 2);
  await click(labels.cancel); assert.equal(calls[1]!.init!.signal!.aborted, true);
  await act(async () => waiting.resolve(raw(extraction()))); await settled(() => dom.document.querySelector('section')?.getAttribute('aria-busy') === 'false');
  assert.equal(checks().length, 0); assert.equal(snapshots.length, 0); assert.equal(calls.length, 2);
  assert.equal(dom.document.querySelector('[data-status="cancelled"]')?.textContent, "已取消");
});

test("closing and changing connection identity isolate late reads without implicit external requests", async () => {
  for (const change of ["close", "token", "endpoint", "scope"] as const) {
    const waiting = deferred<Response>(); let closes = 0; const value = props({ onClose() { closes++; } });
    const calls = installFetch(call => call.path === paths.plan ? response(plan()) : waiting.promise);
    await render(value); await click(labels.read); await settled(() => calls.length === 2);
    if (change === "close") { await act(async () => dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭批量地址核对"]')!.click()); assert.equal(closes, 1); }
    else await render({ ...value, ...(change === "token" ? { token: `${value.token}-changed` } : change === "endpoint" ? { endpoint: "http://127.0.0.1:5179" } : { jobIds: [BASE.jobs[1]!.id] }) });
    assert.equal(calls[1]!.init!.signal!.aborted, true); await act(async () => waiting.resolve(raw(extraction())));
    assert.equal(checks().length, 0); assert.equal(calls.length, 2); await clean();
  }
});

function savingFetch(options: { failWrite?: boolean; failAfterWriteGet?: boolean; initialGetRevision?: number } = {}) {
  let current = BASE, writeAttempts = 0, postWriteGets = 0;
  const calls = installFetch(call => {
    if (call.path === paths.plan) return response(plan((call.body.jobIds as string[]).map(id => item(id)), Number(call.body.expectedRevision)));
    if (call.path === paths.extract) return raw(extraction(capture(String(call.body.input))));
    if (call.path === paths.snapshot) {
      if (writeAttempts && options.failAfterWriteGet && postWriteGets++ === 0) throw new Error("Synthetic snapshot failure");
      return response(!writeAttempts && options.initialGetRevision !== undefined ? { ...current, revision: options.initialGetRevision } : current);
    }
    const jobId = String(call.body.jobId), target = listing(jobId), sourceLocation = location(jobId), revision = Number(call.body.expectedRevision);
    if (call.path === paths.preview) return response({ jobId, listingId: target.id, sourceId: target.sourceId, expectedRevision: revision,
      previewFingerprint: "c".repeat(64), newLocations: [sourceLocation], previousLocationIds: target.locationIds, warnings: ["Synthetic disclosure remains unverified and has no office coordinates."] });
    assert.equal(call.path, paths.write); writeAttempts++;
    if (options.failWrite && writeAttempts === 1) throw new Error("Synthetic unknown write response");
    const observation = { id: `${jobId}-detail-observation`, listingId: target.id, fetchedAt: DETAIL_AT, detailFetchedAt: DETAIL_AT, result: "partial" as const,
      availability: "unknown" as const, completeness: "excerpt" as const, warnings: [] };
    current = { ...current, revision: revision + 1, jobs: current.jobs.map(job => job.id === jobId ? { ...job, locationIds: [sourceLocation.id], revision: job.revision + 1 } : job),
      listings: current.listings.map(entry => entry.id === target.id ? { ...entry, locationIds: [sourceLocation.id], observationIds: [...entry.observationIds, observation.id] } : entry),
      locations: [...current.locations, sourceLocation], observations: [...current.observations, observation] };
    return response({ ok: true, revision: current.revision, jobIds: [jobId], snapshotIds: [], counts: { newJobs: 0, updatedJobs: 1, unchangedJobs: 0, newListings: 0, newObservations: 1, newSnapshots: 0 } });
  });
  return calls;
}
async function prepared(value = props()) { await render(value); await click(labels.read); }

test("explicit per-source checkboxes save sequentially via fresh snapshot, preview, stable write and confirmed snapshot", async () => {
  const calls = savingFetch(), snapshots: AtlasDataset[] = [], ids = BASE.jobs.slice(0, 2).map(value => value.id), offices: string[][] = [];
  await prepared(props({ jobIds: ids, onSnapshot: data => snapshots.push(data), onReviewOffice: (...args) => offices.push(args) }));
  assert.equal(checks().length, 2); assert.equal(snapshots.length, 0);
  await check(0); await check(1); await click(labels.save);
  assert.deepEqual(calls.slice(3).map(call => call.path), [paths.snapshot, paths.preview, paths.write, paths.snapshot, paths.snapshot, paths.preview, paths.write, paths.snapshot]);
  const writes = calls.filter(call => call.path === paths.write);
  assert.equal(writes.length, 2); assert.notEqual(writes[0]!.key, writes[1]!.key); assert.match(writes[0]!.key!, /^address-batch-/);
  assert.equal(writes[1]!.body.expectedRevision, BASE.revision + 1); assert.equal(writes[0]!.body.reviewed, true);
  assert.equal(new Headers(writes[0]!.init!.headers).get("Authorization")?.startsWith("Bearer synthetic-batch-token-"), true);
  assert.equal(writes[0]!.init!.credentials, "omit"); assert.deepEqual(snapshots.map(value => value.revision), [BASE.revision + 1, BASE.revision + 2]);
  assert.equal(checks().every(value => value.disabled && !value.checked), true); assert.equal(dom.document.querySelector('.atlas-enrichment-save'), null);
  assert.equal(snapshots.at(-1)!.locations.filter(value => value.id.endsWith("-source-street")).every(value => !value.coordinates && !value.officeResolution), true);
  const count = calls.length; await click("核对具体办公点"); await act(async () => { await import("../src/components/atlas/AtlasOfficeAddressConfirmation.tsx"); });
  assert.ok(dom.document.querySelector('[aria-label="核对并保存办公地址"]')); assert.equal(calls.length, count); assert.deepEqual(offices, []);
  await click("返回批量结果"); assert.equal(checks().length, 2); assert.equal(checks().every(value => value.disabled), true);
});

test("server version changes before saving clear confirmation and never rebase old evidence automatically", async () => {
  const calls = savingFetch({ initialGetRevision: BASE.revision + 1 }); await prepared(); await check(); await click(labels.save);
  assert.equal(calls.filter(call => call.path === paths.write || call.path === paths.preview).length, 0);
  assert.equal(checks()[0]!.checked, false); assert.equal(checks()[0]!.disabled, true);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /索引版本已改变/);
});

test("prop version changes invalidate old selection; a fresh explicit read is required", async () => {
  const calls = savingFetch(), value = props(); await prepared(value); await check();
  await render({ ...value, data: { ...BASE, revision: BASE.revision + 1 } });
  assert.equal(checks()[0]!.checked, false); assert.equal(checks()[0]!.disabled, true);
  assert.equal(calls.filter(call => call.path === paths.write).length, 0);
  await click(labels.read); assert.equal(checks()[0]!.checked, false); assert.equal(checks()[0]!.disabled, false);
  assert.equal(calls.filter(call => call.path === paths.plan).at(-1)!.body.expectedRevision, BASE.revision + 1);
});

test("unknown write retries preserve the original body and idempotency key across closing and reopening the same scope", async () => {
  const calls = savingFetch({ failWrite: true }), value = props(); await prepared(value); await check(); await click(labels.save);
  assert.match(dom.document.body.textContent!, /本次保存结果待确认/);
  assert.equal(button(labels.read).disabled, true); const first = calls.find(call => call.path === paths.write)!;
  assert.equal(dom.localStorage.length, 0); assert.equal(dom.sessionStorage.length, 0);
  await act(async () => root!.unmount()); root = undefined;
  await render({ ...value, data: { ...BASE, jobs: BASE.jobs.filter(job => job.id !== JOB.id) } });
  assert.equal(calls.filter(call => call.path === paths.write).length, 1); await click(labels.retry);
  const writes = calls.filter(call => call.path === paths.write); assert.equal(writes.length, 2);
  assert.equal(writes[1]!.key, first.key); assert.deepEqual(writes[1]!.body, first.body);
  assert.equal(calls.filter(call => call.path === paths.preview).length, 1); assert.equal(dom.document.querySelector('.atlas-enrichment-save'), null);
});

test("a known write receipt followed by snapshot failure recovers with GET only", async () => {
  const calls = savingFetch({ failAfterWriteGet: true }), value = props(); await prepared(value); await check(); await click(labels.save);
  assert.match(dom.document.body.textContent!, /地点已保存，需重新读取索引确认/);
  const before = calls.length; await click(labels.refresh);
  assert.deepEqual(calls.slice(before).map(call => call.path), [paths.snapshot]); assert.equal(calls.filter(call => call.path === paths.write).length, 1);
  assert.equal(dom.document.querySelector('.atlas-enrichment-save'), null);
});

test("same-company failures remain per job and a new read has no hidden browser or storage side effects", async () => {
  const ids = BASE.jobs.slice(0, 2).map(value => value.id), calls = installFetch(call => {
    if (call.path === paths.plan) return response(plan(ids.map(id => item(id, { status: "company-discovery", exactPlatformTargets: [] }))));
    assert.equal(call.path, paths.company); throw new Error("Synthetic discovery disabled");
  });
  await prepared(props({ jobIds: ids }));
  assert.equal(calls.filter(call => call.path === paths.company).length, 1); assert.equal(dom.document.querySelectorAll('[data-status="error"]').length, 2);
  assert.equal(dom.document.querySelector('iframe'), null); assert.equal(dom.localStorage.length, 0); assert.equal(dom.sessionStorage.length, 0);
});

test("the bounded read deadline aborts the queue without accepting late address captures", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const calls = installFetch(call => {
    if (call.path === paths.plan) return response(plan());
    return new Promise<Response>((_resolve, reject) => call.init!.signal!.addEventListener("abort", () => reject(call.init!.signal!.reason), { once: true }));
  });
  await render(); await click(labels.read); assert.equal(calls.length, 2);
  await act(async () => mock.timers.tick(120_001));
  assert.equal(calls[1]!.init!.signal!.aborted, true); assert.equal(checks().length, 0);
  assert.equal(dom.document.querySelector('section')!.getAttribute("aria-busy"), "false");
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /已停止本轮等待/);
});

test("terminal write rejection clears the checkbox and forces an explicit new read", async () => {
  const calls = savingFetch();
  const original = globalThis.fetch;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => new URL(String(url), dom.location.href).pathname === paths.write
    ? new Response(JSON.stringify({ ok: false, requestId: "synthetic-terminal-rejection", error: { code: "stale-version", message: "Synthetic index version has changed" } }), { status: 409 })
    : original(url, init));
  await prepared(); await check(); await click(labels.save);
  assert.equal(dom.document.querySelector('.atlas-enrichment-save'), null); assert.equal(checks()[0]!.checked, false); assert.equal(checks()[0]!.disabled, true);
  assert.match(dom.document.querySelector('[role="alert"]')!.textContent!, /stale-version/);
  assert.equal(calls.filter(call => call.path === paths.preview).length, 1); assert.equal(button(labels.read).disabled, false);
});

test("two source listings of the same job retain separate saved checkboxes and allow the second explicit save", async () => {
  const otherJob = BASE.jobs[1]!, first = listing(), second = listing(otherJob.id), otherTarget = item(otherJob.id).exactPlatformTargets[0]!;
  let current: AtlasDataset = { ...BASE, jobs: BASE.jobs.filter(value => value.id !== otherJob.id).map(value => value.id === JOB.id ? { ...value, listingIds: [...value.listingIds, second.id] } : value),
    listings: BASE.listings.map(value => value.id === second.id ? { ...value, canonicalJobId: JOB.id } : value) };
  const initial = current;
  const row = item(JOB.id, { exactPlatformTargets: [...item().exactPlatformTargets, otherTarget] });
  const calls = installFetch(call => {
    if (call.path === paths.plan) return response(plan([row]));
    if (call.path === paths.extract) return raw(extraction(capture(String(call.body.input))));
    if (call.path === paths.snapshot) return response(current);
    const target = call.body.listingId === first.id ? first : second;
    const source = { ...location(), id: `${target.id}-batch-source`, evidence: [{ ...location().evidence[0]!, observationId: `${target.id}-batch-observation`, sourceUrl: target.canonicalUrl }] };
    if (call.path === paths.preview) return response({ jobId: JOB.id, listingId: target.id, sourceId: target.sourceId, expectedRevision: current.revision,
      previewFingerprint: "c".repeat(64), newLocations: [source], previousLocationIds: target.locationIds, warnings: ["Synthetic source evidence only; no coordinates."] });
    assert.equal(call.path, paths.write);
    current = { ...current, revision: current.revision + 1, jobs: current.jobs.map(value => value.id === JOB.id ? { ...value, locationIds: [...value.locationIds, source.id], revision: value.revision + 1 } : value),
      listings: current.listings.map(value => value.id === target.id ? { ...value, locationIds: [source.id], observationIds: [...value.observationIds, `${target.id}-batch-observation`] } : value),
      locations: [...current.locations, source], observations: [...current.observations, { id: `${target.id}-batch-observation`, listingId: target.id, fetchedAt: DETAIL_AT,
        detailFetchedAt: DETAIL_AT, result: "partial", availability: "unknown", completeness: "excerpt", warnings: [] }] };
    return response({ ok: true, revision: current.revision, jobIds: [JOB.id], snapshotIds: [], counts: { newJobs: 0, updatedJobs: 1, unchangedJobs: 0, newListings: 0, newObservations: 1, newSnapshots: 0 } });
  });
  await prepared(props({ data: initial })); assert.equal(checks().length, 2);
  await check(0); await click(labels.save); assert.equal(checks()[0]!.disabled, true); assert.equal(checks()[1]!.disabled, false);
  await check(1); await click(labels.save); assert.equal(checks().every(value => value.disabled && !value.checked), true);
  assert.deepEqual(calls.filter(call => call.path === paths.write).map(call => call.body.listingId), [first.id, second.id]);
});

test("an external revision discards the inline office review while retaining batch results for a new plan", async () => {
  const calls = savingFetch(), snapshots: AtlasDataset[] = [], value = props({ onSnapshot: data => snapshots.push(data) });
  await prepared(value); await check(); await click(labels.save); await click("核对具体办公点");
  await act(async () => { await import("../src/components/atlas/AtlasOfficeAddressConfirmation.tsx"); });
  assert.ok(dom.document.querySelector('[aria-label="核对并保存办公地址"]'));
  await render({ ...value, data: { ...snapshots[0]!, revision: snapshots[0]!.revision + 1 } });
  assert.equal(dom.document.querySelector('[aria-label="核对并保存办公地址"]'), null); assert.equal(checks().length, 1);
  assert.equal(button(labels.read).disabled, false); assert.equal(calls.filter(call => call.path === paths.plan).length, 1);
});

test("a job with one resolved office still reads its remaining unlocated workplace", async () => {
  const ready = { ...location(), id: "synthetic-resolved-office", coordinates: { latitude: 31, longitude: 121, coordinateSystem: "WGS84" as const }, precision: "address" as const };
  const row = item(JOB.id, { currentOffice: [ready], pendingLocationIds: ["synthetic-other-workplace"] });
  const calls = installFetch(call => call.path === paths.plan ? response(plan([row])) : raw(extraction()));
  await prepared(); assert.equal(calls.filter(call => call.path === paths.extract).length, 1); assert.equal(checks().length, 1);
  assert.equal(dom.document.querySelector('[data-status="skipped"]'), null);
});

test("failed platform address reading falls back to name-only career discovery and keeps its weak association explicit", async () => {
  const parsed = parsePlatformJobLocations({ jobLocation: { address: { addressCountry: "CN", addressLocality: "Shanghai" } } }); assert.ok(parsed);
  const cityOnly = PlatformDetailLocationsSchema.parse({ version: 1, provider: "liepin", url: listing().canonicalUrl, capturedAt: DETAIL_AT, ...parsed });
  const calls = installFetch(call => call.path === paths.plan ? response(plan()) : call.path === paths.extract ? raw(extraction(cityOnly)) : response(discovery()));
  await prepared(); assert.deepEqual(calls.map(call => call.path), [paths.plan, paths.extract, paths.company]);
  assert.equal(checks().length, 0); assert.match(dom.document.body.textContent!, /企业招聘入口 · 关联待核实/);
  assert.equal(calls.some(call => [paths.write, paths.candidates].includes(call.path)), false);
});

test("an unmatched source street falls back to only the unique same-record same-URL nonremote official street as a read-only clue", async () => {
  const original = listing(), url = "https://careers.example.invalid/jobs/synthetic-one", sourceId = "synthetic-owned-official";
  const target = { listingId: original.id, sourceId, adapterId: "synthetic-jsonld", url, label: "Synthetic owned official" };
  const data = { ...BASE, listings: BASE.listings.map(value => value.id === original.id ? { ...value, sourceId, canonicalUrl: url } : value) };
  const sourceLocation = location();
  const row = item(JOB.id, { status: "source-street", exactPlatformTargets: [], sourceStreetTargets: [streetTarget(sourceLocation)], ownedOfficialTargets: [target] });
  const record = { entityType: "job-posting", sourceRecordId: original.sourceRecordId, url, title: JOB.title.value, companyName,
    locations: [{ raw: "Synthetic official disclosed address", countryCode: "CN", city: "Shanghai", streetAddress: "Synthetic Official Road 25", postalCode: "200000" }],
    compensations: [], workMode: "on-site", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "excerpt",
    evidence: [{ field: "locations[0].streetAddress", quote: "Synthetic Official Road 25", sourceUrl: url }], warnings: [] };
  const variants = [record, { ...record, sourceRecordId: "another-job" }, { ...record, url: "https://careers.example.invalid/jobs/other" }, { ...record, workMode: "remote" }];
  for (const [index, returned] of variants.entries()) {
    const calls = installFetch(call => {
      if (call.path === paths.plan) return response(plan([row]));
      if (call.path === paths.candidates) return response(streetResult(sourceLocation));
      if (call.path === paths.company) return response(discovery());
      assert.equal(call.path, `/api/v1/sources/${sourceId}/preview`);
      return response({ page: { records: [returned], observedAt: DETAIL_AT, coverage: { complete: false, partial: true, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] },
        localMatchedRecords: 1, localFilters: { roles: [JOB.title.value], regions: [], companyNames: [companyName] } });
    });
    await prepared(props({ data }));
    assert.deepEqual(calls[2]!.body, { scope: { roles: [JOB.title.value], regions: [], companyNames: [companyName] }, maxRecords: 50 });
    assert.equal(checks().length, 0); assert.equal(dom.document.querySelector('.atlas-enrichment-save'), null);
    if (index === 0) {
      assert.match(dom.document.body.textContent!, /官网同岗位街址线索 · 待核对.*Synthetic Official Road 25/s);
      assert.equal(calls.length, 3); assert.match(dom.document.body.textContent!, /读取时间：2026-10-19T12:01:00.000Z · 尚未保存或定位/);
    } else { assert.doesNotMatch(dom.document.body.textContent!, /Synthetic Official Road 25/); assert.equal(calls.length, 4); }
    await clean();
  }
});

test("React continues an unconfigured street geocoder to owned JSON-LD detail and recovers its location-only HTTP write without reading a list or replacing JD", async () => {
  const sourceUrl = "https://careers.synthetic-office.com/jobs/held-1051", listUrl = "https://careers.synthetic-office.com/reviewed.xml";
  const source = SourceDefinitionSchema.parse({ sourceId: "synthetic-direct-office", name: "Synthetic direct careers", adapterId: "jobposting-jsonld", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], entryUrl: listUrl,
    options: { enumerationKind: "sitemap-urlset", enumerationUrls: [listUrl], postingPathPrefixes: ["/jobs/"], pageSize: 1 },
    endpointPolicy: { allowedHosts: ["careers.synthetic-office.com"], allowedPathPrefixes: ["/reviewed.xml", "/jobs/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic direct careers", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 1, maxPages: 1, requestsPerMinute: 10 } });
  const posting = { "@type": "JobPosting", url: sourceUrl, identifier: "held-1051", title: "Synthetic C# engineer",
    description: "<p>Original synthetic JD, saved before reading a more detailed location.</p>", hiringOrganization: { name: "Synthetic direct employer" },
    datePosted: "2026-09-01", jobLocation: { address: { addressCountry: "CN", addressLocality: "Shanghai", streetAddress: "Synthetic Prior Road 1" } } };
  const html = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
  const initial = readJobPostingJsonLd(html(posting), sourceUrl).record; assert.ok(initial);
  const repository = openJobRepository(":memory:", { now: () => NOW });
  const projected = await projectSourcePage(await repository.readProjectionSnapshot(), source,
    { records: [initial], observedAt: AT, coverage: { complete: false, partial: true, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, "synthetic-direct-seed");
  await repository.importSnapshot(projected.delta, { actorScope: "synthetic-seed", idempotencyKey: "synthetic-direct-seed", expectedRevision: 0 });
  const before = await repository.readSnapshot(), job = before.jobs[0]!, owned = before.listings[0]!;
  const reads: string[] = [], snapshots: AtlasDataset[] = [], focuses: unknown[] = [];
  const application = createJobApplication({ repository, now: () => NOW, transport: { async request(input) {
    reads.push(input.url); assert.equal(input.url, sourceUrl, "an owned posting beyond a list quota is read without enumerating the list");
    return { url: input.url, status: 200, headers: {}, text: html({ ...posting, description: "<p>A different remote response must not replace the original JD.</p>",
      jobLocation: { address: { addressCountry: "CN", addressLocality: "Shanghai", streetAddress: "Synthetic Direct Road 1051", postalCode: "201051" } } }) };
  } } });
  const token = "synthetic-direct-office-token-1234567890";
  const server = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [dom.location.origin], port: 0 });
  const { url } = await server.listen();
  const requests: Array<{ path: string; body: unknown; key: string | null }> = [];
  let loseReceipt = true;
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), dom.location.href).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get("Idempotency-Key") });
    const result = await nativeHttpFetch(input, init);
    if (path === "/api/v1/jobs/owned-detail-locations/import" && loseReceipt) { loseReceipt = false; await result.text(); throw new Error("Synthetic response lost after database commit"); }
    return result;
  });
  try {
    await prepared(props({ endpoint: url, token, data: before, jobIds: [job.id], onSnapshot: snapshot => snapshots.push(snapshot),
      onOfficeSnapshot: (...args) => focuses.push(args) }));
    await settled(() => dom.document.querySelector('section')?.getAttribute("aria-busy") === "false"
      && checks().length === 1 && !!dom.document.querySelector(`article[data-job-id="${job.id}"]`));
    assert.deepEqual(reads, [sourceUrl], JSON.stringify({ requests, content: dom.document.body.textContent })); assert.deepEqual(await repository.readSnapshot(), before);
    assert.match(dom.document.body.textContent!, /官网同岗位直接读取.*Synthetic Direct Road 1051/s);
    assert.match(dom.document.body.textContent!, /地址查询服务未配置/);
    assert.equal(requests.filter(request => request.path === paths.candidates).length, 1);
    assert.equal((requests.find(request => request.path === paths.candidates)!.body as { query: string }).query, "Synthetic Prior Road 1");
    assert.equal(requests.some(request => /\/sources\/.+\/preview$/.test(request.path)), false);
    assert.deepEqual(requests.find(request => request.path.endsWith("/owned-detail-locations/read"))!.body,
      { jobId: job.id, listingId: owned.id, expectedRevision: before.revision });
    await check(); await click(labels.save);
    await settled(() => [...dom.document.querySelectorAll<HTMLButtonElement>("button")].some(button => button.textContent?.trim() === labels.retry && !button.disabled));
    assert.equal(snapshots.length, 0); assert.equal((await repository.readSnapshot()).revision, before.revision + 1);
    await click(labels.retry); await settled(() => snapshots.length === 1);
    const after = snapshots[0]!, location = after.locations.find(location => after.jobs[0]!.locationIds.includes(location.id))!;
    assert.equal(after.jobs.length, 1); assert.equal(after.revision, before.revision + 1);
    assert.equal(location.streetAddress, "Synthetic Direct Road 1051"); assert.equal(location.postalCode, "201051");
    assert.equal(location.coordinates, undefined); assert.equal(location.verification, "unverified");
    assert.deepEqual(after.snapshots, before.snapshots); assert.deepEqual(after.compensations, before.compensations); assert.deepEqual(after.companies, before.companies);
    assert.equal(after.listings[0]!.recordLastSeenAt, owned.recordLastSeenAt); assert.equal(after.jobs[0]!.selectedSnapshotId, job.selectedSnapshotId);
    assert.equal(focuses.length, 0); assert.deepEqual(reads, [sourceUrl], "receipt recovery must neither refetch the job nor geocode the office");
    const writes = requests.filter(request => request.path.endsWith("/owned-detail-locations/import"));
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
    assert.equal(requests.filter(request => request.path.endsWith("/owned-detail-locations/preview")).length, 1);
    assert.equal(checks()[0]!.disabled, true); assert.ok(button("核对具体办公点"));
    const result = await queryJobs(after, { search: { text: "C#" }, workCountryCodes: ["CN"] });
    assert.equal(result.items.length, 1); assert.equal(result.mappedJobs, 0);
  } finally { await clean(); await server.close(); await application.shutdown(); repository.close(); }
});

test("stopping an in-flight save retains the original request and rejects its late successful receipt", async () => {
  const calls = savingFetch(), original = globalThis.fetch, waiting = deferred<Response>();
  const writes: Array<{ body: unknown; key: string | null; signal: AbortSignal | null | undefined }> = [];
  let hold = true;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(url), dom.location.href).pathname === paths.write) {
      writes.push({ body: JSON.parse(String(init!.body)), key: new Headers(init!.headers).get("Idempotency-Key"), signal: init!.signal });
      if (hold) return waiting.promise;
    }
    return original(url, init);
  });
  const snapshots: AtlasDataset[] = []; await prepared(props({ onSnapshot: data => snapshots.push(data) })); await check(); await click(labels.save);
  assert.equal(writes.length, 1); await click("停止等待保存"); assert.equal(writes[0]!.signal!.aborted, true);
  await act(async () => waiting.resolve(response({ ok: true, revision: BASE.revision + 1, jobIds: [JOB.id], snapshotIds: [],
    counts: { newJobs: 0, updatedJobs: 1, unchangedJobs: 0, newListings: 0, newObservations: 1, newSnapshots: 0 } })));
  assert.equal(snapshots.length, 0); assert.match(dom.document.body.textContent!, /本次保存结果待确认/);
  assert.equal(calls.filter(call => call.path === paths.snapshot).length, 1);
  hold = false; await click(labels.retry); assert.equal(writes.length, 2);
  assert.equal(writes[1]!.key, writes[0]!.key); assert.deepEqual(writes[1]!.body, writes[0]!.body);
  assert.equal(calls.filter(call => call.path === paths.preview).length, 1); assert.equal(snapshots.length, 1);
});

test("a snapshot older than the committed receipt stays unpublished and can be recovered through GET only", async () => {
  const calls = savingFetch(), original = globalThis.fetch;
  let written = false, returnedOld = false;
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), dom.location.href).pathname;
    if (path === paths.write) written = true;
    if (path === paths.snapshot && written && !returnedOld) { returnedOld = true; return response(BASE); }
    return original(url, init);
  });
  const snapshots: AtlasDataset[] = []; await prepared(props({ onSnapshot: data => snapshots.push(data) })); await check(); await click(labels.save);
  assert.equal(snapshots.length, 0); assert.match(dom.document.body.textContent!, /地点已保存，需重新读取索引确认/);
  const before = calls.length; await click(labels.refresh);
  assert.deepEqual(calls.slice(before).map(call => call.path), [paths.snapshot]); assert.equal(snapshots[0]!.revision, BASE.revision + 1);
  assert.equal(calls.filter(call => call.path === paths.write).length, 1);
});

test("Escape respects prior handling and input composition, invokes the latest close callback and removes its listener on unmount", async () => {
  const calls = installFetch(() => { throw new Error("Opening and closing must stay inert"); });
  let oldCloses = 0, latestCloses = 0;
  const value = props({ onClose() { oldCloses++; } }); await render(value, true);
  const consumed = new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true }); consumed.preventDefault();
  await act(async () => dom.dispatchEvent(consumed));
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
  assert.equal(oldCloses, 0);
  await render({ ...value, onClose() { latestCloses++; } }, true);
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  assert.equal(latestCloses, 1); assert.equal(oldCloses, 0); assert.equal(calls.length, 0);
  await act(async () => root!.unmount()); root = undefined;
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  assert.equal(latestCloses, 1);
});

test("Escape exits the internal office subpanel before the batch panel and keeps completed batch rows intact", async () => {
  const calls = savingFetch(); let closes = 0;
  await prepared(props({ onClose() { closes++; } })); await check(); await click(labels.save); await click("核对具体办公点");
  await act(async () => { await import("../src/components/atlas/AtlasOfficeAddressConfirmation.tsx"); });
  assert.ok(dom.document.querySelector('[aria-label="核对并保存办公地址"]'));
  const handled = new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true }); handled.preventDefault();
  await act(async () => dom.dispatchEvent(handled)); assert.ok(dom.document.querySelector('[aria-label="核对并保存办公地址"]'));
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  assert.equal(closes, 0); assert.equal(dom.document.querySelector('[aria-label="核对并保存办公地址"]'), null);
  assert.equal(checks().length, 1); assert.equal(checks()[0]!.disabled, true);
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  assert.equal(closes, 1); assert.equal(calls.filter(call => call.path === paths.write).length, 1);
});

test("internal office save publishes the exact fresh office and job once while source-street saves never emit office focus", async () => {
  const calls = savingFetch(), originalFetch = globalThis.fetch;
  const snapshots: AtlasDataset[] = [], officeEvents: Array<{ snapshot: AtlasDataset; location: JobLocation; jobId: string }> = [];
  let officeData: AtlasDataset | undefined, officeWrites = 0;
  const proposal: OfficeAddressProposal = { basis: "manual-user-confirmation", countryCode: "CN", formattedAddress: "Synthetic Batch Road 10, Shanghai",
    streetAddress: "Synthetic Batch Road 10", postalCode: "200000", coordinateMeaning: "building", evidenceUrl: listing().canonicalUrl,
    coordinates: { latitude: 31.123456, longitude: 121.654321, coordinateSystem: "WGS84" } };
  function proposedPoint() {
    const source = snapshots[0]!.locations.find(value => value.id === location().id)!;
    return applyOfficeAddressConfirmation(source, { id: "synthetic-batch-office-decision", kind: "confirm", actorScope: "synthetic-reviewer", at: NOW,
      jobId: JOB.id, listingId: listing().id, locationId: source.id, revision: snapshots[0]!.revision + 1,
      reason: "Synthetic explicit office confirmation", sourceLocation: source, proposal });
  }
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), dom.location.href).pathname;
    if (path === "/api/v1/locations/office-address/preview") {
      const source = snapshots[0]!.locations.find(value => value.id === location().id)!;
      return response({ expectedRevision: snapshots[0]!.revision, previewFingerprint: "d".repeat(64), jobId: JOB.id, locationId: source.id,
        current: source, sourceLocation: source, proposed: proposedPoint(), warnings: [] });
    }
    if (path === "/api/v1/locations/office-address/confirmations") {
      officeWrites++; const point = proposedPoint(), source = snapshots[0]!;
      officeData = { ...source, revision: source.revision + 1, locations: source.locations.map(value => value.id === point.id ? point : value),
        jobs: source.jobs.map(value => value.id === JOB.id ? { ...value, revision: value.revision + 1 } : value) };
      return response({ ok: true, revision: officeData.revision, jobId: JOB.id, locationId: point.id, decisionId: point.officeResolution!.decisionId,
        activeDecisionId: point.officeResolution!.decisionId, location: point });
    }
    if (path === paths.snapshot && officeData) return response(officeData);
    return originalFetch(url, init);
  });
  await prepared(props({ onSnapshot: snapshot => snapshots.push(snapshot), onOfficeSnapshot: (snapshot, point, jobId) => officeEvents.push({ snapshot, location: point, jobId }) }));
  await check(); await click(labels.save); assert.equal(snapshots.length, 1); assert.equal(officeEvents.length, 0);
  await click("核对具体办公点"); await act(async () => { await import("../src/components/atlas/AtlasOfficeAddressConfirmation.tsx"); });
  await change("完整办公地址", proposal.formattedAddress); await change("办公地址纬度", String(proposal.coordinates.latitude));
  await change("办公地址经度", String(proposal.coordinates.longitude)); await change("办公地址依据链接", proposal.evidenceUrl);
  await change("办公地址核对说明", "Synthetic explicit office confirmation");
  await click("预览办公地址变更");
  const confirm = dom.document.querySelector<HTMLInputElement>('.atlas-office-preview input[type="checkbox"]'); assert.ok(confirm);
  await act(async () => confirm.click()); await click("确认保存办公地址");
  assert.equal(officeWrites, 1); assert.equal(snapshots.length, 2); assert.equal(officeEvents.length, 1);
  assert.equal(officeEvents[0]!.jobId, JOB.id); assert.equal(officeEvents[0]!.location.id, location().id);
  assert.deepEqual(officeEvents[0]!.location.coordinates, proposal.coordinates); assert.equal(officeEvents[0]!.location.precision, "address");
  assert.ok(officeEvents[0]!.snapshot === snapshots[1]); assert.equal(officeEvents[0]!.snapshot.revision, BASE.revision + 2);
  assert.equal(calls.filter(call => call.path === paths.write).length, 1);
});
