import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, mock } from "node:test";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { AtlasSourceServiceError, createAtlasSourceClient, parseAtlasSourceJson } from "../src/components/atlas/service-client.ts";
import { AtlasClientError } from "../src/components/atlas/client.ts";

const source = SourceDefinitionSchema.parse(JSON.parse(readFileSync(new URL("../../../config/sources/examples.json", import.meta.url), "utf8"))[0]);
const scope = { roles: ["TypeScript"], regions: ["上海"], companyNames: [] };
const at = "2026-10-18T12:00:00.000Z";
const client = () => createAtlasSourceClient("http://127.0.0.1:5178", " synthetic-token ");
const envelope = (value: unknown) => JSON.stringify({ ok: true, requestId: "synthetic-source-test", value });
const receipt = { ok: true, revision: 2, jobIds: [], snapshotIds: [], counts: { newJobs: 0, updatedJobs: 0, unchangedJobs: 0, newListings: 0, newObservations: 0, newSnapshots: 0 } };

test("company discovery validates input and calls the authenticated review-only tool route", async () => {
  const result = { status: "requires-company-website", companyName: "Synthetic New Company", observedAt: at,
    matchedSources: [], candidates: [], proposals: [], visitedUrls: [], partial: false, warnings: ["No configured web-search provider."] };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(envelope(result)); });
  assert.deepEqual(await client().discoverCompany(source.sourceId, { companyName: "Synthetic New Company" }), result);
  assert.equal(new URL(calls[0]!.url).pathname, "/api/v1/companies/discover-careers");
  assert.equal(new Headers(calls[0]!.init!.headers).get("Authorization"), "Bearer synthetic-token");
  assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)), { sourceId: source.sourceId, request: { companyName: "Synthetic New Company", limit: 10, maxPages: 3 } });
  await assert.rejects(client().discoverCompany(source.sourceId, { companyName: "" }), AtlasSourceServiceError);
  await assert.rejects(client().discoverCompany(source.sourceId, { companyName: "Synthetic", companyWebsite: "javascript:invalid" }), AtlasSourceServiceError);
  assert.equal(calls.length, 1);
});
const page = { records: [], observedAt: at, coverage: { complete: true, partial: false, fetchedRecords: 0, appliedFilters: [], ignoredFilters: ["roles", "regions"] }, warnings: [] };
const sync = { run: { runId: "synthetic-run", sourceId: source.sourceId, actorScope: "local-owner", generation: 1, scope: { keywords: scope.roles, regions: scope.regions, maxPages: 1, maxRecords: 10 }, status: "partial", startedAt: at, finishedAt: at, summary: { records: 10, pages: 1, partial: true } }, localFilters: scope, warnings: ["Limited to one page."] };
afterEach(() => mock.restoreAll());

test("source reads use real authenticated routes, inert JSON and bounded one-page preview", async () => {
  const fetcher = mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => new Response(envelope(String(url).endsWith("/preview") ? { page, localMatchedRecords: 0, localFilters: scope } : { sources: [source], adapters: [] })));
  const signal = new AbortController().signal;
  assert.equal((await client().list({ signal })).sources[0]!.sourceId, source.sourceId);
  await client().preview(source.sourceId, { scope, maxRecords: 10 }, { signal });
  const [url, options] = fetcher.mock.calls[1]!.arguments as [URL, RequestInit];
  assert.equal(url.href, `http://127.0.0.1:5178/api/v1/sources/${source.sourceId}/preview`);
  assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store"); assert.equal(options.signal, signal);
  assert.deepEqual(options.headers, { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(options.body as string), { scope, maxRecords: 10 });
});

test("source JSON accepts checked-in arrays but does not enable, fetch, install or register anything", () => {
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  const json = readFileSync(new URL("../../../config/sources/examples.json", import.meta.url), "utf8");
  const parsed = parseAtlasSourceJson(json);
  assert.ok(parsed.length >= 4); assert.ok(parsed.every((item) => !item.source.enabled && item.source.status === "needs-review"));
  assert.deepEqual(parseAtlasSourceJson(JSON.stringify({ source, expectedRevision: 8 })), [{ source, expectedRevision: 8 }]);
  for (const value of ["not JSON", "[]", JSON.stringify({ ...source, execute: "unsafe()" }), JSON.stringify({ ...source, options: { apiKey: "never-store-this" } }), JSON.stringify({ source, expectedRevision: -1 })]) {
    assert.throws(() => parseAtlasSourceJson(value), AtlasSourceServiceError);
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test("register and sync send caller-owned idempotency keys and exact finite limits", async () => {
  const fetcher = mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => new Response(envelope(String(url).endsWith("/sync") ? sync : receipt)));
  await client().register({ source, expectedRevision: 1 }, { idempotencyKey: "synthetic-register-1" });
  assert.equal((await client().sync(source.sourceId, { scope, maxRecords: 10, maxPages: 1 }, { idempotencyKey: "synthetic-sync-1" })).run.status, "partial");
  const calls = fetcher.mock.calls.map((call) => call.arguments as [URL, RequestInit]);
  assert.equal(new Headers(calls[0]![1].headers).get("Idempotency-Key"), "synthetic-register-1");
  assert.deepEqual(JSON.parse(calls[0]![1].body as string), { source, expectedRevision: 1 });
  assert.equal(new Headers(calls[1]![1].headers).get("Idempotency-Key"), "synthetic-sync-1");
  assert.deepEqual(JSON.parse(calls[1]![1].body as string), { scope, maxRecords: 10, maxPages: 1 });
  const before = fetcher.mock.callCount();
  await assert.rejects(client().register({ source }, { idempotencyKey: "bad\nkey" }), AtlasSourceServiceError);
  await assert.rejects(client().sync(source.sourceId, { maxPages: 0 }, { idempotencyKey: "synthetic" }), AtlasSourceServiceError);
  await assert.rejects(client().preview("bad/id", {}, {}), AtlasSourceServiceError);
  assert.equal(fetcher.mock.callCount(), before);
});

test("client rejects extra output fields, invalid records and server error bodies without exposing text", async () => {
  for (const response of [
    { ok: true, requestId: "x", value: { sources: [source], adapters: [], privateToken: "must-not-surface" } },
    { ok: true, requestId: "x", value: { sources: [{ ...source, enabled: "yes" }], adapters: [] } },
    { ok: true, requestId: "x", value: { sources: [], adapters: [] }, extra: true },
    { ok: true, value: { sources: [], adapters: [] } },
  ]) {
    const fetcher = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(response)));
    await assert.rejects(client().list(), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response"); fetcher.mock.restore();
  }
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, requestId: "x", error: { code: "rate-limited", message: "private source payload must not leak" } }), { status: 429 }));
  await assert.rejects(client().list(), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "rate-limited" && error.status === 429 && !error.message.includes("private source"));
});

test("streaming response bytes are capped and cancellation propagates to fetch and body readers", async () => {
  let cancelled = false;
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode("中文")); }, cancel() { cancelled = true; } })));
  await assert.rejects(client().list({ maxBytes: 8 }), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "too-large");
  assert.equal(cancelled, true); fetcher.mock.restore();
  const controller = new AbortController(); let options: RequestInit | undefined;
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    options = init;
    return new Response(new ReadableStream({ start() { queueMicrotask(() => controller.abort(new DOMException("synthetic cancelled", "AbortError"))); }, cancel() { cancelled = true; } }));
  });
  await assert.rejects(client().list({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(options?.signal, controller.signal);
  assert.equal(cancelled, true);
});

test("loopback endpoint and token checks precede network access; snapshot uses the shared strict reader", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(envelope(createAtlasDemo())));
  for (const endpoint of ["https://external.example", "http://127.0.0.1/path", "http://user:pass@localhost", "http://localhost/?query=x"]) {
    await assert.rejects(createAtlasSourceClient(endpoint, "synthetic").list(), AtlasClientError);
  }
  await assert.rejects(createAtlasSourceClient("http://127.0.0.1", " ").list(), AtlasClientError);
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal((await client().snapshot()).jobs.length, 22);
  assert.equal(String(fetcher.mock.calls[0]!.arguments[0]), "http://127.0.0.1:5178/api/v1/dataset/export");
});

test("candidate discovery routes preserve original URLs, unknown licensing and inspect/propose separation", async () => {
  const candidate = { candidateId: "synthetic-candidate", provider: "github-repositories", homeUrl: "https://github.com/example/jobs", discoveredAt: at, status: "needs-review", repository: { fullName: "example/jobs" }, entryHints: [], evidenceUrls: ["https://github.com/example/jobs"], warnings: [] };
  const discovery = { candidates: [candidate], observedAt: at, partial: false, warnings: [] };
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(envelope(discovery)));
  const result = await client().discover("synthetic-discovery", { provider: "github-repositories", query: "automation Shanghai", limit: 5 });
  assert.equal(result.candidates[0]!.homeUrl, candidate.homeUrl); assert.equal(result.candidates[0]!.repository!.licenseSpdx, undefined);
  const [url, init] = fetcher.mock.calls[0]!.arguments as [URL, RequestInit];
  assert.equal(url.pathname, "/api/v1/sources/discover");
  assert.deepEqual(JSON.parse(init.body as string), { sourceId: "synthetic-discovery", request: { provider: "github-repositories", query: "automation Shanghai", limit: 5 } });
  assert.equal(new Headers(init.headers).has("Idempotency-Key"), false);
  assert.equal(fetcher.mock.callCount(), 1);
});
