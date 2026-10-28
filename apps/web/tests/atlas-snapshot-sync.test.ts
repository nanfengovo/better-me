import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import { AtlasClientError, queryAtlasPageDirect } from "../src/components/atlas/client.ts";
import { createAtlasSnapshotSynchronizer } from "../src/components/atlas/snapshot-sync.ts";
import { DATASET_SYNC_PROTOCOL, DATASET_TABLES, emptyDatasetUpserts, emptyDatasetDeletes } from "../../job-service/src/dataset-sync-contract.ts";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";
import { compute } from "./fixtures/atlas-compute-harness.ts";
import { prepareAtlasMapGeometry } from "../src/components/atlas/prototypes/map-performance.ts";

const opts = (idempotencyKey: string) => ({ actorScope: "synthetic", idempotencyKey });
const envelope = (value: unknown) => JSON.stringify({ ok: true, requestId: "synthetic-sync", value });
const cursor = { epoch: "a".repeat(32), revision: 1 };
async function body(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part)); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
async function mockServer(handler: (path: string, input: any, request: IncomingMessage) => Promise<{ status?: number; value?: unknown; raw?: string }> | { status?: number; value?: unknown; raw?: string }) {
  const server = createServer(async (request, response) => {
    try { const result = await handler(request.url!, await body(request), request); response.writeHead(result.status ?? 200, { "Content-Type": "application/json" }); response.end(result.raw ?? envelope(result.value)); }
    catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { endpoint: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("real worker installs one baseline, relays only changed rows, and automatically updates query/list/map on one revision", async () => {
  const repo = openJobRepository(":memory:");
  const calls: { path: string; input: any; kind: string; bytes: number }[] = [];
  const server = await mockServer(async (path, input) => {
    assert.equal(path, "/api/v1/dataset/sync");
    const value = await repo.syncSnapshot(input); calls.push({ path, input, kind: value.kind, bytes: Buffer.byteLength(envelope(value)) });
    return { value };
  });
  const { client, requests, responses } = compute();
  try {
    await repo.importSnapshot(syntheticAtlas(300), opts("seed"));
    const first = await client.readSnapshot(server.endpoint, "synthetic-token");
    assert.deepEqual(first, await repo.readSnapshot());
    const boundary = responses.length;
    await repo.importSnapshot(syntheticAtlas(4, "new"), opts("batch"));
    const updated = await client.readSnapshot(server.endpoint, "synthetic-token");
    assert.deepEqual(updated, await repo.readSnapshot());
    assert.equal(updated.sources, first.sources, "unchanged arrays retain identity");
    assert.equal(updated.jobs.find(job => job.id === first.jobs[0]!.id), first.jobs[0], "unchanged rows are not cloned again");
    assert.equal(first.jobs.length, 300, "a displayed older snapshot is never mutated in place");
    const changes = responses.slice(boundary);
    assert.equal(changes.filter(message => message.type === "begin-delta").length, 1);
    assert.equal(changes.filter(message => message.type === "begin-snapshot").length, 0);
    assert.equal(changes.filter(message => message.type === "chunk" && message.target === "jobs").reduce((count, message) => count + (message.type === "chunk" ? message.values.length : 0), 0), 4);
    const query = { search: { text: "C#" }, page: { limit: 30 } }, options = { now: "2026-10-28T01:00:00.000Z" };
    const result = await client.queryPage(updated, query, options);
    const expected = await queryAtlasPageDirect(await repo.readSnapshot(), query, options);
    assert.deepEqual(result.summary, expected.summary); assert.deepEqual(result.page, expected.page);
    assert.equal(result.summary.totalJobs, 152); assert.equal(result.summary.mappedJobs, 76);
    assert.deepEqual(result.geometry, await prepareAtlasMapGeometry(expected.summary.mapBuckets));
    const beforeNoop = responses.length;
    assert.equal(await client.readSnapshot(server.endpoint, "synthetic-token"), updated);
    assert.equal(responses.slice(beforeNoop).filter(message => message.type === "chunk").length, 0);
    assert.deepEqual(calls.map(call => call.kind), ["snapshot", "delta", "unchanged"]);
    assert.ok(calls[1]!.bytes < calls[0]!.bytes / 20); assert.ok(calls[2]!.bytes < 400);
    assert.equal(requests.filter(message => message.type === "install").length, 0);
  } finally { client.dispose(); await server.close(); repo.close(); }
});

test("cancellation after worker commit repairs the UI transfer without another full HTTP download", async () => {
  const repo = openJobRepository(":memory:"), kinds: string[] = [];
  const server = await mockServer(async (_path, input) => { const value = await repo.syncSnapshot(input); kinds.push(value.kind); return { value }; });
  const controller = new AbortController();
  let cancelDelta = false;
  const { client, responses } = compute({ onResponse: message => { if (cancelDelta && message.type === "begin-delta") { cancelDelta = false; controller.abort(); } } });
  try {
    await repo.importSnapshot(syntheticAtlas(10), opts("seed"));
    const first = await client.readSnapshot(server.endpoint, "synthetic-token");
    await repo.importSnapshot(syntheticAtlas(2, "new"), opts("new")); cancelDelta = true;
    await assert.rejects(client.readSnapshot(server.endpoint, "synthetic-token", { signal: controller.signal }), error => error instanceof Error && error.name === "AbortError");
    assert.equal(first.jobs.length, 10);
    const repaired = await client.readSnapshot(server.endpoint, "synthetic-token");
    assert.deepEqual(repaired, await repo.readSnapshot()); assert.equal(repaired.jobs.length, 12);
    assert.deepEqual(kinds, ["snapshot", "delta", "unchanged"]);
    assert.equal(responses.filter(message => message.type === "begin-snapshot").length, 2, "only the local worker-to-UI transfer is repaired");
  } finally { client.dispose(); await server.close(); repo.close(); }
});

test("worker cache eviction repairs from its revision state without downloading a full snapshot", async () => {
  const repo = openJobRepository(":memory:"), kinds: string[] = [];
  const server = await mockServer(async (_path, input) => { const value = await repo.syncSnapshot(input); kinds.push(value.kind); return { value }; });
  const { client } = compute();
  try {
    await repo.importSnapshot(syntheticAtlas(5), opts("seed"));
    await client.readSnapshot(server.endpoint, "synthetic-token");
    for (let index = 0; index < 4; index++) await client.queryPage(syntheticAtlas(1, `other-${index}`), {}, { now: "2026-10-28T01:00:00.000Z" });
    assert.deepEqual(await client.readSnapshot(server.endpoint, "synthetic-token"), await repo.readSnapshot());
    assert.deepEqual(kinds, ["snapshot", "unchanged"]);
  } finally { client.dispose(); await server.close(); repo.close(); }
});

test("concurrent UI refresh observers share one incremental read, while one observer can cancel independently", async () => {
  const repo = openJobRepository(":memory:"), kinds: string[] = [];
  const server = await mockServer(async (_path, input) => { const value = await repo.syncSnapshot(input); kinds.push(value.kind); return { value }; });
  const { client, requests, responses } = compute();
  try {
    await repo.importSnapshot(syntheticAtlas(5), opts("seed"));
    await client.readSnapshot(server.endpoint, "synthetic-token");
    await repo.importSnapshot(syntheticAtlas(2, "new"), opts("new"));
    const controller = new AbortController();
    const cancelled = client.readSnapshot(server.endpoint, "synthetic-token", { signal: controller.signal });
    const first = client.readSnapshot(server.endpoint, "synthetic-token"), second = client.readSnapshot(server.endpoint, "synthetic-token");
    controller.abort();
    await assert.rejects(cancelled, error => error instanceof Error && error.name === "AbortError");
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b); assert.equal(a.jobs.length, 7); assert.deepEqual(kinds, ["snapshot", "delta"]);
    assert.equal(requests.filter(message => message.type === "run" && message.operation.kind === "snapshot").length, 2);
    assert.equal(responses.filter(message => message.type === "begin-delta").length, 1);
  } finally { client.dispose(); await server.close(); repo.close(); }
});

test("invalid delta cursor, duplicate entities and missing references never advance or mutate a valid baseline", async () => {
  const seed = { ...syntheticAtlas(1), revision: 1 };
  const seen: any[] = [];
  let reply: unknown = { protocol: DATASET_SYNC_PROTOCOL, kind: "snapshot", reason: "initial", cursor, dataset: seed };
  const server = await mockServer((_path, input) => { seen.push(input); return { value: reply }; });
  const synchronizer = createAtlasSnapshotSynchronizer();
  try {
    const first = await synchronizer.read(server.endpoint, "synthetic-token");
    const delta = { protocol: DATASET_SYNC_PROTOCOL, kind: "delta", schemaVersion: 1, from: cursor, to: { ...cursor, revision: 2 }, upserts: emptyDatasetUpserts(), deletes: emptyDatasetDeletes() };
    for (const invalid of [
      { ...delta, from: { ...cursor, revision: 0 } },
      { ...delta, to: { ...cursor, epoch: "b".repeat(32) } },
      { ...delta, upserts: { ...delta.upserts, jobs: [seed.jobs[0], seed.jobs[0]] } },
      { ...delta, deletes: { ...delta.deletes, companies: [seed.jobs[0]!.companyId] } },
      { ...delta, upserts: { ...delta.upserts, jobs: [{ ...seed.jobs[0], companyId: "missing-company" }] } },
    ]) {
      reply = invalid;
      await assert.rejects(synchronizer.read(server.endpoint, "synthetic-token"), error => error instanceof AtlasClientError && error.code === "invalid-response");
      assert.deepEqual(seen.at(-1), { cursor }); assert.deepEqual(first.dataset, seed);
    }
    reply = { protocol: DATASET_SYNC_PROTOCOL, kind: "unchanged", cursor };
    assert.equal((await synchronizer.read(server.endpoint, "synthetic-token")).dataset, first.dataset);
  } finally { await server.close(); }
});

test("only explicit unsupported responses fall back to legacy export; malformed success, auth and network errors do not", async () => {
  const paths: string[] = []; let mode = "unsupported";
  const server = await mockServer(path => {
    paths.push(path);
    if (path.endsWith("/export")) return { value: syntheticAtlas(1) };
    if (mode === "unsupported") return { status: 404 };
    if (mode === "unauthorized") return { status: 401 };
    return { value: { ok: true } };
  });
  try {
    const synchronizer = createAtlasSnapshotSynchronizer();
    assert.equal((await synchronizer.read(server.endpoint, "legacy")).dataset.jobs.length, 1);
    assert.deepEqual(paths, ["/api/v1/dataset/sync", "/api/v1/dataset/export"]);
    for (mode of ["unauthorized", "malformed"]) {
      const before = paths.length;
      await assert.rejects(synchronizer.read(server.endpoint, mode), AtlasClientError);
      assert.deepEqual(paths.slice(before), ["/api/v1/dataset/sync"]);
    }
    const before = paths.length;
    await assert.rejects(synchronizer.read("https://example.test", "bad"), AtlasClientError); assert.equal(paths.length, before);
    await assert.rejects(synchronizer.read(server.endpoint, "too-small", { maxBytes: 1 }), error => error instanceof AtlasClientError && error.code === "too-large");
  } finally { await server.close(); }
});

test("connection and token changes establish separate baselines; concurrent polls serialize to one committed revision stream", async () => {
  const repo = openJobRepository(":memory:");
  const inputs: any[] = [];
  const server = await mockServer(async (_path, input) => { inputs.push(input); return { value: await repo.syncSnapshot(input) }; });
  const synchronizer = createAtlasSnapshotSynchronizer();
  try {
    await repo.importSnapshot(syntheticAtlas(2), opts("seed"));
    const first = (await synchronizer.read(server.endpoint, "token-one")).dataset;
    await repo.importSnapshot(syntheticAtlas(2, "new"), opts("new"));
    const results = await Promise.all([synchronizer.read(server.endpoint, "token-one"), synchronizer.read(server.endpoint, "token-one"), synchronizer.read(server.endpoint, "token-two")]);
    assert.equal(results[0]!.dataset, results[1]!.dataset); assert.notEqual(results[0]!.dataset, first);
    assert.ok(inputs.filter(input => Object.keys(input).length === 0).length === 2, "credentials never inherit another connection's cursor");
    assert.ok(DATASET_TABLES.every(table => results[0]!.dataset[table].length === results[2]!.dataset[table].length));
  } finally { await server.close(); repo.close(); }
});

test("an aborted HTTP poll leaves its committed cursor intact for the next poll", async () => {
  const repo = openJobRepository(":memory:");
  const seen: any[] = [];
  let blocked = false, started!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const server = await mockServer(async (_path, input) => {
    seen.push(input);
    const value = await repo.syncSnapshot(input);
    if (blocked) { blocked = false; started(); await gate; }
    return { value };
  });
  const synchronizer = createAtlasSnapshotSynchronizer();
  try {
    await repo.importSnapshot(syntheticAtlas(2), opts("seed"));
    const first = await synchronizer.read(server.endpoint, "synthetic-token");
    await repo.importSnapshot(syntheticAtlas(1, "new"), opts("new"));
    blocked = true;
    const controller = new AbortController(), pending = synchronizer.read(server.endpoint, "synthetic-token", { signal: controller.signal });
    await requested; controller.abort();
    await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
    release();
    const next = await synchronizer.read(server.endpoint, "synthetic-token");
    assert.equal(next.dataset.jobs.length, 3); assert.equal(first.dataset.jobs.length, 2);
    assert.deepEqual(seen[1], seen[2]);
  } finally { release(); await server.close(); repo.close(); }
});

test("a restored store replaces the worker baseline atomically and then resumes delta/no-op reads", async () => {
  const repo = openJobRepository(":memory:");
  const kinds: string[] = [];
  const server = await mockServer(async (_path, input) => { const value = await repo.syncSnapshot(input); kinds.push(value.kind); return { value }; });
  const { client } = compute();
  try {
    await repo.importSnapshot(syntheticAtlas(2), opts("seed"));
    const backup = await repo.backup();
    const old = await client.readSnapshot(server.endpoint, "synthetic-token");
    await repo.importSnapshot(syntheticAtlas(3, "new"), opts("new"));
    assert.equal((await client.readSnapshot(server.endpoint, "synthetic-token")).jobs.length, 5);
    await repo.restore(backup, { ...opts("restore"), expectedRevision: 2 });
    const restored = await client.readSnapshot(server.endpoint, "synthetic-token");
    assert.deepEqual(restored, await repo.readSnapshot()); assert.equal(restored.jobs.length, 2);
    assert.equal(old.jobs.length, 2);
    assert.equal(await client.readSnapshot(server.endpoint, "synthetic-token"), restored);
    assert.deepEqual(kinds, ["snapshot", "delta", "snapshot", "unchanged"]);
  } finally { client.dispose(); await server.close(); repo.close(); }
});
