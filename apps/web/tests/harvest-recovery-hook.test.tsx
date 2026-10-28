import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import type { HarvestCheckpoint, HarvestCheckpointSnapshot, HarvestJournal, HarvestLease, HarvestRunInput } from "../src/components/atlas/harvest-checkpoint";

// Exercise the actual React hook and recovery controller. Only browser storage
// and the cross-tab lock are replaced at their external IO seam.
const dom = new Window({ url: "http://harvest-recovery-hook-fixture.invalid" });
const React = await import("react");
const { act, createElement: h, Suspense, startTransition } = React;
type Connection = { endpoint: string; token: string };
let openJournal: (connection: Connection) => Promise<HarvestJournal> = async () => { throw new Error("Unexpected journal open"); };
let acquireLease: (scope: string, options: { signal: AbortSignal }) => Promise<HarvestLease | undefined> = async () => { throw new Error("Unexpected lease acquisition"); };
const io = {
  openHarvestJournal: (connection: Connection) => openJournal(connection),
  acquireHarvestLease: (scope: string, options: { signal: AbortSignal }) => acquireLease(scope, options),
};
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  React, IS_REACT_ACT_ENVIRONMENT: true, __harvestRecoveryHookIO: io };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./harvest-journal") return { url: "data:text/javascript,export const openHarvestJournal=(...args)=>globalThis.__harvestRecoveryHookIO.openHarvestJournal(...args);export const acquireHarvestLease=(...args)=>globalThis.__harvestRecoveryHookIO.acquireHarvestLease(...args)", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createRoot } = await import("react-dom/client");
const { useHarvestRecovery } = await import("../src/components/atlas/use-harvest-recovery");
type HookInput = Parameters<typeof useHarvestRecovery>[0];
let root: ReturnType<typeof createRoot> | undefined;
let state: ReturnType<typeof useHarvestRecovery>;
const cleanupResolvers: Array<() => void> = [];
function deferred<T>(fallback: T) {
  let resolvePromise!: (value: T) => void;
  const pending = { value: true };
  const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
  const resolve = (value = fallback) => { pending.value = false; resolvePromise(value); };
  cleanupResolvers.push(() => resolve());
  return { promise, resolve, pending };
}
function Probe(props: HookInput & { pause?: ReturnType<typeof deferred<void>>; onRender?: () => void }) {
  state = useHarvestRecovery(props);
  props.onRender?.();
  if (props.pause?.pending.value) throw props.pause.promise;
  return h("p", { "data-endpoint": props.endpoint }, state.state.phase);
}
function tree(props: Parameters<typeof Probe>[0]) { return h(Suspense, { fallback: h("p", null, "pending render") }, h(Probe, props)); }
async function render(props: Parameters<typeof Probe>[0]) {
  if (!root) { const container = dom.document.createElement("main"); dom.document.body.append(container); root = createRoot(container as unknown as Element); }
  await act(async () => { root!.render(tree(props)); });
}
async function flushUntil(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  }
  assert.ok(predicate(), message);
}
const AT = "2026-10-28T00:00:00.000Z";
function journalFixture(scope: string) {
  const input: HarvestRunInput = { keyword: `query-${scope}`, depth: "quick", maxPages: 5, view: { mode: "global", country: "", region: "", regionText: "" } };
  const snapshot: HarvestCheckpointSnapshot = { run: { schemaVersion: 1, id: `run-${scope}`, scope, input, state: "running", createdAt: AT, updatedAt: AT }, batches: [], providers: [] };
  let reads = 0, closes = 0;
  let read: () => Promise<HarvestCheckpointSnapshot> = async () => structuredClone(snapshot);
  const checkpoint: HarvestCheckpoint = {
    id: snapshot.run.id, read: () => { reads++; return read(); }, resume: async () => { snapshot.run.state = "running"; },
    initialize: async () => {}, capture: async () => {}, prepare: async () => {}, confirm: async () => {}, recordProvider: async () => {},
    settle: async next => { snapshot.run.state = next; },
  };
  const journal: HarvestJournal = {
    scope, findResumable: async () => snapshot.run.state === "running" ? checkpoint : undefined,
    findRecoverable: async () => snapshot.run.state !== "completed" && snapshot.run.state !== "superseded" ? checkpoint : undefined,
    create: async () => { throw new Error("Recovery must not create a replacement run"); },
    close() { closes++; },
  };
  return { journal, checkpoint, snapshot, reads: () => reads, closes: () => closes, setRead(next: typeof read) { read = next; } };
}
function leaseFixture() {
  const held = new Set<string>(), events: string[] = [];
  acquireLease = async (scope, { signal }) => {
    signal.throwIfAborted(); events.push(`acquire:${scope}`);
    if (held.has(scope)) return undefined;
    held.add(scope);
    let released = false;
    return { release() { if (released) return; released = true; held.delete(scope); events.push(`release:${scope}`); } };
  };
  return { held, events };
}
function connection(label: string, onResume: HookInput["onResume"]): HookInput {
  return { endpoint: `http://127.0.0.1:${label === "a" ? 5178 : 5179}`, token: `synthetic-token-${label}`, enabled: true, onResume };
}
async function clean() {
  await act(async () => { if (root) root.unmount(); root = undefined; for (const resolve of cleanupResolvers.splice(0)) resolve(); await new Promise<void>(resolve => setImmediate(resolve)); });
  dom.document.body.replaceChildren();
}
afterEach(clean);
after(() => { hooks.deregister(); dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("a deferred old-connection read never invokes the new connection callback even during an uncommitted render", async () => {
  const old = journalFixture("a"), next = journalFixture("b"), leases = leaseFixture();
  const pendingRead = deferred(structuredClone(old.snapshot)), pendingRender = deferred<void>(undefined);
  old.setRead(async () => old.reads() === 1 ? pendingRead.promise : structuredClone(old.snapshot));
  const opened: string[] = [], resumed: string[] = [];
  openJournal = async ({ endpoint }) => { const label = endpoint.endsWith("5178") ? "a" : "b"; opened.push(label); return label === "a" ? old.journal : next.journal; };
  await render(connection("a", async (_input, checkpoint) => { resumed.push(`a:${checkpoint.id}`); }));
  await flushUntil(() => old.reads() === 1, "the old connection should be awaiting its durable checkpoint");
  let renderedNew = false;
  await act(async () => { startTransition(() => root!.render(tree({ ...connection("b", async (_input, checkpoint) => { resumed.push(`b:${checkpoint.id}`); await checkpoint.settle("completed"); }), pause: pendingRender, onRender: () => { renderedNew = true; } }))); });
  assert.equal(renderedNew, true);
  assert.deepEqual(opened, ["a"], "a suspended connection render has not replaced the committed effect");
  await act(async () => pendingRead.resolve());
  await flushUntil(() => !leases.held.has("a"), "the old read should settle without borrowing a different connection callback");
  assert.deepEqual(resumed, [], "old-scope evidence must not reach the latest new-scope callback");
  await act(async () => pendingRender.resolve());
  await flushUntil(() => resumed.length === 1, "the new connection should resume its own checkpoint after commit");
  assert.deepEqual(resumed, ["b:run-b"]);
  assert.deepEqual(opened, ["a", "b"]);
  assert.equal(old.closes(), 1);
});

test("rapid disable and re-enable waits for the old writer to drain before automatically resuming the same scope", async () => {
  const old = journalFixture("a"), next = journalFixture("a"), leases = leaseFixture();
  const pendingWrite = deferred<void>(undefined);
  const signals: AbortSignal[] = [];
  let opens = 0, resumes = 0;
  openJournal = async () => ++opens === 1 ? old.journal : next.journal;
  const input = connection("a", async (_saved, checkpoint, signal) => {
    resumes++; signals.push(signal);
    if (resumes === 1) await pendingWrite.promise;
    else await checkpoint.settle("completed");
  });
  await render(input);
  await flushUntil(() => resumes === 1, "the first writer should own the lease");
  await render({ ...input, enabled: false });
  assert.equal(signals[0]!.aborted, true);
  assert.equal(old.closes(), 0, "a still-accepted write retains its journal until it drains");
  await render(input);
  await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  assert.equal(opens, 1, "the replacement must not race the still-held old lease and become permanently elsewhere");
  assert.equal(resumes, 1); assert.equal(leases.held.has("a"), true);
  await act(async () => pendingWrite.resolve());
  await flushUntil(() => resumes === 2 && !leases.held.size, "the replacement should automatically resume after the old writer releases its lease");
  assert.equal(opens, 2); assert.equal(old.closes(), 1);
  assert.equal(signals[1]!.aborted, false);
  assert.deepEqual(leases.events, ["acquire:a", "release:a", "acquire:a", "release:a"]);
  assert.equal(state.state.phase, "ready");
});

test("unmount closes a journal that opens late without acquiring a lease or resuming collection", async () => {
  const fixture = journalFixture("a"), pendingOpen = deferred(fixture.journal), leases = leaseFixture();
  let opens = 0, resumes = 0;
  openJournal = async () => { opens++; return pendingOpen.promise; };
  await render(connection("a", async () => { resumes++; }));
  await flushUntil(() => opens === 1, "journal opening should have started");
  await act(async () => { root!.unmount(); root = undefined; });
  assert.equal(fixture.closes(), 0);
  await act(async () => pendingOpen.resolve());
  await flushUntil(() => fixture.closes() === 1, "the late-opened handle must still be closed");
  assert.equal(resumes, 0); assert.deepEqual(leases.events, []);
});

test("unmount releases a late lease and closes its journal without reading or executing the checkpoint", async () => {
  const fixture = journalFixture("a");
  let acquisitions = 0, releases = 0, resumes = 0;
  const pendingLease = deferred<HarvestLease>({ release() { releases++; } });
  openJournal = async () => fixture.journal;
  acquireLease = async () => { acquisitions++; return pendingLease.promise; };
  await render(connection("a", async () => { resumes++; }));
  await flushUntil(() => acquisitions === 1, "the pending browser lock request should have started");
  await act(async () => { root!.unmount(); root = undefined; });
  await act(async () => pendingLease.resolve());
  await flushUntil(() => fixture.closes() === 1, "the late lease must not retain its closed component's journal");
  assert.equal(releases, 1); assert.equal(fixture.reads(), 0); assert.equal(resumes, 0);
});

test("unmount while a replacement waits for drain prevents that queued replacement from opening or resuming", async () => {
  const fixture = journalFixture("a"), pendingWrite = deferred<void>(undefined), leases = leaseFixture();
  let opens = 0, resumes = 0;
  openJournal = async () => { opens++; return fixture.journal; };
  const input = connection("a", async () => { resumes++; await pendingWrite.promise; });
  await render(input);
  await flushUntil(() => resumes === 1, "the first run should be executing an accepted write");
  await render({ ...input, enabled: false });
  await render(input);
  await act(async () => { root!.unmount(); root = undefined; });
  await act(async () => pendingWrite.resolve());
  await flushUntil(() => fixture.closes() === 1 && !leases.held.size, "the old accepted writer must finish cleanup after unmount");
  assert.equal(opens, 1); assert.equal(resumes, 1);
  assert.deepEqual(leases.events, ["acquire:a", "release:a"]);
});
