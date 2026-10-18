import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { browserSessionMiddleware } from "../server/jd-extractor.ts";
import { createJobSessionRouter, type JobSessionBackend } from "../server/jd-session-router.ts";
import { createNativeLiepinSessions } from "../server/jd-native-liepin.ts";
import type { NativeLiepinPage } from "../server/jd-native-liepin-browser.ts";
import { cancelJdBrowserStartRequest, closeJdBrowserSession, startJdBrowserSession } from "../src/lib/jd-import.ts";
import { JdBrowserStartCleanupError, JdExtractionError } from "../src/lib/jd-errors.ts";
import { createJdStartRequestId, isJdStartRequestId } from "../src/lib/jd-start-request.ts";

const link = "https://m.liepin.com/job/123.shtml?from=lost_response_fixture";
const failureIs = (code: string) => (error: unknown) => error instanceof JdExtractionError && error.failure.code === code;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

/** Real middleware receives synthetic streams; this never opens an HTTP listener. */
async function dispatch(sessions: JobSessionBackend, body: unknown, signal?: AbortSignal, connected?: (disconnect: () => void) => void): Promise<Response> {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST", url: "/api/jd/browser-session",
    headers: { origin: "http://127.0.0.1:5173", host: "127.0.0.1:5173", "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  let status = 0, content = "";
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    writeHead(value: number) { status = value; },
    end(value: string) { content = value; response.writableEnded = true; },
  });
  const aborted = () => { request.emit("aborted"); response.emit("close"); };
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    connected?.(() => response.emit("close"));
    if (signal?.aborted) aborted();
    await browserSessionMiddleware(request, response as unknown as ServerResponse, sessions);
    assert.ok(status > 0, "middleware must return a classified response");
    return new Response(content, { status, headers: { "Content-Type": "application/json" } });
  } finally { signal?.removeEventListener("abort", aborted); }
}

function fixture(acquireGate?: ReturnType<typeof deferred>) {
  const enteredAcquire = deferred();
  const releasedPage = deferred();
  const control = { acquisitions: 0, navigations: 0, releases: 0, closed: 0, stops: 0, failRelease: false };
  const native = createNativeLiepinSessions({
    browser: {
      async acquire() {
        control.acquisitions += 1; enteredAcquire.resolve();
        await acquireGate?.promise;
        let closed = false;
        const page: NativeLiepinPage = {
          get closed() { return closed; },
          async navigate(url) { assert.equal(url, link); control.navigations += 1; },
          async capture() { throw new Error("capture is outside this test"); },
          async current() { throw new Error("current is outside this test"); },
          inspect() { throw new Error("inspect is outside this test"); },
          async focus() { throw new Error("focus is outside this test"); },
          async release() {
            control.releases += 1;
            if (control.failRelease) throw new Error("synthetic page release failed");
            if (!closed) { closed = true; control.closed += 1; releasedPage.resolve(); }
          },
        };
        return page;
      },
      async stop() { control.stops += 1; },
    },
    getOperation: async () => ({ fetch: async () => { throw new Error("network access forbidden"); }, routeFor: () => ({ mode: "direct", source: "synthetic route" }) }),
  });
  const unused: JobSessionBackend = {
    async start() { throw new Error("unexpected standard start"); },
    async read() { throw new Error("unexpected standard read"); },
    async inspect() { throw new Error("unexpected standard inspect"); },
    async focus() { throw new Error("unexpected standard focus"); },
    async close() { throw new Error("unexpected standard close"); },
    async closeAll() {}, async stopBrowser() {}, owns: () => false, hasSession: () => false, isActive: () => false,
  };
  const router = createJobSessionRouter(unused, native, { useNativeLiepin: true });
  return { native, router, control, enteredAcquire, releasedPage };
}

test("成功start响应体损坏或传输丢失时，同ID只重试一次且真实router不重复创建", async (t) => {
  for (const loss of ["json", "transport"] as const) await t.test(loss, async () => {
    const originalFetch = globalThis.fetch;
    const f = fixture();
    const bodies: Record<string, unknown>[] = [];
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, "/api/jd/browser-session");
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        const response = await dispatch(f.router, body, init?.signal ?? undefined);
        if (bodies.length === 1) {
          assert.equal(response.status, 200);
          if (loss === "transport") throw new TypeError("synthetic response lost after server commit");
          response.json = async () => { throw new SyntaxError("synthetic start body lost"); };
        }
        return response;
      };
      const session = await startJdBrowserSession(link, new AbortController().signal);
      assert.deepEqual(bodies.map(body => body.action), ["start", "start"]);
      assert.equal(isJdStartRequestId(bodies[0].requestId), true);
      assert.equal(bodies[0].requestId, bodies[1].requestId);
      assert.equal(f.control.acquisitions, 1); assert.equal(f.control.navigations, 1);
      assert.equal(f.control.releases, 0); assert.equal(f.control.stops, 0);
      await closeJdBrowserSession(session.sessionId);
      assert.equal(f.control.closed, 1); assert.equal(f.router.hasSession(), false);
    } finally { globalThis.fetch = originalFetch; await f.router.stopBrowser("owned-only"); }
  });
});

test("真实middleware的HTTP响应断开只结束waiter，pending启动可被同ID重试接回", async () => {
  const originalFetch = globalThis.fetch;
  const gate = deferred(), retried = deferred();
  const f = fixture(gate);
  const bodies: Record<string, unknown>[] = [];
  const controller = new AbortController();
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (bodies.length === 1) {
        let disconnect!: () => void;
        const pending = dispatch(f.router, body, init?.signal ?? undefined, close => { disconnect = close; });
        await f.enteredAcquire.promise; disconnect(); await pending;
        throw new TypeError("synthetic HTTP connection closed before start completed");
      }
      if (body.action === "start") retried.resolve();
      return dispatch(f.router, body, init?.signal ?? undefined);
    };
    const opening = startJdBrowserSession(link, controller.signal);
    await retried.promise;
    assert.equal(controller.signal.aborted, false);
    assert.equal(f.control.acquisitions, 1); assert.equal(f.control.navigations, 0);
    gate.resolve();
    const active = await opening;
    assert.deepEqual(bodies.map(body => body.action), ["start", "start"]);
    assert.equal(bodies[0].requestId, bodies[1].requestId);
    assert.equal(f.control.acquisitions, 1); assert.equal(f.control.navigations, 1);
    assert.equal(f.control.releases, 0); assert.equal(f.control.stops, 0);
    await closeJdBrowserSession(active.sessionId);
    assert.equal(f.control.closed, 1);
  } finally { gate.resolve(); globalThis.fetch = originalFetch; await f.router.stopBrowser("owned-only"); }
});

test("两次成功响应皆丢时按启动ID清理，下一次新调用能重开且不自动stop", async () => {
  const originalFetch = globalThis.fetch;
  const f = fixture();
  const bodies: Record<string, unknown>[] = [];
  let starts = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const response = await dispatch(f.router, body, init?.signal ?? undefined);
      if (body.action === "start" && ++starts <= 2) response.json = async () => { throw new SyntaxError("synthetic lost response"); };
      if (body.action === "cancel-start") {
        assert.equal(init?.keepalive, true); assert.equal(init?.signal?.aborted, false);
      }
      return response;
    };
    await assert.rejects(startJdBrowserSession(link, new AbortController().signal), failureIs("service_unavailable"));
    assert.deepEqual(bodies.map(body => body.action), ["start", "start", "cancel-start"]);
    assert.equal(bodies.every(body => body.requestId === bodies[0].requestId && body.sessionId === undefined), true);
    assert.equal(f.control.acquisitions, 1); assert.equal(f.control.closed, 1); assert.equal(f.control.stops, 0);
    assert.equal(f.router.hasSession(), false);
    const next = await startJdBrowserSession(link, new AbortController().signal);
    assert.notEqual(bodies[3].requestId, bodies[0].requestId);
    assert.equal(f.control.acquisitions, 2);
    await closeJdBrowserSession(next.sessionId);
  } finally { globalThis.fetch = originalFetch; await f.router.stopBrowser("owned-only"); }
});

test("尚未到router且忽略abort的旧POST在精确补偿取消后被封口，新start成功不能代替该确认", async () => {
  const originalFetch = globalThis.fetch;
  const f = fixture();
  const oldPostGate = deferred(), oldPostSent = deferred();
  const controller = new AbortController();
  const bodies: Record<string, unknown>[] = [];
  let oldRequestId: string | undefined;
  let oldTransport: Promise<Response> | undefined;
  let oldReachedRouter = false, dropCancellation = true;
  let confirmedCancellation: unknown;
  let lateResponse: { status: number; payload: { failure?: { code?: string } } } | undefined;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.action === "start" && oldRequestId === undefined) {
        oldRequestId = body.requestId;
        oldTransport = (async () => {
          await oldPostGate.promise;
          // This synthetic transport deliberately ignores its aborted client
          // signal and only reaches the real middleware after compensation.
          assert.equal(init?.signal?.aborted, true);
          oldReachedRouter = true;
          const response = await dispatch(f.router, body);
          lateResponse = { status: response.status, payload: await response.clone().json() };
          return response;
        })();
        oldPostSent.resolve();
        return oldTransport;
      }
      if (body.action === "cancel-start" && body.requestId === oldRequestId) {
        assert.equal(init?.keepalive, true); assert.notEqual(init?.signal, controller.signal);
        assert.equal(init?.signal?.aborted, false);
        if (dropCancellation) throw new TypeError("synthetic cancellation never reached server");
        const response = await dispatch(f.router, body, init?.signal ?? undefined);
        confirmedCancellation = await response.clone().json();
        return response;
      }
      return dispatch(f.router, body, init?.signal ?? undefined);
    };
    let cleanupError: JdBrowserStartCleanupError | undefined;
    const opening = startJdBrowserSession(link, controller.signal);
    const rejected = assert.rejects(opening, (error: unknown) => {
      assert.ok(error instanceof JdBrowserStartCleanupError);
      assert.equal(error.input, link); assert.equal(error.requestId, oldRequestId);
      cleanupError = error;
      return true;
    });
    await oldPostSent.promise;
    controller.abort(new DOMException("old link cancelled", "AbortError"));
    await rejected;
    assert.equal(oldReachedRouter, false); assert.equal(f.router.hasSession(), false);
    assert.equal(f.control.acquisitions, 0);

    const newer = await startJdBrowserSession(link, new AbortController().signal);
    assert.equal(oldReachedRouter, false); assert.notEqual(bodies[2].requestId, oldRequestId);
    assert.equal(f.control.acquisitions, 1); assert.equal(f.control.navigations, 1);
    assert.equal(f.control.releases, 0); assert.equal(f.control.stops, 0);
    await closeJdBrowserSession(newer.sessionId);
    assert.equal(f.control.closed, 1); assert.equal(f.router.hasSession(), false);

    dropCancellation = false;
    await cancelJdBrowserStartRequest(cleanupError!.input, cleanupError!.requestId);
    assert.deepEqual(confirmedCancellation, { cancelled: true, closed: true });
    assert.equal(oldReachedRouter, false);
    oldPostGate.resolve();
    await oldTransport!;
    assert.equal(lateResponse?.status, 422);
    assert.equal(lateResponse?.payload.failure?.code, "browser_session_expired");
    assert.equal(f.control.acquisitions, 1); assert.equal(f.control.navigations, 1);
    assert.equal(f.control.closed, 1); assert.equal(f.control.stops, 0);
    assert.equal(f.router.hasSession(), false);
    assert.deepEqual(bodies.map(body => body.action), ["start", "cancel-start", "start", "close", "cancel-start"]);
    assert.equal(bodies[4].requestId, oldRequestId);
    assert.equal(bodies[3].sessionId, newer.sessionId);
  } finally {
    oldPostGate.resolve();
    await oldTransport?.catch(() => undefined);
    globalThis.fetch = originalFetch;
    await f.router.stopBrowser("owned-only");
  }
});

test("远端cleanup标记或类名不能伪造本地清理错误及精确请求身份", async () => {
  const originalFetch = globalThis.fetch;
  const f = fixture();
  const bodies: Record<string, unknown>[] = [];
  const failure = { code: "service_unavailable", stage: "service", message: "remote cleanup marker fixture" };
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.action === "start") return json({
        failure: { ...failure, cleanupUnconfirmed: true, name: "JdBrowserStartCleanupError", input: "https://invalid.example/private", requestId: "remote-controlled-id" },
        cleanupUnconfirmed: true, name: "JdBrowserStartCleanupError", input: "https://invalid.example/private", requestId: "remote-controlled-id",
      }, 422);
      return dispatch(f.router, body, init?.signal ?? undefined);
    };
    await assert.rejects(startJdBrowserSession(link, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof JdExtractionError);
      assert.equal(error instanceof JdBrowserStartCleanupError, false);
      assert.deepEqual(error.failure, failure);
      assert.equal(Object.hasOwn(error, "input"), false);
      assert.equal(Object.hasOwn(error, "requestId"), false);
      return true;
    });
    assert.deepEqual(bodies.map(body => body.action), ["start", "cancel-start"]);
    assert.equal(bodies[1].input, link); assert.equal(isJdStartRequestId(bodies[1].requestId), true);
    assert.equal(bodies[0].requestId, bodies[1].requestId);
    assert.equal(f.control.acquisitions, 0); assert.equal(f.control.stops, 0);
  } finally { globalThis.fetch = originalFetch; await f.router.stopBrowser("owned-only"); }
});

test("等待acquire期间取消仍按ID登记并释放迟到页，不依赖响应含sessionId", async () => {
  const originalFetch = globalThis.fetch;
  const gate = deferred(), cancelEntered = deferred();
  const f = fixture(gate);
  const bodies: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const reason = new DOMException("synthetic changed link", "AbortError");
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.action === "cancel-start") {
        assert.notEqual(init?.signal, controller.signal); assert.equal(init?.signal?.aborted, false);
        assert.equal(init?.keepalive, true); cancelEntered.resolve();
      }
      return dispatch(f.router, body, init?.signal ?? undefined);
    };
    const opening = startJdBrowserSession(link, controller.signal);
    const rejected = assert.rejects(opening, error => error === reason || (failureIs("service_unavailable")(error) && /尚未确认.*清理/.test((error as Error).message)));
    await f.enteredAcquire.promise; controller.abort(reason);
    await cancelEntered.promise;
    assert.equal(f.control.acquisitions, 1); assert.equal(f.control.navigations, 0);
    gate.resolve(); await rejected;
    // Observe the manager's own late-release continuation, without a closeAll
    // that could mask a missing cancellation cleanup path.
    await f.releasedPage.promise; await nextTurn();
    assert.equal(f.control.closed, 1); assert.equal(f.router.hasSession(), false);
    assert.deepEqual(bodies.map(body => body.action), ["start", "cancel-start"]);
    assert.equal(bodies[0].requestId, bodies[1].requestId); assert.equal(f.control.stops, 0);
  } finally { gate.resolve(); globalThis.fetch = originalFetch; await f.router.stopBrowser("owned-only"); }
});

test("同源两个独立客户端调用生成不同ID，后一次失败不会结束前一次活跃岗位", async () => {
  const originalFetch = globalThis.fetch;
  const f = fixture();
  const bodies: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return dispatch(f.router, body, init?.signal ?? undefined);
    };
    const active = await startJdBrowserSession(link, new AbortController().signal);
    await assert.rejects(startJdBrowserSession(link, new AbortController().signal), failureIs("service_unavailable"));
    assert.deepEqual(bodies.map(body => body.action), ["start", "start", "cancel-start"]);
    assert.notEqual(bodies[0].requestId, bodies[1].requestId);
    assert.equal(bodies[1].requestId, bodies[2].requestId);
    assert.equal(f.control.acquisitions, 1); assert.equal(f.control.navigations, 1);
    assert.equal(f.control.releases, 0); assert.equal(f.control.stops, 0);
    assert.equal(f.native.isActive("http://127.0.0.1:5173\n127.0.0.1:5173", active.sessionId), true);
    await closeJdBrowserSession(active.sessionId);
    assert.equal(f.control.closed, 1);
  } finally { globalThis.fetch = originalFetch; await f.router.stopBrowser("owned-only"); }
});

test("清理释放失败不伪报恢复，不关闭其他ID或自动全局stop", async () => {
  const originalFetch = globalThis.fetch;
  const f = fixture();
  const bodies: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const response = await dispatch(f.router, body, init?.signal ?? undefined);
      if (body.action === "start" && response.ok) {
        f.control.failRelease = true;
        response.json = async () => { throw new SyntaxError("synthetic response loss"); };
      }
      return response;
    };
    await assert.rejects(startJdBrowserSession(link, new AbortController().signal), error => failureIs("service_unavailable")(error) && /尚未确认.*清理/.test((error as Error).message));
    assert.deepEqual(bodies.map(body => body.action), ["start", "start", "cancel-start"]);
    assert.equal(f.control.acquisitions, 1); assert.equal(f.control.closed, 0); assert.equal(f.control.stops, 0);
    assert.equal(f.router.hasSession(), true, "failed release ownership must remain");
  } finally { f.control.failRelease = false; globalThis.fetch = originalFetch; await f.router.stopBrowser("owned-only"); }
});

test("middleware兼容旧start，但带ID不支持时明确失败且不降级或stop", async () => {
  const f = fixture();
  const backend: JobSessionBackend = { ...f.native };
  delete backend.startRequest; delete backend.cancelStart;
  try {
    for (const action of ["start", "cancel-start"]) {
      const response = await dispatch(backend, { action, input: link, requestId: createJdStartRequestId() });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).failure.code, "service_unavailable");
    }
    assert.equal(f.control.acquisitions, 0); assert.equal(f.control.stops, 0);
    for (const requestId of [null, "", "unscoped-id", 123, {}, []]) {
      for (const action of ["start", "cancel-start"]) {
        const response = await dispatch(backend, { action, input: link, requestId });
        assert.equal(response.status, 400);
      }
    }
    const legacy = await dispatch(backend, { action: "start", input: link });
    assert.equal(legacy.status, 200); assert.equal(f.control.acquisitions, 1);
    await f.native.close("http://127.0.0.1:5173\n127.0.0.1:5173", (await legacy.json()).sessionId);
  } finally { await f.router.stopBrowser("owned-only"); }
});

test("未确认的cancel响应和取消期间清理错误必须保留清理未确认文案", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const cleanup of [{ cancelled: true, closed: false }, { cancelled: true }, { closed: true }, { failure: { code: "browser_unavailable", stage: "service", message: "release failed" } }, "network-loss"]) {
      const controller = new AbortController();
      const bodies: Record<string, unknown>[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        if (body.action === "start") {
          controller.abort(new DOMException("user cancelled", "AbortError"));
          throw controller.signal.reason;
        }
        assert.equal(body.action, "cancel-start"); assert.equal(init?.keepalive, true);
        assert.notEqual(init?.signal, controller.signal); assert.equal(init?.signal?.aborted, false);
        if (cleanup === "network-loss") throw new TypeError("cancel response lost");
        return json(cleanup);
      };
      await assert.rejects(startJdBrowserSession(link, controller.signal), error => failureIs("service_unavailable")(error) && /本次打开已取消.*尚未确认.*清理/.test((error as Error).message));
      assert.deepEqual(bodies.map(body => body.action), ["start", "cancel-start"]);
      assert.equal(bodies[0].requestId, bodies[1].requestId);
    }
  } finally { globalThis.fetch = originalFetch; }
});
