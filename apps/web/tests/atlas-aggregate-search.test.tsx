import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import { runAtlasSourceSearch, type AtlasAggregateOptions, type AtlasAggregateProgress } from "../src/components/atlas/aggregate-search.ts";
import { AtlasSourceServiceError, createAtlasSourceClient, type AtlasSourceSync } from "../src/components/atlas/service-client.ts";

const fixture = SourceDefinitionSchema.parse(JSON.parse(readFileSync(new URL("../../../config/sources/examples.json", import.meta.url), "utf8"))[0]);
const sources = Array.from({ length: 4 }, (_, index) => ({ ...fixture, sourceId: `aggregate-source-${index}`, attribution: { ...fixture.attribution, label: `Synthetic source ${index}` } }));
const request = { scope: { roles: ["C#"], regions: ["上海"], companyNames: [] }, maxPages: 3, maxRecords: 30 };
const buildRequest: AtlasAggregateOptions["buildRequest"] = (source) => ({ request, idempotencyKey: `same-key-${source.sourceId}` });
function receipt(sourceId: string, status: AtlasSourceSync["run"]["status"] = "completed"): AtlasSourceSync {
  return { run: { runId: `run-${sourceId}`, sourceId, actorScope: "synthetic-owner", generation: 1, scope: {}, status,
    startedAt: "2026-10-19T00:00:00.000Z", summary: { records: 4, pages: 1, added: 1 } }, localFilters: request.scope, warnings: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("two-source concurrency streams a fast receipt before a slow source finishes and preserves per-source keys", async () => {
  const pending = sources.map(() => deferred<AtlasSourceSync>());
  const started: string[] = []; const published: string[] = []; const history: AtlasAggregateProgress[] = [];
  const run = runAtlasSourceSearch({ sources, buildRequest, onProgress: (value) => { history.push(value); },
    onReceipt: (value) => { published.push(value.run.sourceId); },
    sync: async (sourceId, value, options) => {
      assert.deepEqual(value, request); assert.equal(options.idempotencyKey, `same-key-${sourceId}`);
      started.push(sourceId); return pending[sources.findIndex((source) => source.sourceId === sourceId)]!.promise;
    } });
  assert.deepEqual(started, sources.slice(0, 2).map((source) => source.sourceId));
  assert.equal(history[0]!.queued, 4); assert.equal(history[0]!.settled, 0);
  pending[1]!.resolve(receipt(sources[1]!.sourceId)); await tick();
  assert.deepEqual(published, [sources[1]!.sourceId]);
  assert.deepEqual(started, sources.slice(0, 3).map((source) => source.sourceId));
  assert.equal(history.at(-1)!.settled, 1); assert.equal(history.at(-1)!.running, 2);
  pending[0]!.resolve(receipt(sources[0]!.sourceId)); await tick();
  assert.equal(started.length, 4);
  pending[2]!.resolve(receipt(sources[2]!.sourceId)); pending[3]!.resolve(receipt(sources[3]!.sourceId));
  const result = await run;
  assert.equal(result.settled, 4); assert.equal(result.running, 0); assert.equal(result.queued, 0);
  assert.ok(result.sources.every((source) => source.status === "completed" && !source.outcomeUnknown));
  assert.equal(history[0]!.sources[0]!.status, "queued", "previous snapshots must not mutate with later state");
});

test("one transport failure does not stop other sources; partial receipts keep warnings, summary and rate-limit evidence", async () => {
  const partial = receipt(sources[1]!.sourceId, "partial");
  partial.sourceError = { code: "rate-limited", retryAfterSeconds: 45 }; partial.warnings = ["Only the first source page was read."];
  const received: AtlasSourceSync[] = [];
  const result = await runAtlasSourceSearch({ sources: sources.slice(0, 3), buildRequest, onReceipt: (value) => { received.push(value); },
    sync: async (sourceId) => {
      if (sourceId === sources[0]!.sourceId) throw new AtlasSourceServiceError("transport-error", "No confirmed receipt.", 503);
      return sourceId === sources[1]!.sourceId ? partial : receipt(sourceId);
    } });
  assert.deepEqual(result.sources.map((source) => source.status), ["failed", "partial", "completed"]);
  assert.deepEqual(result.sources[0]!.error, { code: "transport-error", message: "No confirmed receipt.", status: 503 });
  assert.equal(result.sources[0]!.outcomeUnknown, true);
  assert.deepEqual(result.sources[1]!.receipt, partial); assert.equal(received.length, 2);
  assert.equal(result.settled, 3);
});

test("a checked sync 429 exposes its refresh interval reason while preserving an earlier unknown request identity", async () => {
  const source = sources[0]!;
  const calls: string[] = [];
  let attempt = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      calls.push(new Headers(options?.headers).get("Idempotency-Key")!);
      if (attempt++ === 0) throw new TypeError("Synthetic lost receipt after dispatch.");
      return new Response(JSON.stringify({ ok: false, requestId: "checked-sync-429", error: { code: "rate-limited", message: "Rate limited." } }), {
        status: 429, headers: { "Content-Type": "application/json" },
      });
    };
    const client = createAtlasSourceClient("http://127.0.0.1:5178", "synthetic-token");
    const first = await runAtlasSourceSearch({ sources: [source], buildRequest, sync: client.sync });
    assert.equal(first.sources[0]!.outcomeUnknown, true);
    const second = await runAtlasSourceSearch({ sources: [source], buildRequest, sync: client.sync });
    assert.deepEqual(calls, [`same-key-${source.sourceId}`, `same-key-${source.sourceId}`]);
    assert.equal(second.sources[0]!.status, "failed");
    assert.equal(second.sources[0]!.outcomeUnknown, true, "a new rejection must not erase an earlier unknown outcome");
    assert.equal(second.sources[0]!.error?.code, "rate-limited");
    assert.equal(second.sources[0]!.error?.status, 429);
    assert.match(second.sources[0]!.error!.message, /刷新间隔限制.*未开始新的刷新.*原标识核对/);
  } finally { globalThis.fetch = originalFetch; }
});

test("bare HTTP 429, malformed tool errors and rate limits without matching status do not claim a known refresh rejection", async () => {
  const errors = [
    new AtlasSourceServiceError("http-error", "Bare HTTP 429", 429),
    new AtlasSourceServiceError("rate-limited", "Unbound rate limit", 503),
    Object.assign(new Error("Foreign 429"), { code: "rate-limited", status: 429 }),
  ];
  const result = await runAtlasSourceSearch({ sources: sources.slice(0, 3), buildRequest,
    sync: async (id) => { throw errors[sources.findIndex((source) => source.sourceId === id)]!; } });
  assert.ok(result.sources.every((source) => source.outcomeUnknown && source.status === "failed"));
  assert.deepEqual(result.sources.map((source) => source.error!.message), errors.map((error) => error.message));
});

test("abort retains settled receipts, cancels queued work and suppresses a late receipt from a transport ignoring abort", async () => {
  const abort = new AbortController(); const slow = deferred<AtlasSourceSync>();
  const published: string[] = []; const states: AtlasAggregateProgress[] = []; const started: string[] = [];
  const run = runAtlasSourceSearch({ sources, buildRequest, signal: abort.signal, onProgress: (value) => { states.push(value); },
    onReceipt: (value) => { published.push(value.run.sourceId); }, sync: async (sourceId) => {
      started.push(sourceId); return sourceId === sources[0]!.sourceId ? receipt(sourceId) : slow.promise;
    } });
  await tick();
  assert.deepEqual(published, [sources[0]!.sourceId]);
  abort.abort(); const result = await run;
  assert.equal(result.cancelled, true); assert.equal(result.settled, 4);
  assert.equal(result.sources[0]!.status, "completed"); assert.ok(result.sources[0]!.receipt);
  assert.deepEqual(result.sources.slice(1).map((source) => [source.status, source.outcomeUnknown]), [["cancelled", true], ["cancelled", true], ["cancelled", false]]);
  assert.equal(started.length, 3);
  const notificationCount = states.length;
  slow.resolve(receipt(sources[1]!.sourceId)); await tick();
  assert.equal(states.length, notificationCount); assert.deepEqual(published, [sources[0]!.sourceId]);
});

test("already-aborted batches never build requests or dispatch network work", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  const result = await runAtlasSourceSearch({ sources, signal: abort.signal,
    buildRequest: () => { calls++; throw new Error("must not run"); }, sync: async (id) => { calls++; return receipt(id); } });
  assert.equal(calls, 0); assert.equal(result.cancelled, true);
  assert.ok(result.sources.every((source) => source.status === "cancelled" && !source.outcomeUnknown));
});

test("synchronous cancellation from progress before dispatch is not reported as an unknown server outcome", async () => {
  const abort = new AbortController(); let calls = 0;
  const result = await runAtlasSourceSearch({ sources: sources.slice(0, 1), signal: abort.signal, buildRequest,
    onProgress: (value) => { if (value.running) abort.abort(); }, sync: async (id) => { calls++; return receipt(id); } });
  assert.equal(calls, 0); assert.equal(result.sources[0]!.outcomeUnknown, false);
});

test("server running, failed, cancelled and superseded receipts stay distinguishable from network failures", async () => {
  const statuses = ["running", "failed", "cancelled", "superseded"] as const;
  const result = await runAtlasSourceSearch({ sources, buildRequest, sync: async (sourceId) => receipt(sourceId, statuses[sources.findIndex((source) => source.sourceId === sourceId)]!) });
  assert.deepEqual(result.sources.map((source) => source.status), statuses);
  assert.equal(result.running, 0); assert.equal(result.settled, 4);
  assert.ok(result.sources.every((source) => source.receipt && !source.outcomeUnknown && !source.error));
});

test("invalid per-source request preparation is isolated and source-mismatched receipts are not published", async () => {
  const published: string[] = []; const started: string[] = [];
  const result = await runAtlasSourceSearch({ sources: sources.slice(0, 3), buildRequest: (source) => {
    if (source.sourceId === sources[0]!.sourceId) throw new Error("Invalid per-source scope."); return buildRequest(source);
  }, onReceipt: (value) => { published.push(value.run.sourceId); }, sync: async (id) => { started.push(id); return receipt(id === sources[1]!.sourceId ? "wrong-source" : id); } });
  assert.equal(started.length, 2); assert.deepEqual(published, [sources[2]!.sourceId]);
  assert.deepEqual(result.sources.map((source) => source.status), ["failed", "failed", "completed"]);
  assert.equal(result.sources[0]!.outcomeUnknown, false); assert.equal(result.sources[1]!.outcomeUnknown, true);
});

test("UI notification failures do not discard real acquisition receipts or prevent remaining sources", async () => {
  const result = await runAtlasSourceSearch({ sources: sources.slice(0, 2), buildRequest,
    onProgress: () => { throw new Error("Synthetic UI failure"); },
    onReceipt: async () => { throw new Error("Synthetic snapshot refresh failure"); }, sync: async (id) => receipt(id) });
  assert.ok(result.sources.every((source) => source.status === "completed" && source.receipt));
  assert.equal(result.notificationErrors.filter((error) => error.phase === "receipt").length, 2);
  assert.ok(result.notificationErrors.some((error) => error.phase === "progress"));
});

test("concurrency can be explicitly serial, duplicate sources and invalid parallelism fail before any dispatch", async () => {
  let active = 0; let maxActive = 0; let calls = 0;
  const sync: AtlasAggregateOptions["sync"] = async (id) => { calls++; active++; maxActive = Math.max(maxActive, active); await tick(); active--; return receipt(id); };
  await runAtlasSourceSearch({ sources, buildRequest, concurrency: 1, sync }); assert.equal(maxActive, 1);
  const before = calls;
  await assert.rejects(runAtlasSourceSearch({ sources: [sources[0]!, sources[0]!], buildRequest, sync }), /unique/);
  for (const concurrency of [0, 9, 1.5, NaN]) await assert.rejects(runAtlasSourceSearch({ sources, buildRequest, sync, concurrency }), RangeError);
  assert.equal(calls, before);
  const empty = await runAtlasSourceSearch({ sources: [], buildRequest, sync });
  assert.equal(empty.total, 0); assert.equal(empty.settled, 0); assert.equal(calls, before);
});
