import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createHash } from "node:crypto";
import { AtlasDatasetSchema, queryJobs, type AtlasDataset } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { AtlasClientError, buildAtlasJobAction, queryAtlasPage, readAtlasSnapshot } from "../src/components/atlas/client.ts";
import { shouldAutoReconnectAtlas } from "../src/components/atlas/connection-recovery.ts";

const NOW = { now: "2026-10-18T12:00:00.000Z" };
const encoder = new TextEncoder();
afterEach(() => mock.restoreAll());

function snapshotBody(data = createAtlasDemo()): Uint8Array {
  return encoder.encode(JSON.stringify({ ok: true, requestId: "synthetic-atlas-read", value: data }));
}
function mockResponse(body: BodyInit | null, init?: ResponseInit) {
  return mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, init));
}
function repeatedDemo(copies = 10): AtlasDataset {
  const base = createAtlasDemo();
  const result = structuredClone(base);
  const groups = ["companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const;
  for (const group of groups) result[group] = [];
  for (let n = 0; n < copies; n++) {
    const renamed = new Map(groups.flatMap((group) => base[group].map((entity) => [entity.id, `${entity.id}-copy${n}`])));
    const clone = JSON.parse(JSON.stringify(base, (_key, value: unknown) => typeof value === "string" && renamed.has(value) ? renamed.get(value) : value)) as AtlasDataset;
    for (const group of groups) (result[group] as unknown[]).push(...clone[group]);
  }
  return AtlasDatasetSchema.parse(result);
}
const hasCode = (code: AtlasClientError["code"]) => (error: unknown) => error instanceof AtlasClientError && error.code === code;

test("a new snapshot can resume the visible page with a fresh cursor instead of jumping to page one", async () => {
  const data = repeatedDemo(3);
  const first = await queryAtlasPage(data, { page: { limit: 30 } }, NOW);
  const second = await queryAtlasPage(data, { page: { limit: 30 } }, NOW, { cursor: first.page.nextCursor });
  const refreshed = { ...data, revision: data.revision + 1 };
  const resumed = await queryAtlasPage(refreshed, { page: { limit: 30 } }, NOW, { pageIndex: 1 });
  assert.deepEqual(resumed.page.items.map(item => item.job.id), second.page.items.map(item => item.job.id));
  assert.equal(resumed.page.snapshotVersion, refreshed.revision);
  assert.notEqual(resumed.page.queryId, second.page.queryId);
  assert.equal(resumed.pageIndex, 1);
});

test("page recovery clamps a shortened result set and respects a selected address", async () => {
  const data = repeatedDemo(3);
  const initial = await queryAtlasPage(data, { page: { limit: 3 } }, NOW);
  const selectedJobIds = initial.summary.mapBuckets[0]!.jobIds;
  const selected = await queryAtlasPage(data, { page: { limit: 3 } }, NOW, { pageIndex: 999, selectedJobIds });
  assert.ok(selected.page.items.length > 0);
  assert.ok(selected.page.items.every(item => selectedJobIds.includes(item.job.id)));
  assert.equal(selected.summary.totalJobs, data.jobs.length);
  assert.equal(selected.pageIndex, Math.floor((selected.page.totalJobs - 1) / 3));
});

test("loopback snapshot read uses the authenticated public export with no browser credentials or redirects", async () => {
  const data = createAtlasDemo();
  const fetchMock = mockResponse(snapshotBody(data));
  const abort = new AbortController();
  assert.deepEqual(await readAtlasSnapshot("http://127.0.0.1:5178", " synthetic-test-token ", { signal: abort.signal }), data);
  const [url, options] = fetchMock.mock.calls[0]!.arguments;
  assert.equal(String(url), "http://127.0.0.1:5178/api/v1/dataset/export");
  assert.deepEqual(options, {
    signal: abort.signal, headers: { Authorization: "Bearer synthetic-test-token" }, credentials: "omit", redirect: "error", cache: "no-store",
  });
});

test("a snapshot budget failure names the size limit, not the valid token and Origin", async () => {
  mockResponse(JSON.stringify({ ok: false, requestId: "size", error: { code: "budget-exceeded", message: "budget" } }), { status: 422 });
  await assert.rejects(readAtlasSnapshot("http://127.0.0.1:5178", "synthetic"), (error: unknown) =>
    error instanceof AtlasClientError && error.code === "too-large" && /索引|快照/.test(error.message) && !/令牌|Origin/.test(error.message));
});

test("automatic recovery retries only transient disconnections, not invalid data or configuration", () => {
  assert.equal(shouldAutoReconnectAtlas(new TypeError("Failed to fetch"), false), true);
  assert.equal(shouldAutoReconnectAtlas(new Error("timeout"), true), true);
  assert.equal(shouldAutoReconnectAtlas(new AtlasClientError("http-error", "岗位索引服务返回 503。"), false), true);
  assert.equal(shouldAutoReconnectAtlas(new AtlasClientError("too-large", "budget exceeded"), false), false);
  assert.equal(shouldAutoReconnectAtlas(new AtlasClientError("http-error", "服务返回 401。"), false), false);
  assert.equal(shouldAutoReconnectAtlas(new AtlasClientError("invalid-response", "invalid"), false), false);
});

test("endpoint policy rejects external addresses, credentials, paths and blank tokens before network access", async () => {
  const fetchMock = mockResponse(snapshotBody());
  for (const endpoint of ["not-a-url", "https://example.invalid", "http://localhost.example.invalid", "http://127.0.0.2:5178", "ftp://localhost", "http://a:b@localhost", "http://localhost/path", "http://localhost/?query=x", "http://localhost/#hash"]) {
    await assert.rejects(readAtlasSnapshot(endpoint, "synthetic"), hasCode("invalid-endpoint"));
  }
  await assert.rejects(readAtlasSnapshot("http://localhost:5178", " \t "), hasCode("missing-token"));
  await assert.rejects(readAtlasSnapshot("http://localhost:5178", "synthetic", { maxBytes: 0 }), RangeError);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal((await readAtlasSnapshot("http://[::1]:5178", "synthetic")).jobs.length, 22);
});

test("streaming byte cap counts UTF-8 bytes and supports multibyte code points split across chunks", async () => {
  const bytes = snapshotBody();
  const stream = () => new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    },
  });
  mock.method(globalThis, "fetch", async () => new Response(stream()));
  assert.equal((await readAtlasSnapshot("http://localhost", "synthetic", { maxBytes: bytes.byteLength })).jobs.length, 22);
  assert.ok(bytes.byteLength > new TextDecoder().decode(bytes).length);
  await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic", { maxBytes: new TextDecoder().decode(bytes).length }), hasCode("too-large"));
});

test("oversized response is cancelled during streaming, without waiting for an unbounded tail", async () => {
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(encoder.encode("中文")); },
    cancel() { cancelled = true; },
  });
  mockResponse(stream);
  await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic", { maxBytes: 8 }), hasCode("too-large"));
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test("declared response sizes are checked early and an undersized Content-Length cannot bypass streaming limit", async () => {
  let cancelled = false;
  mockResponse(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Length": "9000" } });
  await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic", { maxBytes: 500 }), hasCode("too-large"));
  assert.equal(cancelled, true);
  mock.restoreAll();
  mockResponse(snapshotBody(), { headers: { "Content-Length": "1" } });
  await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic", { maxBytes: 500 }), hasCode("too-large"));
});

test("snapshot responses require exact success envelope, valid UTF-8, valid JSON and the public dataset schema", async () => {
  const data = createAtlasDemo();
  const invalid = [
    { ok: "true", requestId: "test", value: data },
    { ok: false, requestId: "test", value: data },
    { ok: true, value: data },
    { ok: true, requestId: "test", value: { ...data, privateAnchor: { latitude: 1 } } },
    { ok: true, requestId: "test", value: data, privateToken: "must-not-pass" },
  ];
  for (const payload of invalid) {
    mock.restoreAll(); mockResponse(JSON.stringify(payload));
    await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic"), hasCode("invalid-response"));
  }
  for (const payload of [encoder.encode("not-json"), new Uint8Array([0xc3, 0x28])]) {
    mock.restoreAll(); mockResponse(payload);
    await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic"), hasCode("invalid-response"));
  }
  mock.restoreAll(); mockResponse(null, { status: 204 });
  await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic"), hasCode("invalid-response"));
  mock.restoreAll(); mockResponse("denied", { status: 403 });
  await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic"), hasCode("http-error"));
});

test("cancellation rejects before fetch or while waiting on response body and cancels the reader", async () => {
  const preAbort = new AbortController(); preAbort.abort();
  const fetchMock = mockResponse(snapshotBody());
  await assert.rejects(readAtlasSnapshot("http://localhost", "synthetic", { signal: preAbort.signal }), { name: "AbortError" });
  assert.equal(fetchMock.mock.callCount(), 0);
  mock.restoreAll();
  const abort = new AbortController();
  let cancelled = false;
  mockResponse(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode('{"ok":')); }, cancel() { cancelled = true; } }));
  const pending = readAtlasSnapshot("http://localhost", "synthetic", { signal: abort.signal });
  await nextTurn(); abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("unselected query uses real shared cursors to reach every result beyond 200 without duplication", async () => {
  const data = repeatedDemo();
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await queryAtlasPage(data, { page: { limit: 30 } }, NOW, { cursor });
    assert.equal(result.summary, result.page);
    assert.equal(result.summary.totalJobs, 220);
    assert.equal(result.summary.mapBuckets.length, 22);
    found.push(...result.page.items.map((item) => item.job.id));
    cursor = result.page.nextCursor;
  } while (cursor);
  assert.equal(found.length, 220);
  assert.equal(new Set(found).size, 220);
});

test("city selection outside the first list page has its own exact pages while map and statistics stay complete", async () => {
  const data = repeatedDemo();
  const initial = await queryAtlasPage(data, { page: { limit: 3 } }, NOW);
  const bucket = initial.summary.mapBuckets.find((candidate) => !initial.page.items.some((item) => candidate.jobIds.includes(item.job.id)))!;
  assert.ok(bucket);
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await queryAtlasPage(data, { page: { limit: 3 } }, NOW, { cursor, selectedJobIds: bucket.jobIds });
    assert.equal(result.summary.totalJobs, 220);
    assert.deepEqual(result.summary.mapBuckets, initial.summary.mapBuckets);
    assert.equal(result.page.totalJobs, 10);
    assert.ok(result.page.items.length > 0 && result.page.items.length <= 3);
    assert.notEqual(result.summary.queryId, result.page.queryId);
    found.push(...result.page.items.map((item) => item.job.id));
    cursor = result.page.nextCursor;
  } while (cursor);
  assert.deepEqual(found.sort(), [...bucket.jobIds].sort());
});

test("selected-job query intersects base filters, empty selection is empty and changed selection invalidates cursors", async () => {
  const data = repeatedDemo(1);
  const allIds = data.jobs.map((job) => job.id);
  const empty = await queryAtlasPage(data, {}, NOW, { selectedJobIds: [] });
  assert.equal(empty.summary.totalJobs, 22); assert.equal(empty.page.totalJobs, 0); assert.equal(empty.page.nextCursor, undefined);
  const selected = await queryAtlasPage(data, { jobIds: allIds.slice(0, 2), page: { limit: 1 } }, NOW, { selectedJobIds: allIds });
  assert.equal(selected.summary.totalJobs, 2); assert.equal(selected.page.totalJobs, 2);
  await assert.rejects(queryAtlasPage(data, { page: { limit: 1 } }, NOW, { selectedJobIds: allIds.slice(4, 6), cursor: selected.page.nextCursor }), (error: unknown) => error instanceof Error && "code" in error && error.code === "stale-cursor");
  await assert.rejects(queryAtlasPage(data, {}, NOW, { selectedJobIds: Array(100_001).fill(allIds[0]) }), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid-query");
  await assert.rejects(queryAtlasPage(data, { jobIds: allIds.slice(0, 2) }, NOW, { selectedJobIds: ["invalid/job-id"] }), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid-query");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(queryAtlasPage(data, {}, NOW, { signal: abort.signal }), { name: "AbortError" });
});

test("job actions keep the primary source URL and successful observation time instead of record update or failed-read time", async () => {
  const data = createAtlasDemo();
  const job = data.jobs[0]!, listing = data.listings[0]!;
  job.updatedAt = "2026-10-18T23:00:00.000Z";
  const original = data.observations[0]!;
  const later = { ...original, id: "later-partial", fetchedAt: "2026-10-18T12:00:00.000Z", result: "partial" as const };
  const failed = { ...original, id: "later-failed", fetchedAt: "2026-10-18T22:00:00.000Z", result: "failed" as const };
  data.observations.push(later, failed); listing.observationIds.push(later.id, failed.id);
  const item = (await queryJobs(data, { jobIds: [job.id] }, NOW)).items[0]!;
  const action = buildAtlasJobAction(data, item);
  assert.equal(action.observedAt, later.fetchedAt);
  assert.equal(action.url, listing.canonicalUrl);
  assert.equal(action.text, job.description);
  assert.equal(action.title, `${item.company.names[0]} · ${job.title.value}`);
  listing.observationIds = [failed.id];
  assert.equal(buildAtlasJobAction(data, item).observedAt, undefined);
  assert.equal(buildAtlasJobAction(data, item).sourcePublishedAt, undefined);
});

test("observation timestamps from other listings or unrelated sources cannot leak into a job action", async () => {
  const data = createAtlasDemo();
  const item = (await queryJobs(data, { jobIds: [data.jobs[0]!.id] }, NOW)).items[0]!;
  data.listings[0]!.observationIds = [];
  data.observations[1]!.fetchedAt = "2026-10-18T23:59:00.000Z";
  data.listings[0]!.observationIds.push(data.observations[1]!.id);
  assert.equal(buildAtlasJobAction(data, item).observedAt, undefined);
  const unrelated = { ...item, sources: [{ ...item.sources[0]!, listingId: data.listings[1]!.id }] };
  assert.equal(buildAtlasJobAction(data, unrelated).url, undefined);
  assert.equal(buildAtlasJobAction(data, unrelated).observedAt, undefined);
});

test("a selected immutable JD snapshot determines its own source and exact capture rather than the first or newest source", async () => {
  const data = createAtlasDemo();
  const job = data.jobs[0]!;
  const original = data.listings[0]!;
  data.sources.push({ ...data.sources[0]!, sourceId: "second-source", name: "第二合成来源", attribution: { ...data.sources[0]!.attribution, label: "第二合成来源" } });
  const listing = { ...original, id: "secondary-listing", sourceId: "second-source", canonicalUrl: "https://example.invalid/secondary", observationIds: ["snapshot-read", "newer-read"] };
  data.listings.push(listing); job.listingIds.push(listing.id);
  const hash = createHash("sha256").update(job.description).digest("hex");
  data.observations.push(
    { ...data.observations[0]!, id: "snapshot-read", sourcePublishedAt: "2025-01-01T10:12:13.456Z", sourcePublishedRaw: "2025-01-01", listingId: listing.id, snapshotId: "selected-snapshot", contentHash: hash, fetchedAt: "2026-10-18T01:00:00.000Z" },
    { ...data.observations[0]!, id: "newer-read", listingId: listing.id, fetchedAt: "2026-10-18T20:00:00.000Z" },
  );
  data.snapshots.push({ id: "selected-snapshot", listingId: listing.id, observationId: "snapshot-read", text: job.description, contentHash: hash,
    sourceUrl: "https://example.invalid/secondary/selected-version", createdAt: "2026-10-18T01:00:00.000Z", extractionMethod: "source-structured", completeness: "detail" });
  job.selectedSnapshotId = "selected-snapshot";
  const item = (await queryJobs(AtlasDatasetSchema.parse(data), { jobIds: [job.id] }, NOW)).items[0]!;
  const action = buildAtlasJobAction(data, item);
  assert.equal(action.observedAt, "2026-10-18T01:00:00.000Z");
  assert.equal(action.url, "https://example.invalid/secondary/selected-version");
  assert.equal(action.platform, "第二合成来源");
  assert.equal(action.sourcePublishedAt, "2025-01-01T10:12:13.456Z");
  assert.equal(action.sourcePublishedText, "2025-01-01");
  assert.equal(action.text, job.description);
  item.job.description = "合成手动修改，不再是该快照原文。";
  assert.equal(buildAtlasJobAction(data, item).observedAt, undefined);
  assert.equal(buildAtlasJobAction(data, item).sourcePublishedAt, undefined);
});
