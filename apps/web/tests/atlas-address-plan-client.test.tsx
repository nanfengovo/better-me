import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import type { PlanAddressEnrichmentInput } from "@better-me/opportunities";
import { AtlasSourceServiceError, createAtlasSourceClient } from "../src/components/atlas/service-client.ts";

const client = () => createAtlasSourceClient("http://127.0.0.1:5178", " synthetic-address-plan-token ");
const query = { jobIds: ["synthetic-job-a", "synthetic-job-b"], expectedRevision: 12 };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-address-plan", value }));
const item = (jobId: string) => ({
  jobId, title: "Synthetic software engineer", companyId: "synthetic-company", companyName: "Synthetic Company",
  status: "company-discovery", currentOffice: [], pendingLocationIds: [`${jobId}-location`], sourceStreetTargets: [],
  exactPlatformTargets: [], ownedOfficialTargets: [],
  companyLookup: { companyName: "Synthetic Company", association: "unverified", strength: "weak" },
  truncated: false, warnings: [],
});
const plan = (jobIds = query.jobIds) => ({
  schemaVersion: 1, snapshotRevision: query.expectedRevision,
  requestedJobs: jobIds.length, processedJobs: jobIds.length,
  truncated: false, items: jobIds.map(item), warnings: [],
});
const invalidResponse = (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response";

afterEach(() => mock.restoreAll());

test("address plans are authenticated, bounded read-only requests for the explicit result scope", async () => {
  const controller = new AbortController();
  const value = plan([...query.jobIds].reverse());
  const fetcher = mock.method(globalThis, "fetch", async () => response(value));
  assert.deepEqual(await client().planAddressEnrichment(query, { signal: controller.signal }), value);
  const [url, init] = fetcher.mock.calls[0]!.arguments as [URL, RequestInit];
  assert.equal(url.pathname, "/api/v1/jobs/address-enrichment/plan");
  assert.equal(init.method, "POST"); assert.equal(init.signal, controller.signal);
  assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
  assert.deepEqual(JSON.parse(String(init.body)), query);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("Authorization"), "Bearer synthetic-address-plan-token");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.has("Idempotency-Key"), false);
  assert.equal(fetcher.mock.callCount(), 1);
});

test("an explicitly empty scope remains empty instead of expanding to the index", async () => {
  let value: unknown = plan([]);
  const fetcher = mock.method(globalThis, "fetch", async () => response(value));
  assert.deepEqual(await client().planAddressEnrichment({ ...query, jobIds: [] }), plan([]));
  assert.deepEqual(JSON.parse(String((fetcher.mock.calls[0]!.arguments[1] as RequestInit).body)), { ...query, jobIds: [] });
  value = plan();
  await assert.rejects(client().planAddressEnrichment({ ...query, jobIds: [] }), invalidResponse);
});

test("a well-formed plan from another revision or job set cannot become this batch's work", async () => {
  let value: unknown;
  mock.method(globalThis, "fetch", async () => response(value));
  for (const changed of [
    { ...plan(), snapshotRevision: query.expectedRevision - 1 },
    { ...plan(), snapshotRevision: query.expectedRevision + 1 },
    plan([query.jobIds[0]!]),
    plan([...query.jobIds, "synthetic-extra-job"]),
    plan([query.jobIds[0]!, "synthetic-unrelated-job"]),
  ]) {
    value = changed;
    await assert.rejects(client().planAddressEnrichment(query), invalidResponse);
  }
});

test("invalid counts, duplicate jobs, inconsistent actions and unrecognized fields are rejected", async () => {
  const base = plan(); let value: unknown;
  mock.method(globalThis, "fetch", async () => response(value));
  for (const changed of [
    { ...base, requestedJobs: 1 }, { ...base, processedJobs: 1 },
    { ...base, items: [item(query.jobIds[0]!), item(query.jobIds[0]!)] },
    { ...base, truncated: true }, { ...base, schemaVersion: 2 },
    { ...base, items: [{ ...item(query.jobIds[0]!), status: "office-ready" }, item(query.jobIds[1]!)] },
    { ...base, items: [{ ...item(query.jobIds[0]!), pendingLocationIds: undefined }, item(query.jobIds[1]!)] },
    { ...base, privateToken: "PRIVATE_SERVICE_FIELD" },
    { ...base, items: [{ ...item(query.jobIds[0]!), homeAddress: "PRIVATE_HOME_FIELD" }, item(query.jobIds[1]!)] },
  ]) {
    value = changed;
    await assert.rejects(client().planAddressEnrichment(query), error => invalidResponse(error)
      && !(error as Error).message.includes("PRIVATE"));
  }
});

test("invalid and overlarge scopes never reach the service", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("must not run"); });
  for (const value of [
    { ...query, jobIds: [query.jobIds[0], query.jobIds[0]] },
    { ...query, jobIds: Array.from({ length: 51 }, (_, index) => `synthetic-job-${index}`) },
    { ...query, expectedRevision: -1 }, { ...query, jobIds: [""] },
    { ...query, companyWebsite: "https://private.example/careers" },
    { ...query, homeAddress: "PRIVATE_HOME" }, { ...query, provider: "nominatim" },
  ]) {
    await assert.rejects(client().planAddressEnrichment(value as PlanAddressEnrichmentInput),
      (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-input");
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test("cancelled batches cannot start or finish reading a stale plan", async () => {
  const early = new AbortController(); early.abort(new DOMException("Synthetic cancellation", "AbortError"));
  const fetcher = mock.method(globalThis, "fetch", async () => response(plan()));
  await assert.rejects(client().planAddressEnrichment(query, { signal: early.signal }), { name: "AbortError" });
  assert.equal(fetcher.mock.callCount(), 0); fetcher.mock.restore();

  const during = new AbortController(); let cancelled = false;
  mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start() { queueMicrotask(() => during.abort(new DOMException("Synthetic cancellation", "AbortError"))); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(client().planAddressEnrichment(query, { signal: during.signal }), { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("oversize and non-JSON plan responses fail without exposing the response body", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => response(plan()));
  await assert.rejects(client().planAddressEnrichment(query, { maxBytes: 8 }),
    (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "too-large");
  fetcher.mock.restore();
  mock.method(globalThis, "fetch", async () => new Response("PRIVATE_UPSTREAM_HTML"));
  await assert.rejects(client().planAddressEnrichment(query), error => invalidResponse(error)
    && !(error as Error).message.includes("PRIVATE"));
});
