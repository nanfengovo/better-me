import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { JobQueryError } from "@better-me/opportunities";
import { atlasCompute, createAtlasComputeClient, type AtlasComputePort } from "../src/components/atlas/compute-client.ts";
import { queryAtlasPageDirect, AtlasClientError } from "../src/components/atlas/client.ts";
import { getAtlasDataCoverage } from "../src/components/atlas/coverage.ts";
import { prepareAtlasMapGeometry } from "../src/components/atlas/prototypes/map-performance.ts";
import { syntheticAtlas } from "../../job-service/tests/synthetic-atlas.ts";
import { compute } from "./fixtures/atlas-compute-harness.ts";
const options = { now: "2026-10-28T01:00:00.000Z" };

function idlePort(): AtlasComputePort {
  return { onmessage: null, onerror: null, onmessageerror: null, postMessage() {}, terminate() {} };
}

test("cancelling a query waiting for the shared first upload does not wait for that upload", async () => {
  const client = createAtlasComputeClient(idlePort());
  const controller = new AbortController();
  const pending = client.queryPage(syntheticAtlas(2), {}, options, { signal: controller.signal });
  let rejection: unknown;
  void pending.catch(error => { rejection = error; });
  try {
    controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(rejection instanceof Error && rejection.name === "AbortError");
  } finally { client.dispose(); await pending.catch(() => {}); }
});

test("a crashed compute worker rejects waiting and future observers instead of running a blocking fallback", async () => {
  const port = idlePort(), client = createAtlasComputeClient(port);
  try {
    const pending = client.queryPage(syntheticAtlas(2), {}, options);
    const rejected = assert.rejects(pending, error => error instanceof AtlasClientError && /已入库数据不受影响/.test(error.message));
    port.onerror?.call(port as unknown as globalThis.Worker, {} as ErrorEvent);
    await rejected;
    await assert.rejects(client.queryPage(syntheticAtlas(2), {}, options), AtlasClientError);
  } finally { client.dispose(); }
});

test("unavailable browser worker construction is an actionable asynchronous error", async () => {
  // Node deliberately has no browser Worker; creating the worker must not throw
  // out of a React event/timer callback before it can attach its rejection path.
  assert.equal(typeof globalThis.Worker, "undefined");
  let pending!: Promise<unknown>;
  assert.doesNotThrow(() => { pending = atlasCompute.queryPage(syntheticAtlas(1), {}); });
  await assert.rejects(pending, error => error instanceof AtlasClientError && /Worker.*已入库数据不受影响/.test(error.message));
});

test("real compute worker matches shared query, selected paging, map buckets and coverage without re-uploading a snapshot", async () => {
  const { client, requests, responses } = compute();
  try {
    const data = syntheticAtlas(270);
    const query = { search: { text: "C#" }, page: { limit: 30 } };
    const [actual, metadata] = await Promise.all([client.queryPage(data, query, options, { pageIndex: 1 }), client.metadata(data, options, "C#")]);
    const expected = await queryAtlasPageDirect(data, query, options, { pageIndex: 1 });
    assert.deepEqual(actual, { ...expected, geometry: await prepareAtlasMapGeometry(expected.summary.mapBuckets) });
    assert.deepEqual(metadata.coverage, getAtlasDataCoverage(data, options));
    const selectedJobIds = data.jobs.slice(0, 100).map(job => job.id);
    const selected = await queryAtlasPageDirect(data, query, options, { selectedJobIds, pageIndex: 1 });
    assert.deepEqual(await client.queryPage(data, query, options, { selectedJobIds, pageIndex: 1 }), { ...selected, geometry: await prepareAtlasMapGeometry(selected.summary.mapBuckets) });
    assert.equal(requests.filter(value => value.type === "install").length, 1);
    assert.ok(responses.some(value => value.type === "chunk" && value.target === "summaryBuckets"));
    assert.ok(responses.filter(value => value.type === "chunk").every(value => value.type === "chunk" && value.values.length <= 128));
    const first = await client.queryPage(data, query, options);
    await assert.rejects(client.queryPage({ ...data, revision: 2 }, query, options, { cursor: first.page.nextCursor }), error => error instanceof JobQueryError && error.code === "stale-cursor");
  } finally { client.dispose(); }
});

test("cancellation rejects promptly, ignores late results and does not poison subsequent queries", async () => {
  const { client } = compute();
  try {
    const data = syntheticAtlas(500);
    await client.queryPage(data, {}, options);
    const controller = new AbortController();
    const pending = client.queryPage(data, {}, options, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
    assert.equal((await client.queryPage(data, { search: { text: "TypeScript" } }, options)).summary.totalJobs, 250);
  } finally { client.dispose(); }
});

test("evicted snapshots are reinstalled and never alias different revisions", async () => {
  const { client, requests } = compute();
  try {
    const first = syntheticAtlas(2, "first");
    for (const data of [first, syntheticAtlas(3, "second"), syntheticAtlas(4, "third"), syntheticAtlas(5, "fourth")]) await client.queryPage(data, {}, options);
    assert.equal((await client.queryPage(first, {}, options)).summary.totalJobs, 2);
    assert.equal(requests.filter(value => value.type === "install").length, 5);
  } finally { client.dispose(); }
});

test("worker fetch validates the same loopback envelope and returns a query-ready snapshot in bounded chunks", async () => {
  const data = syntheticAtlas(270);
  let invalid = false;
  const server = createServer((request, response) => {
    if (["/api/v1/dataset/sync", "/api/v1/dataset/sync-page"].includes(request.url!)) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(invalid ? { ok: true, value: data } : { ok: true, requestId: "synthetic-snapshot", value: data }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { client, requests } = compute();
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const snapshot = await client.readSnapshot(endpoint, "synthetic-token");
    assert.deepEqual(snapshot, data);
    assert.equal((await client.queryPage(snapshot, {}, options)).summary.totalJobs, 270);
    assert.equal(requests.filter(value => value.type === "install").length, 0);
    invalid = true;
    await assert.rejects(client.readSnapshot(endpoint, "synthetic-token"), error => error instanceof AtlasClientError && error.code === "invalid-response");
    await assert.rejects(client.readSnapshot("https://example.com", "synthetic-token"), error => error instanceof AtlasClientError && error.code === "invalid-endpoint");
  } finally { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("5000 and 15000 job worker queries and map updates leave the caller event loop responsive", { skip: process.env.BETTER_ME_SCALE_BENCH !== "1", timeout: 120_000 }, async t => {
  for (const size of [5000, 15000]) {
    const data = syntheticAtlas(size);
    const { client } = compute();
    const delays: number[] = [];
    let previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); delays.push(now - previous); previous = now; }, 10);
    const started = performance.now();
    try {
      const [result, metadata] = await Promise.all([client.queryPage(data, { search: { text: "C#" }, page: { limit: 30 } }, options), client.metadata(data, options, "C#")]);
      assert.equal(result.summary.totalJobs, size / 2); assert.equal(result.page.items.length, 30); assert.equal(metadata.coverage.totalJobs, size);
      assert.equal(result.summary.mappedJobs, size / 4);
      const firstMs = Math.round(performance.now() - started);
      const next = performance.now();
      assert.equal((await client.queryPage(data, { search: { text: "TypeScript" } }, options)).summary.totalJobs, size / 2);
      await new Promise(resolve => setTimeout(resolve, 20));
      t.diagnostic(JSON.stringify({ syntheticJobs: size, uploadAndFirstQueryMs: firstMs, repeatQueryMs: Math.round(performance.now() - next), callerMaxTimerDelayMs: Math.round(Math.max(...delays)), samples: delays.length }));
      assert.ok(Math.max(...delays) < 150, `caller blocked for ${Math.max(...delays)}ms`);
    } finally { clearInterval(timer); client.dispose(); }
  }
});
