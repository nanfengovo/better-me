import assert from "node:assert/strict";
import test from "node:test";
import {
  ContinueSourceScanInputSchema, ReadSourceScanProgressInputSchema, SourcePageSchema, SourceScanProgressResultSchema,
  SourceScanProgressSchema, SourceSyncResultSchema, SourceSyncRunSchema,
} from "../src/browser-contracts.js";

const at = "2026-10-22T00:00:00.000Z";
const scope = { roles: ["C#"], regions: ["Shanghai"], companyNames: ["Synthetic"], countryCodes: ["CN"] };
const run = { runId: "run-synthetic", sourceId: "source-synthetic", actorScope: "synthetic-user", generation: 1,
  scope: { keywords: scope.roles, regions: scope.regions, companies: scope.companyNames, countryCodes: scope.countryCodes, maxRecords: 6, maxPages: 1 },
  scanId: "scan-synthetic", status: "partial", startedAt: at, finishedAt: at, summary: { records: 6, pages: 1, partial: true } };
const progress = { scanId: run.scanId, sourceId: run.sourceId, runId: run.runId, version: 2, scope,
  state: "ready", running: false, canContinue: true, attemptedRecords: 6, pages: 1, hadErrors: false, updatedAt: at };
const result = { run, localFilters: scope, warnings: [], scanProgress: progress };

test("shared browser-safe scan schemas preserve a new result and legacy results without scan fields", () => {
  assert.deepEqual(SourceSyncResultSchema.parse(result), result);
  const { scanId: _scanId, ...legacyRun } = run;
  const legacyResult = { run: legacyRun, localFilters: scope, warnings: [] };
  assert.deepEqual(SourceSyncRunSchema.parse(legacyRun), legacyRun);
  assert.deepEqual(SourceSyncResultSchema.parse(legacyResult), legacyResult);
  assert.deepEqual(SourceScanProgressResultSchema.parse({ sourceId: run.sourceId, progress: null }), { sourceId: run.sourceId, progress: null });
});

test("continuation inputs accept only durable identity and bounded batch limits, never new scope or raw cursors", () => {
  const input = { sourceId: run.sourceId, fromRunId: run.runId, expectedProgressVersion: 2, maxRecords: 6, maxPages: 1 };
  assert.deepEqual(ContinueSourceScanInputSchema.parse(input), input);
  for (const changes of [{ cursor: "private-upstream-cursor" }, { scope }, { actorScope: "another-user" }, { expectedProgressVersion: 0 },
    { expectedProgressVersion: 1.5 }, { maxRecords: 0 }, { maxRecords: 100001 }, { maxPages: 0 }, { maxPages: 1001 }]) {
    assert.equal(ContinueSourceScanInputSchema.safeParse({ ...input, ...changes }).success, false, JSON.stringify(changes));
  }
  assert.deepEqual(ReadSourceScanProgressInputSchema.parse({ sourceId: run.sourceId, runId: run.runId }), { sourceId: run.sourceId, runId: run.runId });
  assert.equal(ReadSourceScanProgressInputSchema.safeParse({ sourceId: run.sourceId, cursor: "private" }).success, false);
});

test("progress continuation flags exactly reflect running state and retained checkpoint state", () => {
  for (const state of ["ready", "retry-page", "exhausted", "truncated", "invalidated"] as const) {
    for (const running of [false, true]) {
      const canContinue = !running && (state === "ready" || state === "retry-page");
      const valid = { ...progress, state, running, canContinue, ...(state === "invalidated" ? { invalidatedReason: "new-scan" } : {}) };
      assert.equal(SourceScanProgressSchema.safeParse(valid).success, true, `${state}/${running}`);
      assert.equal(SourceScanProgressSchema.safeParse({ ...valid, canContinue: !canContinue }).success, false, `${state}/${running}`);
    }
  }
  assert.equal(SourceScanProgressSchema.safeParse({ ...progress, invalidatedReason: "new-scan" }).success, false);
  assert.equal(SourceScanProgressSchema.safeParse({ ...progress, state: "invalidated", canContinue: false }).success, false);
});

test("public results reject private checkpoint data rather than silently stripping it", () => {
  for (const changes of [{ cursor: "private" }, { sourceFingerprint: "a".repeat(64) }, { actorScope: "private-owner" }, { generation: 3 }]) {
    assert.equal(SourceScanProgressSchema.safeParse({ ...progress, ...changes }).success, false);
  }
  assert.equal(SourceSyncResultSchema.safeParse({ ...result, cursor: "private" }).success, false);
  assert.equal(SourceSyncResultSchema.safeParse({ ...result, run: { ...run, scope: { ...run.scope, cursor: "private" } } }).success, false);
  assert.equal(SourceScanProgressSchema.safeParse({ ...progress, scope: { ...scope, cursor: "private" } }).success, false);
});

test("progress envelopes cannot attribute another source's checkpoint to a requested source", () => {
  assert.equal(SourceScanProgressResultSchema.safeParse({ sourceId: run.sourceId, progress }).success, true);
  assert.equal(SourceScanProgressResultSchema.safeParse({ sourceId: "other-source", progress }).success, false);
});

test("sync result progress must match the exact durable source, run, scan, running state and scope", () => {
  for (const changes of [{ sourceId: "other-source" }, { runId: "other-run" }, { scanId: "other-scan" },
    { running: true, canContinue: false }, { scope: { ...scope, roles: ["Python"] } }, { scope: { ...scope, countryCodes: ["US"] } }]) {
    assert.equal(SourceSyncResultSchema.safeParse({ ...result, scanProgress: { ...progress, ...changes } }).success, false, JSON.stringify(changes));
  }
  assert.equal(SourceSyncResultSchema.safeParse({ ...result, localFilters: { ...scope, roles: ["Python"] } }).success, false);
  assert.equal(SourceSyncResultSchema.safeParse({ ...result, run: { ...run, scope: { ...run.scope, keywords: ["Python"] } } }).success, false);
  const { scanId: _scanId, ...legacyRun } = run;
  assert.equal(SourceSyncResultSchema.safeParse({ ...result, run: legacyRun }).success, false);
  const { scanProgress: _progress, ...replayedResult } = result;
  assert.equal(SourceSyncResultSchema.safeParse(replayedResult).success, true);
});

test("partial page retry markers retain the page start and cannot coexist with forward cursors or complete coverage", () => {
  const page = { records: [], observedAt: at, retryCurrentPage: true,
    coverage: { complete: false, partial: true, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [], stopReason: "source-error" };
  assert.equal(SourcePageSchema.safeParse(page).success, true);
  assert.equal(SourcePageSchema.safeParse({ ...page, nextCursor: "must-not-advance" }).success, false);
  assert.equal(SourcePageSchema.safeParse({ ...page, retryCurrentPage: false }).success, false);
  assert.equal(SourcePageSchema.safeParse({ ...page, coverage: { ...page.coverage, partial: false } }).success, false);
  assert.equal(SourcePageSchema.safeParse({ ...page, stopReason: undefined, coverage: { ...page.coverage, complete: true, partial: false } }).success, false);
});
