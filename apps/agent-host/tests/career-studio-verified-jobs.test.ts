import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtlasDatasetSchema, queryJobs, type AtlasDataset, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { createVerifiedJobResolver, createLoopbackVerifiedJobResolver, resolveVerifiedAtlasJobs, JOB_AUTHORITY_ENDPOINT } from "../src/career-studio/verified-jobs.js";
import { CareerStudio } from "../src/career-studio/service.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import { openJobRepository } from "../../job-service/src/repository.js";
import { createJobApplication } from "../../job-service/src/application.js";
import type { StudioContextInput } from "../src/career-studio/contracts.js";

const at = "2026-11-09T00:00:00.000Z", access = { session: "synthetic-session", valid: async () => true };
const field = <T>(value: T) => ({ value, evidence: [], method: "manual" as const, verification: "unverified" as const, revision: 0 });
function dataset(): AtlasDataset {
  return AtlasDatasetSchema.parse({ schemaVersion: 1, revision: 7,
    sources: [{ sourceId: "source-1", name: "Synthetic employer source", adapterId: "synthetic", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "disabled", remoteFilters: [],
      endpointPolicy: { allowedHosts: ["careers.example.invalid"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 10 } }],
    companies: [{ id: "company-1", names: ["Synthetic employer"], domains: [], parentCompanyIds: [], ultimateControllers: field([]), manualOverrides: [] }],
    jobs: [{ id: "job-1", companyId: "company-1", title: field("Synthetic engineer"), description: "SQLite", locationIds: ["office-1"], compensationIds: [], listingIds: ["listing-1"], workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: at }],
    locations: [{ id: "office-1", raw: "Synthetic office disclosure", kind: "office", countryCode: "CN", city: "合成市", streetAddress: "合成路1号", precision: "address", verification: "verified",
      coordinates: { longitude: 121.5, latitude: 31.2, coordinateSystem: "WGS84" }, evidence: [{ observationId: "observation-1", sourceUrl: "https://careers.example.invalid/job-1", observedAt: at, quote: "Synthetic office disclosure" }] }],
    listings: [{ id: "listing-1", sourceId: "source-1", sourceRecordId: "native-1", canonicalJobId: "job-1", canonicalUrl: "https://careers.example.invalid/job-1", observationIds: ["observation-1"], firstDiscoveredAt: at }],
    observations: [{ id: "observation-1", listingId: "listing-1", fetchedAt: at, result: "read", availability: "unknown", completeness: "detail", warnings: [] }],
    snapshots: [], compensations: [] });
}
async function payload(data = dataset()) {
  return { detail: { snapshotRevision: data.revision, job: data.jobs[0]!, company: data.companies[0]!, locations: data.locations,
    compensations: data.compensations, listings: data.listings, observations: data.observations, snapshots: data.snapshots, sources: data.sources },
  indexed: await queryJobs(data, { jobIds: ["job-1"], statuses: ["open", "closed", "unknown"], page: { limit: 1 }, mapLevel: "location" }, { now: at }) };
}
const selected = (): StudioContextInput => ({ workspaceKey: "workspace", resumeId: "resume", sourceFingerprint: "a".repeat(64), consent: true, claims: [], jobs: [{ id: "job-1", title: "Synthetic engineer", company: "Synthetic employer", description: "SQLite", platform: "manual", sourceUrl: null, capturedAt: at,
  firstSeenAt: null, lastSeenAt: null, publishedAt: null, availability: "unknown", verifiedAt: null, companyKey: null, locationKey: null, roleKey: null, skillIds: ["sqlite"], salaryText: "未知",
  coordinates: { longitude: 1, latitude: 2, verified: true, precision: "office", persisted: true, indexed: true } }] });
const trustedContext = (): TrustedToolContext => ({ requestId: "synthetic-read", actorScope: "local-owner", signal: new AbortController().signal, budget: { requests: 0, bytes: 1_000_000, timeoutMs: 1000 }, allowedEffects: ["read-index"] });
function value<T>(result: ToolResult<T>): T { if (!result.ok) throw new Error(result.error.code); assert.equal(result.ok, true); return result.value; }

test("same-version persisted detail and real query membership produce an exact office authority, not a city reference or browser coordinate", async () => {
  const data = await payload(), resolve = createVerifiedJobResolver({ detail: async () => data.detail, indexed: async () => data.indexed });
  const result = await resolve("job-1", new AbortController().signal); assert.ok(result);
  assert.equal(result.persisted, true); assert.equal(result.indexed, true); assert.equal(result.coordinates.longitude, 121.5);
  assert.equal(result.sourceHash.length, 64); assert.equal(result.locationHash.length, 64); assert.equal(result.snapshotRevision, 7);
  assert.notEqual(result.sourceHash, "a".repeat(64));
  const batch = await resolveVerifiedAtlasJobs(["job-1"], { resolve, isCurrent: () => true }); assert.equal(batch.jobs.length, 1); assert.deepEqual(batch.unknownJobIds, []);
});

test("version drift, forged identity, unverified/city/street/nonoffice points, missing evidence chain and multiple office ambiguity stay unknown", async () => {
  const base = await payload();
  const mutations: Array<(value: Awaited<ReturnType<typeof payload>>) => void> = [
    value => value.indexed.snapshotVersion++, value => { value.detail.job.id = "another-job"; },
    value => { value.detail.locations[0]!.verification = "unverified"; }, value => { value.detail.locations[0]!.precision = "city"; },
    value => { value.detail.locations[0]!.precision = "street"; }, value => { value.detail.locations[0]!.kind = "unknown"; },
    value => { value.detail.locations[0]!.coordinates!.coordinateSystem = "GCJ02" as "WGS84"; }, value => { value.detail.observations = []; },
    value => { value.indexed.items = []; }, value => { value.detail.locations[0]!.coordinates!.longitude = 120; },
    value => { const extra = { ...structuredClone(value.detail.locations[0]!), id: "office-2" }; value.detail.locations.push(extra); value.detail.job.locationIds.push(extra.id); },
  ];
  for (const mutate of mutations) { const input = structuredClone(base); mutate(input);
    assert.equal(await createVerifiedJobResolver({ detail: async () => input.detail, indexed: async () => input.indexed })("job-1", new AbortController().signal), undefined); }
});

test("production adapter uses only fixed loopback reads with explicit token, bounded JSON and redirect/cookie denial", async () => {
  const data = await payload(), requests: Array<{ url: string; init: RequestInit }> = [], token = "synthetic-authority-token-12345678901234567890";
  const fetcher: typeof fetch = async (url, init = {}) => { requests.push({ url: String(url), init }); const value = String(url).endsWith("/search") ? data.indexed : data.detail;
    return new Response(JSON.stringify({ ok: true, requestId: "fixture", value }), { headers: { "Content-Type": "application/json" } }); };
  const resolve = createLoopbackVerifiedJobResolver({ token, fetch: fetcher }), result = await resolve("job-1", new AbortController().signal); assert.ok(result);
  assert.deepEqual(requests.map(request => request.url).sort(), [`${JOB_AUTHORITY_ENDPOINT}/api/v1/jobs/job-1`, `${JOB_AUTHORITY_ENDPOINT}/api/v1/jobs/search`]);
  for (const request of requests) { assert.equal(request.init.redirect, "error"); assert.equal(request.init.credentials, "omit"); assert.equal(new Headers(request.init.headers).get("Authorization"), `Bearer ${token}`); }
  const search = requests.find(request => request.init.method === "POST")!; assert.deepEqual(JSON.parse(String(search.init.body)).jobIds, ["job-1"]);
  assert.throws(() => createLoopbackVerifiedJobResolver({ token: "" }), /token_required/);
  for (const bad of [new Response("{}", { status: 302 }), new Response("{}", { headers: { "Content-Type": "text/html" } }), new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "1000001" } })]) {
    assert.equal(await createLoopbackVerifiedJobResolver({ token, fetch: async () => bad.clone() })("job-1", new AbortController().signal), undefined);
  }
});

test("a real isolated JobService SQLite import and independent read-index tools supply authority without network or repository mutation by the resolver", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-verified-jobs-")), repo = openJobRepository(path.join(directory, "jobs.sqlite"), { now: () => at });
  const app = createJobApplication({ repository: repo, backgroundEnrichment: false });
  t.after(async () => { await app.shutdown(); repo.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await repo.importSnapshot(dataset(), { actorScope: "synthetic-seed", idempotencyKey: "seed" });
  const before = await repo.readSnapshot();
  const resolve = createVerifiedJobResolver({ detail: async id => value(await app.registry.execute("jobs.read-detail", { jobId: id }, trustedContext())), indexed: async id => value(await app.registry.execute("jobs.search", { jobIds: [id], statuses: ["open", "closed", "unknown"], mapLevel: "location", page: { limit: 1 } }, trustedContext())) });
  const verified = await resolve("job-1", new AbortController().signal); assert.ok(verified); assert.equal(verified.coordinates.longitude, 121.5); assert.equal(verified.snapshotRevision, before.revision);
  assert.deepEqual(await repo.readSnapshot(), before);
});

test("default context rejects self-proving coordinate flags; only registered trusted authority is retained separately for links", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-studio-job-authority-"))), studios: CareerStudio[] = [];
  t.after(async () => { studios.forEach(studio => studio.close()); await fs.rm(directory, { recursive: true, force: true }); });
  const data = await payload(), resolve = createVerifiedJobResolver({ detail: async () => data.detail, indexed: async () => data.indexed });
  const open = (name: string, trusted = false) => { const studio = new CareerStudio({ ownerId: name, directory: path.join(directory, name), broker: new EvidenceBroker(), ...(trusted ? { resolveVerifiedJob: resolve } : {}) }); studios.push(studio); return studio; };
  const untrusted = open("owner-default"), first = await untrusted.createContext(selected(), access);
  assert.equal(first.context.jobs[0]!.coordinates, undefined); assert.equal(untrusted.store.get<{ jobs: unknown[] }>("atlas-job-authority", first.context.id)?.value.jobs.length, 0);
  const trusted = open("owner-trusted", true), second = await trusted.createContext(selected(), access);
  assert.equal(second.context.jobs[0]!.coordinates, undefined);
  const authority = trusted.store.get<{ contextId: string; jobs: Array<{ jobId: string; coordinates: { longitude: number } }> }>("atlas-job-authority", second.context.id)!.value;
  assert.equal(authority.contextId, second.context.id); assert.equal(authority.jobs[0]!.jobId, "job-1"); assert.equal(authority.jobs[0]!.coordinates.longitude, 121.5);
});

test("missing, hung, wrong-job and late revoked authority remain unknown with a finite budget", async () => {
  const data = await payload(), resolve = createVerifiedJobResolver({ detail: async () => data.detail, indexed: async () => data.indexed });
  assert.deepEqual((await resolveVerifiedAtlasJobs(["job-1"], { isCurrent: () => true })).unknownJobIds, ["job-1"]);
  let active = true; const late = await resolveVerifiedAtlasJobs(["job-1"], { isCurrent: () => active, resolve: async (id, signal) => { const value = await resolve(id, signal); active = false; return value; } }); assert.equal(late.jobs.length, 0);
  const watchdog = setTimeout(() => {}, 300); try { const hung = await resolveVerifiedAtlasJobs(["job-1"], { isCurrent: () => true, timeoutMs: 10, resolve: async () => new Promise(() => {}) }); assert.deepEqual(hung.unknownJobIds, ["job-1"]); } finally { clearTimeout(watchdog); }
  const wrong = await resolveVerifiedAtlasJobs(["job-2"], { isCurrent: () => true, resolve: async (_id, signal) => resolve("job-1", signal) }); assert.equal(wrong.jobs.length, 0);
});
