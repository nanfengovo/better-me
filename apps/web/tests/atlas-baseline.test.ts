import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AtlasDataset } from "@better-me/opportunities";
import { startLocalJobService } from "../../job-service/src/lifecycle.ts";
import { createJobHttpServer } from "../../job-service/src/http.ts";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";
import { BASELINE_MAX_BYTES, type BaselineProgress } from "../../job-service/src/dataset-baseline-contract.ts";
import { queryAtlasPageDirect } from "../src/components/atlas/client.ts";
import { compute } from "./fixtures/atlas-compute-harness.ts";

const queryOptions = { now: "2026-10-28T01:00:00.000Z" };
type Call = { tool: string; input: any; bytes: number; startedMs: number; elapsedMs: number; value?: any };
async function fixture(size: number) {
  const directory = await mkdtemp(join(tmpdir(), "better-me-paged-baseline-"));
  const calls: Call[] = []; let legacy = false;
  let service: Awaited<ReturnType<typeof startLocalJobService>> | undefined;
  try {
    const repo = openJobRepository(join(directory, "jobs.sqlite"));
    try { await repo.importSnapshot(syntheticAtlas(size), { actorScope: "synthetic-seed", idempotencyKey: "seed" }); } finally { repo.close(); }
    service = await startLocalJobService({ dataDirectory: directory, port: 0, allowedOrigins: ["http://localhost:5296"] }, {
      createHttpServer(options) {
        const registry = options.registry;
        assert.ok(registry.executeSerialized);
        const http = createJobHttpServer({ ...options, registry: { ...registry, async executeSerialized(tool, input, context) {
          const at = performance.now();
          const result = await registry.executeSerialized!(tool, input, context);
          calls.push({ tool, input, bytes: result.json.byteLength, startedMs: at, elapsedMs: performance.now() - at,
            ...(tool === "jobs.baseline-page" || tool === "enrichment.status" ? { value: JSON.parse(new TextDecoder().decode(result.json)).value } : {}) });
          return result;
        } } });
        const listener = http.server.listeners("request")[0]!;
        http.server.removeListener("request", listener);
        http.server.on("request", (request, response) => {
          // Reference path: simulate only an old service's explicit 404 feature
          // negotiation. Its existing full-sync handler remains unmodified.
          if (legacy && request.url === "/api/v1/dataset/sync-page") { response.writeHead(404); response.end(); return; }
          listener.call(http.server, request, response);
        });
        return http;
      },
    });
    const endpoint = service.url, token = (await readFile(service.tokenPath, "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    return { directory, service, endpoint, token, headers, calls, useLegacy() { legacy = true; },
      close: async () => { await service!.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await service?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

test("real read lane and compute worker publish searchable prefixes/list/map before the full baseline, relaying each job once", async () => {
  const f = await fixture(300), { client, responses, requests } = compute();
  const previews: Array<{ data: AtlasDataset; progress: BaselineProgress }> = [];
  const callbackErrors: unknown[] = [];
  try {
    const data = await client.readSnapshot(f.endpoint, f.token, { onProgress: async (data, progress) => {
      previews.push({ data, progress });
      try {
        const page = await client.queryPage(data, { search: { text: "C#" }, page: { limit: 30 } }, queryOptions);
        assert.ok(page.page.items.length > 0); assert.ok(page.summary.mapBuckets.length > 0); assert.ok(page.geometry);
        assert.ok(page.summary.totalJobs <= progress.loadedJobs);
      } catch (error) { callbackErrors.push(error); }
    } });
    assert.deepEqual(callbackErrors, []);
    assert.ok(previews.length >= 2); assert.equal(previews[0]!.data.jobs.length, 64);
    assert.equal(previews[0]!.progress.complete, false); assert.equal(previews.at(-1)!.progress.complete, true);
    assert.equal(previews[0]!.data.jobs.length, 64, "later pages never mutate a displayed prefix");
    assert.equal(data, previews.at(-1)!.data, "the final baseline must not be transferred a second time");
    const pages = f.calls.filter(call => call.tool === "jobs.baseline-page");
    assert.ok(pages.length > 1); assert.ok(pages.every(page => page.bytes < BASELINE_MAX_BYTES));
    assert.equal(f.calls.filter(call => call.tool === "jobs.sync-public" || call.tool === "jobs.export-public").length, 0);
    assert.equal(responses.filter(message => message.type === "begin-snapshot").length, 0);
    assert.equal(responses.filter(message => message.type === "chunk" && message.target === "jobs").reduce((sum, message) => sum + (message.type === "chunk" ? message.values.length : 0), 0), 300);
    assert.equal(requests.filter(message => message.type === "install").length, 0, "prefix queries use the already installed worker snapshot");
    const exported = (await (await fetch(`${f.endpoint}/api/v1/dataset/export`, { headers: f.headers })).json()).value;
    assert.deepEqual(data, exported);
    const query = { search: { text: "C#" }, page: { limit: 30 } };
    const actual = await client.queryPage(data, query, queryOptions), expected = await queryAtlasPageDirect(exported, query, queryOptions);
    assert.deepEqual(actual.summary, expected.summary); assert.deepEqual(actual.page, expected.page);
    const before = f.calls.length;
    assert.equal(await client.readSnapshot(f.endpoint, f.token), data);
    assert.deepEqual(f.calls.slice(before).map(call => call.tool), ["jobs.sync-pages"]);
  } finally { client.dispose(); await f.close(); }
});

test("cancelling the last prefix observer is prompt and releases its read session without committing an incomplete cursor", async () => {
  const f = await fixture(240), { client } = compute(), controller = new AbortController();
  try {
    let partial: AtlasDataset | undefined;
    const at = performance.now();
    await assert.rejects(client.readSnapshot(f.endpoint, f.token, { signal: controller.signal, onProgress: data => { partial = data; controller.abort(); } }), error => error instanceof Error && error.name === "AbortError");
    assert.ok(partial && partial.jobs.length < 240); assert.ok(performance.now() - at < 3000);
    const session = f.calls.find(call => call.tool === "jobs.baseline-page")!.value.session;
    const deadline = performance.now() + 4000;
    while (!f.calls.some(call => call.tool === "jobs.baseline-close")) {
      assert.ok(performance.now() < deadline, "cancelled baseline must actively release its WAL session");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const response = await fetch(`${f.endpoint}/api/v1/dataset/baseline`, { method: "POST", headers: f.headers, body: JSON.stringify({ page: { session, sequence: 0 } }) });
    assert.equal((await response.json()).value.kind, "expired");
    const before = f.calls.length;
    const complete = await client.readSnapshot(f.endpoint, f.token);
    assert.equal(complete.jobs.length, 240);
    assert.deepEqual(f.calls.slice(before).find(call => call.tool === "jobs.sync-pages")!.input, {}, "the aborted preview never advances the complete revision cursor");
    assert.equal(partial.jobs.length, 64);
  } finally { client.dispose(); await f.close(); }
});

test("independent progress observers share one baseline; cancelling one does not interrupt the other", async () => {
  const f = await fixture(400), { client } = compute(), controller = new AbortController();
  try {
    let cancelledCalls = 0, survivingCalls = 0;
    const a = client.readSnapshot(f.endpoint, f.token, { signal: controller.signal, onProgress: () => { cancelledCalls++; controller.abort(); } });
    const b = client.readSnapshot(f.endpoint, f.token, { onProgress: () => { survivingCalls++; } });
    await assert.rejects(a, error => error instanceof Error && error.name === "AbortError");
    assert.equal((await b).jobs.length, 400); assert.equal(cancelledCalls, 1); assert.ok(survivingCalls >= 2);
    assert.equal(f.calls.filter(call => call.tool === "jobs.sync-pages").length, 1);
    assert.equal(f.calls.filter(call => call.tool === "jobs.baseline-page" && !call.input.page).length, 1);
  } finally { client.dispose(); await f.close(); }
});

test("concurrent ingestion and automatic enrichment do not leak into a pinned prefix; delta catches up after completion", async () => {
  const f = await fixture(200), { client } = compute();
  try {
    let imported = false;
    const first = await client.readSnapshot(f.endpoint, f.token, { onProgress: async (_data, progress) => {
      if (imported || progress.complete) return; imported = true;
      const response = await fetch(`${f.endpoint}/api/v1/dataset/import`, { method: "POST", headers: { ...f.headers, "Idempotency-Key": "during-baseline" }, body: JSON.stringify({ dataset: syntheticAtlas(2, "while-reading") }) });
      assert.equal(response.status, 200);
    } });
    assert.equal(first.jobs.length, 200); assert.ok(imported);
    let latest = await client.readSnapshot(f.endpoint, f.token);
    assert.equal(latest.jobs.length, 202);
    const deadline = performance.now() + 8000;
    for (;;) {
      const response = await fetch(`${f.endpoint}/api/v1/enrichment/status`, { headers: f.headers });
      const status = (await response.json()).value;
      if (status.revision > latest.revision) latest = await client.readSnapshot(f.endpoint, f.token);
      if (!status.pending && !status.running) { assert.equal(status.failed, 0); assert.equal(status.completed, 2); break; }
      assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(first.jobs.length, 200); assert.equal(latest.jobs.length, 202);
    const row = latest.locations.find(location => location.id === "location-while-reading-1")!;
    assert.equal(row.city, "上海市"); assert.equal(row.coordinates, undefined);
    assert.equal(f.calls.filter(call => call.tool === "jobs.baseline-page" && !call.input.page).length, 1);
  } finally { client.dispose(); await f.close(); }
});

test("baseline HTTP remains authenticated, validates cursors and enforces a cumulative download budget", async () => {
  const f = await fixture(300), { client } = compute();
  try {
    assert.equal((await fetch(`${f.endpoint}/api/v1/dataset/baseline`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${f.endpoint}/api/v1/dataset/baseline`, { method: "POST", headers: { ...f.headers, Origin: "https://unrelated.example" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${f.endpoint}/api/v1/dataset/baseline`, { method: "POST", headers: f.headers, body: JSON.stringify({ page: { session: "bad", sequence: -1 } }) })).status, 400);
    await assert.rejects(client.readSnapshot(f.endpoint, f.token, { maxBytes: 150_000 }), error => error instanceof Error && "code" in error && error.code === "too-large");
    assert.equal(f.calls.filter(call => call.tool === "jobs.sync-public" || call.tool === "jobs.export-public").length, 0, "a budget failure cannot silently fall back to a whole export");
    assert.equal((await client.readSnapshot(f.endpoint, f.token)).jobs.length, 300);
  } finally { client.dispose(); await f.close(); }
});

test("baseline HTTP traversal and presentation costs stay separate", { skip: process.env.BETTER_ME_BASELINE_PROFILE !== "1" }, async t => {
  const f = await fixture(500), { client } = compute();
  const at = performance.now(), checkpoints: unknown[] = [];
  try {
    await client.readSnapshot(f.endpoint, f.token, { onProgress: async (data, progress) => {
      const at = performance.now();
      await client.queryPage(data, { search: { text: "C#" }, page: { limit: 30 } }, queryOptions);
      checkpoints.push({ jobs: progress.loadedJobs, atMs: Math.round(performance.now()), queryMs: Math.round(performance.now() - at) });
    } });
    t.diagnostic(JSON.stringify({ totalMs: Math.round(performance.now() - at), checkpoints,
      startedAtMs: Math.round(at), pages: f.calls.filter(call => call.tool === "jobs.baseline-page").map(call => ({ atMs: Math.round(call.startedMs), ms: Math.round(call.elapsedMs), entities: call.value.loadedJobs, bytes: call.bytes })) }));
  } finally { client.dispose(); await f.close(); }
});

test("5000/15000 first-entry baseline: bounded network pages, progressive list/map, exact final data and responsive caller", { skip: process.env.BETTER_ME_SCALE_BENCH !== "1", timeout: 360_000 }, async t => {
  for (const size of [5000, 15000]) {
    const f = await fixture(size), { client, responses } = compute();
    const prefixes: number[] = [], delays: number[] = [], callbackErrors: unknown[] = [], queryMs: number[] = [];
    let firstReadyMs = 0, firstReadyBytes = 0, previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); delays.push(now - previous); previous = now; }, 10);
    const at = performance.now();
    try {
      const data = await client.readSnapshot(f.endpoint, f.token, { maxBytes: 256 * 1024 * 1024, onProgress: async (data, progress) => {
        prefixes.push(progress.loadedJobs);
        const queryAt = performance.now();
        try {
          const csharp = await client.queryPage(data, { search: { text: "C#" }, page: { limit: 30 } }, queryOptions);
          assert.equal(csharp.page.items.length, 30); assert.ok(csharp.summary.mapBuckets.length); assert.ok(csharp.geometry);
          if (!firstReadyMs) { firstReadyMs = Math.round(performance.now() - at); firstReadyBytes = f.calls.reduce((sum, call) => sum + call.bytes, 0); }
          const typescript = await client.queryPage(data, { search: { text: "TypeScript" }, page: { limit: 30 } }, queryOptions);
          assert.equal(typescript.page.items.length, 30); assert.equal(typescript.summary.mappedJobs, 0, "unknown locations cannot become fabricated map pins");
        } catch (error) { callbackErrors.push(error); }
        queryMs.push(Math.round(performance.now() - queryAt));
      } });
      assert.deepEqual(callbackErrors, []); assert.ok(firstReadyMs > 0);
      const fullReadyMs = Math.round(performance.now() - at);
      assert.equal(data.jobs.length, size); assert.equal(prefixes[0], 64); assert.equal(prefixes.at(-1), size);
      assert.ok(prefixes.length > 2 && prefixes.length <= 10, "coalesce UI checkpoints instead of recalculating once per wire page");
      const pages = f.calls.filter(call => call.tool === "jobs.baseline-page");
      const initialBytes = f.calls.reduce((sum, call) => sum + call.bytes, 0);
      assert.ok(pages.every(call => call.bytes <= BASELINE_MAX_BYTES));
      assert.equal(f.calls.filter(call => call.tool === "jobs.sync-public" || call.tool === "jobs.export-public").length, 0);
      const relayedJobs = responses.filter(message => message.type === "chunk" && message.target === "jobs").reduce((sum, message) => sum + (message.type === "chunk" ? message.values.length : 0), 0);
      assert.equal(relayedJobs, size);
      const result = await client.queryPage(data, { search: { text: "C#" }, page: { limit: 30 } }, queryOptions);
      assert.equal(result.summary.totalJobs, size / 2); assert.equal(result.summary.mappedJobs, size / 4);
      const next = await client.queryPage(data, { search: { text: "C#" }, page: { limit: 30 } }, queryOptions, { pageIndex: 1 });
      assert.equal(next.page.items.length, 30); assert.deepEqual(next.summary.mapBuckets, result.summary.mapBuckets);
      assert.ok(next.page.items.every(item => !result.page.items.some(first => first.job.id === item.job.id)));
      await new Promise(resolve => setTimeout(resolve, 20)); clearInterval(timer);
      assert.ok(Math.max(...delays) < 150, `caller blocked for ${Math.round(Math.max(...delays))}ms`);
      // Exact full-export comparison is outside the responsiveness measurement.
      const full = (await (await fetch(`${f.endpoint}/api/v1/dataset/export`, { headers: f.headers })).json()).value;
      assert.deepEqual(data, full);
      const legacy = compute(); f.useLegacy();
      const legacyAt = performance.now();
      let legacyReadyMs: number;
      try {
        const reference = await legacy.client.readSnapshot(f.endpoint, f.token, { maxBytes: 256 * 1024 * 1024 });
        const page = await legacy.client.queryPage(reference, { search: { text: "C#" }, page: { limit: 30 } }, queryOptions);
        legacyReadyMs = Math.round(performance.now() - legacyAt);
        assert.deepEqual(reference, data); assert.deepEqual(page.summary, result.summary);
      } finally { legacy.client.dispose(); }
      const fullBytes = f.calls.findLast(call => call.tool === "jobs.sync-public")!.bytes;
      assert.ok(firstReadyBytes < fullBytes / 20);
      t.diagnostic(JSON.stringify({ syntheticJobs: size, firstSearchListMapReadyMs: firstReadyMs, firstReadyBytes,
        pagedCompleteWithInteractiveQueriesMs: fullReadyMs, fullSyncReferenceReadyMs: legacyReadyMs, fullSyncReferenceBytes: fullBytes,
        initialPagedBytes: initialBytes, networkPages: pages.length, maxPageBytes: Math.max(...pages.map(call => call.bytes)),
        baselineReadLaneMs: Math.round(pages.reduce((sum, call) => sum + call.elapsedMs, 0)), checkpointQueryPairMs: queryMs,
        publishedJobPrefixes: prefixes, jobRowsRelayed: relayedJobs, callerMaxTimerDelayMs: Math.round(Math.max(...delays)),
        finalJobs: data.jobs.length, csharpMatches: result.summary.totalJobs, mappedJobs: result.summary.mappedJobs, finalDatasetEqualsExport: true }));
    } finally { clearInterval(timer); client.dispose(); await f.close(); }
  }
});
