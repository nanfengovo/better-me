import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "playwright-core";
import { createBrowserSessionManager, type BrowserSessionInfo } from "../server/jd-browser-session.ts";
import { createNativeLiepinSessions } from "../server/jd-native-liepin.ts";
import type { NativeJobPlatform, NativeLiepinPage } from "../server/jd-native-liepin-browser.ts";
import { createJobSessionRouter, type JobSessionBackend } from "../server/jd-session-router.ts";
import { browserSessionMiddleware } from "../server/jd-extractor.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

const inputs = { "51JOB": "https://jobs.51job.com/shanghai/166509900.html", "猎聘": "https://www.liepin.com/job/1984701079.shtml", "BOSS直聘": "https://www.zhipin.com/job_detail/fixture.html" } as const;
const ttl = 600_000;
const isFailure = (code: string) => (error: unknown) => error instanceof JdExtractionError && error.failure.code === code;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
type Extension = { extend(owner: string, id: string, signal?: AbortSignal): Promise<BrowserSessionInfo> };

function fixture(platform: keyof typeof inputs) {
  let clock = 1_700_000_000_000, serial = 0, releases = 0, acquisitions = 0, navigations = 0, captures = 0, activations = 0;
  let closed = false, releaseFails = false; let releaseWait: Promise<void> | undefined;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const setTimer = ((callback: () => void, ms: number) => { const id = ++serial; timers.set(id, { callback, ms }); return id as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  const clearTimer = (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer as unknown as number); };
  const getOperation = async () => ({ fetch, routeFor: () => ({ mode: "direct" as const, source: "extension fixture" }) });
  const release = async () => { releases++; if (releaseWait) await releaseWait; if (releaseFails) throw new Error("retained fixture page"); closed = true; };
  const snapshot = { html: "<html><body>请完成安全验证</body></html>", url: inputs[platform], title: "访问验证", gate: "verification_required" as const };
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => closed, url: () => inputs[platform], mainFrame: () => ({}),
    route: async () => undefined, routeWebSocket: async () => undefined,
    goto: async () => { navigations++; }, bringToFront: async () => { activations++; },
    evaluate: async () => { captures++; return snapshot; },
  });
  const nativePage: NativeLiepinPage = {
    get closed() { return closed; }, navigate: async () => { navigations++; },
    capture: async () => { captures++; return { state: "ready", identity: "same-document", snapshot }; },
    current: async () => true, focus: async () => { activations++; }, release,
    inspect: () => ({ resources: [], mainDocument: { state: "response", status: 200 }, truncated: false, blockedPopups: 0, blockedSockets: 0, scriptErrors: 0 }),
  };
  const manager = platform === "51JOB" ? createBrowserSessionManager({
    now: () => clock, setTimer, clearTimer, getOperation,
    acquire: async () => { acquisitions++; return { page: page as unknown as Page, context: new EventEmitter() as unknown as BrowserContext, release, releasePage: release }; },
    stopBrowser: async () => undefined,
  }) : createNativeLiepinSessions({
    platform: platform as NativeJobPlatform, now: () => clock, setTimer, clearTimer, getOperation,
    browser: { acquire: async () => { acquisitions++; return nativePage; }, stop: async () => undefined },
  });
  return { manager: manager as typeof manager & Extension, page, nativePage, timers,
    now: () => clock, advance: (ms: number) => { clock += ms; }, closePage: () => { closed = true; },
    failRelease: (value: boolean) => { releaseFails = value; },
    waitRelease: (value: Promise<void> | undefined) => { releaseWait = value; },
    counts: () => ({ releases, acquisitions, navigations, captures, activations }),
    expire: () => { const timer = [...timers.values()].find(item => item.ms >= ttl); assert.ok(timer); return timer.callback; },
  };
}

for (const platform of ["51JOB", "猎聘", "BOSS直聘"] as const) {
  test(`${platform} explicit extension keeps the same page alive beyond its original deadline and ignores a queued old timer`, async () => {
    const f = fixture(platform);
    try {
      const info = await f.manager.start("owner", inputs[platform]), oldTimer = f.expire(), before = f.counts();
      f.advance(540_000);
      const extended = await f.manager.extend("owner", info.sessionId);
      assert.deepEqual(extended, { ...info, expiresAt: new Date(f.now() + ttl).toISOString() });
      assert.deepEqual(f.counts(), before, "extending must not navigate, capture, focus, acquire or release");
      f.advance(60_000); oldTimer(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.manager.isActive("owner", info.sessionId), true); assert.deepEqual(f.counts(), before);
      f.advance(540_000); f.expire()(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.manager.isActive("owner", info.sessionId), false); assert.equal(f.counts().releases, 1);
      await assert.rejects(f.manager.extend("owner", info.sessionId), isFailure("browser_session_expired"));
    } finally { await f.manager.closeAll(); }
  });

  test(`${platform} extension rejects foreign, missing, expired, closed and logically ended pages`, async () => {
    const f = fixture(platform);
    try {
      const info = await f.manager.start("owner", inputs[platform]);
      await assert.rejects(f.manager.extend("other", info.sessionId), isFailure("browser_session_expired"));
      await assert.rejects(f.manager.extend("owner", "unknown"), isFailure("browser_session_expired"));
      const cancelled = new AbortController(); cancelled.abort(new Error("cancelled extension"));
      await assert.rejects(f.manager.extend("owner", info.sessionId, cancelled.signal), error => error === cancelled.signal.reason);
      assert.equal(f.manager.isActive("owner", info.sessionId), true);
      f.failRelease(true); await assert.rejects(f.manager.close("owner", info.sessionId));
      await assert.rejects(f.manager.extend("owner", info.sessionId), isFailure("browser_session_expired"));
    } finally { f.failRelease(false); await f.manager.closeAll(); }
    const closed = fixture(platform);
    try { const info = await closed.manager.start("owner", inputs[platform]); closed.closePage(); await assert.rejects(closed.manager.extend("owner", info.sessionId), isFailure("browser_session_expired")); }
    finally { await closed.manager.closeAll(); }
    const expired = fixture(platform);
    try { const info = await expired.manager.start("owner", inputs[platform]); expired.advance(ttl); await assert.rejects(expired.manager.extend("owner", info.sessionId), isFailure("browser_session_expired")); assert.equal(expired.manager.isActive("owner", info.sessionId), false); }
    finally { await expired.manager.closeAll(); }
  });

  test(`${platform} inspection and focus never renew; extension rejects busy work and never shortens a deadline after clock rollback`, async () => {
    const f = fixture(platform); const entered = deferred<void>(), pending = deferred<unknown>();
    try {
      const info = await f.manager.start("owner", inputs[platform]); f.advance(300_000);
      await f.manager.inspect("owner", info.sessionId); await f.manager.focus("owner", info.sessionId);
      f.advance(-100_000);
      const extended = await f.manager.extend("owner", info.sessionId);
      assert.equal(Date.parse(extended.expiresAt), f.now() + ttl);
      f.advance(-200_000);
      const same = await f.manager.extend("owner", info.sessionId); assert.equal(same.expiresAt, extended.expiresAt);
      if (platform === "51JOB") f.page.evaluate = async () => { entered.resolve(); return pending.promise; };
      else f.nativePage.capture = async () => { entered.resolve(); await pending.promise; return { state: "failed" }; };
      const inspecting = f.manager.inspect("owner", info.sessionId); await entered.promise;
      await assert.rejects(f.manager.extend("owner", info.sessionId), isFailure("browser_unavailable"));
      pending.resolve({ html: "", url: inputs[platform], title: "" }); await inspecting;
      f.advance(Date.parse(same.expiresAt) - f.now());
      await assert.rejects(f.manager.extend("owner", info.sessionId), isFailure("browser_session_expired"));
    } finally { pending.resolve(undefined); await f.manager.closeAll(); }
  });

  test(`${platform} read, inspect and focus leave expiry fixed unless the user explicitly extends`, async () => {
    const f = fixture(platform);
    try {
      const info = await f.manager.start("owner", inputs[platform]); f.advance(ttl - 1);
      await f.manager.inspect("owner", info.sessionId); await f.manager.focus("owner", info.sessionId);
      await assert.rejects(f.manager.read("owner", info.sessionId), isFailure("verification_required"));
      f.advance(1);
      await assert.rejects(f.manager.extend("owner", info.sessionId), isFailure("browser_session_expired"));
      assert.equal(f.manager.isActive("owner", info.sessionId), false);
    } finally { await f.manager.closeAll(); }
  });

  test(`${platform} explicit drain and stop retain their reservation and reject extension while page release is pending`, async () => {
    for (const mode of ["closeAll", "stopBrowser"] as const) {
      const f = fixture(platform), gate = deferred<void>();
      try {
        const info = await f.manager.start("owner", inputs[platform]); f.waitRelease(gate.promise);
        const stopping = f.manager[mode](); await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.manager.owns(info.sessionId), true);
        await assert.rejects(f.manager.extend("owner", info.sessionId), isFailure("browser_session_expired"));
        assert.equal(f.manager.isActive("owner", info.sessionId), false);
        gate.resolve(); await stopping; assert.equal(f.manager.owns(info.sessionId), false);
      } finally { gate.resolve(); await f.manager.closeAll(); }
    }
  });
}

test("router delegates extension and refreshes the same start-request receipt without launching again", async () => {
  const f = fixture("51JOB"), unused = fixture("猎聘");
  const router = createJobSessionRouter(f.manager, unused.manager, { requestOptions: { now: f.now } }) as ReturnType<typeof createJobSessionRouter> & Extension;
  const requestId = `${f.now().toString(36)}_00000000-1111-4222-8333-444444444444`;
  try {
    const info = await router.startRequest("owner", inputs["51JOB"], requestId);
    f.advance(540_000);
    const extended = await router.extend("owner", info.sessionId);
    f.advance(60_000);
    const recovered = await router.startRequest("owner", inputs["51JOB"], requestId);
    assert.deepEqual(recovered, extended); assert.notEqual(recovered.expiresAt, info.expiresAt);
    assert.equal(f.counts().acquisitions, 1); assert.equal(f.counts().navigations, 1); assert.equal(unused.counts().acquisitions, 0);
    await assert.rejects(router.extend("other", info.sessionId), isFailure("browser_session_expired"));
    assert.deepEqual(await router.startRequest("owner", inputs["51JOB"], requestId), extended);
  } finally { await router.closeAll(); }
});

test("an aborted extension response still refreshes the live start receipt after the backend committed its deadline", async () => {
  const f = fixture("51JOB"), unused = fixture("猎聘"), cancelled = new AbortController();
  const reason = new Error("lost extension response");
  const backend: JobSessionBackend = { ...f.manager, extend: async (...args) => {
    const info = await f.manager.extend(...args); cancelled.abort(reason); return info;
  } };
  const router = createJobSessionRouter(backend, unused.manager, { requestOptions: { now: f.now } });
  const requestId = `${f.now().toString(36)}_00000000-1111-4222-8333-444444444444`;
  try {
    const original = await router.startRequest("owner", inputs["51JOB"], requestId); f.advance(ttl - 60_000);
    await assert.rejects(router.extend("owner", original.sessionId, cancelled.signal), error => error === reason);
    assert.equal(f.manager.isActive("owner", original.sessionId), true);
    const beforeDeadline = await router.startRequest("owner", inputs["51JOB"], requestId);
    assert.equal(Date.parse(beforeDeadline.expiresAt), f.now() + ttl);
    f.advance(60_000);
    assert.deepEqual(await router.startRequest("owner", inputs["51JOB"], requestId), beforeDeadline);
    assert.equal(f.counts().acquisitions, 1); assert.equal(f.counts().navigations, 1); assert.equal(f.counts().releases, 0);
  } finally { await router.closeAll(); }
});

for (const mode of ["close", "cancel", "closeAll", "stopBrowser"] as const) {
  test(`late extension after ${mode} cannot revive a page or its cached start receipt`, async () => {
    const f = fixture("51JOB"), unused = fixture("猎聘"), gate = deferred<void>(), entered = deferred<void>();
    const backend: JobSessionBackend = { ...f.manager, extend: async (...args) => {
      const info = await f.manager.extend(...args); entered.resolve(); await gate.promise; return info;
    } };
    const router = createJobSessionRouter(backend, unused.manager, { requestOptions: { now: f.now } });
    const requestId = `${f.now().toString(36)}_00000000-1111-4222-8333-444444444444`;
    try {
      const info = await router.startRequest("owner", inputs["51JOB"], requestId); f.advance(1000);
      const pending = router.extend("owner", info.sessionId); const rejected = assert.rejects(pending, isFailure("browser_session_expired"));
      await entered.promise;
      if (mode === "close") await router.close("owner", info.sessionId);
      else if (mode === "cancel") assert.deepEqual(await router.cancelStart("owner", inputs["51JOB"], requestId), { cancelled: true, closed: true });
      else await router[mode]();
      gate.resolve(); await rejected;
      await assert.rejects(router.startRequest("owner", inputs["51JOB"], requestId), isFailure("browser_session_expired"));
      assert.equal(f.counts().acquisitions, 1); assert.equal(f.counts().navigations, 1);
    } finally { gate.resolve(); await router.closeAll(); }
  });
}

test("unsupported extension has an explicit service failure and never falls back to reopening", async () => {
  const f = fixture("51JOB"), unused = fixture("猎聘");
  const backend: JobSessionBackend = { ...f.manager, extend: undefined };
  const router = createJobSessionRouter(backend, unused.manager) as ReturnType<typeof createJobSessionRouter> & Extension;
  try { const info = await router.start("owner", inputs["51JOB"]); await assert.rejects(router.extend("owner", info.sessionId), isFailure("service_unavailable")); assert.equal(f.counts().acquisitions, 1); }
  finally { await router.closeAll(); }
});

test("same-origin HTTP extend returns the same session metadata and preserves owner and action validation", async () => {
  const f = fixture("51JOB");
  const server = createServer((request, response) => { void browserSessionMiddleware(request, response, f.manager); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, requestOrigin = origin) => fetch(`${origin}/api/jd/browser-session`, { method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const started = await post({ action: "start", input: inputs["51JOB"] }); assert.equal(started.status, 200);
    const info = await started.json() as BrowserSessionInfo; f.advance(300_000); const before = f.counts();
    const response = await post({ action: "extend", sessionId: info.sessionId, target: "https://evil.test", expiresAt: "2099-01-01T00:00:00Z" });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ...info, expiresAt: new Date(f.now() + ttl).toISOString() }); assert.deepEqual(f.counts(), before);
    assert.equal((await post({ action: "extend", sessionId: "x" })).status, 400);
    assert.equal((await post({ action: "extend", sessionId: info.sessionId }, "https://evil.test")).status, 403);
    await post({ action: "close", sessionId: info.sessionId });
    const ended = await post({ action: "extend", sessionId: info.sessionId }); assert.equal(ended.status, 422); assert.equal((await ended.json() as { failure: { code: string } }).failure.code, "browser_session_expired");
  } finally { await f.manager.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("HTTP extend reports unsupported legacy service explicitly without replacing its page", async () => {
  const f = fixture("51JOB"); const backend: JobSessionBackend = { ...f.manager, extend: undefined };
  const server = createServer((request, response) => { void browserSessionMiddleware(request, response, backend); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(`${origin}/api/jd/browser-session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const info = await (await post({ action: "start", input: inputs["51JOB"] })).json() as BrowserSessionInfo;
    const before = f.counts(); const response = await post({ action: "extend", sessionId: info.sessionId });
    assert.equal(response.status, 422); assert.equal((await response.json() as { failure: { code: string } }).failure.code, "service_unavailable"); assert.deepEqual(f.counts(), before);
  } finally { await f.manager.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
