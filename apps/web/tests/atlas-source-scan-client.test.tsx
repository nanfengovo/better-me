import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, mock } from "node:test";
import { ContinueSourceScanInputSchema, type ContinueSourceScanInput, type SourceScanProgress, type SourceSyncResult } from "@better-me/source-adapters/browser-contracts";
import { AtlasSourceServiceError, createAtlasSourceClient } from "../src/components/atlas/service-client.ts";

const sourceId = "synthetic-source", fromRunId = "synthetic-prior-run", at = "2026-10-22T00:00:00.000Z";
const scope = { roles: ["C#"], regions: ["上海"], companyNames: [], countryCodes: ["CN"] };
const command: ContinueSourceScanInput = { sourceId, fromRunId, expectedProgressVersion: 2, maxRecords: 20, maxPages: 1 };
const client = () => createAtlasSourceClient("http://127.0.0.1:5178", "synthetic-scan-token");
const envelope = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-scan-request", value }));
const progress = (runId = fromRunId): SourceScanProgress => ({ scanId: "synthetic-scan", sourceId, runId, version: 2, scope,
  state: "ready", running: false, canContinue: true, attemptedRecords: 20, pages: 1, hadErrors: false, updatedAt: at });
function continued(): SourceSyncResult {
  return { run: { runId: "synthetic-continued-run", sourceId, actorScope: "local-owner", generation: 2, scope: { keywords: scope.roles, regions: scope.regions, companies: [], countryCodes: ["CN"], maxRecords: 20, maxPages: 1 },
    requestFingerprint: createHash("sha256").update(JSON.stringify({ tool: "sources.continue-sync", input: ContinueSourceScanInputSchema.parse(command) })).digest("hex"),
    scanId: "synthetic-scan", continuedFromRunId: fromRunId, status: "partial", startedAt: at, finishedAt: at, summary: { records: 20, pages: 1, partial: true } },
  localFilters: scope, warnings: [], scanProgress: { ...progress("synthetic-continued-run"), version: 4, pages: 2, attemptedRecords: 40 } };
}
afterEach(() => mock.restoreAll());

test("scan progress uses an authenticated strict POST with an optional exact run binding and no external cursor", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit) => { calls.push({ url: String(url), init }); return envelope({ sourceId, progress: calls.length === 3 ? null : progress() }); });
  const signal = new AbortController().signal;
  assert.deepEqual((await client().readScanProgress({ sourceId, runId: fromRunId }, { signal })).progress, progress());
  await client().readScanProgress({ sourceId }); assert.equal((await client().readScanProgress({ sourceId })).progress, null);
  assert.equal(new URL(calls[0]!.url).pathname, `/api/v1/sources/${sourceId}/scan-progress`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { runId: fromRunId }); assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {});
  assert.equal(calls[0]!.init.method, "POST"); assert.equal(calls[0]!.init.signal, signal);
  assert.equal(new Headers(calls[0]!.init.headers).get("Authorization"), "Bearer synthetic-scan-token");
  assert.equal(new Headers(calls[0]!.init.headers).get("Idempotency-Key"), null);
});

test("continuation binds the retained source, original run, version and finite budget with the caller's durable key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit) => { calls.push({ url: String(url), init }); return envelope(continued()); });
  const before = structuredClone(command), signal = new AbortController().signal;
  assert.deepEqual(await client().continueSync(command, { signal, idempotencyKey: "synthetic-continue-key" }), continued());
  assert.deepEqual(command, before);
  assert.equal(new URL(calls[0]!.url).pathname, `/api/v1/sources/${sourceId}/continue-sync`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { fromRunId, expectedProgressVersion: 2, maxRecords: 20, maxPages: 1 });
  assert.equal(calls[0]!.init.method, "POST"); assert.equal(calls[0]!.init.signal, signal);
  assert.equal(new Headers(calls[0]!.init.headers).get("Idempotency-Key"), "synthetic-continue-key");
  assert.equal(new Headers(calls[0]!.init.headers).get("Authorization"), "Bearer synthetic-scan-token");
  const olderReceipt = continued(); delete olderReceipt.scanProgress;
  mock.restoreAll(); mock.method(globalThis, "fetch", async () => envelope(olderReceipt));
  assert.deepEqual(await client().continueSync(command, { idempotencyKey: "synthetic-continue-key" }), olderReceipt, "a durable original run remains readable after a later batch owns the current checkpoint");
});

test("well-shaped but foreign progress, runs, versions, scopes and request fingerprints remain untrusted", async () => {
  const wrongProgress = [{ sourceId: "other", progress: progress() }, { sourceId, progress: { ...progress(), sourceId: "other" } },
    { sourceId, progress: { ...progress(), runId: "other" } }, { sourceId, progress: { ...progress(), version: 0 } },
    { sourceId, progress: { ...progress(), cursor: "private-provider-cursor" } }];
  for (const response of wrongProgress) {
    mock.method(globalThis, "fetch", async () => envelope(response));
    await assert.rejects(client().readScanProgress({ sourceId, runId: fromRunId }), error => error instanceof AtlasSourceServiceError && error.code === "invalid-response"); mock.restoreAll();
  }
  const changes: Array<(value: SourceSyncResult) => void> = [
    value => { value.run.sourceId = "other"; }, value => { value.run.continuedFromRunId = "other"; }, value => { value.run.runId = fromRunId; },
    value => { value.run.requestFingerprint = "a".repeat(64); }, value => { delete value.run.requestFingerprint; }, value => { delete value.run.scanId; },
    value => { value.scanProgress!.scanId = "other"; }, value => { value.scanProgress!.sourceId = "other"; }, value => { value.scanProgress!.runId = "other"; },
    value => { value.scanProgress!.version = command.expectedProgressVersion; }, value => { value.scanProgress!.scope = { ...scope, roles: ["other"] }; },
    value => { value.run.scope.regions = ["other"]; }, value => { value.run.status = "running"; },
  ];
  for (const change of changes) {
    const response = structuredClone(continued()); change(response); mock.method(globalThis, "fetch", async () => envelope(response));
    await assert.rejects(client().continueSync(command, { idempotencyKey: "same-original-key" }), error => error instanceof AtlasSourceServiceError && error.code === "invalid-response"); mock.restoreAll();
  }
  mock.method(globalThis, "fetch", async () => envelope(continued()));
  await assert.rejects(client().continueSync({ ...command, expectedProgressVersion: 1 }, { idempotencyKey: "same-original-key" }), /原批次|指纹/);
});

test("invalid scan input or external cursor cannot reach the network, while abort and byte bounds remain effective", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => envelope(continued()));
  await assert.rejects(client().readScanProgress({ sourceId: "bad/id" }), AtlasSourceServiceError);
  await assert.rejects(client().continueSync({ ...command, expectedProgressVersion: 0 }, { idempotencyKey: "key" }), AtlasSourceServiceError);
  await assert.rejects(client().continueSync({ ...command, maxPages: 1001 }, { idempotencyKey: "key" }), AtlasSourceServiceError);
  await assert.rejects(client().continueSync({ ...command, cursor: "untrusted" } as ContinueSourceScanInput, { idempotencyKey: "key" }), AtlasSourceServiceError);
  await assert.rejects(client().continueSync(command, { idempotencyKey: "bad\nkey" }), AtlasSourceServiceError);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client().continueSync(command, { signal: abort.signal, idempotencyKey: "key" }), { name: "AbortError" });
  assert.equal(fetcher.mock.callCount(), 0);
  await assert.rejects(client().continueSync(command, { maxBytes: 8, idempotencyKey: "key" }), error => error instanceof AtlasSourceServiceError && error.code === "too-large");
});

test("unknown write outcomes retry the exact body and key, while known tool failures retain their typed recovery semantics", async () => {
  const attempts: Array<{ body: unknown; key: string | null }> = [];
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit) => {
    attempts.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") });
    if (attempts.length === 1) throw new Error("Synthetic connection lost"); return envelope(continued());
  });
  await assert.rejects(client().continueSync(command, { idempotencyKey: "retained-original-key" }), error => error instanceof AtlasSourceServiceError && error.code === "transport-error" && /原幂等键/.test(error.message));
  await client().continueSync(command, { idempotencyKey: "retained-original-key" }); assert.deepEqual(attempts[0], attempts[1]); mock.restoreAll();
  for (const [code, status] of [["stale-version", 409], ["idempotency-conflict", 409], ["rate-limited", 429], ["invalid-input", 404]] as const) {
    mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, requestId: "failure", error: { code, message: "private-provider-response" } }), { status }));
    await assert.rejects(client().continueSync(command, { idempotencyKey: "retained-original-key" }), error => error instanceof AtlasSourceServiceError && error.code === code && error.status === status && !error.message.includes("private-provider-response")); mock.restoreAll();
  }
});

test("an old backend gives an upgrade diagnostic without replacing a missing feature with an empty successful scan", async () => {
  mock.method(globalThis, "fetch", async () => new Response("<html>old backend</html>", { status: 404 }));
  for (const action of [() => client().readScanProgress({ sourceId }), () => client().continueSync(command, { idempotencyKey: "original" })]) {
    await assert.rejects(action(), error => error instanceof AtlasSourceServiceError && error.status === 404 && /升级/.test(error.message) && /原幂等键/.test(error.message));
  }
});

test("fresh sync cannot acknowledge a different query or budget using an internally consistent same-source run", async () => {
  const request = { scope, maxRecords: 20, maxPages: 1 };
  const fresh = structuredClone(continued()); delete fresh.run.continuedFromRunId;
  fresh.run.requestFingerprint = createHash("sha256").update(JSON.stringify({ sourceId, scope, maxRecords: 20, maxPages: 1 })).digest("hex");
  mock.method(globalThis, "fetch", async () => envelope(fresh));
  assert.equal((await client().sync(sourceId, request, { idempotencyKey: "fresh-key" })).run.runId, fresh.run.runId); mock.restoreAll();
  for (const change of [
    (value: SourceSyncResult) => { value.run.scope.keywords = ["other query"]; value.localFilters.roles = ["other query"]; value.scanProgress!.scope.roles = ["other query"]; },
    (value: SourceSyncResult) => { value.run.requestFingerprint = "b".repeat(64); },
    (value: SourceSyncResult) => { delete value.run.requestFingerprint; },
  ]) {
    const result = structuredClone(fresh); change(result); mock.method(globalThis, "fetch", async () => envelope(result));
    await assert.rejects(client().sync(sourceId, request, { idempotencyKey: "fresh-key" }), error => error instanceof AtlasSourceServiceError && error.code === "invalid-response"); mock.restoreAll();
  }
  mock.method(globalThis, "fetch", async () => envelope(fresh));
  await assert.rejects(client().sync(sourceId, { ...request, maxPages: 2 }, { idempotencyKey: "fresh-key" }), /指纹/);
});
