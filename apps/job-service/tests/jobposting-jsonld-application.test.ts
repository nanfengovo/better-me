import assert from "node:assert/strict";
import test from "node:test";
import { SourceDefinitionSchema, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository } from "../src/repository.js";

const at = "2026-10-19T00:00:00.000Z", origin = "https://careers.synthetic.example";
const source = SourceDefinitionSchema.parse({ sourceId: "synthetic-structured", name: "Synthetic structured source", adapterId: "jobposting-jsonld", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [], entryUrl: `${origin}/sitemap.xml`,
  options: { companyName: "Synthetic Source Company", enumerationKind: "sitemap-urlset", enumerationUrls: [`${origin}/sitemap.xml`], postingPathPrefixes: ["/jobs/"], pageSize: 1 },
  endpointPolicy: { allowedHosts: ["careers.synthetic.example"], allowedPathPrefixes: ["/sitemap.xml", "/jobs/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic source provenance", usage: "unknown", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 2, maxPages: 2, requestsPerMinute: 30 } });
function context(key?: string): TrustedToolContext { return { requestId: `synthetic-jsonld-${key ?? "read"}`, actorScope: "local-owner", allowedEffects: ["read-index", "local-write", "external-read"], signal: new AbortController().signal,
  budget: { requests: 20, bytes: 4_000_000, timeoutMs: 10_000 }, ...(key ? { idempotencyKey: key } : {}) }; }
function value(result: ToolResult): any { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value; }
function document(id: string, company = true) {
  const record = { "@context": "https://schema.org", "@type": "JobPosting", identifier: { "@type": "PropertyValue", value: id }, url: `${origin}/jobs/${id}`,
    title: `Synthetic ${id === "one" ? "C#" : "C++"} Engineer`, description: `<p>Build ${id === "one" ? "C#" : "C++"} systems with source evidence.</p>`,
    ...(company ? { hiringOrganization: { name: "Synthetic Employer" } } : {}), datePosted: "2026-09-13", employmentType: ["FULL_TIME"],
    jobLocation: { "@type": "Place", address: { addressCountry: "China", addressRegion: "Shanghai", addressLocality: "Shanghai", streetAddress: "Synthetic source street" }, geo: { latitude: 31.22222, longitude: 121.45806 } } };
  return `<html><script type="application/ld+json">${JSON.stringify(record)}</script></html>`;
}

test("the installed JSON-LD adapter flows through register, preview, sync, SQLite, HTTP query and source detail", async () => {
  const repository = openJobRepository(":memory:", { now: () => at }); const calls: string[] = [];
  const application = createJobApplication({ repository, now: () => at, transport: { request: async ({ url }) => {
    calls.push(url); return { url, status: 200, headers: {}, text: url.endsWith("sitemap.xml")
      ? `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/jobs/one</loc></url><url><loc>${origin}/jobs/two</loc></url></urlset>`
      : document(url.endsWith("one") ? "one" : "two") };
  } } });
  const http = createJobHttpServer({ registry: application.registry, token: "synthetic-jsonld-http-token-123456789", allowedOrigins: ["http://localhost:5173"], port: 0 });
  const { url } = await http.listen();
  try {
    const installed = value(await application.registry.execute("sources.list", {}, context()));
    assert.ok(installed.adapters.some((adapter: any) => adapter.adapterId === "jobposting-jsonld"));
    value(await application.registry.execute("sources.register", { source, expectedRevision: 0 }, context("register")));
    const discovery = value(await application.registry.execute("companies.discover-careers", { request: { companyName: "Synthetic Source Company" } }, context()));
    assert.equal(calls.length, 0); assert.equal(discovery.matchedSources[0].sourceId, source.sourceId);
    const before = await repository.backup();
    const query = { sourceId: source.sourceId, scope: { roles: ["C#"], regions: ["Shanghai"], companyNames: [], countryCodes: ["CN"] } };
    const preview = value(await application.registry.execute("sources.preview", query, context()));
    assert.equal(preview.localMatchedRecords, 1); assert.deepEqual(await repository.backup(), before);
    const synced = value(await application.registry.execute("sources.sync", query, context("sync")));
    assert.equal(synced.run.status, "completed"); assert.equal(synced.run.summary.records, 2);
    const count = calls.length;
    const replay = value(await application.registry.execute("sources.sync", query, context("sync")));
    assert.equal(replay.run.runId, synced.run.runId); assert.equal(calls.length, count);
    const snapshot = await repository.readSnapshot(); assert.equal(snapshot.jobs.length, 1); assert.equal(snapshot.locations[0]!.coordinates, undefined);
    assert.deepEqual(snapshot.companies[0]!.names, ["Synthetic Employer"]);
    assert.equal(snapshot.jobs[0]!.employmentType, "unknown"); assert.equal(snapshot.jobs[0]!.status, "unknown");
    const detail = value(await application.registry.execute("jobs.read-detail", { jobId: snapshot.jobs[0]!.id }, context()));
    assert.equal(detail.sources[0].attribution.label, "Synthetic source provenance");
    assert.equal(detail.listings[0].canonicalUrl, `${origin}/jobs/one`); assert.match(detail.job.description, /C#/);
    assert.equal(detail.observations[0].sourcePublishedAt, undefined); assert.equal(detail.observations[0].sourcePublishedRaw, "2026-09-13");
    assert.equal(detail.snapshots[0].completeness, "detail");
    const response = await fetch(`${url}/api/v1/jobs/search`, { method: "POST", headers: { Authorization: "Bearer synthetic-jsonld-http-token-123456789", "Content-Type": "application/json" },
      body: JSON.stringify({ search: { text: "C#" }, market: "domestic", includeUnknownLocations: false, workCountryCodes: ["CN"], workRegionGroups: [["Shanghai"]], mapCityReferences: true }) });
    const result = value(await response.json() as ToolResult); assert.equal(response.status, 200); assert.equal(result.totalJobs, 1); assert.equal(result.mappedJobs, 0);
    assert.equal(result.mapReferenceCoverage.cityReferenceJobs, 1); assert.equal(result.items[0].distance, undefined);
    assert.equal(result.items[0].sources[0].sourceId, source.sourceId);
  } finally { await http.close(); await application.shutdown(); repository.close(); }
});
