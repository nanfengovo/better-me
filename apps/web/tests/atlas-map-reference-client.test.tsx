import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { createAtlasSourceClient, AtlasSourceServiceError } from "../src/components/atlas/service-client.ts";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { createMapReferenceFixture } from "./fixtures/atlas-map-references.ts";

const client = () => createAtlasSourceClient("http://127.0.0.1:5178", " synthetic-map-token ");
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-map-reference-client", value }));
afterEach(() => mock.restoreAll());

test("map references use one authenticated read-only POST bound to the requested index revision", async () => {
  const data = createAtlasDemo(), batch = await createMapReferenceFixture(data), controller = new AbortController();
  const fetcher = mock.method(globalThis, "fetch", async () => response(batch));
  assert.deepEqual(await client().mapReferences({ expectedRevision: data.revision }, { signal: controller.signal }), batch);
  const [url, init] = fetcher.mock.calls[0]!.arguments as unknown as [URL, RequestInit];
  assert.equal(url.pathname, "/api/v1/locations/map-references"); assert.equal(init.method, "POST"); assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.equal(init.signal, controller.signal);
  assert.deepEqual(init.headers, { Authorization: "Bearer synthetic-map-token", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(String(init.body)), { expectedRevision: data.revision, limit: 1000 });
  assert.equal(new Headers(init.headers).has("Idempotency-Key"), false);
});

test("map reference inputs reject credentials, private anchors, provider paths and invalid scopes before fetch", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("must remain inert"); });
  for (const value of [{ expectedRevision: 1, homeAddress: "PRIVATE" }, { expectedRevision: 1, latitude: 31 },
    { expectedRevision: 1, manifestPath: "C:/private/data" }, { expectedRevision: 1, limit: 1001 },
    { expectedRevision: 1, locationIds: ["duplicate", "duplicate"] }, { expectedRevision: -1 }]) {
    await assert.rejects(client().mapReferences(value), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-input");
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test("a valid map result must still match this revision, requested locations and limit", async () => {
  const data = createAtlasDemo(), batch = await createMapReferenceFixture(data);
  for (const [query, value] of [
    [{ expectedRevision: 2 }, batch], [{ expectedRevision: data.revision, locationIds: [data.locations[0]!.id] }, batch],
    [{ expectedRevision: data.revision, limit: 1 }, batch], [{ expectedRevision: data.revision }, { ...batch, privateToken: "PRIVATE_RESULT" }],
  ] as const) {
    const fetcher = mock.method(globalThis, "fetch", async () => response(value));
    await assert.rejects(client().mapReferences(query), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "invalid-response" && !error.message.includes("PRIVATE_RESULT"));
    fetcher.mock.restore();
  }
});

test("map-reference cancellation and byte limits close response streams", async () => {
  const controller = new AbortController(); let cancelled = false;
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start() { queueMicrotask(() => controller.abort(new DOMException("synthetic abort", "AbortError"))); }, cancel() { cancelled = true; },
  })));
  await assert.rejects(client().mapReferences({ expectedRevision: 1 }, { signal: controller.signal }), { name: "AbortError" }); assert.equal(cancelled, true);
  fetcher.mock.restore(); cancelled = false;
  mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(stream) { stream.enqueue(new TextEncoder().encode("中文")); }, cancel() { cancelled = true; } })));
  await assert.rejects(client().mapReferences({ expectedRevision: 1 }, { maxBytes: 8 }), (error: unknown) => error instanceof AtlasSourceServiceError && error.code === "too-large");
  assert.equal(cancelled, true);
});

test("an older service's non-JSON 404 is recognized without displaying its body", async () => {
  mock.method(globalThis, "fetch", async () => new Response("PRIVATE_LEGACY_ROUTE_TEXT", { status: 404 }));
  await assert.rejects(client().mapReferences({ expectedRevision: 1 }), (error: unknown) => error instanceof AtlasSourceServiceError
    && error.status === 404 && /尚不支持城市分布参考/.test(error.message) && !error.message.includes("PRIVATE"));
});
