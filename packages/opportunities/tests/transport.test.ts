import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  AtlasDatasetSchema, JobQueryResultSchema, createJobQueryService, createJobsSearchTool,
  createToolRegistry, type AtlasDataset, type JobQueryInput, type JobQueryResult, type TrustedToolContext,
  normalizeSearchText,
} from "../src/index.js";

const NOW = "2026-10-18T12:00:00.000Z";
function dataset(): AtlasDataset {
  return AtlasDatasetSchema.parse({
    schemaVersion: 1, revision: 2, sources: [],
    companies: [{ id: "synthetic-company", names: ["Synthetic company"], domains: [], parentCompanyIds: [], manualOverrides: [], ultimateControllers: { value: [], method: "manual", verification: "unknown", evidence: [], revision: 0 } }],
    jobs: [{ id: "synthetic-job", companyId: "synthetic-company", title: { value: "C++ engineer", method: "manual", verification: "unverified", evidence: [], revision: 0 }, description: "Synthetic public description", locationIds: [], compensationIds: [], listingIds: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: NOW }],
    locations: [], compensations: [], listings: [], observations: [], snapshots: [],
  });
}
function context(requestId = "test-request"): TrustedToolContext {
  return { requestId, signal: new AbortController().signal, actorScope: "synthetic-user", allowedEffects: ["read-index"], budget: { requests: 0, bytes: 200_000, timeoutMs: 5000 } };
}

test("real domain query is identical through UI, tool and an isolated HTTP test transport", async () => {
  const snapshot = dataset();
  const service = createJobQueryService({ readSnapshot: async () => structuredClone(snapshot) });
  const registry = createToolRegistry([createJobsSearchTool(service, () => ({ now: NOW }))]);
  const query: JobQueryInput = { search: { text: "cpp" } };
  const ui = await service.search(query, { now: NOW });
  const tool = await registry.execute<JobQueryResult>("jobs.search", query, context());
  assert.equal(tool.ok, true);
  if (!tool.ok) throw new Error(tool.error.code);
  assert.deepEqual(tool.value, ui);
  assert.equal(JobQueryResultSchema.safeParse(ui).success, true);

  // This is a disposable transport fixture, not a production auth/API implementation.
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await registry.execute("jobs.search", input, context("http-request"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/test/jobs/search`, { method: "POST", body: JSON.stringify(query) });
    const http = await response.json() as { ok: boolean; value: unknown };
    assert.equal(http.ok, true);
    assert.deepEqual(http.value, ui);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("private query configuration cannot be supplied in tool args or returned in results", async () => {
  const service = createJobQueryService({ readSnapshot: async () => dataset() });
  let resolutions = 0;
  const registry = createToolRegistry([createJobsSearchTool(service, () => {
    resolutions++;
    return { now: NOW, anchor: { ref: "home-v1", latitude: 1.2345678, longitude: 9.8765432, coordinateSystem: "WGS84" } };
  })]);
  const good = await registry.execute("jobs.search", { distance: { anchorRef: "home-v1", includeUnknown: true } }, context());
  assert.equal(good.ok, true);
  assert.equal(resolutions, 1);
  assert.doesNotMatch(JSON.stringify(good), /1\.2345678|9\.8765432|latitude|longitude/);
  const bad = await registry.execute("jobs.search", { anchor: { latitude: 1.2345678 } }, context());
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, "invalid-input");
  assert.equal(resolutions, 1);
  const stale = await registry.execute("jobs.search", { distance: { anchorRef: "wrong-ref" } }, context());
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "location-unresolved");
});

test("output contract validates nested values and aggregate consistency", async () => {
  const service = createJobQueryService({ readSnapshot: async () => dataset() });
  const result = await service.search({}, { now: NOW });
  assert.equal(JobQueryResultSchema.safeParse(result).success, true);
  assert.equal(JobQueryResultSchema.safeParse({ ...result, totalJobs: 99 }).success, false);
  const forged = structuredClone(result);
  forged.items[0]!.salaryCny = 1_000_000;
  assert.equal(JobQueryResultSchema.safeParse(forged).success, false);
  const registry = createToolRegistry([createJobsSearchTool(service)]);
  const denied = await registry.execute("jobs.search", {}, { ...context(), allowedEffects: [] });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "not-authorized");
});

test("search normalization and alias lookup do not treat inherited object properties as terms", async () => {
  const service = createJobQueryService({ readSnapshot: async () => dataset() });
  assert.equal(normalizeSearchText("constructor"), "constructor");
  const absent = await service.search({ search: { text: "constructor" } }, { now: NOW, aliases: {} });
  assert.equal(absent.totalJobs, 0);
  const punctuationAlias = await service.search({ search: { text: "unrelated" } }, { now: NOW, aliases: { unrelated: ["."] } });
  assert.equal(punctuationAlias.totalJobs, 0);
});
