import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalJobService } from "../../job-service/src/lifecycle.ts";
import { createJobHttpServer } from "../../job-service/src/http.ts";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";
import { queryAtlasPageDirect } from "../src/components/atlas/client.ts";
import { compute } from "./fixtures/atlas-compute-harness.ts";

test("5000/15000 jobs: three real ingest/enrichment batches use revision deltas and preserve responsive search/list/map", { skip: process.env.BETTER_ME_SCALE_BENCH !== "1", timeout: 360_000 }, async t => {
  for (const size of [5000, 15000]) {
    const directory = await mkdtemp(join(tmpdir(), "better-me-revision-scale-"));
    let service: Awaited<ReturnType<typeof startLocalJobService>> | undefined;
    const { client, responses } = compute();
    const syncReads: { bytes: number; since?: number }[] = [];
    try {
      const repo = openJobRepository(join(directory, "jobs.sqlite"));
      try { await repo.importSnapshot(syntheticAtlas(size), { actorScope: "synthetic-seed", idempotencyKey: "seed" }); }
      finally { repo.close(); }
      service = await startLocalJobService({ dataDirectory: directory, port: 0, allowedOrigins: ["http://localhost:5296"] }, {
        // Inspect serialized byte counts without reparsing large responses on the listener.
        createHttpServer(options) {
          const original = options.registry;
          assert.ok(original.executeSerialized, "the normal isolated read lane must remain active");
          return createJobHttpServer({ ...options, registry: { ...original, async executeSerialized(tool, input, context) {
            const result = await original.executeSerialized!(tool, input, context);
            if (tool === "jobs.sync-public") syncReads.push({ bytes: result.json.byteLength, since: (input as { cursor?: { revision: number } }).cursor?.revision });
            return result;
          } } });
        },
      });
      const endpoint = service.url, token = (await readFile(service.tokenPath, "utf8")).trim();
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const firstAt = performance.now();
      let data = await client.readSnapshot(endpoint, token);
      const initialSyncMs = Math.round(performance.now() - firstAt);
      assert.equal(data.jobs.length, size);
      const initialBytes = syncReads[0]!.bytes;
      const deltaStart = responses.length;
      const delays: number[] = [], syncMs: number[] = [], batchMs: number[] = [], ingestResponseMs: number[] = [];
      let previous = performance.now();
      const timer = setInterval(() => { const at = performance.now(); delays.push(at - previous); previous = at; }, 10);
      const started = performance.now();
      try {
        for (let batch = 0; batch < 3; batch++) {
          const batchAt = performance.now();
          const [receipt, concurrent] = await Promise.all([
            fetch(`${endpoint}/api/v1/dataset/import`, { method: "POST", headers: { ...headers, "Idempotency-Key": `synthetic-batch-${batch}` }, body: JSON.stringify({ dataset: syntheticAtlas(16, `new-${batch}`) }) }).then(response => { ingestResponseMs.push(Math.round(performance.now() - batchAt)); return response; }),
            client.queryPage(data, { search: { text: batch % 2 ? "C#" : "TypeScript" }, page: { limit: 30 } }, { now: "2026-10-28T01:00:00.000Z" }),
          ]);
          assert.equal(concurrent.page.items.length, 30); assert.ok(concurrent.geometry);
          assert.equal(concurrent.summary.mappedJobs, batch % 2 ? size / 4 + batch * 4 : 0, "undisclosed TypeScript locations must remain unlocated, never invented office pins");
          assert.equal(receipt.status, 200, await receipt.text());
          const at = performance.now();
          data = await client.readSnapshot(endpoint, token); syncMs.push(Math.round(performance.now() - at));
          assert.equal(data.jobs.length, size + (batch + 1) * 16);
          // The real background worker is service-owned. Follow its actual revision
          // until idle; it must not require a user action or a full snapshot read.
          const enrichmentDeadline = performance.now() + 60_000;
          for (;;) {
            const response = await fetch(`${endpoint}/api/v1/enrichment/status`, { headers });
            assert.equal(response.status, 200);
            const status = (await response.json()).value;
            if (status.revision > data.revision) data = await client.readSnapshot(endpoint, token);
            if (!status.pending && !status.running && status.workerState !== "running") break;
            if (performance.now() > enrichmentDeadline) assert.fail(`synthetic background batch did not settle: ${JSON.stringify(status)}`);
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const page = await client.queryPage(data, { search: { text: "C#" }, page: { limit: 30 } }, { now: "2026-10-28T01:00:00.000Z" });
          assert.equal(page.summary.totalJobs, size / 2 + (batch + 1) * 8);
          assert.equal(page.summary.mappedJobs, size / 4 + (batch + 1) * 4);
          const metadata = await client.metadata(data, { now: "2026-10-28T01:00:00.000Z" }, "C#");
          assert.equal(metadata.coverage.totalJobs, data.jobs.length);
          batchMs.push(Math.round(performance.now() - batchAt));
        }
        const before = responses.length;
        assert.equal(await client.readSnapshot(endpoint, token), data);
        assert.equal(responses.slice(before).filter(message => message.type === "chunk").length, 0);
        await new Promise(resolve => setTimeout(resolve, 25));
      } finally { clearInterval(timer); }
      const totalMs = Math.round(performance.now() - started);
      const snapshotTransfers = responses.slice(deltaStart).filter(message => message.type === "begin-snapshot").length;
      assert.equal(snapshotTransfers, 0, "small committed batches must never retransfer the whole library");
      const jobRowsRelayed = responses.slice(deltaStart).filter(message => message.type === "chunk" && message.target === "jobs").reduce((total, message) => total + (message.type === "chunk" ? message.values.length : 0), 0);
      const changedJobIds = new Set(responses.slice(deltaStart).flatMap(message => message.type === "chunk" && message.target === "jobs" ? message.values.map(row => (row as { id: string }).id) : []));
      assert.equal(changedJobIds.size, 48, "only the 48 newly ingested jobs, including their later enrichment revisions, are relayed");
      assert.ok(jobRowsRelayed >= 48 && jobRowsRelayed <= 96);
      const deltaBytes = syncReads.slice(1).reduce((total, read) => total + read.bytes, 0);
      assert.ok(deltaBytes < initialBytes / 20, "incremental traffic should be independent of library size");
      assert.ok(syncReads.slice(1).every(read => read.since !== undefined));
      assert.ok(Math.max(...delays) < 150, `caller blocked for ${Math.round(Math.max(...delays))}ms`);
      // Full-export/reference comparison is outside the responsiveness timing and
      // only for verification, not part of the production refresh path.
      const exported = await fetch(`${endpoint}/api/v1/dataset/export`, { headers });
      const full = (await exported.json()).value;
      assert.deepEqual(data, full);
      const query = { search: { text: "C#" }, page: { limit: 30 } }, options = { now: "2026-10-28T01:00:00.000Z" };
      const expected = await queryAtlasPageDirect(full, query, options), actual = await client.queryPage(data, query, options);
      assert.deepEqual(actual.summary, expected.summary); assert.deepEqual(actual.page, expected.page);
      t.diagnostic(JSON.stringify({ syntheticJobs: size, initialSyncMs, initialSnapshotBytes: initialBytes, incrementalBytesForThreeBatches: deltaBytes,
        syncRequestCountAfterBaseline: syncReads.length - 1, lastUnchangedBytes: syncReads.at(-1)!.bytes, ingestResponseMs, batchSyncMs: syncMs, endToEndBatchMs: batchMs,
        threeBatchTotalMs: totalMs, wholeLibraryTransfersAfterBaseline: snapshotTransfers, incrementalJobRowsRelayed: jobRowsRelayed,
        callerMaxTimerDelayMs: Math.round(Math.max(...delays)), finalJobs: data.jobs.length, matchedJobs: actual.summary.totalJobs, mappedJobs: actual.summary.mappedJobs }));
    } finally { client.dispose(); await service?.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
