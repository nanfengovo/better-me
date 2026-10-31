import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AtlasDatasetSchema } from "@better-me/opportunities";
import { BASELINE_PROTOCOL, type BaselinePage } from "../../job-service/src/dataset-baseline-contract.ts";
import { DATASET_SYNC_PROTOCOL, emptyDatasetUpserts } from "../../job-service/src/dataset-sync-contract.ts";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";
import { createAtlasSnapshotSynchronizer } from "../src/components/atlas/snapshot-sync.ts";

test("bad baseline pages never advance a complete cursor, mutate its dataset or trigger whole-export fallback", async t => {
  const epoch = "a".repeat(32), session = "b".repeat(32);
  const cursor = { epoch, revision: 1 }, nextCursor = { epoch, revision: 2 };
  const seed = AtlasDatasetSchema.parse({ ...syntheticAtlas(1, "old"), revision: 1 });
  const a = AtlasDatasetSchema.parse(syntheticAtlas(1, "first"));
  const b = AtlasDatasetSchema.parse(syntheticAtlas(1, "second"));
  const { schemaVersion: _schema, revision: _revision, ...firstRows } = a;
  const { schemaVersion: _s, revision: _r, ...secondRows } = b;
  secondRows.sources = [];
  const first: BaselinePage = { protocol: BASELINE_PROTOCOL, kind: "page", session, cursor: nextCursor,
    sequence: 0, next: { session, sequence: 1 }, loadedJobs: 1, totalJobs: 2, checkpoint: true, complete: false, rows: firstRows };
  const last: BaselinePage = { ...first, sequence: 1, next: undefined, loadedJobs: 2, complete: true, rows: secondRows };
  const cases: Array<[string, (page: BaselinePage) => unknown]> = [
    ["out of order", page => ({ ...page, sequence: 3 })],
    ["mixed revision", page => ({ ...page, cursor: { epoch, revision: 3 } })],
    ["mixed session", page => ({ ...page, session: "c".repeat(32) })],
    ["duplicate across pages", page => ({ ...page, rows: { ...emptyDatasetUpserts(), jobs: a.jobs } })],
    ["dangling reference", page => ({ ...page, rows: { ...page.rows, companies: [] } })],
    ["incorrect loaded count", page => ({ ...page, loadedJobs: 1 })],
    ["changed total count", page => ({ ...page, totalJobs: 3 })],
    ["terminal open graph", page => ({ ...page, checkpoint: false })],
    ["expired", () => ({ protocol: BASELINE_PROTOCOL, kind: "expired" })],
  ];
  for (const [name, corrupt] of cases) await t.test(name, async () => {
    let phase: "seed" | "bad" | "unchanged" = "seed", closes = 0;
    const syncInputs: unknown[] = [], unexpected: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      let value: unknown;
      if (request.url === "/api/v1/dataset/sync-page") {
        syncInputs.push(input);
        value = phase === "seed" ? { protocol: DATASET_SYNC_PROTOCOL, kind: "snapshot", cursor, reason: "initial", dataset: seed }
          : phase === "bad" ? { protocol: DATASET_SYNC_PROTOCOL, kind: "baseline-required", cursor: nextCursor, reason: "cursor-expired" }
            : { protocol: DATASET_SYNC_PROTOCOL, kind: "unchanged", cursor };
      } else if (request.url === "/api/v1/dataset/baseline") value = input.page ? corrupt(last) : first;
      else if (request.url === "/api/v1/dataset/baseline/close") { closes++; value = { closed: true }; }
      else { unexpected.push(request.url!); response.writeHead(500); response.end(); return; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, requestId: "synthetic-validation", value }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`, synchronizer = createAtlasSnapshotSynchronizer();
    try {
      const original = (await synchronizer.read(endpoint, "synthetic-token")).dataset;
      const before = JSON.stringify(original), previews: number[] = [];
      phase = "bad";
      await assert.rejects(synchronizer.read(endpoint, "synthetic-token", { onProgress: data => { previews.push(data.jobs.length); } }), /分页/);
      assert.deepEqual(previews, [1]); assert.equal(JSON.stringify(original), before); assert.equal(closes, 1);
      phase = "unchanged";
      assert.equal((await synchronizer.read(endpoint, "synthetic-token")).dataset, original);
      assert.deepEqual(syncInputs, [{}, { cursor }, { cursor }]); assert.deepEqual(unexpected, []);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
