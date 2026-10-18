import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type SourceDefinition, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { type SourcePage, type SourceTransport } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { openJobRepository } from "../src/repository.js";

const AT = "2026-10-19T00:00:00.000Z";
const COMPANY = { identifier: "SyntheticOrg", name: "Synthetic Public Test Company" };
const API = "https://api.smartrecruiters.com/v1/companies/SyntheticOrg/postings";
const TARGET_ID = "123456789012345";
const IRRELEVANT_ID = "123456789012346";
const UNREAD_ID = "123456789012347";
const NO_LINK_ID = "123456789012348";
const TARGET_URL = `https://jobs.smartrecruiters.com/SyntheticOrg/${TARGET_ID}-full-stack-developer-net`;

function context(idempotencyKey?: string): TrustedToolContext {
  return { requestId: randomUUID(), actorScope: "local-owner", allowedEffects: ["read-index", "external-read", "local-write"],
    signal: new AbortController().signal, budget: { requests: 20, bytes: 1_000_000, timeoutMs: 5000 },
    ...(idempotencyKey ? { idempotencyKey } : {}) };
}
function value<T>(result: ToolResult<unknown>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error(result.error.code);
  return result.value as T;
}
function listing(id: string, name: string) {
  return { id, name, company: COMPANY, ref: `${API}/${id}`,
    location: { city: "Suzhou", region: "Jiangsu", country: "cn", fullLocation: "Suzhou, Jiangsu, China",
      remote: false, hybrid: false, latitude: "31.299", longitude: "120.5853" },
    releasedDate: "2026-07-29T03:47:46.915Z", active: true };
}
function detail(id: string, responsibilities: string, qualifications: string, includePostingUrl = true) {
  return { id, name: "Synthetic systems engineer", company: COMPANY, ref: `${API}/${id}`,
    ...(includePostingUrl ? { postingUrl: id === TARGET_ID ? TARGET_URL : `https://jobs.smartrecruiters.com/SyntheticOrg/${id}-systems-engineer` } : {}),
    active: true,
    jobAd: { sections: {
      companyDescription: { title: "Company", text: "Synthetic public fixture employer." },
      jobDescription: { title: "Responsibilities", text: `<p>${responsibilities}</p>` },
      qualifications: { title: "Qualifications", text: `<p>${qualifications}</p>` },
      additionalInformation: { title: "Additional information", text: "" },
    } } };
}

test("default application resolves missing list links from bounded same-tenant details and indexes only linked C# body matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-smartrecruiters-integration-"));
  const databasePath = join(directory, "atlas.sqlite");
  const repository = openJobRepository(databasePath, { now: () => AT });
  const requests: string[] = [];
  const source: SourceDefinition = {
    sourceId: "synthetic-smartrecruiters-integration", name: "Synthetic Bosch SmartRecruiters fixture",
    adapterId: "smartrecruiters", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"],
    entityType: "job-posting", enabled: true, status: "active", remoteFilters: ["roles"], entryUrl: API,
    options: { companyIdentifier: "SyntheticOrg", companyName: "Synthetic Public Test Company", countryCode: "CN",
      pageSize: 4, fetchDetails: true, maxDetailRequestsPerPage: 3 },
    endpointPolicy: { allowedHosts: ["api.smartrecruiters.com"], allowedPathPrefixes: ["/v1/companies/SyntheticOrg/postings"],
      requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic test source", homepageUrl: "https://jobs.smartrecruiters.com/SyntheticOrg",
      usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 3, requestsPerMinute: 20 },
  };
  const responses: Record<string, unknown> = {
    [TARGET_ID]: detail(TARGET_ID, "Build and maintain internal services.", "Experience developing production systems in C# and .NET."),
    [IRRELEVANT_ID]: detail(IRRELEVANT_ID, "Maintain Python services.", "Experience with Python and SQL."),
    [NO_LINK_ID]: detail(NO_LINK_ID, "Build customer services.", "Experience with C# and SQL.", false),
  };
  const transport: SourceTransport = { request: async ({ url }) => {
    requests.push(url);
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").at(-1)!;
    const payload = parsed.pathname === new URL(API).pathname
      ? { offset: Number(parsed.searchParams.get("offset")), limit: Number(parsed.searchParams.get("limit")), totalFound: 4,
          content: [listing(TARGET_ID, "Synthetic software engineer"), listing(IRRELEVANT_ID, "Synthetic systems engineer"),
            listing(NO_LINK_ID, "Synthetic services engineer"), listing(UNREAD_ID, "Synthetic platform engineer")] }
      : responses[last] ?? (() => { throw new Error(`Unexpected unbounded detail request: ${url}`); })();
    return { url, status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify(payload) };
  } };
  let application: ReturnType<typeof createJobApplication> | undefined;
  try {
    application = createJobApplication({ repository, transport, now: () => AT });
    const installed = value<{ adapters: Array<{ adapterId: string; version: string; capabilities: string[]; remoteFilters: string[] }> }>(
      await application.registry.execute("sources.list", {}, context()));
    const smartRecruiters = installed.adapters.find((adapter) => adapter.adapterId === "smartrecruiters" && adapter.version === "1");
    assert.ok(smartRecruiters, "the default application registers the SmartRecruiters adapter");
    assert.ok(smartRecruiters.capabilities.includes("list-jobs"));
    assert.ok(smartRecruiters.remoteFilters.includes("roles"), "configured role keywords are sent to the public candidate query");

    value(await application.registry.execute("sources.register", { source }, context("register-smartrecruiters")));
    const scope = { roles: ["C#"], regions: ["Suzhou"], companyNames: ["Synthetic Public Test Company"], countryCodes: ["CN"] };
    const preview = value<{ page: SourcePage; localMatchedRecords: number }>(
      await application.registry.execute("sources.preview", { sourceId: source.sourceId, scope }, context()));
    assert.deepEqual(preview.page.records.map((item) => item.sourceRecordId), [TARGET_ID, IRRELEVANT_ID],
      "only candidates with a source-supplied detail link remain visible; q does not establish a keyword match");
    assert.equal(preview.page.records[0]!.url, TARGET_URL, "the detail's exact slug is preserved instead of synthesizing a route");
    assert.equal(preview.page.records[0]!.applicationUrl, TARGET_URL);
    assert.equal(preview.page.coverage.fetchedRecords, 4, "all four linkless list candidates are counted in coverage");
    assert.equal(preview.page.coverage.partial, true);
    assert.ok(preview.page.warnings.some((warning) => warning.includes("2 malformed, duplicate, wrong-tenant or unlinked records were omitted")),
      "a matching detail without a public link and an unread linkless candidate are explicitly omitted");
    assert.deepEqual(preview.page.coverage.ignoredFilters, ["regions", "companyNames"]);
    assert.equal(preview.localMatchedRecords, 1, "only the detailed C# duties/qualifications match the shared local matcher");
    assert.equal(requests.length, 4, "one list plus the configured three detail reads");
    assert.deepEqual(requests.slice(1), [TARGET_ID, IRRELEVANT_ID, NO_LINK_ID].map((id) => `${API}/${id}`));
    assert.equal(new URL(requests[0]!).searchParams.get("q"), "C#");

    const synced = value<{ run: { status: string; summary?: { records?: number; added?: number; needsHuman?: number } } }>(
      await application.registry.execute("sources.sync", { sourceId: source.sourceId, scope }, context("sync-smartrecruiters")));
    assert.equal(synced.run.status, "partial", "omitted linkless candidates are reported as partial coverage");
    assert.equal(synced.run.summary?.records, 4, "sync coverage counts fetched candidates, including omitted unlinked records");
    assert.equal(synced.run.summary?.added, 1, "broad candidates and unread requirements do not become canonical jobs");
    assert.equal(synced.run.summary?.needsHuman ?? 0, 0, "omitted linkless candidates do not become actionable records");
    assert.equal(requests.length, 8, "preview and sync each obey the same bounded detail allowance");

    const snapshot = await repository.readSnapshot();
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.listings.length, 1);
    assert.equal(snapshot.listings[0]!.sourceRecordId, TARGET_ID);
    assert.equal(snapshot.listings[0]!.canonicalUrl, TARGET_URL);
    const projection = await repository.readProjectionSnapshot();
    assert.equal(projection.locations.length, 1);
    assert.equal(projection.locations[0]!.countryCode, "CN");
    assert.equal(projection.locations[0]!.city, "Suzhou");
    assert.equal(projection.locations[0]!.latitude, undefined, "SmartRecruiters city centroid is never stored as an office coordinate");
    assert.equal(projection.locations[0]!.longitude, undefined);
    assert.ok(!snapshot.listings.some((item) => [IRRELEVANT_ID, NO_LINK_ID, UNREAD_ID].includes(item.sourceRecordId!)),
      "unrelated, matching-but-unlinked and unread candidates never enter SQLite");

    const searched = value<{ totalJobs: number; items: Array<{ job: { id: string }; sources: Array<{ url?: string }> }> }>(
      await application.registry.execute("jobs.search", { search: { text: "C#", mode: "fuzzy" }, workCountryCodes: ["CN"], workRegionText: "Suzhou" }, context()));
    assert.equal(searched.totalJobs, 1);
    assert.equal(searched.items[0]!.sources[0]!.url, TARGET_URL);
    const detailResult = value<{ job: { id: string }; listings: Array<{ canonicalUrl?: string }>; observations: Array<{ sourcePublishedAt?: string; sourcePublishedRaw?: string }>; snapshots: Array<{ text: string }> }>(
      await application.registry.execute("jobs.read-detail", { jobId: searched.items[0]!.job.id }, context()));
    assert.equal(detailResult.listings[0]!.canonicalUrl, TARGET_URL);
    assert.equal(detailResult.observations[0]!.sourcePublishedAt, "2026-07-29T03:47:46.915Z");
    assert.equal(detailResult.observations[0]!.sourcePublishedRaw, "2026-07-29T03:47:46.915Z");
    assert.ok(detailResult.snapshots[0]!.text.includes("Experience developing production systems in C# and .NET."));
    assert.ok(!detailResult.snapshots[0]!.text.includes("Experience with Python and SQL."));
    assert.ok(!requests.some((url) => url.endsWith(`/${UNREAD_ID}`)), "the quota leaves the fourth candidate unread");
  } finally {
    await application?.shutdown();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
