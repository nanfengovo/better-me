import assert from "node:assert/strict";
import test from "node:test";
import type { SourceDefinition } from "@better-me/opportunities";
import { SourceHealthResultSchema } from "@better-me/source-adapters";
import { createJobApplication } from "../src/application.js";
import { openJobRepository } from "../src/repository.js";

const source: SourceDefinition = {
  sourceId: "health-synthetic", name: "Health synthetic source", adapterId: "mapped-json", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active",
  remoteFilters: [], entryUrl: "https://jobs.example.test/list.json", options: {},
  endpointPolicy: { allowedHosts: ["jobs.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic health source", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 10, requestsPerMinute: 100 },
};

test("source health is actor-scoped and reports the latest run plus partial errors", async () => {
  let current = "2026-10-25T00:00:00.000Z";
  const repository = openJobRepository(":memory:", { now: () => current });
  try {
    await repository.registerSource(source, { actorScope: "owner-a", idempotencyKey: "register" });
    const first = await repository.startRun({ sourceId: source.sourceId, actorScope: "owner-a", idempotencyKey: "run-1",
      scope: { keywords: ["C#"], regions: ["上海"], companies: ["Acme"] } });
    current = "2026-10-25T00:01:00.000Z";
    await repository.finishRun(first.runId, { actorScope: "owner-a", status: "completed", summary: { records: 3, pages: 1, added: 2 } });

    current = "2026-10-25T00:03:00.000Z";
    const partial = await repository.startRun({ sourceId: source.sourceId, actorScope: "owner-a", idempotencyKey: "run-2",
      scope: { keywords: ["TypeScript"], regions: ["北京"], companies: ["Beta"] } });
    await repository.finishRun(partial.runId, { actorScope: "owner-a", status: "partial", summary: { records: 1, pages: 1, partial: true, errorCode: "timeout" } });

    const application = createJobApplication({ repository });
    const response = await application.registry.execute("sources.list", {}, {
      requestId: "health-read", actorScope: "owner-a", allowedEffects: ["read-index"], signal: new AbortController().signal,
      budget: { requests: 1, bytes: 1_000_000, timeoutMs: 5_000 },
    });
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error(response.error.code);
    const payload = response.value as { health: unknown };
    assert.equal(JSON.stringify(payload).includes("runId"), false);
    assert.equal(JSON.stringify(payload).includes("actorScope"), false);
    const health = SourceHealthResultSchema.parse(payload.health);
    const entry = health.entries.find(value => value.sourceId === source.sourceId);
    assert.ok(entry);
    assert.equal(entry.latestRun?.status, "partial");
    assert.equal(entry.latestRun?.at, "2026-10-25T00:03:00.000Z");
    assert.deepEqual(entry.latestRun?.scope, { roles: ["TypeScript"], regions: ["北京"], companyNames: ["Beta"] });
    assert.equal(entry.latestRun?.partial, true);
    assert.equal(entry.lastCompleted?.at, "2026-10-25T00:01:00.000Z");
    assert.equal(entry.lastPartial?.at, "2026-10-25T00:03:00.000Z");
    assert.equal(entry.lastPartial?.errorCode, "timeout");
    assert.deepEqual(entry.latestError, { at: "2026-10-25T00:03:00.000Z", status: "partial", code: "timeout" });

    current = "2026-10-25T00:04:00.000Z";
    const other = await repository.startRun({ sourceId: source.sourceId, actorScope: "owner-b", idempotencyKey: "other-run", scope: { keywords: ["Private"] } });
    const otherHealth = SourceHealthResultSchema.parse(await repository.listSourceHealth("owner-b"));
    assert.deepEqual(otherHealth.entries.find(value => value.sourceId === source.sourceId)?.latestRun, {
      at: other.startedAt, status: "running", scope: { roles: ["Private"] }, partial: false,
    });
    assert.equal(otherHealth.entries.find(value => value.sourceId === source.sourceId)?.lastCompleted, undefined);
    await application.shutdown();
  } finally {
    repository.close();
  }
});

test("source health rejects malformed actor scopes before querying", async () => {
  const repository = openJobRepository(":memory:");
  try { await assert.rejects(repository.listSourceHealth("bad actor scope")); }
  finally { repository.close(); }
});

test("source health keeps cancelled runs as the latest interruption without an error code", async () => {
  const repository = openJobRepository(":memory:", { now: () => "2026-10-25T00:05:00.000Z" });
  try {
    await repository.registerSource(source, { actorScope: "owner-a", idempotencyKey: "register-cancel" });
    const run = await repository.startRun({ sourceId: source.sourceId, actorScope: "owner-a", idempotencyKey: "run-cancel", scope: { keywords: ["Rust"] } });
    await repository.cancelRun(run.runId, { actorScope: "owner-a" });
    const health = SourceHealthResultSchema.parse(await repository.listSourceHealth("owner-a"));
    assert.deepEqual(health.entries.find(value => value.sourceId === source.sourceId)?.latestError, {
      at: "2026-10-25T00:05:00.000Z", status: "cancelled",
    });
  } finally { repository.close(); }
});
