import assert from "node:assert/strict";
import test from "node:test";
import { createJobSessionRouter, matchesPlannedJobSearchUrl, type JobSessionBackend } from "../server/jd-session-router.ts";
import { buildPlatformSearchRequest, type PlatformSearchInput } from "@better-me/source-adapters/browser-contracts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserContext, Page } from "playwright-core";
import { browserSessionMiddleware, jdExtractionMiddleware } from "../server/jd-extractor.ts";
import { createBrowserSessionManager } from "../server/jd-browser-session.ts";
import { createNativeLiepinSessions } from "../server/jd-native-liepin.ts";
import type { NativeJobPlatform, NativeLiepinPage } from "../server/jd-native-liepin-browser.ts";

const original = "https://m.liepin.com/job/1984701079.shtml?mscid=wx_h5_001";
const other = "https://msearch.51job.com/jobs/all/166761768.html";
const bossOriginal = "https://www.zhipin.com/job_detail/bossFixture.html";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
function fixture(name: string) {
  const sessions = new Map<string, string>();
  const calls: string[] = [];
  const backend: JobSessionBackend = {
    async start(owner, input) { calls.push("start"); sessions.set(name, owner); return { sessionId: name, platform: name === "native" ? "猎聘" : "51JOB", url: input, expiresAt: new Date().toISOString() }; },
    async read(owner, id) { calls.push("read"); assert.equal(sessions.get(id), owner); return { text: name, method: "fixture", provenance: { kind: "link", platform: "猎聘", url: original, observedAt: new Date().toISOString() } }; },
    async inspect(owner, id) { calls.push("inspect"); assert.equal(sessions.get(id), owner); throw new Error("inspection marker"); },
    async focus(owner, id) { calls.push("focus"); assert.equal(sessions.get(id), owner); return { activationRequested: true }; },
    async close(owner, id) { calls.push("close"); if (sessions.get(id) === owner) sessions.delete(id); return { closed: true }; },
    async closeAll() { calls.push("closeAll"); sessions.clear(); },
    async stopBrowser() { calls.push("stopBrowser"); sessions.clear(); },
    owns: (id) => sessions.has(id),
    hasSession: () => sessions.size > 0,
  };
  return { backend, sessions, calls };
}
const unavailable = (error: unknown) => error instanceof JdExtractionError && error.failure.code === "browser_unavailable";

function searchRouterFixture() {
  const standard = fixture("standard"), native = fixture("native"), boss = fixture("boss"), job51 = fixture("job51");
  for (const f of [standard, native, boss, job51]) {
    f.backend.startSearch = async (owner, input, signal) => {
      signal?.throwIfAborted();
      const planned = buildPlatformSearchRequest(input);
      const info = await f.backend.start(owner, planned.url, signal);
      return { ...info, platform: planned.platform };
    };
    f.backend.readSearch = async (owner, id) => {
      f.calls.push("readSearch"); assert.equal(f.sessions.get(id), owner);
      return { status: "empty", platform: "LinkedIn", url: "https://www.linkedin.com/jobs/search", cards: [], partial: false, warnings: [] };
    };
  }
  const router = createJobSessionRouter(standard.backend, native.backend, { nativeBoss: boss.backend, native51Job: job51.backend });
  return { standard, native, boss, job51, router };
}

test("platform searches route domestic pages to native engines independently of detail flags and keep one shared lease", async () => {
  const f = searchRouterFixture();
  for (const [provider, engine] of [["liepin", f.native], ["boss", f.boss], ["51job", f.job51], ["linkedin", f.standard]] as const) {
    const input: PlatformSearchInput = { provider, keyword: "software" };
    const info = await f.router.startSearch("owner", input);
    assert.equal(engine.sessions.get(info.sessionId), "owner"); assert.equal(f.router.hasSession(), true);
    await assert.rejects(f.router.startSearch("other", { provider: "linkedin", keyword: "other" }), unavailable);
    await assert.rejects(f.router.start("owner", original), unavailable);
    assert.throws(() => f.router.configure({ useNativeLiepin: true }), unavailable);
    await assert.rejects(f.router.readSearch("other", info.sessionId));
    await f.router.readSearch("owner", info.sessionId); await f.router.focus("owner", info.sessionId);
    await f.router.close("other", info.sessionId); assert.equal(f.router.hasSession(), true);
    await f.router.close("owner", info.sessionId); assert.equal(f.router.hasSession(), false);
    assert.equal(engine.calls.includes("stopBrowser"), false);
  }
  const detail = await f.router.start("owner", original);
  await assert.rejects(f.router.startSearch("owner", { provider: "liepin", keyword: "software" }), unavailable);
  await f.router.close("owner", detail.sessionId);
});

test("search start reserves shared recovery and closeAll cancels it before any browser acquisition", async () => {
  const f = searchRouterFixture(), gate = deferred();
  f.native.backend.recoverExited = async () => { await gate.promise; return false; };
  const pending = f.router.startSearch("owner", { provider: "boss", keyword: "software" });
  const rejected = assert.rejects(pending, unavailable);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.router.hasSession(), true);
  await assert.rejects(f.router.start("owner", other), unavailable);
  await assert.rejects(f.router.startSearch("owner", { provider: "linkedin", keyword: "software" }), unavailable);
  const closing = f.router.closeAll(); gate.resolve(); await rejected; await closing;
  assert.equal(f.router.hasSession(), false);
  for (const engine of [f.standard, f.native, f.boss, f.job51]) assert.equal(engine.calls.includes("start"), false);
});

test("late uncooperative search launch stays reserved and releases its own receipt after cancellation", async () => {
  const f = searchRouterFixture(), gate = deferred(), started = deferred();
  const open = f.boss.backend.startSearch!; let operationSignal: AbortSignal | undefined;
  f.boss.backend.startSearch = async (owner, input, signal) => { operationSignal = signal; started.resolve(); await gate.promise; return open(owner, input); };
  const pending = f.router.startSearch("owner", { provider: "boss", keyword: "software" });
  const rejected = assert.rejects(pending, unavailable); await started.promise;
  const closing = f.router.closeAll();
  assert.equal(operationSignal?.aborted, true);
  await assert.rejects(f.router.start("owner", other), unavailable);
  gate.resolve(); await rejected; await closing;
  assert.equal(f.boss.sessions.size, 0); assert.equal(f.router.hasSession(), false);
  assert.ok(f.boss.calls.includes("close"));
});

test("search planner rejects arbitrary URLs and a missing search backend without touching browser engines", async () => {
  const f = searchRouterFixture();
  for (const input of [{ provider: "boss", keyword: "software", url: "https://evil.test" }, { provider: "unknown", keyword: "software" }]) {
    await assert.rejects(f.router.startSearch("owner", input as PlatformSearchInput), error => error instanceof JdExtractionError && error.failure.code === "invalid_link");
  }
  const missing = createJobSessionRouter(f.standard.backend, f.native.backend);
  await assert.rejects(missing.startSearch("owner", { provider: "boss", keyword: "software" }), error => error instanceof JdExtractionError && error.failure.code === "service_unavailable");
  for (const engine of [f.standard, f.native, f.boss, f.job51]) assert.deepEqual(engine.calls, []);
});

test("search identity keeps every planned condition, rejects duplicate overrides and permits explicit next-page parameters", () => {
  for (const provider of ["51job", "boss", "liepin", "linkedin"] as const) {
    const planned = buildPlatformSearchRequest({ provider, keyword: "软件", regionId: "cn-beijing" }).url;
    const current = new URL(planned); current.searchParams.set("page", "2");
    assert.equal(matchesPlannedJobSearchUrl(current.href, planned), true);
    const condition = [...current.searchParams.keys()].find(key => key !== "page")!;
    current.searchParams.append(condition, "other");
    assert.equal(matchesPlannedJobSearchUrl(current.href, planned), false);
    assert.equal(matchesPlannedJobSearchUrl(planned.replace("https:", "http:"), planned), false);
    assert.equal(matchesPlannedJobSearchUrl("https://evil.test/", planned), false);
  }
});

function endedRecoveryFixture() {
  const controls = new Map<string, { fail: boolean; releases: number; acquisitions: number; stops: number }>();
  const native = (platform: NativeJobPlatform) => {
    const control = { fail: false, releases: 0, acquisitions: 0, stops: 0 }; controls.set(platform, control);
    const page: NativeLiepinPage = {
      closed: false, navigate: async () => undefined,
      capture: async () => { throw new Error("no capture expected"); }, current: async () => false,
      inspect: () => ({ resources: [], mainDocument: { state: "unknown" }, truncated: false, blockedPopups: 0, blockedSockets: 0, scriptErrors: 0 }),
      focus: async () => undefined,
      release: async () => { control.releases++; if (control.fail) throw new Error("fixture release failure"); },
    };
    return createNativeLiepinSessions({ platform,
      browser: { acquire: async () => { control.acquisitions++; return page; }, stop: async () => { control.stops++; } },
      getOperation: async () => ({ fetch, routeFor: () => ({ mode: "direct", source: "fixture" }) }),
    });
  };
  const control = { fail: false, releases: 0, acquisitions: 0, stops: 0 }; controls.set("51JOB", control);
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false, url: () => other, mainFrame: () => ({}),
    route: async () => undefined, routeWebSocket: async () => undefined,
    goto: async () => undefined, bringToFront: async () => undefined,
  }) as unknown as Page;
  const release = async () => { control.releases++; if (control.fail) throw new Error("fixture release failure"); };
  const standard = createBrowserSessionManager({
    acquire: async () => { control.acquisitions++; return { page, context: new EventEmitter() as unknown as BrowserContext, release, releasePage: release }; },
    getOperation: async () => ({ fetch, routeFor: () => ({ mode: "direct", source: "fixture" }) }),
    stopBrowser: async () => { control.stops++; },
  });
  const liepin = native("猎聘"), boss = native("BOSS直聘");
  const router = createJobSessionRouter(standard, liepin, { useNativeLiepin: true, useNativeBoss: true, nativeBoss: boss });
  return { router, controls, engines: { standard, liepin, boss } };
}

for (const [platform, input, next] of [["51JOB", other, original], ["猎聘", original, bossOriginal], ["BOSS直聘", bossOriginal, other]] as const) {
  test(`an explicit next start recovers the same owner's ended ${platform} page without its old ID or stopping a browser`, async () => {
    const f = endedRecoveryFixture(); const control = f.controls.get(platform)!;
    try {
      const old = await f.router.start("owner", input);
      await assert.rejects(f.router.start("owner", next), unavailable);
      assert.equal(control.releases, 0, "an active lease is never implicitly closed");
      control.fail = true;
      await assert.rejects(f.router.close("owner", old.sessionId));
      assert.equal(f.router.owns(old.sessionId), true);
      await assert.rejects(f.router.start("different-owner", next), unavailable);
      assert.equal(control.releases, 1, "another owner cannot retry the ended page");
      await assert.rejects(f.router.start("owner", next));
      assert.equal(control.releases, 2); assert.equal(f.router.owns(old.sessionId), true);
      assert.equal([...f.controls.values()].reduce((total, value) => total + value.acquisitions, 0), 1);
      control.fail = false;
      const opened = await f.router.start("owner", next);
      assert.equal(f.router.owns(old.sessionId), false);
      assert.equal(opened.url, next); assert.notEqual(opened.sessionId, old.sessionId);
      assert.equal(control.releases, 3);
      assert.ok([...f.controls.values()].every(value => value.stops === 0));
      await f.router.close("owner", opened.sessionId);
    } finally { for (const value of f.controls.values()) value.fail = false; await f.router.closeAll(); }
  });
}

test("ended-page recovery waits for every engine after one failure and retains the shared start reservation", async () => {
  const standard = fixture("standard"), native = fixture("native"), boss = fixture("boss"), gate = deferred();
  const failure = new Error("fixture ended release failed"); let finished = false;
  standard.backend.retryEnded = async () => { standard.calls.push("retryEnded"); throw failure; };
  native.backend.retryEnded = async () => { native.calls.push("retryEnded"); await gate.promise; };
  boss.backend.retryEnded = async () => { boss.calls.push("retryEnded"); };
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true, useNativeBoss: true, nativeBoss: boss.backend });
  const pending = router.start("owner", original).finally(() => { finished = true; });
  const rejected = assert.rejects(pending, error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.equal(router.hasSession(), true);
  await assert.rejects(router.start("owner", other), unavailable);
  assert.throws(() => router.configure({ useNativeLiepin: false }), unavailable);
  assert.deepEqual(boss.calls, ["retryEnded"]);
  gate.resolve(); await rejected; assert.equal(router.hasSession(), false);
  assert.equal(native.calls.includes("start"), false);
});

test("cancellation or closeAll while ended-page recovery waits prevents new navigation without releasing its reservation early", async () => {
  for (const mode of ["abort", "closeAll"] as const) {
    const standard = fixture("standard"), native = fixture("native"), gate = deferred();
    const controller = new AbortController(), cancelled = new Error("fixture cancelled recovery");
    native.backend.retryEnded = async () => { native.calls.push("retryEnded"); await gate.promise; };
    const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
    const pending = router.start("owner", original, controller.signal);
    const rejected = assert.rejects(pending, mode === "abort" ? error => error === cancelled : unavailable);
    await new Promise(resolve => setImmediate(resolve));
    let closing: Promise<void> | undefined;
    if (mode === "abort") controller.abort(cancelled); else closing = router.closeAll();
    await assert.rejects(router.start("owner", other), unavailable);
    assert.equal(router.hasSession(), true);
    gate.resolve(); await rejected; await closing;
    assert.equal(router.hasSession(), false); assert.equal(native.calls.includes("start"), false);
    assert.equal(standard.calls.includes("stopBrowser") || native.calls.includes("stopBrowser"), false);
  }
});

test("confirmed exited native browser can release its stale slot before a different platform starts", async () => {
  const standard = fixture("standard"), native = fixture("native");
  native.sessions.set("native", "old-owner");
  let confirmed = false;
  native.backend.recoverExited = async () => { if (!confirmed) return false; native.sessions.clear(); return true; };
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
  await assert.rejects(router.start("owner", other), unavailable);
  assert.equal(native.sessions.size, 1); assert.deepEqual(standard.calls, []);
  confirmed = true;
  assert.equal((await router.start("owner", other)).sessionId, "standard");
  assert.equal(native.sessions.size, 0); await router.closeAll();
});

test("exit proof runs under the shared starting reservation and closeAll cancels it before navigation", async () => {
  const standard = fixture("standard"), native = fixture("native"), gate = deferred();
  native.backend.recoverExited = async () => { await gate.promise; return false; };
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
  const pending = router.start("owner", original);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(router.hasSession(), true);
  await assert.rejects(router.start("other", other), unavailable);
  assert.throws(() => router.configure({ useNativeLiepin: false }), unavailable);
  const rejected = assert.rejects(pending, unavailable); const closing = router.closeAll();
  gate.resolve(); await rejected; await closing;
  assert.equal(router.hasSession(), false); assert.equal(native.calls.includes("start"), false);
  assert.equal(standard.calls.includes("start"), false);
});

test("failed exit proof waits for every engine before releasing the shared reservation", async () => {
  const standard = fixture("standard"), native = fixture("native"), gate = deferred();
  standard.backend.recoverExited = async () => { throw new Error("fixture proof failed"); };
  native.backend.recoverExited = async () => { await gate.promise; return false; };
  const router = createJobSessionRouter(standard.backend, native.backend);
  const pending = router.start("owner", other); const rejected = assert.rejects(pending, /fixture proof failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(router.hasSession(), true); await assert.rejects(router.start("other", original), unavailable);
  gate.resolve(); await rejected; assert.equal(router.hasSession(), false);
  assert.equal(standard.calls.includes("start"), false);
});

test("native and standard entry imports initialize in fresh processes without circular singleton access", async () => {
  await Promise.all(["jd-native-liepin.ts", "jd-native-liepin-browser.ts", "jd-browser-session.ts", "jd-extractor.ts"].map(async (file) => {
    const url = new URL(`../server/${file}`, import.meta.url).href;
    const script = `await import(${JSON.stringify(url)}); process.stdout.write('module-ready');`;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { timeout: 10_000, windowsHide: true });
    assert.equal(result.stdout, "module-ready", file);
    assert.equal(result.stderr, "", file);
  }));
});

test("routes the original Liepin session and keeps owner checks at the owning engine", async () => {
  const standard = fixture("standard"), native = fixture("native");
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
  const session = await router.start("owner", original);
  assert.equal(session.sessionId, "native");
  await assert.rejects(router.start("owner", other), unavailable);
  assert.equal((await router.read("owner", session.sessionId)).text, "native");
  await assert.rejects(router.focus("wrong-owner", session.sessionId));
  assert.equal(native.sessions.size, 1);
  await router.focus("owner", session.sessionId);
  await assert.rejects(router.inspect("owner", session.sessionId), /inspection marker/);
  await router.close("wrong-owner", session.sessionId);
  assert.equal(router.hasSession(), true);
  await router.close("owner", session.sessionId);
  await router.start("owner", other);
  assert.deepEqual(standard.calls, ["start"]);
});

test("native BOSS has its own engine and owner while all three engines share one active job", async () => {
  const standard = fixture("standard"), native = fixture("native"), boss = fixture("boss");
  const router = createJobSessionRouter(standard.backend, native.backend, { nativeBoss: boss.backend, useNativeBoss: true, useNativeLiepin: true });
  const session = await router.start("owner", bossOriginal);
  assert.equal(session.sessionId, "boss");
  assert.equal(router.owns("boss"), true);
  assert.equal((await router.read("owner", "boss")).text, "boss");
  await assert.rejects(router.read("wrong-owner", "boss"));
  await assert.rejects(router.start("other-owner", original), unavailable);
  await assert.rejects(router.start("owner", other), unavailable);
  assert.throws(() => router.configure({ useNativeLiepin: true, useNativeBoss: false }), unavailable);
  await router.close("wrong-owner", "boss");
  assert.equal(router.hasSession(), true);
  await router.focus("owner", "boss");
  await assert.rejects(router.inspect("owner", "boss"), /inspection marker/);
  await router.close("owner", "boss");
  assert.equal(boss.calls.includes("stopBrowser"), false);
  assert.deepEqual(standard.calls, []);
  assert.deepEqual(native.calls, []);
  assert.equal((await router.start("owner", original)).sessionId, "native");
  await router.closeAll();
});

test("BOSS native flag is explicit, cannot select a missing backend and preserves legacy configuration", async () => {
  const standard = fixture("standard"), native = fixture("native"), boss = fixture("boss");
  const router = createJobSessionRouter(standard.backend, native.backend, { nativeBoss: boss.backend });
  assert.equal((await router.start("owner", bossOriginal)).sessionId, "standard");
  assert.deepEqual(boss.calls, []);
  await router.close("owner", "standard");
  router.configure({ useNativeLiepin: true, useNativeBoss: true });
  router.configure({ useNativeLiepin: false });
  assert.equal((await router.readOnce("owner", bossOriginal)).text, "boss");
  assert.equal(router.hasSession(), false);
  assert.equal(boss.calls.includes("stopBrowser"), false);
  const missing = createJobSessionRouter(standard.backend, native.backend);
  assert.throws(() => missing.configure({ useNativeLiepin: false, useNativeBoss: true }), unavailable);
  const invalid = createJobSessionRouter(standard.backend, native.backend, { useNativeBoss: true });
  await assert.rejects(invalid.start("owner", bossOriginal), unavailable);
});

test("closing a late BOSS launch releases its own page and drains every engine", async () => {
  const standard = fixture("standard"), native = fixture("native"), boss = fixture("boss"), gate = deferred();
  const start = boss.backend.start;
  boss.backend.start = async (...args) => { await gate.promise; return start(...args); };
  const router = createJobSessionRouter(standard.backend, native.backend, { nativeBoss: boss.backend, useNativeBoss: true });
  const pending = router.start("owner", bossOriginal);
  const rejected = assert.rejects(pending, unavailable);
  await new Promise(resolve => setImmediate(resolve));
  const closing = router.closeAll();
  await assert.rejects(router.start("owner", original), unavailable);
  gate.resolve();
  await Promise.all([rejected, closing]);
  assert.equal(router.hasSession(), false);
  assert.equal(boss.sessions.size, 0);
  assert.ok(boss.calls.includes("close"));
  for (const backend of [standard, native, boss]) assert.ok(backend.calls.includes("closeAll"));
});

test("stop attempts all three browsers despite page and browser errors, retaining retry behavior", async () => {
  const standard = fixture("standard"), native = fixture("native"), boss = fixture("boss");
  const router = createJobSessionRouter(standard.backend, native.backend, { nativeBoss: boss.backend, useNativeBoss: true });
  standard.backend.closeAll = async () => { standard.calls.push("closeAll"); throw new Error("page failed"); };
  let fail = true;
  native.backend.stopBrowser = async () => { native.calls.push("stopBrowser"); if (fail) throw new Error("browser failed"); };
  await assert.rejects(router.stopBrowser(), /browser failed/);
  for (const backend of [standard, native, boss]) assert.equal(backend.calls.filter(call => call === "stopBrowser").length, 1);
  fail = false;
  await router.stopBrowser();
  for (const backend of [standard, native, boss]) assert.equal(backend.calls.filter(call => call === "stopBrowser").length, 2);
});

test("reserves one launch across both engines until a late start settles", async () => {
  const standard = fixture("standard"), native = fixture("native"), gate = deferred();
  const start = native.backend.start;
  native.backend.start = async (...args) => { await gate.promise; return start(...args); };
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
  const pending = router.start("owner", original);
  assert.equal(router.hasSession(), true);
  await assert.rejects(router.start("owner", other), unavailable);
  assert.equal(standard.calls.length, 0);
  gate.resolve(); await pending;
  await router.closeAll();
  assert.equal(router.hasSession(), false);
});

test("drains both engines even when one close fails and blocks a competing start", async () => {
  const standard = fixture("standard"), native = fixture("native"), gate = deferred();
  standard.backend.closeAll = async () => { standard.calls.push("closeAll"); await gate.promise; throw new Error("close failed"); };
  const router = createJobSessionRouter(standard.backend, native.backend);
  const closing = router.closeAll();
  assert.equal(router.closeAll(), closing);
  await assert.rejects(router.start("owner", original), unavailable);
  assert.deepEqual(native.calls, ["closeAll"]);
  const rejected = assert.rejects(closing, /close failed/); gate.resolve(); await rejected;
  assert.equal(router.hasSession(), false);
});

test("rejects canceled or invalid starts without touching either engine", async () => {
  const standard = fixture("standard"), native = fixture("native");
  const router = createJobSessionRouter(standard.backend, native.backend);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(router.start("owner", original, controller.signal), /cancelled/);
  await assert.rejects(router.start("owner", "https://example.com/job"), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "invalid_link");
  assert.equal(standard.calls.length + native.calls.length, 0);
  assert.equal(router.hasSession(), false);
});

test("native routing stays disabled by default and switching cannot change an owned session", async () => {
  const standard = fixture("standard"), native = fixture("native");
  const router = createJobSessionRouter(standard.backend, native.backend);
  await router.start("owner", original);
  assert.deepEqual(native.calls, []);
  assert.throws(() => router.configure({ useNativeLiepin: true }), unavailable);
  await router.close("owner", "standard");
  router.configure({ useNativeLiepin: true });
  await router.start("owner", original);
  assert.equal((await router.read("owner", "native")).text, "native");
  await router.closeAll();
  for (const input of [other, "https://www.zhipin.com/job_detail/fixture.html", "https://www.linkedin.com/jobs/view/123456/"]) {
    await router.start("owner", input);
    assert.equal(standard.sessions.has("standard"), true);
    await router.close("owner", "standard");
  }
  assert.deepEqual(native.calls, ["start", "read", "closeAll"]);
});

test("closing during an uncooperative launch waits for and releases its late page", async () => {
  const standard = fixture("standard"), native = fixture("native"), gate = deferred();
  const start = native.backend.start;
  let launchSignal: AbortSignal | undefined;
  native.backend.start = async (owner, input, signal) => { launchSignal = signal; await gate.promise; return start(owner, input, signal); };
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
  const pending = router.start("owner", original);
  const rejected = assert.rejects(pending, unavailable);
  await new Promise((resolve) => setImmediate(resolve));
  let finished = false;
  const closing = router.closeAll().then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launchSignal?.aborted, true);
  assert.equal(finished, false);
  await assert.rejects(router.start("other-owner", other), unavailable);
  gate.resolve();
  await Promise.all([rejected, closing]);
  assert.equal(native.sessions.size, 0);
  assert.equal(router.hasSession(), false);
  assert.ok(native.calls.includes("close"));
});

test("ordinary closeAll releases only job pages, stop drains both browsers despite one failure and can retry", async () => {
  const standard = fixture("standard"), native = fixture("native"), gate = deferred();
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
  await router.start("owner", original);
  await router.closeAll();
  assert.equal(standard.calls.includes("stopBrowser") || native.calls.includes("stopBrowser"), false);
  native.backend.closeAll = async () => { native.calls.push("closeAll"); throw new Error("page close failed"); };
  let failStop = true;
  standard.backend.stopBrowser = async () => { standard.calls.push("stopBrowser"); await gate.promise; if (failStop) throw new Error("browser close failed"); };
  const stopping = router.stopBrowser();
  assert.equal(router.stopBrowser(), stopping);
  const rejected = assert.rejects(stopping, /browser close failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(native.calls.includes("stopBrowser"));
  await assert.rejects(router.start("owner", other), unavailable);
  gate.resolve(); await rejected;
  failStop = false;
  await router.stopBrowser();
  assert.equal(standard.calls.filter((call) => call === "stopBrowser").length, 2);
  assert.equal(native.calls.filter((call) => call === "stopBrowser").length, 2);
});

test("one-shot browser reads use the shared reservation and close only their owned page on success or failure", async () => {
  const standard = fixture("standard"), native = fixture("native");
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
  await router.start("owner", original);
  await assert.rejects(router.readOnce("other-owner", other), unavailable);
  assert.equal(native.sessions.get("native"), "owner");
  await router.close("owner", "native");
  assert.equal((await router.readOnce("legacy-owner", original)).text, "native");
  assert.equal(router.hasSession(), false);
  native.backend.read = async () => { throw new Error("verification fixture"); };
  await assert.rejects(router.readOnce("legacy-owner", original), /verification fixture/);
  assert.equal(native.sessions.size, 0);
  assert.equal(native.calls.includes("stopBrowser"), false);
});

test("legacy mode=browser HTTP requests cannot bypass an active session or stop the other owner's page", async () => {
  const standard = fixture("standard"), native = fixture("native");
  const router = createJobSessionRouter(standard.backend, native.backend, { useNativeLiepin: true });
  const server = createServer((request, response) => {
    if (request.url === "/api/jd/browser-session") void browserSessionMiddleware(request, response, router);
    else void jdExtractionMiddleware(request, response, () => { response.writeHead(404).end(); }, router);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (endpoint: string, value: unknown, requestOrigin = origin) => fetch(`${origin}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin }, body: JSON.stringify(value) });
  try {
    assert.equal((await post("/api/jd/browser-session", { action: "start", input: original })).status, 200);
    const existingOwner = native.sessions.get("native");
    const rejected = await post("/api/jd/extract", { input: other, mode: "browser" });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).failure.code, "browser_unavailable");
    assert.equal(native.sessions.get("native"), existingOwner);
    assert.deepEqual(standard.calls, []);
    assert.equal((await post("/api/jd/extract", { input: other, mode: "browser" }, "https://evil.test")).status, 403);
    await router.close(existingOwner!, "native");
    const read = await post("/api/jd/extract", { input: original, mode: "browser" });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).text, "native");
    assert.equal(router.hasSession(), false);
    assert.equal((await post("/api/jd/browser-session", { action: "stop-browser" })).status, 200);
    assert.ok(standard.calls.includes("stopBrowser") && native.calls.includes("stopBrowser"));
  } finally {
    await router.stopBrowser();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the actual standard manager still stops its browser after failed page release and retains failed shutdown for retry", async () => {
  let stopped = false;
  let failStop = true;
  let releases = 0;
  let stops = 0;
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => stopped, url: () => other, mainFrame: () => ({}),
    route: async () => undefined, routeWebSocket: async () => undefined,
    goto: async () => undefined, bringToFront: async () => undefined,
  }) as unknown as Page;
  const release = async () => { releases += 1; if (!stopped) throw new Error("page close failed"); };
  const manager = createBrowserSessionManager({
    acquire: async () => ({ page, context: new EventEmitter() as unknown as BrowserContext, release, releasePage: release }),
    getOperation: async () => ({ fetch: async () => { throw new Error("no network expected"); }, routeFor: () => ({ mode: "direct", source: "fixture" }) }),
    stopBrowser: async () => { stops += 1; if (failStop) throw new Error("browser close failed"); stopped = true; },
  });
  const info = await manager.start("owner", other);
  await assert.rejects(manager.close("owner", info.sessionId), unavailable);
  assert.equal(manager.owns(info.sessionId), true);
  await assert.rejects(manager.stopBrowser(), /browser close failed/);
  assert.equal(stops, 1);
  assert.equal(manager.hasSession(), true);
  failStop = false;
  await manager.stopBrowser();
  assert.equal(stops, 2);
  assert.ok(releases >= 3);
  assert.equal(manager.owns(info.sessionId), false);
  assert.equal(manager.hasSession(), false);
});

test("the compatibility stop callback runs after a failed session drain", async () => {
  const standard = fixture("standard");
  const calls: string[] = [];
  standard.backend.closeAll = async () => { calls.push("pages"); throw new Error("page close failed"); };
  const server = createServer((request, response) => {
    void browserSessionMiddleware(request, response, standard.backend, async () => { calls.push("browser"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${origin}/api/jd/browser-session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ action: "stop-browser" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["pages", "browser"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
