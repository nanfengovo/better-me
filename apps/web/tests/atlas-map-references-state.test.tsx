import assert from "node:assert/strict";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { useAtlasMapReferences, type AtlasMapReferencesInput } from "../src/components/atlas/use-atlas-map-references.ts";
import { createMapReferenceFixture } from "./fixtures/atlas-map-references.ts";

const dom = new Window({ url: "http://map-reference-state.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
let root: ReturnType<typeof createRoot> | undefined;
let state: ReturnType<typeof useAtlasMapReferences>;
function Probe(props: AtlasMapReferencesInput) { state = useAtlasMapReferences(props); return null; }
function fixture(): AtlasMapReferencesInput {
  const snapshot = createAtlasDemo(); delete snapshot.locations[0]!.coordinates; snapshot.locations[0]!.precision = "unknown";
  return { active: true, dataMode: "live", connected: true, endpoint: "http://127.0.0.1:5178", token: "synthetic-state-token", snapshot };
}
async function render(props: AtlasMapReferencesInput) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(Probe, props)));
}
async function settle() {
  const deadline = performance.now() + 2000;
  while (state.loading) { assert.ok(performance.now() < deadline, "map projection validation should complete"); await act(async () => { await delay(5); }); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-map-state", value }));
async function clean() { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); mock.timers.reset(); }
afterEach(clean);
after(() => { dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("local, demo, inactive, disconnected and already coordinated data do not invoke the service", async () => {
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  const props = fixture();
  for (const change of [{ dataMode: "local" }, { dataMode: "demo" }, { active: false }, { connected: false }, { snapshot: null }, { snapshot: createAtlasDemo() }] as const) {
    await render({ ...props, ...change }); assert.equal(state.result, undefined); assert.equal(state.loading, false);
  }
  const remote = structuredClone(props.snapshot!); remote.locations[0]!.kind = "remote-region";
  await render({ ...props, snapshot: remote }); assert.equal(state.eligible, false);
  remote.locations[0]!.kind = "office"; remote.jobs[0]!.workMode = "remote";
  await render({ ...props, snapshot: structuredClone(remote) }); assert.equal(state.eligible, false);
  assert.equal(fetcher.mock.callCount(), 0);
});

test("one snapshot read is cached across unrelated renders and activation, without changing source coordinates", async () => {
  const props = fixture(), before = structuredClone(props.snapshot), batch = await createMapReferenceFixture(props.snapshot!);
  const fetcher = mock.method(globalThis, "fetch", async () => response(batch));
  await render(props); await settle(); assert.equal(state.loading, false); assert.deepEqual(state.result, batch);
  await render({ ...props }); await render({ ...props, active: false }); assert.equal(state.result, undefined);
  await render(props); assert.deepEqual(state.result, batch); assert.equal(fetcher.mock.callCount(), 1);
  assert.deepEqual(props.snapshot, before); assert.equal(props.snapshot!.locations[0]!.coordinates, undefined);
});

test("endpoint, token, snapshot, view, activation and unmount cancel a pending read and discard late responses", async () => {
  const changes: Array<(props: AtlasMapReferencesInput) => Promise<void>> = [
    props => render({ ...props, endpoint: "http://127.0.0.1:6178" }), props => render({ ...props, token: "synthetic-next-token" }),
    props => render({ ...props, snapshot: { ...props.snapshot!, revision: props.snapshot!.revision + 1 } }),
    props => render({ ...props, snapshot: structuredClone(props.snapshot) }),
    props => render({ ...props, dataMode: "local" }), props => render({ ...props, active: false }),
    async () => { await act(async () => root!.unmount()); root = undefined; },
  ];
  for (const change of changes) {
    const props = fixture(), batch = await createMapReferenceFixture(props.snapshot!), late = deferred<Response>();
    const signals: AbortSignal[] = [];
    mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return signals.length === 1 ? late.promise : new Promise<Response>(() => {}); });
    await render(props); assert.equal(state.loading, true); assert.equal(signals[0]!.aborted, false);
    await change(props); assert.equal(signals[0]!.aborted, true);
    await act(async () => late.resolve(response(batch))); assert.equal(state.result, undefined);
    await clean();
  }
});

test("an old service produces a useful upgrade message and explicit retry performs only the read route", async () => {
  const props = fixture(), batch = await createMapReferenceFixture(props.snapshot!); let calls = 0;
  const fetcher = mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new URL(String(url)).pathname, "/api/v1/locations/map-references"); assert.equal(init!.method, "POST");
    return ++calls === 1 ? new Response(JSON.stringify({ ok: false, requestId: "synthetic-old-service", error: { code: "not-found", message: "PRIVATE_SERVER_MESSAGE" } }), { status: 404 }) : response(batch);
  });
  await render(props); assert.equal(state.result, undefined); assert.match(state.error!, /尚不支持城市分布参考.*更新并重启/); assert.doesNotMatch(state.error!, /PRIVATE/);
  await render(props); assert.equal(fetcher.mock.callCount(), 1, "errors do not start automatic retries");
  await act(async () => state.retry()); await settle(); assert.deepEqual(state.result, batch); assert.equal(fetcher.mock.callCount(), 2);
});

test("explicit cancel leaves a retryable state and ignores a transport that finishes after cancellation", async () => {
  const props = fixture(), batch = await createMapReferenceFixture(props.snapshot!), late = deferred<Response>();
  let signal: AbortSignal | undefined, calls = 0;
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { signal = init!.signal as AbortSignal; return ++calls === 1 ? late.promise : response(batch); });
  await render(props); await act(async () => state.cancel()); assert.equal(signal!.aborted, true); assert.equal(state.loading, false); assert.match(state.error!, /已取消/);
  await act(async () => late.resolve(response(batch))); assert.equal(state.result, undefined); assert.equal(calls, 1);
  await act(async () => state.retry()); await settle(); assert.deepEqual(state.result, batch); assert.equal(calls, 2);
});

test("a structurally valid result for changed source evidence is rejected before it can poison the shared list query", async () => {
  const props = fixture(), batch = await createMapReferenceFixture(props.snapshot!);
  batch.references[0]!.locationFingerprint = "c".repeat(64);
  mock.method(globalThis, "fetch", async () => response(batch));
  await render(props); await settle(); assert.equal(state.result, undefined); assert.equal(state.loading, false); assert.match(state.error!, /当前索引地点不一致.*岗位列表仍可使用/);
});

test("a stale response remains an error and a timed out read cannot publish late city points", async () => {
  const props = fixture(), batch = await createMapReferenceFixture(props.snapshot!);
  const fetcher = mock.method(globalThis, "fetch", async () => response({ ...batch, snapshotRevision: batch.snapshotRevision + 1 }));
  await render(props); assert.equal(state.result, undefined); assert.match(state.error!, /索引版本不一致/); fetcher.mock.restore();
  mock.timers.enable({ apis: ["setTimeout"] }); let signal: AbortSignal | undefined;
  const late = deferred<Response>();
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    signal = init!.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); void late.promise.then(resolve); });
  });
  await act(async () => state.retry()); await act(async () => mock.timers.tick(20_000));
  assert.equal(signal!.aborted, true); assert.equal(state.loading, false); assert.match(state.error!, /超时/);
  await act(async () => late.resolve(response(batch))); assert.equal(state.result, undefined);
});
