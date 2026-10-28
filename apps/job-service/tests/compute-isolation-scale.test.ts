import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalJobService } from "../src/lifecycle.ts";
import { openJobRepository } from "../src/repository.ts";
import { syntheticAtlas } from "./synthetic-atlas.ts";

test("large-library collection does not starve the listener or concurrent search", { skip: process.env.BETTER_ME_SCALE_BENCH !== "1", timeout: 180_000 }, async t => {
  for (const size of [5000, 15000]) {
    const directory = await mkdtemp(join(tmpdir(), "better-me-compute-scale-"));
    let service: Awaited<ReturnType<typeof startLocalJobService>> | undefined;
    try {
      const repo = openJobRepository(join(directory, "jobs.sqlite"));
      try { await repo.importSnapshot(syntheticAtlas(size), { actorScope: "synthetic-seed", idempotencyKey: "seed" }); }
      finally { repo.close(); }
      service = await startLocalJobService({ dataDirectory: directory, port: 0, allowedOrigins: ["http://localhost:5296"] });
      const token = (await readFile(service.tokenPath, "utf8")).trim();
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const delays: number[] = [];
      let lastTick = performance.now();
      const timer = setInterval(() => { const at = performance.now(); delays.push(at - lastTick); lastTick = at; }, 10);
      const started = performance.now();
      try {
        const write = fetch(`${service.url}/api/v1/dataset/import`, { method: "POST", headers: { ...headers, "Idempotency-Key": "synthetic-delta" }, body: JSON.stringify({ dataset: syntheticAtlas(1, "new"), expectedRevision: 1 }) });
        const readStart = performance.now();
        const search = await fetch(`${service.url}/api/v1/jobs/search`, { method: "POST", headers, body: JSON.stringify({ search: { text: "C#" }, page: { limit: 30 } }) });
        const result = await search.json();
        const searchMs = performance.now() - readStart;
        assert.equal(search.status, 200, JSON.stringify(result));
        assert.ok([size / 2, size / 2 + 1].includes(result.value.totalJobs));
        assert.equal(result.value.items.length, 30);
        assert.ok(result.value.mapBuckets.length > 0);
        const committed = await write;
        assert.equal(committed.status, 200, await committed.text());
        // Include the automatically woken real enrichment batch and export.
        const exported = await fetch(`${service.url}/api/v1/dataset/export`, { headers });
        assert.equal(exported.status, 200); await exported.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 30));
        t.diagnostic(JSON.stringify({ syntheticJobs: size, searchMs: Math.round(searchMs), concurrentWriteAndReadMs: Math.round(performance.now() - started), listenerMaxTimerDelayMs: Math.round(Math.max(...delays)), samples: delays.length }));
        assert.ok(Math.max(...delays) < 150, `listener blocked for ${Math.round(Math.max(...delays))}ms at ${size} jobs`);
      } finally { clearInterval(timer); }
    } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
