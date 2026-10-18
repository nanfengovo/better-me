import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { type SourceDefinition, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { type SourceAdapter, type SourceAdapterRequest, type SourceJobRecord, type SourcePage } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { openJobRepository } from "../src/repository.js";

const at = "2026-10-18T12:00:00.000Z";
const emptyScope = { roles: [], regions: [], companyNames: [] };
const source: SourceDefinition = {
  sourceId: "application-review-source", name: "Synthetic review source", adapterId: "application-review", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 },
};
function record(overrides: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return { entityType: "job-posting", sourceRecordId: "review-job", url: "https://careers.example.test/jobs/review-job",
    companyName: "Synthetic employer", title: "Synthetic engineer", description: "Synthetic original job description.",
    locations: [{ raw: "上海", countryCode: "CN", city: "上海" }], compensations: [], workMode: "on-site", employmentType: "social",
    remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [], ...overrides };
}
function page(request: SourceAdapterRequest, records: SourceJobRecord[]): SourcePage {
  return { records, observedAt: request.context.observedAt, coverage: { complete: true, partial: false, fetchedRecords: records.length,
    appliedFilters: [], ignoredFilters: (Object.keys(request.scope) as Array<keyof typeof emptyScope>).filter((key) => request.scope[key].length > 0) }, warnings: [] };
}
function context(key?: string): TrustedToolContext {
  return { requestId: randomUUID(), actorScope: "local-owner", allowedEffects: ["read-index", "local-write", "external-read"],
    signal: new AbortController().signal, budget: { requests: 10, bytes: 4_000_000, timeoutMs: 4000 }, ...(key ? { idempotencyKey: key } : {}) };
}
function value<T = any>(result: ToolResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
async function fixture(handler: SourceAdapter["list"]) {
  const repository = openJobRepository(":memory:", { now: () => at });
  await repository.registerSource(source, { actorScope: "local-owner", idempotencyKey: "seed" });
  const adapter: SourceAdapter = { adapterId: source.adapterId, version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"], list: handler };
  let application = createJobApplication({ repository, adapters: [adapter], now: () => at });
  return { repository, get application() { return application; },
    async restartApplication() { await application.shutdown(); application = createJobApplication({ repository, adapters: [adapter], now: () => at }); },
    async close() { await application.shutdown(); repository.close(); } };
}

test("review: durable sync fingerprints distinguish caller limits even when both clamp to the same source policy", async () => {
  let fetches = 0;
  const f = await fixture(async (request) => { fetches++; return page(request, [record()]); });
  try {
    const first = { sourceId: source.sourceId, maxRecords: 101 };
    const changed = { sourceId: source.sourceId, maxRecords: 102 };
    value(await f.application.registry.execute("sources.sync", first, context("same-key")));
    const liveConflict = await f.application.registry.execute("sources.sync", changed, context("same-key"));
    assert.equal(liveConflict.ok, false);
    if (!liveConflict.ok) assert.equal(liveConflict.error.code, "idempotency-conflict");
    await f.restartApplication();
    const durableConflict = await f.application.registry.execute("sources.sync", changed, context("same-key"));
    assert.equal(durableConflict.ok, false, "Recreating the executor must preserve the same conflict rule as the live registry.");
    if (!durableConflict.ok) assert.equal(durableConflict.error.code, "idempotency-conflict");
    assert.equal(fetches, 1);
  } finally { await f.close(); }
});

test("review: a terminal run remains recoverable by its key after the source is disabled", async () => {
  let fetches = 0;
  const f = await fixture(async (request) => { fetches++; return page(request, [record()]); });
  try {
    const input = { sourceId: source.sourceId };
    const initial = value(await f.application.registry.execute("sources.sync", input, context("completed-key")));
    const revision = (await f.repository.readSnapshot()).revision;
    await f.repository.registerSource({ ...source, enabled: false, status: "disabled" }, { actorScope: "local-owner", idempotencyKey: "disable", expectedRevision: revision });
    await f.restartApplication();
    const recovered = value(await f.application.registry.execute("sources.sync", input, context("completed-key")));
    assert.equal(recovered.run.runId, initial.run.runId);
    assert.equal(recovered.run.status, "completed");
    assert.equal(fetches, 1, "Recovering a terminal receipt must not access the disabled source.");
  } finally { await f.close(); }
});

test("review: local preview respects a source runtime restriction in the same way as sync", async () => {
  let fetches = 0;
  const f = await fixture(async (request) => { fetches++; return page(request, [record()]); });
  try {
    const revision = (await f.repository.readSnapshot()).revision;
    await f.repository.registerSource({ ...source, runtime: ["browser-companion"] }, { actorScope: "local-owner", idempotencyKey: "browser-only", expectedRevision: revision });
    const result = await f.application.registry.execute("sources.preview", { sourceId: source.sourceId }, context());
    assert.equal(result.ok, false, "A source restricted to the browser companion cannot be fetched by the local service preview.");
    if (!result.ok) assert.equal(result.error.code, "unsupported-capability");
    assert.equal(fetches, 0);
  } finally { await f.close(); }
});

test("review: a regional refresh includes explicitly eligible remote jobs without fabricating an office", async () => {
  const f = await fixture(async (request) => page(request, [record({ workMode: "remote", locations: [], remoteEligibleRegions: ["Europe"] })]));
  try {
    const input = { sourceId: source.sourceId, scope: { ...emptyScope, regions: ["Europe"] } };
    const preview = value(await f.application.registry.execute("sources.preview", input, context()));
    assert.equal(preview.localMatchedRecords, 1, "An explicit remote eligibility region is searchable source location evidence.");
    value(await f.application.registry.execute("sources.sync", input, context("regional-remote")));
    const stored = await f.repository.readSnapshot();
    assert.equal(stored.jobs.length, 1);
    assert.deepEqual(stored.jobs[0]!.remoteEligibleRegions, ["Europe"]);
    assert.equal(stored.locations.some((location) => location.kind === "office"), false);
  } finally { await f.close(); }
});

test("review: explicit switch to remote stops exposing a prior office as the current work location", async () => {
  let remote = false;
  const f = await fixture(async (request) => page(request, [record(remote ? { workMode: "remote", locations: [], remoteEligibleRegions: ["Europe"] } : {})]));
  try {
    value(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context("office")));
    const before = await f.repository.readSnapshot();
    assert.equal(before.locations[0]!.kind, "office");
    remote = true;
    value(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId }, context("remote")));
    const after = await f.repository.readSnapshot();
    assert.equal(after.jobs[0]!.workMode, "remote");
    assert.equal(after.jobs[0]!.locationIds.some((id) => after.locations.some((location) => location.id === id && location.kind === "office")), false,
      "The old office may stay in historical data, but cannot remain a current office after an explicit remote-only change.");
    assert.ok(after.locations.some((location) => location.id === before.locations[0]!.id), "Historical source location must remain available.");
  } finally { await f.close(); }
});
