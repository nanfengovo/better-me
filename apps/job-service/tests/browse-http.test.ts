import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository } from "../src/repository.js";
import { syntheticAtlas } from "./synthetic-atlas.js";

test("browse: heavy history stays server-side, full-library paging/map stays exact, small commits use deltas", async () => {
  const repository = openJobRepository(":memory:");
  const app = createJobApplication({ repository, backgroundEnrichment: false });
  const token = "synthetic-browse-token-1234567890", origin = "http://localhost:5296";
  const server = createJobHttpServer({ registry: app.registry, token, allowedOrigins: [origin], port: 0 });
  const headers = { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" };
  try {
    const seed = syntheticAtlas(64);
    for (const job of seed.jobs) job.description += "\n" + "C# historical payload ".repeat(1000);
    for (const snapshot of seed.snapshots) {
      snapshot.text = seed.jobs.find(job => job.selectedSnapshotId === snapshot.id)!.description;
      snapshot.contentHash = createHash("sha256").update(snapshot.text).digest("hex");
      const observation = seed.observations.find(row => row.id === snapshot.observationId)!;
      observation.contentHash = snapshot.contentHash; observation.rawText = snapshot.text;
    }
    await repository.importSnapshot(seed, { actorScope: "synthetic", idempotencyKey: "seed" });
    const { url } = await server.listen();
    const post = (path: string, input: unknown) => fetch(`${url}/api/v1/${path}`, { method: "POST", headers, body: JSON.stringify(input) });
    const response = await post("atlas/browse", {});
    assert.equal(response.status, 200, "browse must not require a full public export");
    const raw = await response.text(), view = JSON.parse(raw).value;
    assert.equal(view.kind, "view"); assert.equal(view.dataset.view, "browse");
    assert.equal(view.dataset.jobs.length, 64); assert.equal(view.dataset.snapshots.length, 0);
    assert.ok(view.dataset.jobs.every((job: { description: string }) => job.description === ""));
    assert.ok(!raw.includes("historical payload"));
    assert.ok(Buffer.byteLength(raw) < Buffer.byteLength(JSON.stringify(seed)) / 10);
    const query = { search: { text: "C#" }, mapLevel: "location", page: { limit: 10 } };
    const first = (await (await post("atlas/query", { snapshot: view.snapshot, query, options: { now: "2026-11-16T00:00:00.000Z" } })).json()).value;
    const expected = (await (await post("jobs/search", query)).json()).value;
    assert.equal(first.summary.totalJobs, expected.totalJobs);
    assert.deepEqual(first.summary.mapBuckets, expected.mapBuckets);
    assert.equal(first.page.items.length, 10);
    const next = (await (await post("atlas/query", { snapshot: view.snapshot, query, page: { pageIndex: 1 } })).json()).value;
    assert.equal(next.pageIndex, 1);
    assert.equal(next.summary.totalJobs, first.summary.totalJobs);
    assert.ok(next.page.items.every((item: { job: { id: string } }) => !first.page.items.some((old: { job: { id: string } }) => old.job.id === item.job.id)));
    const detail = await (await fetch(`${url}/api/v1/jobs/${seed.jobs[0]!.id}`, { headers })).json();
    assert.equal(detail.value.job.description, seed.jobs[0]!.description);
    assert.equal(detail.value.snapshots[0].text, seed.snapshots[0]!.text);
    const same = (await (await post("atlas/browse", { snapshot: view.snapshot })).json()).value;
    assert.equal(same.kind, "unchanged");
    await repository.importSnapshot(syntheticAtlas(2, "new"), { actorScope: "synthetic", idempotencyKey: "batch" });
    const delta = (await (await post("atlas/browse", { snapshot: view.snapshot })).json()).value;
    assert.equal(delta.kind, "delta"); assert.equal(delta.base, view.snapshot);
    assert.equal(delta.upserts.jobs.length, 2); assert.equal(delta.upserts.snapshots.length, 0);
    const old = (await (await post("atlas/query", { snapshot: view.snapshot, query: { page: { limit: 1 } } })).json()).value;
    assert.equal(old.summary.totalJobs, 64, "queries must use the captured view, not mix concurrent revisions");
    assert.equal((await post("dataset/import", { dataset: view.dataset })).status, 400, "a browse view must never be accepted as a complete backup");
    assert.equal((await fetch(`${url}/api/v1/atlas/browse`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${url}/api/v1/atlas/browse`, { method: "POST", headers: { ...headers, Origin: "https://unrelated.example" }, body: "{}" })).status, 403);
    const after = await repository.readSnapshot();
    assert.equal(after.snapshots.length, seed.snapshots.length + 2, "browsing must not prune durable history");
  } finally { await server.close(); await app.shutdown(); repository.close(); }
});
