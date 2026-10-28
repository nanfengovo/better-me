import assert from "node:assert/strict";
import test from "node:test";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository } from "../src/repository.js";
import { syntheticAtlas } from "./synthetic-atlas.js";

const token = "synthetic-dataset-sync-token-1234567890";
const origin = "http://localhost:5296";

test("after a baseline, a small committed batch downloads only its changed public entities", async () => {
  const repository = openJobRepository(":memory:");
  const application = createJobApplication({ repository, backgroundEnrichment: false });
  const server = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [origin], port: 0 });
  const headers = { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" };
  try {
    await repository.importSnapshot(syntheticAtlas(50), { actorScope: "synthetic-seed", idempotencyKey: "seed" });
    const { url } = await server.listen();
    const sync = (input: unknown) => fetch(`${url}/api/v1/dataset/sync`, { method: "POST", headers, body: JSON.stringify(input) });
    const first = await sync({});
    assert.equal(first.status, 200, "the revision sync endpoint must provide the initial baseline");
    const baseline = await first.json();
    assert.equal(baseline.value.kind, "snapshot");
    assert.equal(baseline.value.dataset.jobs.length, 50);
    await repository.importSnapshot(syntheticAtlas(2, "new"), { actorScope: "synthetic-seed", idempotencyKey: "batch-1", expectedRevision: baseline.value.cursor.revision });
    const response = await sync({ cursor: baseline.value.cursor });
    assert.equal(response.status, 200);
    const deltaText = await response.text();
    const delta = JSON.parse(deltaText).value;
    assert.equal(delta.kind, "delta", "a two-job batch must not download the 52-job snapshot again");
    assert.deepEqual(delta.from, baseline.value.cursor);
    assert.equal(delta.to.revision, baseline.value.cursor.revision + 1);
    assert.equal(delta.upserts.jobs.length, 2);
    assert.equal(delta.upserts.sources.length, 0);
    assert.ok(Buffer.byteLength(deltaText) < Buffer.byteLength(JSON.stringify(baseline)) / 5);
    const same = await (await sync({ cursor: delta.to })).json();
    assert.equal(same.value.kind, "unchanged");
    assert.deepEqual(same.value.cursor, delta.to);
    assert.equal((await fetch(`${url}/api/v1/dataset/sync`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${url}/api/v1/dataset/sync`, { method: "POST", headers: { ...headers, Origin: "https://unrelated.example" }, body: "{}" })).status, 403);
    assert.equal((await sync({ cursor: { ...delta.to, revision: -1 } })).status, 400);
  } finally {
    await server.close();
    await application.shutdown();
    repository.close();
  }
});
