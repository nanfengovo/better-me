import assert from "node:assert/strict";
import test, { after, afterEach, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";
import { fxData, fxState } from "./fixtures/atlas-fx.ts";
import type { AtlasFxContextInput } from "../src/components/atlas/useAtlasFxContext.ts";
const dom = new Window({ url: "http://synthetic-fx-context.invalid" });
const React = await import("react"); const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client"); const { useAtlasFxContext } = await import("../src/components/atlas/useAtlasFxContext.ts");
let root: ReturnType<typeof createRoot> | undefined, current: ReturnType<typeof useAtlasFxContext>;
function Probe(props: AtlasFxContextInput) { current = useAtlasFxContext(props); return h("div"); }
function fixture(): AtlasFxContextInput { return { active: true, connected: true, dataMode: "live", endpoint: "http://127.0.0.1:5178", token: "synthetic-fx-context-token", snapshot: fxData(), asOfDay: "2026-10-21" }; }
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, requestId: "synthetic-fx-context", value }));
async function render(props: AtlasFxContextInput) { if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); } await act(async () => root!.render(h(Probe, props))); }
async function settle() { const deadline = performance.now() + 3000; while (current.loading) { assert.ok(performance.now() < deadline); await act(async () => { await delay(5); }); } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mock.restoreAll(); });
after(() => { void dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

test("FX context immediately hides the old result on new snapshot, discards a late response and binds the current expectedRevision", async () => {
  const late = deferred<Response>(), calls: { body: { expectedRevision: number }; signal?: AbortSignal | null }[] = [];
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit) => { const body = JSON.parse(String(init.body)); calls.push({ body, signal: init.signal }); return body.expectedRevision === 2 ? late.promise : response(fxState(body.expectedRevision, true)); });
  const props = fixture(); await render(props); await settle(); assert.equal(current.ready, true); assert.ok(current.context?.activeSnapshot);
  await render({ ...props, snapshot: fxData(2) }); assert.equal(current.ready, false); assert.equal(current.context, undefined);
  await render({ ...props, snapshot: fxData(3) }); assert.equal(calls[1]!.signal?.aborted, true); await settle(); assert.equal(current.context?.datasetRevision, 3);
  await act(async () => late.resolve(response(fxState(2, true)))); assert.equal(current.context?.datasetRevision, 3); assert.deepEqual(calls.map(value => value.body.expectedRevision), [1, 2, 3]);
});

test("failed or cancelled FX reads expose a retry while keeping previous FX unavailable; 404 alone enables an explicit no-FX fallback", async () => {
  let mode: "ok" | "error" | "old" = "ok";
  mock.method(globalThis, "fetch", async () => { if (mode === "error") throw new TypeError("synthetic disconnected"); return mode === "old" ? new Response("", { status: 404 }) : response(fxState(1, true)); });
  await render(fixture()); await settle(); assert.equal(current.ready, true); mode = "error";
  await act(async () => current.retry()); await settle(); assert.equal(current.ready, false); assert.equal(current.context, undefined); assert.match(current.error!, /回执/);
  mode = "old"; await act(async () => current.retry()); await settle(); assert.equal(current.ready, true); assert.equal(current.unsupported, true); assert.equal(current.context, undefined);
  assert.match(current.error!, /升级|更新/);
});

test("connection identity, UTC day, inactive state and local/demo views do not reuse a private FX context", async () => {
  const calls: RequestInit[] = []; mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit) => { calls.push(init); return response(fxState(1, true)); });
  const props = fixture(); await render(props); await settle(); const previous = current.context;
  await render({ ...props, asOfDay: "2026-10-22" }); assert.equal(current.context, undefined); await settle(); assert.notEqual(current.context, previous); assert.equal(calls.length, 2);
  await render({ ...props, dataMode: "demo" }); assert.equal(current.context, undefined); assert.equal(current.ready, true); assert.equal(calls.length, 2);
  await render({ ...props, dataMode: "local" }); assert.equal(current.context, undefined); assert.equal(calls.length, 2);
  await render({ ...props, token: "synthetic-new-fx-token" }); assert.equal(current.context, undefined); await settle(); assert.equal(calls.length, 3);
  await render({ ...props, active: false }); assert.equal(current.context, undefined); assert.equal(current.ready, false);
});

test("stopping an in-flight context read aborts it and a late success cannot unlock queries", async () => {
  const late = deferred<Response>(); let signal: AbortSignal | null | undefined;
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit) => { signal = init.signal; return late.promise; });
  await render(fixture()); assert.equal(current.loading, true); await act(async () => current.cancel()); assert.equal(signal?.aborted, true); assert.equal(current.ready, false);
  await act(async () => late.resolve(response(fxState(1, true)))); assert.equal(current.ready, false); assert.equal(current.context, undefined); assert.match(current.error!, /停止/);
});
