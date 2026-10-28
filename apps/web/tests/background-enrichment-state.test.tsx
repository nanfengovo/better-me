import assert from "node:assert/strict";
import test, { after, afterEach, mock } from "node:test";
import { Window } from "happy-dom";
import type { AtlasDataset } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo";
import { useBackgroundEnrichment, type BackgroundEnrichmentInput } from "../src/components/atlas/use-background-enrichment";

const dom = new Window({ url: "http://background-enrichment-fixture.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
let root: ReturnType<typeof createRoot> | undefined;
let state: ReturnType<typeof useBackgroundEnrichment>;
function Probe(props: BackgroundEnrichmentInput) { state = useBackgroundEnrichment(props); return null; }
function fixture(onSnapshot: (snapshot: AtlasDataset) => void = () => {}): BackgroundEnrichmentInput {
  return { endpoint: "http://127.0.0.1:5178", token: "synthetic-background-token", enabled: true, currentRevision: 10, onSnapshot };
}
const status = (revision = 10, extra: Record<string, unknown> = {}) => ({ revision, pending: 1, running: 0, completed: 0, failed: 0, ...extra });
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-background", value }));
const snapshot = (revision: number) => ({ ...createAtlasDemo(), revision });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function render(props: BackgroundEnrichmentInput) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(Probe, props)));
}
async function tick(ms: number) { await act(async () => mock.timers.tick(ms)); }
async function clean() { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); mock.timers.reset(); dom.document.body.replaceChildren(); Reflect.deleteProperty(dom.document, "visibilityState"); }
afterEach(clean);
after(() => { dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("status counts update independently and only a newer repository revision downloads a snapshot", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let revision = 10, completed = 0, statusReads = 0, snapshotReads = 0;
  const delivered: number[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/enrichment/status") { statusReads++; return response(status(revision, { completed })); }
    assert.equal(path, "/api/v1/dataset/export"); snapshotReads++; return response(snapshot(revision));
  });
  const props = fixture(value => delivered.push(value.revision));
  await render(props);
  assert.equal(state.status?.revision, 10);
  assert.equal(snapshotReads, 0, "an already displayed revision does not need a large export");
  completed = 3;
  await tick(1_500);
  assert.equal(state.status?.completed, 3);
  assert.equal(snapshotReads, 0);
  revision = 11;
  await tick(1_500);
  assert.deepEqual(delivered, [11]);
  assert.equal(snapshotReads, 1);
  await tick(1_500);
  assert.equal(snapshotReads, 1);
  assert.equal(statusReads, 4);
});

test("a fresh mount discovers server tasks and catches up without any client submission or persisted state", async () => {
  const paths: string[] = [], delivered: number[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    assert.equal(init?.method ?? "GET", "GET");
    return response(path.endsWith("/status") ? status(11) : snapshot(11));
  });
  const props = fixture(value => delivered.push(value.revision));
  await render(props);
  assert.deepEqual(delivered, [11]);
  await act(async () => root!.unmount()); root = undefined;
  await render(props);
  assert.deepEqual(delivered, [11, 11], "reload recovery uses server state, not previous hook memory");
  assert.deepEqual(paths, ["/api/v1/enrichment/status", "/api/v1/dataset/export", "/api/v1/enrichment/status", "/api/v1/dataset/export"]);
});

test("slow snapshots remain single-flight and intermediate revisions coalesce into one follow-up export", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let revision = 11, exports = 0, active = 0, maxActive = 0;
  const reads = [deferred<Response>(), deferred<Response>()];
  const delivered: number[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (new URL(String(input)).pathname.endsWith("/status")) return response(status(revision));
    active++; maxActive = Math.max(maxActive, active);
    return reads[exports++]!.promise.finally(() => { active--; });
  });
  await render(fixture(value => delivered.push(value.revision)));
  assert.equal(state.refreshingSnapshot, true);
  revision = 12; await tick(1_500);
  revision = 13; await tick(1_500);
  assert.equal(exports, 1);
  await act(async () => reads[0]!.resolve(response(snapshot(11))));
  assert.equal(exports, 2);
  await act(async () => reads[1]!.resolve(response(snapshot(13))));
  assert.deepEqual(delivered, [11, 13]);
  assert.equal(maxActive, 1);
  assert.equal(state.refreshingSnapshot, false);
  await tick(1_500);
  assert.equal(exports, 2);
});

test("a foreground revision overtaking an in-flight export cannot be replaced by its older result", async () => {
  const slow = deferred<Response>();
  const delivered: number[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    new URL(String(input)).pathname.endsWith("/status") ? response(status(11)) : slow.promise);
  const props = fixture(value => delivered.push(value.revision));
  await render(props);
  await render({ ...props, currentRevision: 20 });
  await act(async () => slow.resolve(response(snapshot(11))));
  assert.deepEqual(delivered, []);
  assert.equal(state.error, undefined);
  assert.equal(state.refreshingSnapshot, false);
});

test("replacing credentials aborts old observation and ignores its late snapshot", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const slow = deferred<Response>();
  const delivered: number[] = [], routes: string[] = [];
  let oldSignal: AbortSignal | undefined, nextRevision = 20;
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; routes.push(path);
    const old = new Headers(init?.headers).get("Authorization")?.endsWith("synthetic-background-token");
    if (path.endsWith("/status")) return response(status(old ? 11 : nextRevision));
    if (old) { oldSignal = init?.signal ?? undefined; return slow.promise; }
    return response(snapshot(nextRevision));
  });
  const props = fixture(value => delivered.push(value.revision));
  await render(props);
  await render({ ...props, token: "different-synthetic-token", currentRevision: 20 });
  assert.equal(oldSignal?.aborted, true);
  assert.equal(state.status?.revision, 20);
  await act(async () => slow.resolve(response(snapshot(11))));
  assert.deepEqual(delivered, []);
  nextRevision = 21; await tick(1_500);
  assert.deepEqual(delivered, [21]);
  assert.equal(routes.every(path => path.endsWith("/status") || path.endsWith("/export")), true);
});

test("disabling or unmounting aborts status reads and late responses never revive the observer", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const reads = [deferred<Response>(), deferred<Response>()];
  const signals: AbortSignal[] = [], delivered: number[] = [];
  mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal!); return reads[signals.length - 1]!.promise;
  });
  const props = fixture(value => delivered.push(value.revision));
  await render(props);
  await render({ ...props, enabled: false });
  assert.equal(signals[0]!.aborted, true);
  await act(async () => reads[0]!.resolve(response(status(99))));
  assert.deepEqual(state, { loading: false, refreshingSnapshot: false });
  await render(props);
  await act(async () => root!.unmount()); root = undefined;
  assert.equal(signals[1]!.aborted, true);
  await act(async () => reads[1]!.resolve(response(status(100))));
  await tick(60_000);
  assert.equal(signals.length, 2);
  assert.deepEqual(delivered, []);
});

test("visibility and page lifecycle pause only observation, then discover the latest server revision", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const slow = deferred<Response>();
  let revision = 11, statusReads = 0, snapshotReads = 0, oldSignal: AbortSignal | undefined;
  const delivered: number[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET", "observing must never cancel server tasks");
    if (new URL(String(input)).pathname.endsWith("/status")) { statusReads++; return response(status(revision)); }
    if (++snapshotReads === 1) { oldSignal = init?.signal ?? undefined; return slow.promise; }
    return response(snapshot(revision));
  });
  await render(fixture(value => delivered.push(value.revision)));
  Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { dom.document.dispatchEvent(new dom.Event("visibilitychange")); });
  assert.equal(oldSignal?.aborted, true);
  assert.equal(state.refreshingSnapshot, false);
  await tick(20_000);
  assert.equal(statusReads, 1);
  revision = 12;
  Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { dom.document.dispatchEvent(new dom.Event("visibilitychange")); });
  assert.deepEqual(delivered, [12]);
  await act(async () => slow.resolve(response(snapshot(11))));
  assert.deepEqual(delivered, [12]);
  await act(async () => { dom.dispatchEvent(new dom.Event("pagehide")); });
  await tick(20_000);
  assert.equal(statusReads, 2);
  revision = 13;
  await act(async () => { dom.dispatchEvent(new dom.Event("pageshow")); });
  assert.deepEqual(delivered, [12, 13]);
});

test("idle polling backs off and transient export errors retry without losing confirmed status", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, exports = 0;
  const delivered: number[] = [], errors: string[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (new URL(String(input)).pathname.endsWith("/status")) { reads++; return response(status(11, { pending: 0, completed: 7 })); }
    exports++;
    return exports === 1 ? new Response("private database error", { status: 500 }) : response(snapshot(11));
  });
  await render({ ...fixture(value => delivered.push(value.revision)), onError: message => errors.push(message) });
  assert.equal(state.status?.completed, 7);
  assert.match(state.error ?? "", /索引暂未刷新/);
  await tick(4_999); assert.equal(reads, 1);
  await tick(1); assert.equal(reads, 2);
  assert.deepEqual(delivered, [11]);
  assert.equal(state.error, undefined);
  await tick(9_999); assert.equal(reads, 2);
  await tick(1); assert.equal(reads, 3);
  assert.equal(exports, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors.some(message => message.includes("private")), false);
});

test("a stale export below the requested revision is not published and is retried on the next poll", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let exports = 0;
  const delivered: number[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    response(new URL(String(input)).pathname.endsWith("/status") ? status(12) : snapshot(++exports === 1 ? 11 : 12)));
  await render(fixture(value => delivered.push(value.revision)));
  assert.deepEqual(delivered, []);
  assert.equal(exports, 1, "stale reads cannot create a tight retry loop");
  assert.match(state.error ?? "", /索引暂未刷新/);
  await tick(1_500);
  assert.deepEqual(delivered, [12]);
  assert.equal(exports, 2);
});

test("disabling observation clears request deadlines even when transport ignores abort", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const scheduling = mock.method(globalThis, "setTimeout");
  const clearing = mock.method(globalThis, "clearTimeout");
  const slow = deferred<Response>();
  mock.method(globalThis, "fetch", async () => slow.promise);
  const props = fixture();
  await render(props);
  const deadline = scheduling.mock.calls.find(call => call.arguments[1] === 10_000)?.result;
  assert.notEqual(deadline, undefined);
  await render({ ...props, enabled: false });
  assert.equal(clearing.mock.calls.some(call => call.arguments[0] === deadline), true);
  await act(async () => slow.resolve(response(status())));
});

test("a stuck status request times out, reports one safe error and retries without overlapping polls", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const errors: string[] = [];
  mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (++reads > 1) return response(status(10, { pending: 0 }));
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("private transport detail")), { once: true }));
  });
  await render({ ...fixture(), onError: message => errors.push(message) });
  await tick(9_999);
  assert.equal(reads, 1);
  await tick(1);
  assert.match(state.error ?? "", /暂时无法读取后台补全状态/);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0]!, /private/);
  await tick(2_999); assert.equal(reads, 1);
  await tick(1); assert.equal(reads, 2);
  assert.equal(state.error, undefined);
});
