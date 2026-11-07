import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type SourceDefinition, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { type SourceTransport } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { openJobRepository } from "../src/repository.js";

const ORIGIN = "https://jll.wd1.myworkdayjobs.com";
const SITE = "jllcareerschina";
const API = `${ORIGIN}/wday/cxs/jll/${SITE}`;
const URL = `${ORIGIN}/${SITE}/job/Beijing/Engineer_REQ123`;
const AT = "2026-10-24T00:00:00.000Z";
function context(key?: string): TrustedToolContext { return { requestId: randomUUID(), actorScope: "local-owner", allowedEffects: ["read-index", "external-read", "local-write"], signal: new AbortController().signal, budget: { requests: 20, bytes: 1_000_000, timeoutMs: 5000 }, ...(key ? { idempotencyKey: key } : {}) }; }
function value<T>(result: ToolResult<unknown>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error(result.error.code); return result.value as T; }

test("default job application previews and syncs a bounded Workday CXS source through the controlled adapter registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-workday-integration-"));
  const repository = openJobRepository(join(directory, "atlas.sqlite"), { now: () => AT });
  const requests: Array<{ method?: string; url: string; body?: string }> = [];
  const source: SourceDefinition = {
    sourceId: "synthetic-jll-workday", name: "Synthetic JLL Workday", adapterId: "workday-cxs", adapterVersion: "1", capabilities: ["list-jobs"],
    runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", entryUrl: `${ORIGIN}/${SITE}`,
    options: { tenant: "jll", site: SITE, pageSize: 2, maxDetailRequestsPerPage: 1 }, remoteFilters: ["roles"],
    endpointPolicy: { allowedHosts: ["jll.wd1.myworkdayjobs.com"], allowedPathPrefixes: [`/wday/cxs/jll/${SITE}`], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "Synthetic Workday source", usage: "unknown", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 2, requestsPerMinute: 30 },
  };
  const transport: SourceTransport = { async request(input) {
    requests.push({ method: input.method, url: input.url, ...(input.jsonBody ? { body: input.jsonBody } : {}) });
    if (input.method === "POST") return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ total: 1, jobPostings: [{ title: "Engineer", externalPath: "/job/Beijing/Engineer_REQ123", bulletFields: ["REQ123"], locationsText: "Beijing, CN", postedOn: "Posted Yesterday" }] }) };
    return { url: input.url, status: 200, headers: {}, text: JSON.stringify({ jobPostingInfo: { title: "Engineer", jobReqId: "REQ123", jobPostingId: "Engineer_REQ123", jobPostingSiteId: SITE, externalUrl: URL, location: "Beijing, CN", country: { alpha2Code: "CN" }, posted: true, canApply: true, jobDescription: "Build reliable systems." }, hiringOrganization: { name: "JLL Example Ltd" } }) };
  } };
  const application = createJobApplication({ repository, now: () => AT, transport });
  try {
    await repository.registerSource(source, { actorScope: "local-owner", idempotencyKey: "seed-workday-source" });
    const scope = { roles: ["reliable systems"], regions: [], companyNames: [] };
    const preview = value<{ page: { records: Array<{ sourceRecordId?: string; completeness: string }>; coverage: { partial: boolean } } }>(
      await application.registry.execute("sources.preview", { sourceId: source.sourceId, scope }, context()));
    assert.equal(preview.page.records.length, 1); assert.equal(preview.page.records[0]!.sourceRecordId, "REQ123");
    assert.equal(preview.page.records[0]!.completeness, "detail"); assert.equal(preview.page.coverage.partial, false);
    const synced = value<{ run: { status: string; summary?: { added?: number } } }>(
      await application.registry.execute("sources.sync", { sourceId: source.sourceId, scope }, context("workday-sync")));
    assert.equal(synced.run.status, "completed"); assert.equal(synced.run.summary?.added, 1);
    assert.deepEqual(requests.map(item => item.method ?? "GET"), ["POST", "GET", "POST", "GET"]);
    assert.ok(requests.filter(item => item.method === "POST").every(item => item.url === `${API}/jobs`));
    assert.ok(requests.filter(item => item.method === "GET").every(item => item.url === `${API}/job/Beijing/Engineer_REQ123`));
    assert.ok(requests.filter(item => item.method === "POST").every(item => JSON.parse(item.body!).searchText === "reliable systems"));
    const snapshot = await repository.readSnapshot();
    assert.equal(snapshot.jobs.length, 1); assert.ok(snapshot.companies[0]!.names.includes("JLL Example Ltd"));
    const projection = await repository.readProjectionSnapshot();
    assert.equal(projection.locations[0]!.countryCode, "CN"); assert.equal(projection.locations[0]!.city, undefined);
    assert.equal(projection.locations[0]!.latitude, undefined); assert.equal(projection.locations[0]!.streetAddress, undefined);
  } finally { await application.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }); }
});
