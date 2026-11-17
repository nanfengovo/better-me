import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AtlasDatasetSchema } from "@better-me/opportunities";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { startLocalJobService } from "../../job-service/src/lifecycle.ts";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";
import { compute } from "./fixtures/atlas-compute-harness.ts";

test("real compute worker: a library exceeding the old byte budget browses completely, queries all jobs and loads one job's history lazily", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "better-me-browse-test-"));
  const { client, responses } = compute();
  let service: Awaited<ReturnType<typeof startLocalJobService>> | undefined;
  try {
    const seed = syntheticAtlas(64);
    for (const job of seed.jobs) {
      job.title.value = "Software Engineer";
      job.description += "\nC# requirements " + "Synthetic job content. ".repeat(1000);
    }
    for (const snapshot of seed.snapshots) {
      snapshot.text = seed.jobs.find(job => job.selectedSnapshotId === snapshot.id)!.description;
      snapshot.contentHash = createHash("sha256").update(snapshot.text).digest("hex");
      const observation = seed.observations.find(row => row.id === snapshot.observationId)!;
      observation.contentHash = snapshot.contentHash; observation.rawText = snapshot.text;
    }
    const repository = openJobRepository(join(directory, "jobs.sqlite"));
    await repository.importSnapshot(seed, { actorScope: "synthetic", idempotencyKey: "seed" }); repository.close();
    service = await startLocalJobService({ dataDirectory: directory, port: 0, allowedOrigins: ["http://localhost:5296"] });
    const token = (await readFile(service.tokenPath, "utf8")).trim();
    await assert.rejects(client.readSnapshot(service.url, token, { maxBytes: 512 * 1024 }), { code: "too-large" });
    const started = performance.now(), data = await client.readSnapshot(service.url, token, { view: "browse", maxBytes: 512 * 1024 });
    const readMs = Math.round(performance.now() - started);
    assert.equal(data.jobs.length, 64); assert.equal(data.snapshots.length, 0);
    assert.ok(data.jobs.every(job => !job.description));
    assert.equal(AtlasDatasetSchema.safeParse(data).success, false, "display view marker must survive worker transport and prevent full import");
    const beforeQueries = responses.length;
    const query = { search: { text: "C#" }, mapLevel: "location" as const, page: { limit: 10 } };
    const first = await client.queryPage(data, query, { now: "2026-11-16T00:00:00.000Z" });
    assert.equal(first.summary.totalJobs, 64, "search must use complete JDs held on the server, not empty browse descriptions");
    assert.equal(first.page.items.length, 10); assert.equal(first.summary.mappedJobs, 16); assert.ok(first.geometry);
    const second = await client.queryPage(data, query, { now: "2026-11-16T00:00:00.000Z" }, { pageIndex: 1 });
    assert.equal(second.summary.totalJobs, 64); assert.equal(second.pageIndex, 1);
    assert.deepEqual(second.summary.mapBuckets, first.summary.mapBuckets, "list paging must not narrow map coverage");
    const metadata = await client.metadata(data, {}, "C#");
    assert.equal(metadata.coverage.totalJobs, 64); assert.equal(metadata.penetratedIds.length, 64);
    const evidence = await client.detail(data, seed.jobs[0]!.id);
    assert.equal(evidence.snapshotRevision, data.revision);
    assert.equal(evidence.job.description, seed.jobs[0]!.description);
    assert.equal(evidence.snapshots[0]!.text, seed.snapshots[0]!.text);
    assert.equal(data.snapshots.length, 0, "detail reads must not mutate or expand the browse baseline");
    const afterDetail = responses.length;
    assert.equal(await client.readSnapshot(service.url, token, { view: "browse", maxBytes: 512 * 1024 }), data);
    assert.equal(responses.slice(afterDetail).filter(row => row.type === "chunk").length, 0, "unchanged polling sends no full-library worker chunks");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "synthetic-new" };
    assert.equal((await fetch(`${service.url}/api/v1/dataset/import`, { method: "POST", headers, body: JSON.stringify({ dataset: syntheticAtlas(2, "new") }) })).status, 200);
    const beforeDelta = responses.length;
    const next = await client.readSnapshot(service.url, token, { view: "browse", maxBytes: 512 * 1024 });
    assert.equal(next.jobs.length, 66); assert.equal(next.snapshots.length, 0);
    assert.equal(responses.slice(beforeDelta).filter(row => row.type === "begin-snapshot").length, 0);
    assert.equal(responses.slice(beforeDelta).filter(row => row.type === "begin-delta").length, 1);
    assert.equal(responses.slice(beforeDelta).filter(row => row.type === "chunk" && row.target === "jobs").flatMap(row => row.type === "chunk" ? row.values : []).length, 2);
    assert.equal((await client.queryPage(data, query)).summary.totalJobs, 64, "an older captured view remains internally coherent");
    t.diagnostic(JSON.stringify({ syntheticJobs: 64, browseReadMs: readMs, fullSerializedBytes: Buffer.byteLength(JSON.stringify(seed)), rendererDescriptionBytes: 0, queryResponses: responses.length - beforeQueries }));
  } finally { client.dispose(); await service?.close(); await rm(directory, { recursive: true, force: true }); }
});
