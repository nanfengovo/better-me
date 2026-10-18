import assert from "node:assert/strict";
import test from "node:test";
import { createJobSessionRouter, type JobSessionBackend } from "../server/jd-session-router.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";
import { createJdStartRequestId, isJdStartRequestId, JD_START_REQUEST_WINDOW_MS } from "../src/lib/jd-start-request.ts";

const original = "https://m.liepin.com/job/1984701079.shtml?mscid=wx_h5_001";
const other = "https://msearch.51job.com/jobs/all/166761768.html";
const base = Date.now();
const key = (index: number, time = base) => `${time.toString(36)}_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const code = (expected: string) => (error: unknown) => error instanceof JdExtractionError && error.failure.code === expected;

function fixture(options: { maxRecords?: number; startTimeoutMs?: number; cancelWaitMs?: number } = {}) {
  let time = base;
  let starts = 0, closes = 0, stops = 0, closeFailure = false;
  let gate: ReturnType<typeof deferred> | undefined;
  const pages = new Map<string, { owner: string; active: boolean; expires: number }>();
  const backend: JobSessionBackend = {
    async start(owner, input, signal) {
      const id = `session_${++starts}`;
      const page = { owner, active: false, expires: time + 600_000 }; pages.set(id, page);
      if (gate) await gate.promise;
      if (signal?.aborted) {
        if (!closeFailure) pages.delete(id);
        throw signal.reason;
      }
      page.active = true;
      return { sessionId: id, platform: "猎聘", url: input, expiresAt: new Date(page.expires).toISOString() };
    },
    async close(owner, id) { closes++; const page = pages.get(id); if (page?.owner === owner) { page.active = false; if (closeFailure) throw new Error("fixture close failed"); pages.delete(id); } return { closed: true }; },
    async read() { throw new Error("not used"); }, async inspect() { throw new Error("not used"); },
    async focus() { return { activationRequested: true }; },
    async closeAll() { for (const [id, page] of pages) await backend.close(page.owner, id); },
    async stopBrowser() { stops++; pages.clear(); },
    async retryEnded(owner) { for (const [id, page] of pages) if (page.owner === owner && !page.active) await backend.close(owner, id); },
    owns: id => pages.has(id),
    isActive: (owner, id) => { const page = pages.get(id); return page?.owner === owner && page.active && time < page.expires; },
    hasSession: () => pages.size > 0,
  };
  const router = createJobSessionRouter(backend, backend, { useNativeLiepin: true, requestOptions: { now: () => time, ...options } });
  return { router, backend, pages, get starts() { return starts; }, get closes() { return closes; }, get stops() { return stops; },
    tick(ms: number) { time += ms; }, waitStart() { gate = deferred(); return gate; }, failClose(value: boolean) { closeFailure = value; } };
}

test("start request IDs are unique, timestamped, and never accept arbitrary text", () => {
  const first = createJdStartRequestId(), second = createJdStartRequestId();
  assert.ok(isJdStartRequestId(first)); assert.notEqual(first, second);
  for (const value of ["", "request-id", first.toUpperCase(), null, {}, `${first}/x`]) assert.equal(isJdStartRequestId(value), false);
});

test("one lost response and concurrent waiters return the same session with unchanged TTL and one launch", async () => {
  const f = fixture(), gate = f.waitStart();
  const dropped = new AbortController();
  const first = f.router.startRequest("owner", original, key(1), dropped.signal);
  const cancelled = assert.rejects(first, error => error instanceof DOMException && error.name === "AbortError");
  await new Promise(resolve => setImmediate(resolve));
  const retry = f.router.startRequest("owner", original, key(1));
  dropped.abort(new DOMException("transport lost", "AbortError")); await cancelled;
  gate.resolve(); const info = await retry;
  f.tick(1000);
  assert.deepEqual(await f.router.startRequest("owner", original, key(1)), info);
  assert.equal(f.starts, 1); assert.equal(f.closes, 0); assert.equal(f.stops, 0);
  await f.router.close("owner", info.sessionId);
});

test("request binding rejects another owner or source without touching an active page", async () => {
  const f = fixture(), info = await f.router.startRequest("owner", original, key(2));
  for (const action of ["startRequest", "cancelStart"] as const) {
    await assert.rejects(f.router[action]("foreign", original, key(2)), code("job_mismatch"));
    await assert.rejects(f.router[action]("owner", other, key(2)), code("job_mismatch"));
  }
  await assert.rejects(f.router.startRequest("owner", other, key(3)), code("browser_unavailable"));
  assert.equal(f.closes, 0); assert.equal(f.starts, 1); assert.equal(f.backend.isActive?.("owner", info.sessionId), true);
  assert.deepEqual(await f.router.cancelStart("owner", other, key(3)), { cancelled: true, closed: false });
  assert.equal(f.closes, 0, "a failed different request never closes the active session");
  await f.router.close("owner", info.sessionId);
});

test("cancel-before-start records a tombstone and never opens a delayed request", async () => {
  const f = fixture();
  assert.deepEqual(await f.router.cancelStart("owner", original, key(4)), { cancelled: true, closed: true });
  await assert.rejects(f.router.startRequest("owner", original, key(4)), code("browser_session_expired"));
  f.tick(JD_START_REQUEST_WINDOW_MS + 1);
  await assert.rejects(f.router.startRequest("owner", original, key(4)), code("browser_session_expired"));
  assert.equal(f.starts, 0);
  const current = await f.router.startRequest("owner", original, key(5, base + JD_START_REQUEST_WINDOW_MS + 1));
  await f.router.close("owner", current.sessionId);
});

test("expired unknown startup can be precisely cancelled after a pause without allowing a late launch", async () => {
  const f = fixture(), old = key(101);
  f.tick(JD_START_REQUEST_WINDOW_MS + 1);
  assert.deepEqual(await f.router.cancelStart("owner", original, old), { cancelled: true, closed: true });
  await assert.rejects(f.router.startRequest("owner", original, old), code("browser_session_expired"));
  assert.equal(f.starts, 0); assert.equal(f.closes, 0); assert.equal(f.stops, 0);
});

test("a pruned completed startup remains confirmable by exact cancellation", async () => {
  const f = fixture(), old = key(102);
  const info = await f.router.startRequest("owner", original, old);
  await f.router.close("owner", info.sessionId);
  f.tick(JD_START_REQUEST_WINDOW_MS + 1);
  assert.deepEqual(await f.router.cancelStart("owner", original, old), { cancelled: true, closed: true });
  await assert.rejects(f.router.startRequest("owner", original, old), code("browser_session_expired"));
  assert.equal(f.starts, 1); assert.equal(f.closes, 1); assert.equal(f.stops, 0);
});

test("aged unknown cancellation never closes a newer active session and stays unconfirmed until it ends", async () => {
  const f = fixture(), old = key(103);
  f.tick(JD_START_REQUEST_WINDOW_MS + 1);
  const current = await f.router.startRequest("owner", original, key(104, base + JD_START_REQUEST_WINDOW_MS + 1));
  assert.deepEqual(await f.router.cancelStart("owner", original, old), { cancelled: true, closed: false });
  assert.equal(f.backend.isActive?.("owner", current.sessionId), true);
  assert.equal(f.closes, 0); assert.equal(f.stops, 0);
  await f.router.close("owner", current.sessionId);
  assert.deepEqual(await f.router.cancelStart("owner", original, old), { cancelled: true, closed: true });
  assert.equal(f.starts, 1); assert.equal(f.closes, 1);
});

test("aged retained cleanup keeps owner and source binding and retries only its own failed page", async () => {
  const f = fixture(), old = key(105);
  const info = await f.router.startRequest("owner", original, old);
  f.failClose(true);
  await assert.rejects(f.router.cancelStart("owner", original, old), /fixture close failed/);
  f.tick(JD_START_REQUEST_WINDOW_MS + 1);
  await assert.rejects(f.router.cancelStart("foreign", original, old), code("job_mismatch"));
  await assert.rejects(f.router.cancelStart("owner", other, old), code("job_mismatch"));
  assert.equal(f.pages.has(info.sessionId), true);
  f.failClose(false);
  assert.deepEqual(await f.router.cancelStart("owner", original, old), { cancelled: true, closed: true });
  assert.equal(f.pages.size, 0); assert.equal(f.starts, 1); assert.equal(f.stops, 0);
});

test("exact cancellation still rejects invalid or future IDs and respects pending capacity", async () => {
  const f = fixture({ maxRecords: 1, cancelWaitMs: 1 }), gate = f.waitStart();
  const active = f.router.startRequest("owner", original, key(106));
  const rejected = assert.rejects(active, code("browser_session_expired"));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.router.cancelStart("owner", original, "invalid-id"), code("invalid_link"));
  await assert.rejects(f.router.cancelStart("owner", original, key(107, base + 5001)), code("browser_session_expired"));
  await assert.rejects(f.router.cancelStart("owner", original, key(108, base - JD_START_REQUEST_WINDOW_MS - 1)), code("browser_unavailable"));
  assert.deepEqual(await f.router.cancelStart("owner", original, key(106)), { cancelled: true, closed: false });
  gate.resolve(); await rejected;
  assert.deepEqual(await f.router.cancelStart("owner", original, key(106)), { cancelled: true, closed: true });
  assert.equal(f.starts, 1); assert.equal(f.stops, 0);
});

test("close, stop, natural expiry and ended ownership can never replay cached ready info", async () => {
  for (const mode of ["close", "closeAll", "stop", "ttl", "ended"] as const) {
    const f = fixture(), id = key(6), info = await f.router.startRequest("owner", original, id);
    if (mode === "close") await f.router.close("owner", info.sessionId);
    if (mode === "closeAll") await f.router.closeAll();
    if (mode === "stop") await f.router.stopBrowser();
    if (mode === "ttl") f.tick(600_000);
    if (mode === "ended") f.pages.get(info.sessionId)!.active = false;
    await assert.rejects(f.router.startRequest("owner", original, id), code("browser_session_expired"));
    assert.equal(f.starts, 1, mode);
    await f.router.closeAll();
  }
});

test("cancel owns only its request and retained close failures block new launch without eviction", async () => {
  const f = fixture({ maxRecords: 1 }), id = key(7), info = await f.router.startRequest("owner", original, id);
  f.failClose(true);
  await assert.rejects(f.router.cancelStart("owner", original, id), /fixture close failed/);
  assert.equal(f.backend.owns(info.sessionId), true); assert.equal(f.backend.isActive?.("owner", info.sessionId), false);
  await assert.rejects(f.router.startRequest("owner", original, id), code("browser_session_expired"));
  f.tick(JD_START_REQUEST_WINDOW_MS + 1);
  const newId = key(8, base + JD_START_REQUEST_WINDOW_MS + 1);
  await assert.rejects(f.router.startRequest("owner", original, newId), code("browser_unavailable"));
  assert.equal(f.starts, 1);
  f.failClose(false); assert.deepEqual(await f.router.cancelStart("owner", original, id), { cancelled: true, closed: true });
  const next = await f.router.startRequest("owner", original, newId);
  assert.equal(f.starts, 2); await f.router.close("owner", next.sessionId);
});

test("pending cancellation retains late acquired failure until actual release and old IDs never restart", async () => {
  const f = fixture({ maxRecords: 1 }), gate = f.waitStart(), id = key(9);
  const pending = f.router.startRequest("owner", original, id);
  const rejected = assert.rejects(pending, code("browser_session_expired"));
  await new Promise(resolve => setImmediate(resolve)); f.failClose(true);
  const cancelled = f.router.cancelStart("owner", original, id);
  gate.resolve(); await rejected;
  assert.deepEqual(await cancelled, { cancelled: true, closed: false });
  assert.equal(f.pages.size, 1); f.tick(JD_START_REQUEST_WINDOW_MS + 1);
  await assert.rejects(f.router.startRequest("owner", original, id), code("browser_session_expired"));
  const fresh = key(10, base + JD_START_REQUEST_WINDOW_MS + 1);
  await assert.rejects(f.router.startRequest("owner", original, fresh), code("browser_unavailable"));
  assert.equal(f.starts, 1); f.failClose(false);
  await f.backend.retryEnded?.("owner");
  const next = await f.router.startRequest("owner", original, fresh);
  await f.router.close("owner", next.sessionId);
});

test("finite logical timeout cancels a pending launch and one HTTP waiter cannot cancel another", async () => {
  const f = fixture({ startTimeoutMs: 10 }), gate = f.waitStart(), id = key(11);
  const pending = f.router.startRequest("owner", original, id);
  const rejected = assert.rejects(pending, code("browser_session_expired"));
  await new Promise(resolve => setTimeout(resolve, 20)); gate.resolve(); await rejected;
  assert.equal(f.pages.size, 0);
  assert.deepEqual(await f.router.cancelStart("owner", original, id), { cancelled: true, closed: true });
  assert.equal(f.starts, 1);
});

test("the bounded registry rejects new IDs rather than evicting a pending request", async () => {
  const f = fixture({ maxRecords: 1 }), gate = f.waitStart(), id = key(12);
  const pending = f.router.startRequest("owner", original, id);
  f.tick(JD_START_REQUEST_WINDOW_MS + 1);
  await assert.rejects(f.router.startRequest("owner", original, key(13, base + JD_START_REQUEST_WINDOW_MS + 1)), code("browser_unavailable"));
  gate.resolve(); const info = await pending;
  assert.equal((await f.router.startRequest("owner", original, id)).sessionId, info.sessionId);
  await f.router.close("owner", info.sessionId);
});

test("a stalled preflight cannot hold timeout or cancellation HTTP waiters open or release its reservation", async () => {
  const f = fixture({ startTimeoutMs: 10, cancelWaitMs: 5 }), gate = deferred(), id = key(14);
  f.backend.recoverExited = async () => { await gate.promise; return false; };
  const pending = f.router.startRequest("owner", original, id);
  await assert.rejects(pending, code("browser_session_expired"));
  assert.deepEqual(await f.router.cancelStart("owner", original, id), { cancelled: true, closed: false });
  assert.equal(f.router.hasSession(), true, "real preflight still owns its reservation");
  await assert.rejects(f.router.startRequest("owner", other, key(15)), code("browser_unavailable"));
  assert.equal(f.starts, 0);
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.router.hasSession(), false);
  assert.equal(f.starts, 0, "the late preflight cannot create a page after cancellation");
  assert.deepEqual(await f.router.cancelStart("owner", original, id), { cancelled: true, closed: true });
});
