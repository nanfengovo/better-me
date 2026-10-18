import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeCompensation, queryJobs, type JobQueryResult, type SourceDefinition, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { type SourcePage, type SourceScope, type SourceTransport } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { openJobRepository } from "../src/repository.js";

const AT = "2026-10-19T00:00:00.000Z";
const API = "https://api.ashbyhq.com/posting-api/job-board/synthetic-projection?includeCompensation=true";
const ORIGINAL = "https://jobs.ashbyhq.com/synthetic-projection/synthetic-remote-engineer";
const source: SourceDefinition = {
  sourceId: "synthetic-ashby-projection", name: "Synthetic public Ashby fixture", adapterId: "ashby", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
  entryUrl: API, options: { boardToken: "synthetic-projection", companyName: "Synthetic public employer" },
  endpointPolicy: { allowedHosts: ["api.ashbyhq.com"], allowedPathPrefixes: ["/posting-api/job-board/synthetic-projection"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic official careers fixture", homepageUrl: "https://jobs.ashbyhq.com/synthetic-projection", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 20 },
};
const scope: SourceScope = { roles: ["C#"], regions: [], companyNames: [] };
const fx = { id: "synthetic-dated-fx", provider: "Synthetic test rate", date: "2026-10-19", ratesToCny: { USD: 7, CNY: 1 } };

function context(key?: string): TrustedToolContext {
  return { requestId: randomUUID(), actorScope: "local-owner", allowedEffects: ["read-index", "external-read", "local-write"],
    signal: new AbortController().signal, budget: { requests: 10, bytes: 1_000_000, timeoutMs: 5000 }, ...(key ? { idempotencyKey: key } : {}) };
}
function value<T>(result: ToolResult<unknown>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error(result.error.code);
  return result.value as T;
}
function posting() {
  return {
    id: "synthetic-remote-engineer", title: "Synthetic C# systems engineer", jobUrl: ORIGINAL, applyUrl: `${ORIGINAL}/application`,
    descriptionPlain: "Synthetic duties: develop C# services and automated tests.", isRemote: true, workplaceType: "Remote",
    publishedAt: "2026-10-12T09:00:00Z", location: "Dallas, Texas",
    address: { postalAddress: { addressCountry: "United States", addressRegion: "Texas", addressLocality: "Dallas" } },
    secondaryLocations: [
      { location: "Chicago, Illinois", address: { postalAddress: { addressCountry: "United States", addressRegion: "Illinois", addressLocality: "Chicago" } } },
      // The documented flat address and observed nested address are both explicit source fields.
      { location: "Toronto, Ontario", address: { addressCountry: "Canada", addressRegion: "Ontario", addressLocality: "Toronto" } },
    ],
    compensation: {
      compensationTierSummary: "Synthetic salary, bonus, commission and equity; multiple components",
      compensationTiers: [{ id: "synthetic-us-tier", title: "United States", tierSummary: "Synthetic United States compensation", components: [
        { id: "synthetic-base", summary: "Salary USD 168000–220500", compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 168000, maxValue: 220500 },
        { id: "synthetic-commission", summary: "Commission USD 72000–94500", compensationType: "Commission", interval: "1 YEAR", currencyCode: "USD", minValue: 72000, maxValue: 94500 },
        { id: "synthetic-bonus", summary: "Bonus USD 12000–18000", compensationType: "Bonus", interval: "1 YEAR", currencyCode: "USD", minValue: 12000, maxValue: 18000 },
        { id: "synthetic-equity", summary: "Equity USD 20000–40000", compensationType: "EquityCashValue", interval: "1 YEAR", currencyCode: "USD", minValue: 20000, maxValue: 40000 },
        { id: "synthetic-percentage", summary: "Equity 0.5%–1.75%", compensationType: "EquityPercentage", interval: "NONE", currencyCode: null, minValue: 0.5, maxValue: 1.75 },
      ] }],
      // This summary envelope must not replace or duplicate actual tier components.
      summaryComponents: [{ compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 100000, maxValue: 999999 }],
    },
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "better-me-ashby-projection-test-"));
  const databasePath = join(directory, "atlas.sqlite");
  const repository = openJobRepository(databasePath, { now: () => AT });
  const requests: string[] = [];
  const transport: SourceTransport = { request: async ({ url }) => {
    assert.equal(url, API, "the fixture never reads an original posting, application page or another source");
    requests.push(url);
    return { url, status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify({ jobs: [posting()] }) };
  } };
  const application = createJobApplication({ repository, transport, now: () => AT });
  try { value(await application.registry.execute("sources.register", { source }, context("register-ashby"))); }
  catch (error) { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return { repository, application, requests, databasePath,
    async close() { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("Ashby remote structured primary and secondary addresses survive sync, SQLite reopen and same-location country queries without office pins", async () => {
  const f = await fixture();
  try {
    const scoped = { ...scope, countryCodes: ["US"], regions: ["Chicago"] };
    const preview = value<{ page: SourcePage; localMatchedRecords: number }>(
      await f.application.registry.execute("sources.preview", { sourceId: source.sourceId, scope: scoped }, context()));
    assert.equal(preview.localMatchedRecords, 1, "a secondary remote region retains its explicit country for local source filtering");
    assert.equal(preview.page.records[0]!.workMode, "remote");
    const synced = value<{ run: { status: string; summary?: { added?: number } } }>(
      await f.application.registry.execute("sources.sync", { sourceId: source.sourceId, scope: scoped }, context("sync-ashby-addresses")));
    assert.equal(synced.run.status, "completed");
    assert.equal(synced.run.summary?.added, 1);
    assert.equal(f.requests.length, 2, "one preview and one manual sync each read a single synthetic feed");

    const snapshot = await f.repository.readSnapshot();
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.locations.length, 3);
    assert.equal(snapshot.jobs[0]!.workMode, "remote");
    assert.deepEqual(snapshot.jobs[0]!.remoteEligibleRegions, ["Dallas, Texas", "Chicago, Illinois", "Toronto, Ontario"]);
    const places = snapshot.locations.map(({ raw, countryCode, region, city, kind, coordinates }) => ({ raw, countryCode, region, city, kind, coordinates }))
      .sort((left, right) => left.raw.localeCompare(right.raw));
    assert.deepEqual(places, [
      { raw: "Chicago, Illinois", countryCode: "US", region: "Illinois", city: "Chicago", kind: "remote-region", coordinates: undefined },
      { raw: "Dallas, Texas", countryCode: "US", region: "Texas", city: "Dallas", kind: "remote-region", coordinates: undefined },
      { raw: "Toronto, Ontario", countryCode: "CA", region: "Ontario", city: "Toronto", kind: "remote-region", coordinates: undefined },
    ]);
    assert.ok(snapshot.locations.every((location) => location.verification === "unverified" && location.evidence.length > 0));

    const searched = value<JobQueryResult>(await f.application.registry.execute("jobs.search", {
      search: { text: "C#", mode: "fuzzy" }, market: "overseas", workCountryCodes: ["US"], workRegionText: "Chicago", includeUnknownLocations: false,
    }, context()));
    assert.equal(searched.totalJobs, 1);
    assert.deepEqual(searched.items[0]!.locations.map((location) => location.city), ["Chicago"]);
    assert.equal(searched.items[0]!.sources[0]!.url, ORIGINAL);
    assert.equal(searched.mappedJobs, 0);
    assert.equal(searched.unlocatedJobs, 1);
    assert.equal(searched.locationPinCount, 0);
    assert.deepEqual(searched.mapBuckets, [], "an eligible remote region is never invented as an office coordinate");
    for (const query of [{ workCountryCodes: ["CN"] }, { market: "domestic" as const }, { workCountryCodes: ["US"], workRegionText: "Toronto" }]) {
      const excluded = value<JobQueryResult>(await f.application.registry.execute("jobs.search", { ...query, includeUnknownLocations: false }, context()));
      assert.equal(excluded.totalJobs, 0, "countries and cities must match the same source location");
    }
    const canadian = value<JobQueryResult>(await f.application.registry.execute("jobs.search", { workCountryCodes: ["CA"], workRegionText: "Toronto" }, context()));
    assert.equal(canadian.totalJobs, 1);
    assert.deepEqual(canadian.items[0]!.locations.map((location) => location.countryCode), ["CA"]);

    const reopened = openJobRepository(f.databasePath, { now: () => AT });
    try { assert.deepEqual(await reopened.readSnapshot(), snapshot, "structured remote geography and source evidence persist in SQLite"); }
    finally { reopened.close(); }
    assert.equal(f.requests.length, 2, "querying and reopening the index never re-fetch the source");
  } finally { await f.close(); }
});

test("Ashby tier base, commission, bonus and equity retain original amounts while unknown tax blocks comparable gross annual salary", async () => {
  const f = await fixture();
  try {
    value(await f.application.registry.execute("sources.sync", { sourceId: source.sourceId, scope }, context("sync-ashby-pay")));
    const snapshot = await f.repository.readSnapshot();
    const current = snapshot.jobs[0]!.compensationIds.map((id) => snapshot.compensations.find((pay) => pay.id === id)!);
    const component = (label: string) => {
      const found = current.filter((pay) => pay.raw.includes(label));
      assert.equal(found.length, 1, `one separate ${label} tier disclosure is retained`);
      assert.match(found[0]!.raw, /United States/, "tier attribution survives projection");
      return found[0]!;
    };
    const base = component("Salary USD");
    assert.deepEqual({ currency: base.currency, period: base.period, min: base.min, max: base.max, kind: base.kind, tax: base.tax },
      { currency: "USD", period: "year", min: 168000, max: 220500, kind: "base", tax: "unknown" });
    const commission = component("Commission USD");
    assert.deepEqual({ min: commission.min, max: commission.max, kind: commission.kind, tax: commission.tax }, { min: 72000, max: 94500, kind: "unknown", tax: "unknown" });
    const bonus = component("Bonus USD");
    assert.deepEqual({ min: bonus.min, max: bonus.max, kind: bonus.kind }, { min: 12000, max: 18000, kind: "bonus" });
    const equity = component("Equity USD");
    assert.deepEqual({ min: equity.min, max: equity.max, kind: equity.kind }, { min: 20000, max: 40000, kind: "equity" });
    const percentage = component("Equity 0.5%");
    assert.equal(percentage.currency, undefined);
    assert.equal(percentage.min, undefined, "ownership percentages are never monetary amounts");
    assert.equal(percentage.max, undefined);
    assert.ok(current.every((pay) => pay.tax === "unknown" && pay.verification === "unverified" && pay.evidence.length > 0));
    assert.ok(!current.some((pay) => pay.min === 100000 || pay.max === 999999), "summaryComponents' cross-tier envelope does not replace actual tier ranges");
    assert.equal(normalizeCompensation(base, { fx, now: AT }).reason, "unknown-tax-basis");
    assert.equal(normalizeCompensation(commission, { fx, now: AT }).reason, "not-base-salary");

    const searched = await queryJobs(snapshot, { workCountryCodes: ["US"], sort: { field: "salary", direction: "desc" } }, { fx, now: AT });
    assert.equal(searched.totalJobs, 1);
    assert.equal(searched.unknownSalaryCount, 1);
    assert.equal(searched.items[0]!.salarySelection, "none");
    assert.equal(searched.items[0]!.salaryCny, undefined);
    assert.ok(searched.items[0]!.salaryCandidates.every((candidate) => candidate.status !== "comparable" && candidate.cnyAnnual === undefined));
    const knownOnly = await queryJobs(snapshot, { salary: { range: { min: 1 }, includeUnknown: false } }, { fx, now: AT });
    assert.equal(knownOnly.totalJobs, 0, "a numeric source amount plus valid FX does not establish a gross annual base salary");
    assert.equal((await queryJobs(snapshot, { salary: { range: { min: 1 }, includeUnknown: true } }, { fx, now: AT })).totalJobs, 1);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
