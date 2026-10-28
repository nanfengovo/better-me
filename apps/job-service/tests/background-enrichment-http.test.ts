import assert from "node:assert/strict";
import test from "node:test";
import { createJobApplication } from "../src/application.js";
import { createJobHttpServer } from "../src/http.js";
import { openJobRepository } from "../src/repository.js";

const token = "synthetic-enrichment-status-token-1234567890";
const origin = "http://localhost:5173";

test("background status is an authenticated actor-scoped summary, never a snapshot", async () => {
  const repository = openJobRepository(":memory:");
  const scopes: string[] = [];
  Object.assign(repository, {
    getEnrichmentStatus: async (options: { actorScope?: string }) => {
      scopes.push(options.actorScope ?? "");
      return { revision: 7, pending: 3, running: 0, completed: 2, failed: 1 };
    },
    processEnrichmentBatch: async () => ({ processed: 0, status: {} }),
  });
  const application = createJobApplication({ repository });
  const server = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [origin], port: 0 });
  try {
    const { url } = await server.listen();
    const path = `${url}/api/v1/enrichment/status`;
    assert.equal((await fetch(path)).status, 401);
    assert.equal((await fetch(path, { headers: { Authorization: `Bearer ${token}`, Origin: "https://unrelated.example" } })).status, 403);
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}`, Origin: origin } });
    assert.equal(response.status, 200);
    const result = await response.json() as { ok: boolean; value: Record<string, unknown> };
    assert.equal(result.ok, true);
    assert.equal(result.value.revision, 7);
    assert.equal(result.value.pending, 3);
    assert.equal(result.value.completed, 2);
    assert.equal(result.value.failed, 1);
    assert.deepEqual(scopes, ["local-owner"]);
    assert.equal(result.value.snapshot, undefined);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.ok(["idle", "running"].includes(String(result.value.workerState)));
  } finally {
    await server.close();
    await application.shutdown();
    repository.close();
  }
});
