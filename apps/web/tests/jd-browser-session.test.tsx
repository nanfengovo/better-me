import assert from "node:assert/strict";
import { buildPlatformSearchRequest } from "@better-me/source-adapters/browser-contracts";
import { VISIBLE_JOB_SEARCH_SNAPSHOT } from "../server/jd-search-capture.ts";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Browser, BrowserContext, Frame, LaunchOptions, Page, Request, Response, Route } from "playwright-core";
import { createBrowserSessionManager, type BrowserSessionInspection, type BrowserSessionOptions } from "../server/jd-browser-session.ts";
import { browserSessionMiddleware } from "../server/jd-extractor.ts";
import { JdExtractionError, type JdFailureCode } from "../src/lib/jd-errors.ts";
import type { NetworkOperation } from "../server/network-proxy.ts";

const source = "https://m.zhipin.com/mpa/html/weijd/weijd-job/anonymousJob?fromSource=2";
const owner = "http://localhost:5175\nlocalhost:5175";
const description = "岗位职责：研发设备通信服务并交付完整回归测试。任职要求：熟悉 C#、SQL Server、异步编程、单元测试与接口文档。";
const html = `<title>匿名研发职位</title><div class="job-sec-text">${description}</div>`;
const isFailure = (code: JdFailureCode) => (error: unknown) => error instanceof JdExtractionError && error.failure.code === code;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const diagnosticRequest = (url: string, type = "script", metadata: Partial<Request> = {}) => ({ url: () => url, resourceType: () => type, isNavigationRequest: () => false, ...metadata }) as unknown as Request;
const unknownPageLoad = { readyState: "unknown", content: "unknown", visibleFrames: 0 } as const;
const standardSource = "https://msearch.51job.com/jobs/all/166761768.html";
const standardSnapshot = { html: `<title>匿名研发职位</title><div class="job_msg">${description}</div>`, url: standardSource, title: "匿名研发职位" };
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(overrides: BrowserSessionOptions = {}) {
  let clock = 1_700_000_000_000;
  let closed = 0;
  let launched = 0;
  let snapshots = 0;
  let activations = 0;
  let operationReads = 0;
  let routes = 0;
  const navigations: string[] = [];
  const launchOptions: LaunchOptions[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  const page = new EventEmitter() as EventEmitter & { isClosed: () => boolean; close: () => Promise<void>; url: () => string; goto: (url: string) => Promise<void>; evaluate: () => Promise<unknown>; mainFrame: () => Frame; waitForNavigation: (options: { signal?: AbortSignal }) => Promise<Response | null>; route: BrowserContext["route"]; routeWebSocket: BrowserContext["routeWebSocket"] };
  const mainFrame = { page: () => page } as unknown as Frame;
  page.mainFrame = () => mainFrame;
  let pageClosed = false;
  let pageLocation = "about:blank";
  page.isClosed = () => pageClosed;
  page.close = async () => { if (!pageClosed) { pageClosed = true; page.emit("close"); } };
  page.url = () => pageLocation;
  page.waitForNavigation = (options) => new Promise((resolve, reject) => {
    const cleanup = () => { page.removeListener("commit", committed); options.signal?.removeEventListener("abort", aborted); };
    const committed = (response: Response | null) => { cleanup(); resolve(response); };
    const aborted = () => { cleanup(); reject(options.signal?.reason); };
    page.once("commit", committed);
    options.signal?.addEventListener("abort", aborted, { once: true });
  });
  const commitDocument = async (request: Request) => {
    page.emit("framenavigated", mainFrame);
    page.emit("commit", { request: () => request } as unknown as Response);
    await Promise.resolve();
  };
  let snapshot = { html, url: source, title: "匿名研发职位" } as { html: string; url: string; title: string; gate?: "login_required" | "verification_required"; oversized?: boolean; pageLoad?: BrowserSessionInspection["pageLoad"] };
  let onNavigate: ((url: string) => typeof snapshot) | undefined;
  page.goto = async (url) => {
    navigations.push(url);
    snapshot = onNavigate?.(url) ?? { ...snapshot, url };
    const request = diagnosticRequest(snapshot.url, "document", { isNavigationRequest: () => true, frame: () => mainFrame });
    page.emit("request", request);
    page.emit("response", { request: () => request, status: () => 200 });
    pageLocation = snapshot.url;
    await commitDocument(request);
  };
  page.evaluate = async () => { snapshots += 1; return snapshot; };
  Object.assign(page, { bringToFront: async () => { activations += 1; } });
  let requestRoute!: (route: Route) => Promise<void>;
  let socketRoute!: (socket: { close: () => void }) => void;
  page.route = async (_pattern, handler) => { requestRoute = handler; };
  page.routeWebSocket = async (_pattern, handler) => { socketRoute = handler; };
  const context = Object.assign(new EventEmitter(), {
    route: async (_pattern: string, handler: typeof requestRoute) => { requestRoute = handler; },
    routeWebSocket: async (_pattern: string, handler: typeof socketRoute) => { socketRoute = handler; },
    newPage: async () => page,
  });
  const contexts: unknown[] = [];
  const browser = Object.assign(new EventEmitter(), {
    // This synthetic launcher reuses its fake object across launches; a new
    // context must reset the old context's closed-page flag.
    newContext: async (options: unknown) => { pageClosed = false; contexts.push(options); return context; },
    close: async () => { closed += 1; pageClosed = true; },
  }) as unknown as Browser;
  const operation: NetworkOperation = { fetch: async () => { throw new Error("manual sessions must never preflight"); }, routeFor: () => { routes += 1; return { mode: "manual", source: "anonymous fixture", proxyUrl: "http://127.0.0.1:17891" }; } };
  const manager = createBrowserSessionManager({
    now: () => clock,
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    sleep: async (ms, signal) => { signal.throwIfAborted(); clock += ms; },
    launch: async (options) => { launched += 1; launchOptions.push(options); return browser; },
    getOperation: async () => { operationReads += 1; return operation; },
    stopBrowser: async () => undefined,
    ...overrides,
  });
  return {
    manager, browser, page, context, contexts, navigations, launchOptions, operation, commitDocument,
    activations: () => activations,
    count: () => ({ closed, launched, snapshots, operationReads, routes }),
    setSnapshot: (value: typeof snapshot) => {
      snapshot = value;
      if (pageLocation !== value.url) { pageLocation = value.url; page.emit("framenavigated", mainFrame); }
      return value;
    },
    setPageUrl: (value: string) => { pageLocation = value; },
    setNavigation: (handler: (url: string) => typeof snapshot) => { onNavigate = handler; },
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    timer: (ms: number) => { const timer = [...timers.values()].find((value) => value.ms === ms); assert.ok(timer); timer.callback(); },
    requestRoute: () => requestRoute,
    socketRoute: () => socketRoute,
  };
}

const linkedinSearchInput = { provider: "linkedin", keyword: "software", regionId: "us" } as const;
const linkedinSearchUrl = buildPlatformSearchRequest(linkedinSearchInput).url;
const linkedinSearchHtml = `<li class="base-search-card"><a class="base-search-card__full-link" href="https://www.linkedin.com/jobs/view/123456/"><h3 class="base-search-card__title">Software Engineer</h3></a><span class="base-search-card__subtitle">Example Company</span></li>`;

test("standard search captures the fixed visible-card expression and shares detail ownership, focus, renewal and close", async () => {
  const f = fixture(); f.setNavigation(url => ({ url, html: linkedinSearchHtml, title: "Jobs" }));
  const evaluate = f.page.evaluate; let evaluations = 0;
  Object.assign(f.page, { evaluate: async (expression: unknown) => { assert.equal(expression, VISIBLE_JOB_SEARCH_SNAPSHOT); evaluations++; return evaluate(); } });
  try {
    const info = await f.manager.startSearch("owner", linkedinSearchInput);
    assert.equal(info.url, linkedinSearchUrl); assert.equal(info.platform, "LinkedIn");
    await assert.rejects(f.manager.read("owner", info.sessionId), isFailure("unsupported_page"));
    await assert.rejects(f.manager.readSearch("other", info.sessionId), isFailure("browser_session_expired"));
    assert.equal(evaluations, 0);
    await assert.rejects(f.manager.start("owner", standardSource), isFailure("browser_unavailable"));
    const result = await f.manager.readSearch("owner", info.sessionId);
    assert.equal(result.status, "ready"); assert.equal(result.cards.length, 1); assert.equal(result.cards[0].title, "Software Engineer");
    assert.ok(evaluations >= 3); assert.deepEqual(f.navigations, [linkedinSearchUrl]);
    assert.equal((await f.manager.extend("owner", info.sessionId)).sessionId, info.sessionId);
    await f.manager.focus("owner", info.sessionId);
    await f.manager.close("other", info.sessionId); assert.equal(f.manager.hasSession(), true);
    await f.manager.close("owner", info.sessionId); assert.equal(f.manager.hasSession(), false);
    const detail = await f.manager.start("owner", standardSource);
    await assert.rejects(f.manager.readSearch("owner", detail.sessionId), isFailure("unsupported_page"));
  } finally { await f.manager.closeAll(); }
});

test("standard search rejects changed keyword/location and forged snapshot URLs, keeps login gates and reports honest empty state", async () => {
  for (const mode of ["keyword", "location", "forged", "gate", "empty", "paging"] as const) {
    const f = fixture(); f.setNavigation(url => ({ url, html: linkedinSearchHtml, title: "Jobs" }));
    const info = await f.manager.startSearch("owner", linkedinSearchInput);
    try {
      const url = new URL(linkedinSearchUrl);
      if (mode === "keyword" || mode === "location") url.searchParams.set(mode === "keyword" ? "keywords" : "location", "changed");
      if (mode === "paging") url.searchParams.set("start", "25");
      f.setSnapshot({ url: url.href, title: "Jobs", html: mode === "empty" ? '<div class="no-results">No matching jobs found</div>' : linkedinSearchHtml, ...(mode === "gate" ? { gate: "login_required" as const } : {}) });
      if (mode === "forged") f.setPageUrl("https://www.linkedin.com/jobs/search?keywords=other");
      if (mode === "empty" || mode === "paging") {
        const result = await f.manager.readSearch("owner", info.sessionId);
        assert.equal(result.status, mode === "empty" ? "empty" : "ready");
      } else await assert.rejects(f.manager.readSearch("owner", info.sessionId), isFailure(mode === "gate" ? "login_required" : mode === "forged" ? "unsupported_page" : "job_mismatch"));
      assert.equal(f.manager.isActive("owner", info.sessionId), true); assert.equal(f.count().closed, 0);
      assert.deepEqual(f.navigations, [linkedinSearchUrl]);
    } finally { await f.manager.closeAll(); }
  }
});

test("standard search waits through a complete but unrendered SPA shell and accepts later stable cards without navigating again", async () => {
  const f = fixture();
  f.setNavigation(url => ({ url, html: "<body></body>", title: "Jobs", pageLoad: { readyState: "complete", content: "empty", visibleFrames: 0 } }));
  const info = await f.manager.startSearch("owner", linkedinSearchInput), started = f.now();
  const evaluate = f.page.evaluate;
  f.page.evaluate = async () => {
    if (f.now() - started >= 2_800) f.setSnapshot({ url: linkedinSearchUrl, html: linkedinSearchHtml, title: "Jobs" });
    return evaluate();
  };
  try {
    const result = await f.manager.readSearch("owner", info.sessionId);
    assert.equal(result.status, "ready"); assert.equal(result.cards.length, 1);
    assert.equal(f.now() - started, 3_600);
    assert.deepEqual(f.navigations, [linkedinSearchUrl]); assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("standard search returns honest stable unknown diagnostics after eight seconds and cannot extend that budget with changing layouts", async () => {
  for (const changing of [false, true]) {
    const f = fixture(); f.setNavigation(url => ({ url, html: "<body></body>", title: "Jobs" }));
    const info = await f.manager.startSearch("owner", linkedinSearchInput), started = f.now();
    if (changing) {
      let attempt = 0;
      f.page.evaluate = async () => ({ url: linkedinSearchUrl, title: "Jobs", html: '<div class="base-search-card">Still loading</div>'.repeat(++attempt % 2 + 1) });
    }
    try {
      if (changing) await assert.rejects(f.manager.readSearch("owner", info.sessionId), isFailure("unsupported_page"));
      else {
        const result = await f.manager.readSearch("owner", info.sessionId);
        assert.equal(result.status, "unknown_layout"); assert.equal(result.cards.length, 0);
        assert.match(result.warnings.join(" "), /未确认结果数量/);
      }
      assert.equal(f.now() - started, 8_000);
      assert.deepEqual(f.navigations, [linkedinSearchUrl]); assert.equal(f.count().closed, 0);
      assert.equal(f.manager.isActive("owner", info.sessionId), true);
    } finally { await f.manager.closeAll(); }
  }
});

test("standard search stops the loading grace promptly for explicit empty results or either gate", async () => {
  for (const outcome of ["empty", "login_required", "verification_required"] as const) {
    const f = fixture(); f.setNavigation(url => ({ url, html: "<body></body>", title: "Jobs" }));
    const info = await f.manager.startSearch("owner", linkedinSearchInput), started = f.now(), evaluate = f.page.evaluate;
    f.page.evaluate = async () => {
      if (f.now() - started >= 1_600) f.setSnapshot({ url: linkedinSearchUrl, title: "Jobs",
        html: outcome === "empty" ? '<div class="no-results">No matching jobs found</div>' : "",
        ...(outcome === "empty" ? {} : { gate: outcome }) });
      return evaluate();
    };
    try {
      if (outcome === "empty") assert.equal((await f.manager.readSearch("owner", info.sessionId)).status, "empty");
      else await assert.rejects(f.manager.readSearch("owner", info.sessionId), isFailure(outcome));
      assert.equal(f.now() - started, outcome === "empty" ? 2_400 : 1_600);
      assert.deepEqual(f.navigations, [linkedinSearchUrl]); assert.equal(f.count().closed, 0);
    } finally { await f.manager.closeAll(); }
  }
});

test("standard search loading grace remains cancellable and keeps the owned page available for a later explicit read", async () => {
  const cancel = new AbortController(); let waited = 0;
  const f = fixture({ sleep: async (ms, signal) => {
    waited += ms; f.advance(ms);
    if (waited === 1_200) cancel.abort(new Error("cancel loading wait"));
    signal.throwIfAborted();
  } });
  f.setNavigation(url => ({ url, html: "<body></body>", title: "Jobs" }));
  const info = await f.manager.startSearch("owner", linkedinSearchInput);
  try {
    await assert.rejects(f.manager.readSearch("owner", info.sessionId, cancel.signal), /cancel loading wait/);
    await nextTurn();
    assert.equal(waited, 1_200); assert.equal(f.manager.isActive("owner", info.sessionId), true); assert.equal(f.count().closed, 0);
    f.setSnapshot({ url: linkedinSearchUrl, html: linkedinSearchHtml, title: "Jobs" });
    assert.equal((await f.manager.readSearch("owner", info.sessionId)).status, "ready");
    assert.deepEqual(f.navigations, [linkedinSearchUrl]);
  } finally { await f.manager.closeAll(); }
});

test("cancelled standard search keeps an outstanding snapshot locked and cannot reuse its late result after close", async () => {
  const f = fixture(); f.setNavigation(url => ({ url, html: linkedinSearchHtml, title: "Jobs" }));
  const info = await f.manager.startSearch("owner", linkedinSearchInput);
  const entered = deferred<void>(), pending = deferred<unknown>(), cancel = new AbortController();
  f.page.evaluate = () => { entered.resolve(); return pending.promise; };
  try {
    const work = f.manager.readSearch("owner", info.sessionId, cancel.signal); await entered.promise;
    const rejected = assert.rejects(work, /cancel search/); cancel.abort(new Error("cancel search")); await rejected;
    assert.equal(f.manager.isActive("owner", info.sessionId), true); assert.equal(f.count().closed, 0);
    await assert.rejects(f.manager.extend("owner", info.sessionId), isFailure("browser_unavailable"));
    await f.manager.close("owner", info.sessionId);
    pending.resolve({ url: linkedinSearchUrl, html: linkedinSearchHtml, title: "Jobs" }); await nextTurn();
    assert.equal(f.manager.hasSession(), false);
    await assert.rejects(f.manager.readSearch("owner", info.sessionId), isFailure("browser_session_expired"));
  } finally { pending.resolve({}); await f.manager.closeAll(); }
});

test("manual browser sessions retain bound JobPosting publication without reloading or guessing update times", async () => {
  for (const datePosted of ["2026-09-01T12:34:56.789Z", "2026-09-01"]) {
    const f = fixture();
    try {
      f.setSnapshot({ html: html + `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "匿名研发职位", url: source, description, datePosted })}</script>`, url: source, title: "匿名研发职位" });
      const info = await f.manager.start(owner, source);
      const result = await f.manager.read(owner, info.sessionId);
      assert.equal(result.provenance.sourcePublishedText, datePosted); assert.equal(result.provenance.sourcePublishedAt, datePosted.includes("T") ? datePosted : undefined);
      assert.notEqual(result.provenance.observedAt, datePosted); assert.deepEqual(f.navigations, [source]);
    } finally { await f.manager.closeAll(); }
  }
});

test("51job verification network stays on its owned page through busy reads and ignores ended-session responses", async () => {
  const f = fixture();
  f.setSnapshot({ ...standardSnapshot, gate: "verification_required" });
  const info = await f.manager.start(owner, standardSource);
  const host = "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com";
  const request = diagnosticRequest(`https://${host}/private-path?signature=secret`, "xhr");
  const pending = deferred<unknown>();
  const evaluate = f.page.evaluate;
  f.page.evaluate = () => pending.promise;
  const cancel = new AbortController();
  const work = f.manager.read(owner, info.sessionId, cancel.signal);
  const rejected = assert.rejects(work, { name: "AbortError" });
  await nextTurn();
  f.page.emit("request", request);
  f.advance(12);
  f.page.emit("response", { request: () => request, status: () => 200 });
  f.advance(8);
  f.page.emit("requestfinished", request);
  cancel.abort();
  await rejected;
  pending.resolve({ ...standardSnapshot, gate: "verification_required" });
  await nextTurn();
  f.page.evaluate = evaluate;
  await assert.rejects(f.manager.inspect("foreign-owner", info.sessionId), isFailure("browser_session_expired"));
  const observed = await f.manager.inspect(owner, info.sessionId);
  assert.equal(observed.gate, "verification_required", "HTTP200 is transport evidence only");
  assert.deepEqual(observed.verificationNetwork, {
    requests: [{ id: 1, host, type: "xhr" }],
    events: [{ requestId: 1, phase: "request", atMs: 0 }, { requestId: 1, phase: "response", atMs: 12, status: 200 }, { requestId: 1, phase: "finished", atMs: 20 }],
    truncated: false,
  });
  assert.equal(JSON.stringify(observed).includes("signature"), false);
  assert.equal(JSON.stringify(observed).includes("private-path"), false);
  assert.equal(f.navigations.length, 1);
  assert.equal(info.expiresAt, new Date(f.now() - 20 + 600_000).toISOString());
  observed.verificationNetwork!.requests[0].host = "mutated.invalid";
  assert.equal((await f.manager.inspect(owner, info.sessionId)).verificationNetwork!.requests[0].host, host);
  await f.manager.close(owner, info.sessionId);
  const next = await f.manager.start(owner, standardSource);
  f.page.emit("response", { request: () => request, status: () => 403 });
  f.page.emit("requestfailed", request);
  assert.deepEqual((await f.manager.inspect(owner, next.sessionId)).verificationNetwork, { requests: [], events: [], truncated: false });
  await f.manager.closeAll();
});

test("standard read/inspect abort and timeout preserve the same page and stay busy until the actual snapshot settles", async () => {
  for (const action of ["read", "inspect"] as const) for (const ending of ["abort", "timeout"] as const) {
    const f = fixture();
    const pending = deferred<unknown>();
    try {
      f.setSnapshot(standardSnapshot);
      const info = await f.manager.start(owner, standardSource);
      const expiry = info.expiresAt;
      let evaluations = 0;
      f.page.evaluate = () => { evaluations++; return pending.promise; };
      const cancellation = new AbortController();
      const operation = f.manager[action](owner, info.sessionId, cancellation.signal);
      const rejected = assert.rejects(operation, ending === "abort" ? { name: "AbortError" } : isFailure("timeout"));
      if (ending === "abort") cancellation.abort(); else f.timer(action === "read" ? 45_000 : 10_000);
      await rejected;
      assert.equal(f.count().closed, 0, `${action}/${ending} must preserve the live job page`);
      assert.equal(f.manager.isActive(owner, info.sessionId), true);
      assert.equal(f.manager.isActive("foreign", info.sessionId), false);
      for (const retry of ["read", "inspect", "extend"] as const) await assert.rejects(f.manager[retry](owner, info.sessionId), isFailure("browser_unavailable"));
      assert.equal(evaluations, 1, "a second snapshot must not overlap the cancelled command");
      pending.resolve({ ...standardSnapshot, html: "<main>late cancelled result must not be adopted</main>" });
      await nextTurn();
      f.page.evaluate = async () => { evaluations++; return standardSnapshot; };
      assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
      assert.equal((await f.manager.read(owner, info.sessionId)).text, `匿名研发职位\n\n${description}`);
      f.advance(new Date(expiry).getTime() - f.now());
      assert.equal(f.manager.isActive(owner, info.sessionId), false, "cancelling and retrying never extends the original expiry");
      assert.deepEqual(f.navigations, [standardSource]);
      assert.equal(f.count().launched, 1);
    } finally { pending.resolve(standardSnapshot); await f.manager.closeAll(); }
  }
});

test("standard pre-cancelled read and inspect preserve the page without starting a snapshot", async () => {
  const f = fixture();
  try {
    f.setSnapshot(standardSnapshot);
    const info = await f.manager.start(owner, standardSource), before = f.count();
    const cancellation = new AbortController(); cancellation.abort();
    for (const action of ["read", "inspect"] as const) await assert.rejects(f.manager[action](owner, info.sessionId, cancellation.signal), { name: "AbortError" });
    assert.deepEqual(f.count(), before);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    assert.deepEqual(f.navigations, [standardSource]);
  } finally { await f.manager.closeAll(); }
});

test("standard preserved cancelled work cannot revive a page after explicit close, TTL or browser stop", async () => {
  for (const ending of ["close", "ttl", "stop"] as const) {
    const f = fixture(), pending = deferred<unknown>();
    try {
      f.setSnapshot(standardSnapshot);
      const info = await f.manager.start(owner, standardSource);
      f.page.evaluate = () => pending.promise;
      const cancellation = new AbortController();
      const operation = f.manager.read(owner, info.sessionId, cancellation.signal);
      const rejected = assert.rejects(operation, { name: "AbortError" }); cancellation.abort(); await rejected;
      if (ending === "close") await f.manager.close(owner, info.sessionId);
      else if (ending === "ttl") { f.timer(600_000); await nextTurn(); }
      else await f.manager.stopBrowser();
      assert.equal(f.manager.isActive(owner, info.sessionId), false);
      assert.equal(f.count().closed, 1);
      f.page.evaluate = async () => standardSnapshot;
      const next = await f.manager.start(owner, standardSource);
      const newPending = deferred<unknown>(); f.page.evaluate = () => newPending.promise;
      const newInspection = f.manager.inspect(owner, next.sessionId);
      pending.resolve({ ...standardSnapshot, html: "<main>old late result</main>" }); await nextTurn();
      await assert.rejects(f.manager.read(owner, next.sessionId), isFailure("browser_unavailable"), "old operation cannot release the new session's busy lock");
      await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_session_expired"));
      newPending.resolve(standardSnapshot); assert.equal((await newInspection).pageState, "original_job");
      assert.equal(f.manager.isActive(owner, next.sessionId), true);
      assert.deepEqual(f.navigations, [standardSource, standardSource]);
    } finally { pending.resolve(standardSnapshot); await f.manager.closeAll(); }
  }
});

test("session isActive is an owner-bound synchronous liveness query with no navigation or cleanup", async () => {
  const f = fixture();
  try {
    assert.equal(f.manager.isActive(owner, "unknown"), false);
    const info = await f.manager.start(owner, source), before = f.count(), navigations = [...f.navigations];
    assert.equal(f.manager.isActive(owner, info.sessionId), true);
    assert.equal(f.manager.isActive("another-owner", info.sessionId), false);
    assert.equal(f.manager.isActive(owner, "unknown"), false);
    assert.deepEqual(f.count(), before); assert.deepEqual(f.navigations, navigations);
    f.advance(599_999);
    assert.equal(f.manager.isActive(owner, info.sessionId), true);
    f.advance(1);
    assert.equal(f.manager.isActive(owner, info.sessionId), false);
    assert.equal(f.manager.owns(info.sessionId), true, "expired ownership is retained until an actual cleanup operation");
    assert.deepEqual(f.count(), before); assert.deepEqual(f.navigations, navigations);
  } finally { await f.manager.closeAll(); }
});

test("session isActive preserves a busy usable lease and rejects externally closed or ended retained pages", async () => {
  const f = fixture(); const pending = deferred<unknown>(); const entered = deferred<void>();
  try {
    const info = await f.manager.start(owner, source);
    f.page.evaluate = () => { entered.resolve(); return pending.promise; };
    const inspection = f.manager.inspect(owner, info.sessionId); await entered.promise;
    assert.equal(f.manager.isActive(owner, info.sessionId), true, "busy is not ended");
    pending.resolve({ html, url: source, title: "匿名研发职位" }); await inspection;
    f.page.isClosed = () => true;
    assert.equal(f.manager.isActive(owner, info.sessionId), false);
    f.page.isClosed = () => false;
    f.browser.close = async () => { throw new Error("fixture retains unclosed browser"); };
    await assert.rejects(f.manager.close(owner, info.sessionId), isFailure("browser_unavailable"));
    assert.equal(f.manager.owns(info.sessionId), true);
    assert.equal(f.manager.isActive(owner, info.sessionId), false, "failed physical close cannot restore logical liveness");
  } finally { pending.resolve({ html, url: source, title: "匿名研发职位" }); f.browser.close = async () => undefined; await f.manager.closeAll(); }
});

test("人工会话新建可见非持久浏览器，无静态预检，原岗位read不刷新且使用同一网络快照", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    assert.match(info.sessionId, /^[a-f\d-]{36}$/);
    assert.equal(info.url, source);
    assert.equal(info.platform, "BOSS直聘");
    assert.equal(Date.parse(info.expiresAt), 1_700_000_600_000);
    assert.equal(f.launchOptions[0]?.headless, false);
    assert.deepEqual(f.launchOptions[0]?.proxy, { server: "http://127.0.0.1:17891", bypass: "<-loopback>" });
    assert.deepEqual(f.contexts, [{ serviceWorkers: "block", acceptDownloads: false, locale: "zh-CN" }]);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).mainDocumentRequests, 1);
    const result = await f.manager.read(owner, info.sessionId);
    assert.match(result.method, /人工接续/);
    assert.match(result.text, /设备通信/);
    assert.equal(result.provenance.url, source);
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.page.url(), source);
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.deepEqual(f.navigations, [source]);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).mainDocumentRequests, 1, "连续读取与检查不增加主页面网络请求计数");
    assert.equal(f.count().operationReads, 1);
    assert.equal(f.count().routes, 1);
    assert.ok(f.count().snapshots >= 3);
    assert.deepEqual(await f.manager.close(owner, info.sessionId), { closed: true });
    assert.equal(f.count().closed, 1);
  } finally { await f.manager.closeAll(); }
});

test("持久人工会话复用平台context，结束或TTL只释放岗位页，保活页与其它lease不受影响", async () => {
  let acquisitions = 0;
  let releases = 0;
  const nextPage = fixture();
  const f = fixture({ acquire: async (platform, operation, signal, url) => {
    signal?.throwIfAborted();
    assert.equal(platform, "BOSS直聘");
    assert.equal(operation, f.operation);
    assert.equal(url, source);
    const page = ++acquisitions === 1 ? f.page : nextPage.page;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      releases += 1;
      await page.close();
    };
    return { page: page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release };
  } });
  f.context.route = async () => { assert.fail("session must not replace persistent context routing"); };
  f.context.routeWebSocket = async () => { assert.fail("session must not replace persistent context socket policy"); };
  f.context.newPage = async () => { assert.fail("lease already owns its job page"); };
  let otherPagesClosed = 0;
  const unrelated = { close: async () => { otherPagesClosed += 1; } };
  try {
    const first = await f.manager.start(owner, source);
    assert.equal(f.count().launched, 0);
    assert.equal(f.context.listenerCount("page"), 0, "session must not attach a shared-context page closer");
    f.context.emit("page", unrelated);
    let action = "";
    await f.requestRoute()({ request: () => diagnosticRequest("https://img.bosszhipin.com/fixture.png", "image"), fallback: async () => { action = "fallback"; }, continue: async () => { assert.fail("allowed leased-page traffic must reach runtime policy"); } } as unknown as Route);
    assert.equal(action, "fallback");
    f.setSnapshot({ html: "", url: source, title: "", gate: "verification_required" });
    await assert.rejects(f.manager.read(owner, first.sessionId), isFailure("verification_required"));
    assert.equal(releases, 0, "verification failure preserves the active job page");
    await f.manager.close(owner, first.sessionId);
    assert.equal(releases, 1);
    assert.equal(f.page.isClosed(), true);
    assert.equal(f.count().closed, 0, "releasing a lease must never close its browser");
    const second = await f.manager.start(owner, source);
    assert.equal(acquisitions, 2);
    assert.match((await f.manager.read(owner, second.sessionId)).text, /设备通信/);
    f.timer(600_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases, 2);
    assert.equal(nextPage.page.isClosed(), true);
    assert.equal(nextPage.count().closed, 0);
    assert.equal(otherPagesClosed, 0);
    await f.manager.closeAll();
    assert.equal(releases, 2, "closeAll is idempotent and owns only session leases");
    assert.equal(otherPagesClosed, 0);
  } finally { await f.manager.closeAll(); await nextPage.manager.closeAll(); }
});

test("持久岗位页迟到获取取消释放自身lease，已建页读取取消保留同一lease和平台context", async () => {
  const pending = deferred<Awaited<ReturnType<NonNullable<BrowserSessionOptions["acquire"]>>>>();
  const acquired = deferred<void>();
  const f = fixture({ acquire: async () => { acquired.resolve(); return pending.promise; } });
  let released = 0;
  const release = async () => { released += 1; await f.page.close(); };
  const controller = new AbortController();
  const starting = f.manager.start(owner, source, controller.signal);
  await acquired.promise;
  controller.abort();
  await assert.rejects(starting, { name: "AbortError" });
  await f.manager.retryEnded(owner);
  assert.equal(f.manager.hasSession(), true, "late acquisition remains reserved after ended cleanup");
  await assert.rejects(f.manager.start(owner, source), isFailure("browser_unavailable"));
  const closing = f.manager.closeAll();
  pending.resolve({ page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release });
  await closing;
  assert.equal(released, 1);
  assert.equal(f.count().closed, 0);
  assert.equal(f.contexts.length, 0);

  let releases = 0;
  const active = fixture({ acquire: async () => {
    const finish = async () => { releases += 1; await active.page.close(); };
    return { page: active.page as unknown as Page, context: active.context as unknown as BrowserContext, release: finish, releasePage: finish };
  } });
  try {
    const info = await active.manager.start(owner, source);
    const late = deferred<unknown>();
    active.page.evaluate = () => late.promise;
    const cancellation = new AbortController();
    const reading = active.manager.read(owner, info.sessionId, cancellation.signal);
    const rejected = assert.rejects(reading, { name: "AbortError" });
    cancellation.abort();
    await rejected;
    late.resolve({ html, url: source, title: "匿名研发职位" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases, 0);
    assert.equal(active.count().closed, 0);
    active.page.evaluate = async () => ({ html, url: source, title: "匿名研发职位" });
    assert.equal((await active.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    await active.manager.close(owner, info.sessionId);
    assert.equal(releases, 1);
  } finally { await active.manager.closeAll(); }
});

test("51job cancelled late acquisition keeps a failed lease for the same owner's next explicit recovery", async () => {
  const pending = deferred<Awaited<ReturnType<NonNullable<BrowserSessionOptions["acquire"]>>>>();
  const arrived = deferred<void>();
  let attempts = 0, allowClose = false;
  const f = fixture({ acquire: async () => { arrived.resolve(); return pending.promise; } });
  const release = async () => { attempts++; if (!allowClose) throw new Error("fixture late release failed"); await f.page.close(); };
  const controller = new AbortController();
  try {
    const starting = f.manager.start(owner, "https://msearch.51job.com/jobs/all/166761768.html", controller.signal);
    await arrived.promise;
    controller.abort(); await assert.rejects(starting, { name: "AbortError" });
    pending.resolve({ page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(f.manager.hasSession(), true, "a failed late release must retain ownership after acquisition settles");
    await f.manager.retryEnded("another-owner"); assert.equal(attempts, 1);
    await assert.rejects(f.manager.retryEnded(owner), isFailure("browser_unavailable"));
    assert.equal(attempts, 2); assert.equal(f.manager.hasSession(), true);
    allowClose = true; await f.manager.retryEnded(owner);
    assert.equal(attempts, 3); assert.equal(f.manager.hasSession(), false);
    assert.equal(f.count().closed, 0, "recovery closes only the late lease, preserving the context");
  } finally { allowClose = true; await f.manager.closeAll(); }
});

test("cancelled acquisition without a page clears ownership across cleanup settlement interleavings", async () => {
  const leaked: Array<{ delay: number; afterRetry: boolean }> = [];
  for (const delay of [0, 1, 2, 3]) {
    let rejectPending!: (error: unknown) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectPending = reject; });
    const arrived = deferred<void>();
    const f = fixture({ acquire: (_platform, _operation, signal, _url, acquisition) => {
      assert.ok(acquisition); acquisition.pending(pending); arrived.resolve();
      return new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); });
    } });
    const controller = new AbortController();
    const starting = f.manager.start(owner, "https://msearch.51job.com/jobs/all/166761768.html", controller.signal);
    await arrived.promise;
    const rejected = assert.rejects(starting, { name: "AbortError" });
    controller.abort();
    let failure = Promise.resolve();
    for (let step = 0; step < delay; step++) failure = failure.then(() => undefined);
    void failure.then(() => rejectPending(new Error("fixture page creation rejected without a page")));
    await rejected; await new Promise((resolve) => setImmediate(resolve));
    const beforeRetry = f.manager.hasSession();
    await f.manager.retryEnded(owner);
    const afterRetry = f.manager.hasSession();
    if (beforeRetry || afterRetry) leaked.push({ delay, afterRetry });
    assert.equal(f.count().closed, 0, "an acquisition with no page must not close the context");
    await f.manager.closeAll();
  }
  assert.deepEqual(leaked, [], "all completed acquisitions without a page must release their reservation");
});

test("51job ended recovery skips active or foreign leases and propagates fulfilled disposal failures without stopping the browser", async () => {
  const link = "https://msearch.51job.com/jobs/all/166761768.html";
  let attempts = 0, allowClose = false;
  const f = fixture({ acquire: async () => {
    const release = async () => { attempts++; if (!allowClose) throw new Error("fixture release failure"); await f.page.close(); };
    return { page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release };
  } });
  const info = await f.manager.start(owner, link);
  try {
    f.setSnapshot({ html: "", url: link, title: "", gate: "verification_required" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("verification_required"));
    await f.manager.retryEnded(owner); assert.equal(attempts, 0); assert.equal(f.manager.owns(info.sessionId), true);
    await assert.rejects(f.manager.close(owner, info.sessionId), isFailure("browser_unavailable"));
    await f.manager.retryEnded("other-owner"); assert.equal(attempts, 1);
    await assert.rejects(f.manager.retryEnded(owner), isFailure("browser_unavailable"));
    assert.equal(attempts, 2); assert.equal(f.manager.owns(info.sessionId), true);
    allowClose = true; await f.manager.retryEnded(owner);
    assert.equal(attempts, 3); assert.equal(f.manager.owns(info.sessionId), false); assert.equal(f.manager.hasSession(), false);
    await f.manager.retryEnded(owner); assert.equal(attempts, 3); assert.equal(f.count().closed, 0);
  } finally { allowClose = true; await f.manager.closeAll(); }
});

test("岗位lease关闭失败不会报告closed，保留owner隔离且重复close重试直到实际成功", async () => {
  let attempts = 0;
  let allowClose = false;
  const f = fixture({ acquire: async () => {
    const release = async () => {
      attempts += 1;
      if (!allowClose) throw new Error("internal close failure must not leak");
      await f.page.close();
    };
    return { page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release };
  } });
  const info = await f.manager.start(owner, source);
  try {
    assert.deepEqual(await f.manager.close("http://other.test\nother.test", info.sessionId), { closed: true });
    assert.equal(attempts, 0);
    await assert.rejects(f.manager.close(owner, info.sessionId), (error: unknown) => {
      assert.ok(error instanceof JdExtractionError);
      assert.equal(error.failure.code, "browser_unavailable");
      assert.match(error.failure.message, /未能确认.*关闭.*重试.*关闭专用浏览器/);
      assert.doesNotMatch(error.failure.message, /internal close failure/);
      return true;
    });
    assert.equal(f.page.isClosed(), false);
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("browser_session_expired"));
    await assert.rejects(f.manager.start(owner, source), isFailure("browser_unavailable"));
    await assert.rejects(f.manager.close(owner, info.sessionId), isFailure("browser_unavailable"));
    assert.equal(attempts, 2);
    assert.deepEqual(await f.manager.close("http://other.test\nother.test", info.sessionId), { closed: true });
    assert.equal(attempts, 2, "another owner cannot retry or close this page");
    allowClose = true;
    assert.deepEqual(await f.manager.close(owner, info.sessionId), { closed: true });
    assert.equal(f.page.isClosed(), true);
    assert.equal(attempts, 3);
    assert.deepEqual(await f.manager.close(owner, info.sessionId), { closed: true });
    assert.equal(attempts, 3);
    assert.equal(f.count().closed, 0, "session cleanup never closes the shared browser");
  } finally { allowClose = true; await f.manager.closeAll(); }
});

test("并发close共用一次失败释放且均明确失败，closeAll仍排空供随后关闭context", async () => {
  const pending = deferred<void>();
  let attempts = 0;
  const f = fixture({ acquire: async () => {
    const release = async () => {
      attempts += 1;
      if (f.page.isClosed()) return;
      await pending.promise;
      throw new Error("page could not close");
    };
    return { page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release };
  } });
  const info = await f.manager.start(owner, source);
  const first = assert.rejects(f.manager.close(owner, info.sessionId), isFailure("browser_unavailable"));
  const second = assert.rejects(f.manager.close(owner, info.sessionId), isFailure("browser_unavailable"));
  let drained = false;
  const stopping = f.manager.closeAll().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  pending.resolve();
  await Promise.all([first, second, stopping]);
  assert.equal(attempts, 1);
  assert.equal(drained, true);
  assert.equal(f.page.isClosed(), false, "draining session work does not claim physical closure");
  // The subsequent pool.closeAll closes its context and emits the page event.
  await f.page.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await f.manager.close(owner, info.sessionId), { closed: true });
  assert.equal(attempts, 2);
  await f.manager.closeAll();
});

test("TTL/取消后显式关闭/外部关页释放失败不产生未处理拒绝，并保留显式重试错误", async () => {
  for (const end of ["ttl", "cancel", "close-event"] as const) {
    let attempts = 0;
    const f = fixture({ acquire: async () => {
      const release = async () => {
        attempts += 1;
        if (!f.page.isClosed()) throw new Error("not closed");
      };
      return { page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release };
    } });
    const info = await f.manager.start(owner, source);
    if (end === "ttl") f.timer(600_000);
    else if (end === "close-event") f.page.emit("close");
    else {
      const waiting = deferred<unknown>();
      f.page.evaluate = () => waiting.promise;
      const controller = new AbortController();
      const rejected = assert.rejects(f.manager.read(owner, info.sessionId, controller.signal), { name: "AbortError" });
      controller.abort();
      await rejected;
      waiting.resolve({ html, url: source, title: "" });
      assert.equal(attempts, 0, "read cancellation never releases a live lease");
      await assert.rejects(f.manager.close(owner, info.sessionId), isFailure("browser_unavailable"));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1, end);
    await assert.rejects(f.manager.close(owner, info.sessionId), isFailure("browser_unavailable"));
    assert.equal(attempts, 2, end);
    await f.manager.closeAll();
    assert.equal(attempts, 3, "drain retries the failed lease once and still resolves");
    await f.page.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await f.manager.close(owner, info.sessionId), { closed: true });
    await f.manager.closeAll();
  }
});

test("HTTP结束会话关闭失败返回422，关闭专用浏览器仍进入context回收并确认成功", async () => {
  let releases = 0;
  let contextsClosed = 0;
  const f = fixture({ acquire: async () => {
    const release = async () => {
      releases += 1;
      if (!f.page.isClosed()) throw new Error("page close failure");
    };
    return { page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release };
  } });
  const server = createServer((request, response) => {
    void browserSessionMiddleware(request, response, f.manager, async () => { contextsClosed += 1; await f.page.close(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const submit = (body: unknown) => fetch(`${origin}/api/jd/browser-session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  try {
    const started = await submit({ action: "start", input: source });
    assert.equal(started.status, 200);
    const info = await started.json() as { sessionId: string };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const close = await submit({ action: "close", sessionId: info.sessionId });
      assert.equal(close.status, 422);
      const result = await close.json() as { closed?: unknown; failure: { code: string; message: string } };
      assert.equal(result.closed, undefined);
      assert.equal(result.failure.code, "browser_unavailable");
      assert.match(result.failure.message, /关闭专用浏览器/);
    }
    assert.equal(releases, 2);
    assert.equal(contextsClosed, 0);
    const stopped = await submit({ action: "stop-browser" });
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), { closed: true });
    assert.equal(contextsClosed, 1, "failed job page close must not prevent context shutdown");
    assert.equal(f.page.isClosed(), true);
    const closed = await submit({ action: "close", sessionId: info.sessionId });
    assert.equal(closed.status, 200);
    assert.deepEqual(await closed.json(), { closed: true });
  } finally {
    await f.page.close();
    await f.manager.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("会话绑owner且仅一个活动，错误owner无法读/关，过期和不存在统一错误", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    await assert.rejects(f.manager.start(owner, source), isFailure("browser_unavailable"));
    await assert.rejects(f.manager.read("http://evil.test\nevil.test", info.sessionId), isFailure("browser_session_expired"));
    assert.deepEqual(await f.manager.close("http://evil.test\nevil.test", info.sessionId), { closed: true });
    assert.equal(f.count().closed, 0);
    f.advance(600_001);
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("browser_session_expired"));
    assert.equal(f.count().closed, 1);
    await assert.rejects(f.manager.read(owner, "missing-session"), isFailure("browser_session_expired"));
  } finally { await f.manager.closeAll(); }
});

test("可见登录或验证只返回业务失败并保留会话，随后可显式重读", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    for (const code of ["login_required", "verification_required"] as const) {
      f.setSnapshot({ html: "", url: source, title: "", gate: code });
      await assert.rejects(f.manager.read(owner, info.sessionId), isFailure(code));
      assert.equal(f.count().closed, 0);
      assert.deepEqual(f.navigations, [source]);
    }
    f.setSnapshot({ html: "<title>访问验证</title>", url: "https://m.zhipin.com/web/passport/zp/security.html", title: "访问验证" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("verification_required"));
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.page.url(), "https://m.zhipin.com/web/passport/zp/security.html");
    f.setSnapshot({ html, url: source, title: "匿名研发职位" });
    assert.match((await f.manager.read(owner, info.sessionId)).text, /研发/);
    assert.equal(f.count().operationReads, 1);
  } finally { await f.manager.closeAll(); }
});

test("BOSS官方可见注册登录页多次read与inspect均提示登录，保留现场且不导航", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const loginUrl = "https://www.zhipin.com/web/user/";
    const title = "【BOSS直聘注册登录】boss直聘在线注册登录-BOSS直聘";
    f.setSnapshot({ html: `<title>${title}</title><main><p>手机号</p><p>验证码</p><p>扫码登录</p></main>`, url: loginUrl, title });
    for (let repeat = 0; repeat < 3; repeat++) {
      await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("login_required"));
      assert.equal((await f.manager.inspect(owner, info.sessionId)).gate, "login_required");
      assert.equal(f.page.url(), loginUrl);
      assert.deepEqual(f.navigations, [source]);
      assert.equal(f.count().closed, 0);
    }
  } finally { await f.manager.closeAll(); }
});

test("猎聘空中转页立即保留现场，后续可见登录通过再次读取识别", async () => {
  const f = fixture();
  const liepinSource = "https://m.liepin.com/job/1984701079.shtml?mscid=anonymous";
  const transitUrl = "https://wow.liepin.com/t1012695/4410f519.html";
  try {
    const info = await f.manager.start(owner, liepinSource);
    f.setSnapshot({ url: transitUrl, title: "", html: "<html><body></body></html>" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("unsupported_page"));
    assert.equal(f.count().snapshots, 1);
    f.setSnapshot({ url: transitUrl, title: "", html: '<main class="login4c-main-container"><p>微信扫码登录</p><p>我已有账号，直接登录</p></main>' });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("login_required"));
    assert.equal(f.count().snapshots, 2);
    assert.equal(f.count().closed, 0);
    assert.deepEqual(f.navigations, [liepinSource]);
  } finally { await f.manager.closeAll(); }
});

test("read等待导航中的快照恢复，原岗位与随后出现的验证均不刷新", async () => {
  for (const gate of [undefined, "verification_required"] as const) {
    const f = fixture();
    try {
      const info = await f.manager.start(owner, source);
      const evaluate = f.page.evaluate;
      let attempts = 0;
      f.page.evaluate = async () => {
        if (++attempts <= 3) throw new Error("Execution context was destroyed, most likely because of a navigation");
        return gate ? { html: "", url: source, title: "", gate } : evaluate();
      };
      if (gate) await assert.rejects(f.manager.read(owner, info.sessionId), isFailure(gate));
      else assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
      assert.ok(attempts >= 4);
      assert.deepEqual(f.navigations, [source]);
      assert.equal(f.count().closed, 0);
    } finally { await f.manager.closeAll(); }
  }
});

test("read无法取得当前快照时有界失败并保留现场，不以刷新尝试恢复", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    f.page.evaluate = async () => { throw new Error("Cannot find context with specified id"); };
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("unsupported_page"));
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("精确aboutblank持续空白有界返回unsupported并保留会话，恢复后仍可读取", async () => {
  const sleeps: number[] = [];
  const f = fixture({ sleep: async (ms, signal) => { signal.throwIfAborted(); sleeps.push(ms); f.advance(ms); } });
  try {
    const info = await f.manager.start(owner, source);
    f.setSnapshot({ html: "", url: "about:blank", title: "", gate: "login_required" });
    await assert.rejects(f.manager.read(owner, info.sessionId), (error: unknown) => {
      assert.ok(error instanceof JdExtractionError);
      assert.equal(error.failure.code, "unsupported_page");
      assert.match(error.failure.message, /空白页/);
      return true;
    });
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.ok(waited >= 2_400 && waited <= 2_800, "精确空白页只短暂等待，不能占满40秒读取期限");
    assert.ok(sleeps.every((ms) => ms === 400));
    assert.deepEqual(f.navigations, [source], "空白页不自动跳回原岗");
    assert.equal(f.page.url(), "about:blank");
    assert.equal(f.count().closed, 0);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "blank");
    f.setSnapshot({ html, url: source, title: "匿名研发职位" });
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("短暂aboutblank恢复原岗后重新稳定正文，不沿用空白前稳定时间", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    let attempts = 0;
    f.page.evaluate = async () => f.setSnapshot(++attempts === 2 ? { html: "", url: "about:blank", title: "" } : { html, url: source, title: "匿名研发职位" });
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.equal(attempts, 6, "恢复正文的导航快照丢弃后须重新连续稳定800ms");
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("空白页转为平台非岗位页时保留当前页，其他来源仍立即拒绝", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    f.setSnapshot({ html: "", url: "about:blank", title: "" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("unsupported_page"));
    const transitUrl = "https://m.zhipin.com/fixture-intermediate";
    f.setSnapshot({ html: "<main>中转完成</main>", url: transitUrl, title: "" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("unsupported_page"));
    assert.equal(f.page.url(), transitUrl);
    assert.deepEqual(f.navigations, [source]);
    let outsideSnapshots = 0;
    f.setPageUrl("https://outside.example.test/");
    f.page.evaluate = async () => { outsideSnapshots += 1; return { html: "", url: "https://outside.example.test/", title: "" }; };
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("job_mismatch"));
    assert.equal(outsideSnapshots, 1, "外部来源仍立即拒绝，不沿用空白等待分支");
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
  const exact = fixture();
  try {
    const info = await exact.manager.start(owner, source);
    for (const url of ["about:blank#fragment", "about:srcdoc", "data:text/html,", "https://outside.example.test/"]) {
      exact.setSnapshot({ html: "", url, title: "" });
      await assert.rejects(exact.manager.read(owner, info.sessionId), isFailure("job_mismatch"));
    }
    assert.deepEqual(exact.navigations, [source]);
    assert.equal(exact.count().closed, 0);
  } finally { await exact.manager.closeAll(); }
});

test("inspect只把ready精确aboutblank归为空白，不采纳其gate或推翻最近网络响应", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const request = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    f.page.emit("request", request);
    f.page.emit("response", { request: () => request, status: () => 200 });
    await f.commitDocument(request);
    f.setSnapshot({ html: "", url: "about:blank", title: "private-title", gate: "verification_required", pageLoad: { readyState: "complete", content: "empty", visibleFrames: 0 } });
    const blank = await f.manager.inspect(owner, info.sessionId);
    assert.equal(blank.pageState, "blank");
    assert.equal(blank.snapshotState, "ready");
    assert.equal(blank.gate, undefined);
    assert.deepEqual(blank.pageLoad, { readyState: "complete", content: "empty", visibleFrames: 0 });
    assert.deepEqual(blank.mainDocument, { state: "response", status: 200 }, "表示最近网络响应，不将无网络的空白页说成新HTTP响应");
    assert.doesNotMatch(JSON.stringify(blank), /private|about:|title|url/);
    for (const url of ["about:blank#fragment", "about:srcdoc", "https://outside.example.test/"]) {
      f.setSnapshot({ html: "", url, title: "" });
      assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "unknown");
    }
    f.setSnapshot({ html: "", url: "about:blank", title: "", oversized: true });
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "unknown");
    f.page.evaluate = async () => { throw new Error("Execution context was destroyed"); };
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "unknown");
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("多次读取与检查变化中的平台非岗位页不导航，随后验证仍保留现场", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const transitUrl = "https://m.zhipin.com/fixture-loading";
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.setSnapshot({ url: transitUrl, title: "加载中", html: `<main>加载步骤 ${attempt}</main>` });
      const before = f.count().snapshots;
      await assert.rejects(f.manager.read(owner, info.sessionId), error => {
        assert.ok(error instanceof JdExtractionError);
        assert.equal(error.failure.code, "unsupported_page");
        assert.match(error.failure.message, /自行返回原岗位/);
        return true;
      });
      assert.equal(f.count().snapshots, before + 1, "可确认的非岗位页立即结束本次读取");
      assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "platform_intermediate");
      assert.equal(f.page.url(), transitUrl);
      assert.deepEqual(f.navigations, [source]);
      assert.equal(f.count().closed, 0);
    }
    f.setSnapshot({ url: transitUrl, title: "", html: "", gate: "verification_required" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("verification_required"));
    assert.equal((await f.manager.inspect(owner, info.sessionId)).gate, "verification_required");
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("四个平台的无gate中转页均不自动返回岗位，读取与检查保留当前页面", async () => {
  for (const jobUrl of [source, "https://msearch.51job.com/jobs/all/123456789.html", "https://m.liepin.com/job/123456789.shtml", "https://www.linkedin.com/jobs/view/123456789/"]) {
    const f = fixture();
    try {
      const info = await f.manager.start(owner, jobUrl);
      const transitUrl = new URL("/fixture-auth-complete", jobUrl).href;
      f.setSnapshot({ html: "<main>登录完成</main>", url: transitUrl, title: "登录完成" });
      await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("unsupported_page"));
      assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "platform_intermediate");
      assert.deepEqual(f.navigations, [jobUrl]);
      assert.equal(f.page.url(), transitUrl);
      assert.equal(f.count().closed, 0);
      assert.equal(f.count().launched, 1);
    } finally { await f.manager.closeAll(); }
  }
});

test("允许的验证码资源页与平台中转页均保留，用户自行返回原岗位后才成功读取", async () => {
  const f = fixture();
  const liepinSource = "https://m.liepin.com/job/1984701079.shtml?mscid=anonymous";
  const job = { html: `<title>匿名研发职位</title><div class="job-intro-content">${description}</div>`, url: liepinSource, title: "匿名研发职位" };
  try {
    const info = await f.manager.start(owner, liepinSource);
    for (const url of ["https://turing.captcha.gtimg.com/fixture-intermediate", "https://wow.liepin.com/fixture-intermediate"]) {
      f.setSnapshot({ html: "<main>中转完成</main>", url, title: "" });
      await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("unsupported_page"));
      assert.equal(f.page.url(), url);
      assert.deepEqual(f.navigations, [liepinSource]);
    }
    f.setSnapshot(job);
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.deepEqual(f.navigations, [liepinSource]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("检查当前窗口不导航且不返回认证正文，安全验证后同一会话仍可读原岗位", async () => {
  const f = fixture();
  const liepinSource = "https://m.liepin.com/job/1984701079.shtml?mscid=anonymous";
  const notice = "行为异常。尊敬的客户您好，猎聘安全中心发现您的帐号或IP可能存在异常，为了保障您的账号及资源安全，请进行安全验证。";
  try {
    const info = await f.manager.start(owner, liepinSource);
    f.setSnapshot({ html: `<main>${notice}</main>`, url: "https://wow.liepin.com/t1012695/4410f519.html?privateToken=secret", title: "private account name" });
    assert.deepEqual(await f.manager.inspect(owner, info.sessionId), { pageState: "platform_intermediate", gate: "verification_required", resources: [], mainDocument: { state: "response", status: 200 }, mainDocumentRequests: 1, truncated: false, blockedPopups: 0, blockedSockets: 0, snapshotState: "ready", pageLoad: unknownPageLoad, scriptErrors: 0 });
    assert.deepEqual(f.navigations, [liepinSource]);
    assert.equal(f.count().closed, 0);
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("verification_required"));
    f.setSnapshot({ html: `<title>匿名研发职位</title><div class="job-intro-content">${description}</div>`, url: liepinSource, title: "匿名研发职位" });
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    assert.deepEqual(f.navigations, [liepinSource]);
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.equal(f.count().launched, 1);
    assert.equal(f.contexts.length, 1);
  } finally { await f.manager.closeAll(); }
});

test("检查区分原岗正文、错岗、平台中转和未知页，登录/验证状态独立返回", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    f.setSnapshot({ html, url: "https://m.zhipin.com/mpa/html/weijd/weijd-job/differentJob", title: "" });
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "different_job");
    f.setSnapshot({ html: "", url: source, title: "", gate: "login_required" });
    assert.deepEqual(await f.manager.inspect(owner, info.sessionId), { pageState: "unknown", gate: "login_required", resources: [], mainDocument: { state: "response", status: 200 }, mainDocumentRequests: 1, truncated: false, blockedPopups: 0, blockedSockets: 0, snapshotState: "ready", pageLoad: unknownPageLoad, scriptErrors: 0 });
    f.setSnapshot({ html: "", url: "https://m.zhipin.com/web/passport/zp/security.html", title: "" });
    assert.deepEqual(await f.manager.inspect(owner, info.sessionId), { pageState: "platform_intermediate", gate: "verification_required", resources: [], mainDocument: { state: "response", status: 200 }, mainDocumentRequests: 1, truncated: false, blockedPopups: 0, blockedSockets: 0, snapshotState: "ready", pageLoad: unknownPageLoad, scriptErrors: 0 });
    f.setSnapshot({ html: "<main>安全验证工程师</main>", url: source, title: "" });
    assert.deepEqual(await f.manager.inspect(owner, info.sessionId), { pageState: "unknown", resources: [], mainDocument: { state: "response", status: 200 }, mainDocumentRequests: 1, truncated: false, blockedPopups: 0, blockedSockets: 0, snapshotState: "ready", pageLoad: unknownPageLoad, scriptErrors: 0 });
    f.setSnapshot({ html, url: "https://m.zhipin.com.evil.test/", title: "", gate: "login_required" });
    assert.deepEqual(await f.manager.inspect(owner, info.sessionId), { pageState: "unknown", resources: [], mainDocument: { state: "response", status: 200 }, mainDocumentRequests: 1, truncated: false, blockedPopups: 0, blockedSockets: 0, snapshotState: "ready", pageLoad: unknownPageLoad, scriptErrors: 0 });
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
});

test("inspect明确区分导航中、快照失败和超大页面，恢复后ready且始终不导航", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const evaluate = f.page.evaluate;
    f.page.evaluate = async () => { throw new Error("Execution context was destroyed, most likely because of a navigation: private-secret"); };
    const navigation = await f.manager.inspect(owner, info.sessionId);
    assert.equal(navigation.snapshotState, "navigation_in_progress");
    assert.equal(navigation.pageState, "unknown");
    assert.equal(navigation.gate, undefined);
    assert.deepEqual(navigation.pageLoad, unknownPageLoad);
    f.page.evaluate = async () => { throw new Error("private-secret unrelated evaluation failure"); };
    const failed = await f.manager.inspect(owner, info.sessionId);
    assert.equal(failed.snapshotState, "failed");
    assert.equal(failed.pageState, "unknown");
    assert.deepEqual(failed.pageLoad, unknownPageLoad);
    assert.doesNotMatch(JSON.stringify([navigation, failed]), /private-secret|Execution context|evaluation/);
    f.page.evaluate = evaluate;
    f.setSnapshot({ html: "", url: source, title: "", oversized: true, pageLoad: { readyState: "complete", content: "embedded_content", visibleFrames: 1 } });
    const oversized = await f.manager.inspect(owner, info.sessionId);
    assert.equal(oversized.snapshotState, "oversized");
    assert.deepEqual(oversized.pageLoad, unknownPageLoad);
    f.setSnapshot({ html: "长".repeat(750_000), url: source, title: "" });
    assert.equal((await f.manager.inspect(owner, info.sessionId)).snapshotState, "oversized");
    f.setSnapshot({ html, url: source, title: "匿名研发职位" });
    const ready = await f.manager.inspect(owner, info.sessionId);
    assert.equal(ready.snapshotState, "ready");
    assert.equal(ready.pageState, "original_job");
    assert.deepEqual(ready.pageLoad, unknownPageLoad, "旧mock未附加载信息时不能推断页面空白或完成");
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("快照自称空白或原岗位但与实际地址不符时拒绝HTML，保留会话且可恢复", async () => {
  const waits: number[] = [];
  const f = fixture({ sleep: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); f.advance(ms); } });
  try {
    const info = await f.manager.start(owner, source);
    const evaluate = f.page.evaluate;
    for (const [actual, candidate] of [
      [source, { html: "", url: "about:blank", title: "private-title", gate: "login_required" }],
      ["https://m.zhipin.com/mpa/html/weijd/weijd-job/anotherJob", { html, url: source, title: "private-title" }],
    ] as const) {
      f.setPageUrl(actual);
      f.page.evaluate = async () => candidate;
      const inspection = await f.manager.inspect(owner, info.sessionId);
      assert.equal(inspection.snapshotState, "failed");
      assert.equal(inspection.pageState, "unknown");
      assert.equal(inspection.gate, undefined);
      assert.deepEqual(inspection.pageLoad, unknownPageLoad);
      const sleptBefore = waits.reduce((sum, ms) => sum + ms, 0);
      await assert.rejects(f.manager.read(owner, info.sessionId), (error: unknown) => {
        assert.ok(error instanceof JdExtractionError);
        assert.equal(error.failure.code, "unsupported_page");
        assert.match(error.failure.message, /快照.*来源一致/);
        return true;
      });
      const waited = waits.reduce((sum, ms) => sum + ms, 0) - sleptBefore;
      assert.ok(waited >= 2_400 && waited <= 2_800, "连续来源不一致只进行有界等待");
      assert.equal(f.page.url(), actual, "不能把伪造快照改写为实际URL并采用HTML");
      assert.equal(f.count().closed, 0);
      assert.deepEqual(f.navigations, [source]);
      assert.doesNotMatch(JSON.stringify(inspection), /private|title|https?:/);
    }
    f.setSnapshot({ html, url: source, title: "匿名研发职位" });
    f.page.evaluate = evaluate;
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
});

test("快照的运行时形状非法只返回可读失败，不泄露异常或误采正文", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    for (const candidate of [
      undefined, null, false, 42, "private-value", [], {},
      { html: null, url: source, title: "" },
      { html, url: null, title: "" },
      { html, url: source },
      { html, url: source, title: 1 },
      { html, url: source, title: "", gate: "private-invalid-gate" },
      { html, url: source, title: "", oversized: "true" },
      { html, url: source, title: "", pageLoad: null },
      { html, url: source, title: "", pageLoad: { readyState: "complete", content: "empty", visibleFrames: "0" } },
      { get html() { throw new Error("private-getter-error"); }, url: source, title: "" },
    ]) {
      f.page.evaluate = async () => candidate;
      const inspection = await f.manager.inspect(owner, info.sessionId);
      assert.equal(inspection.snapshotState, "failed");
      assert.equal(inspection.pageState, "unknown");
      assert.equal(inspection.gate, undefined);
      assert.deepEqual(inspection.pageLoad, unknownPageLoad);
      await assert.rejects(f.manager.read(owner, info.sessionId), (error: unknown) => {
        assert.ok(error instanceof JdExtractionError, "未知形状不能冒出TypeError");
        assert.equal(error.failure.code, "unsupported_page");
        assert.doesNotMatch(error.failure.message, /private|TypeError|getter/);
        return true;
      });
      assert.equal(f.count().closed, 0);
      assert.deepEqual(f.navigations, [source]);
    }
  } finally { await f.manager.closeAll(); }
});

test("快照期间地址变化或同文档A到B再回A均丢弃旧内容，子帧导航不干扰", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const request = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    f.page.emit("request", request);
    f.page.emit("response", { request: () => request, status: () => 200 });
    await f.commitDocument(request);
    const evaluate = f.page.evaluate;
    for (const returnsToOriginal of [false, true]) {
      const old = deferred<unknown>();
      f.page.evaluate = () => old.promise;
      const inspecting = f.manager.inspect(owner, info.sessionId);
      f.setPageUrl(`${source}#next`);
      if (returnsToOriginal) {
        f.page.emit("framenavigated", f.page.mainFrame());
        f.setPageUrl(source);
        f.page.emit("framenavigated", f.page.mainFrame());
      }
      old.resolve({ html, url: source, title: "private-old-title", gate: "login_required" });
      const discarded = await inspecting;
      assert.equal(discarded.snapshotState, "navigation_in_progress");
      assert.equal(discarded.pageState, "unknown");
      assert.equal(discarded.gate, undefined);
      assert.deepEqual(discarded.pageLoad, unknownPageLoad);
      assert.deepEqual(discarded.mainDocument, { state: "response", status: 200 }, "同文档导航代数不得改变最近网络状态");
      f.setPageUrl(source);
    }
    f.page.evaluate = async () => {
      f.page.emit("framenavigated", { page: () => f.page } as unknown as Frame);
      return evaluate();
    };
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("两次read快照之间的主帧A到B再回A重置真实岗位正文稳定计时", async () => {
  let sleeps = 0;
  const f = fixture({ sleep: async (ms, signal) => {
    signal.throwIfAborted();
    f.advance(ms);
    if (++sleeps === 1) {
      const current = f.page.url();
      f.setPageUrl(`${current}#transient`);
      f.page.emit("framenavigated", f.page.mainFrame());
      f.setPageUrl(current);
      f.page.emit("framenavigated", f.page.mainFrame());
    }
  } });
  try {
    const info = await f.manager.start(owner, source);
    let attempts = 0;
    const evaluate = f.page.evaluate;
    f.page.evaluate = () => { attempts += 1; return evaluate(); };
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.equal(attempts, 4, "返回相同正文后仍需连续800ms，不能累计离开前的稳定时间");
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("主文档响应已到但未提交时inspect立即导航中，不读取旧DOM；只有当前Request提交才恢复", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const before = f.count().snapshots;
    const current = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    f.page.emit("request", current);
    f.page.emit("response", { request: () => current, status: () => 200 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const loading = await f.manager.inspect(owner, info.sessionId);
      assert.equal(loading.snapshotState, "navigation_in_progress");
      assert.equal(loading.pageState, "unknown");
      assert.deepEqual(loading.mainDocument, { state: "response", status: 200 }, "网络响应与文档提交是独立状态");
      assert.equal(loading.gate, undefined);
      assert.deepEqual(loading.pageLoad, unknownPageLoad);
    }
    assert.equal(f.count().snapshots, before, "未提交时不读取旧文档");
    f.page.emit("framenavigated", f.page.mainFrame());
    f.page.emit("commit", null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.manager.inspect(owner, info.sessionId)).snapshotState, "navigation_in_progress", "same-document提交没有新主资源");
    const other = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    await f.commitDocument(other);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).snapshotState, "navigation_in_progress", "任意framenavigated或别的Request不能证明当前提交");
    await f.commitDocument(current);
    const ready = await f.manager.inspect(owner, info.sessionId);
    assert.equal(ready.snapshotState, "ready");
    assert.equal(ready.pageState, "original_job");
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("read正文稳定期间同URL新Request响应未提交不能采用旧DOM，真实提交后重新连续稳定", async () => {
  let sleeping = 0;
  let next: Request | undefined;
  let atCommit = -1;
  const f = fixture({ sleep: async (ms, signal) => {
    signal.throwIfAborted(); f.advance(ms);
    sleeping += 1;
    if (sleeping === 1) {
      next = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
      f.page.emit("request", next);
      f.page.emit("response", { request: () => next, status: () => 200 });
    } else if (sleeping === 4) {
      assert.equal(f.count().snapshots, 1, "超800ms仍不得采用或读取未提交前的旧DOM");
      assert.ok(next);
      atCommit = sleeping;
      await f.commitDocument(next);
    }
  } });
  try {
    const info = await f.manager.start(owner, source);
    const result = await f.manager.read(owner, info.sessionId);
    assert.match(result.text, /设备通信/);
    assert.equal(atCommit, 4, "旧代码会在第三次快照误采旧DOM而不等提交");
    assert.equal(sleeping, 6, "真正提交后重新连续稳定800ms");
    assert.equal(f.count().snapshots, 4);
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
});

test("旧Request迟到提交不覆盖新等待，读取取消保留同页且当前文档完成后可重试", async () => {
  const sleeping = deferred<void>();
  const release = deferred<void>();
  const f = fixture({ sleep: async (_ms, signal) => { sleeping.resolve(); await release.promise; signal.throwIfAborted(); } });
  try {
    const info = await f.manager.start(owner, source);
    const first = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    const second = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    for (const request of [first, second]) {
      f.page.emit("request", request);
      f.page.emit("response", { request: () => request, status: () => 200 });
    }
    await f.commitDocument(first);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).snapshotState, "navigation_in_progress");
    const controller = new AbortController();
    const reason = new DOMException("cancel manual document commit", "AbortError");
    const reading = f.manager.read(owner, info.sessionId, controller.signal);
    const rejected = assert.rejects(reading, (error: unknown) => error === reason);
    await sleeping.promise;
    controller.abort(reason);
    await rejected;
    await f.commitDocument(second);
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.count().closed, 0);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).snapshotState, "ready");
    assert.deepEqual(f.navigations, [source]);
  } finally { release.resolve(); await f.manager.closeAll(); }
});

test("同URL响应200后ERR_ABORTED未提交时不采用旧DOM，新Request真实提交后仍可恢复", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const before = f.count().snapshots;
    const aborted = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame(), failure: () => ({ errorText: "net::ERR_ABORTED" }) });
    f.page.emit("request", aborted);
    f.page.emit("response", { request: () => aborted, status: () => 200 });
    const pending = await f.manager.inspect(owner, info.sessionId);
    assert.deepEqual(pending.mainDocument, { state: "response", status: 200 });
    assert.equal(pending.snapshotState, "navigation_in_progress");
    f.page.emit("requestfailed", aborted);
    const failed = await f.manager.inspect(owner, info.sessionId);
    assert.equal(failed.snapshotState, "failed");
    assert.equal(failed.pageState, "unknown");
    assert.equal(failed.gate, undefined);
    assert.deepEqual(failed.mainDocument, { state: "failed" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("unsupported_page"));
    assert.equal(f.count().snapshots, before, "未提交或已取消的主文档不能读取此前页面残留的完整正文");
    await f.commitDocument(aborted);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).snapshotState, "failed", "失败请求的迟到commit不能复活");
    const recovered = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    f.page.emit("request", recovered);
    f.page.emit("response", { request: () => recovered, status: () => 200 });
    await f.commitDocument(recovered);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    assert.match((await f.manager.read(owner, info.sessionId)).text, /设备通信/);
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("主文档pending时检查不执行DOM快照且保留会话，响应后可继续检查原岗位", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const evaluate = f.page.evaluate;
    let attemptedSnapshots = 0;
    f.page.evaluate = async () => { attemptedSnapshots += 1; throw new Error("pending时不应读取认证正文"); };
    const navigation = diagnosticRequest(`${source}&private=pending`, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    f.page.emit("request", navigation);
    for (let index = 0; index < 2; index++) {
      const result = await f.manager.inspect(owner, info.sessionId);
      assert.equal(result.snapshotState, "navigation_in_progress");
      assert.equal(result.pageState, "unknown");
      assert.deepEqual(result.pageLoad, unknownPageLoad);
      assert.deepEqual(result.mainDocument, { state: "pending" });
      assert.equal(result.gate, undefined);
    }
    assert.equal(attemptedSnapshots, 0);
    assert.equal(f.count().closed, 0);
    assert.deepEqual(f.navigations, [source]);
    f.page.emit("response", { request: () => navigation, status: () => 200 });
    await f.commitDocument(navigation);
    f.page.evaluate = evaluate;
    const recovered = await f.manager.inspect(owner, info.sessionId);
    assert.equal(recovered.snapshotState, "ready");
    assert.equal(recovered.pageState, "original_job");
    assert.deepEqual(recovered.mainDocument, { state: "response", status: 200 });
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("检查开始后才导航的挂起快照有界返回pending，迟到结果不采用且会话仍可用", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const evaluate = f.page.evaluate;
    const late = deferred<unknown>();
    f.page.evaluate = () => late.promise;
    const inspecting = f.manager.inspect(owner, info.sessionId);
    const navigation = diagnosticRequest(`${source}&private=racing`, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    f.page.emit("request", navigation);
    f.timer(1_000);
    const pending = await inspecting;
    assert.equal(pending.snapshotState, "navigation_in_progress");
    assert.equal(pending.pageState, "unknown");
    assert.deepEqual(pending.pageLoad, unknownPageLoad);
    assert.deepEqual(pending.mainDocument, { state: "pending" });
    assert.equal(pending.gate, undefined);
    assert.equal(f.count().closed, 0);
    late.resolve({ html: "private-late-content", url: source, title: "private-title", gate: "login_required", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 3 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.manager.inspect(owner, info.sessionId)).snapshotState, "navigation_in_progress");
    assert.equal(pending.gate, undefined, "迟到的旧快照不会修改已返回结果");
    f.page.emit("response", { request: () => navigation, status: () => 200 });
    await f.commitDocument(navigation);
    f.page.evaluate = evaluate;
    const ready = await f.manager.inspect(owner, info.sessionId);
    assert.equal(ready.snapshotState, "ready");
    assert.equal(ready.gate, undefined);
    assert.equal(ready.pageState, "original_job");
    assert.deepEqual(f.navigations, [source]);
    assert.equal(f.count().closed, 0);
    assert.doesNotMatch(JSON.stringify([pending, ready]), /private|late-content|title|https?:/);
  } finally { await f.manager.closeAll(); }
});

test("快照开始后导航已完成也丢弃旧登录或正文，不返回矛盾状态", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const evaluate = f.page.evaluate;
    const old = deferred<unknown>();
    f.page.evaluate = () => old.promise;
    const inspecting = f.manager.inspect(owner, info.sessionId);
    const navigation = diagnosticRequest(`${source}&private=new-document`, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    f.page.emit("request", navigation);
    f.page.emit("response", { request: () => navigation, status: () => 200 });
    await f.commitDocument(navigation);
    old.resolve({ html, url: source, title: "private-title", gate: "login_required", pageLoad: { readyState: "complete", content: "visible_text", visibleFrames: 2 } });
    const discarded = await inspecting;
    assert.equal(discarded.snapshotState, "navigation_in_progress");
    assert.equal(discarded.pageState, "unknown");
    assert.deepEqual(discarded.pageLoad, unknownPageLoad);
    assert.deepEqual(discarded.mainDocument, { state: "response", status: 200 });
    assert.equal(discarded.gate, undefined);
    f.page.evaluate = evaluate;
    const fresh = await f.manager.inspect(owner, info.sessionId);
    assert.equal(fresh.snapshotState, "ready");
    assert.equal(fresh.pageState, "original_job");
    assert.equal(fresh.gate, undefined);
    assert.equal(f.count().closed, 0);
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
});

test("非导航快照挂起只返回failed并保留会话，关闭后迟到快照不能复活", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const late = deferred<unknown>();
    f.page.evaluate = () => late.promise;
    const inspecting = f.manager.inspect(owner, info.sessionId);
    f.timer(1_000);
    const result = await inspecting;
    assert.equal(result.snapshotState, "failed");
    assert.deepEqual(result.mainDocument, { state: "response", status: 200 });
    assert.deepEqual(result.pageLoad, unknownPageLoad);
    assert.equal(f.count().closed, 0);
    await f.manager.close(owner, info.sessionId);
    late.resolve({ html, url: source, title: "private-title" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.count().closed, 1);
    await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_session_expired"));
  } finally { await f.manager.closeAll(); }
});

test("inspect仅返回枚举加载状态与受限计数，缺失或无效测量严格未知", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    for (const measured of [
      { readyState: "loading", content: "empty", visibleFrames: 0 },
      { readyState: "interactive", content: "visible_text", visibleFrames: 2 },
      { readyState: "complete", content: "embedded_content", visibleFrames: 1000 },
    ] as const) {
      f.setSnapshot({ html: "<main>private-page-content</main>", url: source, title: "private-title", pageLoad: { ...measured, text: "private-text", frameUrl: "private-frame-url" } as BrowserSessionInspection["pageLoad"] });
      const result = await f.manager.inspect(owner, info.sessionId);
      assert.deepEqual(result.pageLoad, measured);
      assert.equal(result.scriptErrors, 0);
      assert.doesNotMatch(JSON.stringify(result), /private|frameUrl|https?:|stack|message/);
      result.pageLoad.visibleFrames = 99;
      assert.deepEqual((await f.manager.inspect(owner, info.sessionId)).pageLoad, measured, "返回对象不共享测量引用");
    }
    for (const invalid of [
      { readyState: "unknown", content: "visible_text", visibleFrames: 3 },
      { readyState: "complete", content: "unknown", visibleFrames: 3 },
      { readyState: "private-secret", content: "visible_text", visibleFrames: 1 },
      { readyState: "complete", content: "private-secret", visibleFrames: 0 },
      { readyState: "complete", content: "embedded_content", visibleFrames: -1 },
      { readyState: "complete", content: "embedded_content", visibleFrames: 1001 },
      { readyState: "complete", content: "embedded_content", visibleFrames: 1.5 },
      { readyState: "complete", content: "embedded_content", visibleFrames: Number.NaN },
    ]) {
      f.page.evaluate = async () => ({ html, url: source, title: "private-title", pageLoad: invalid });
      const result = await f.manager.inspect(owner, info.sessionId);
      assert.deepEqual(result.pageLoad, unknownPageLoad);
      assert.doesNotMatch(JSON.stringify(result), /private-secret|private-title/);
    }
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
});

test("脚本异常仅按pageerror事件计数并封顶，不读取消息或stack且不带入新会话", async () => {
  const f = fixture();
  let privateReads = 0;
  const privateError = new Error("private-secret");
  Object.defineProperty(privateError, "message", { get: () => { privateReads += 1; return "private-secret"; } });
  Object.defineProperty(privateError, "stack", { get: () => { privateReads += 1; return "private-stack"; } });
  try {
    const info = await f.manager.start(owner, source);
    f.page.emit("console", privateError);
    f.page.emit("requestfailed", diagnosticRequest("https://resource.example.test/fail.js"));
    assert.equal((await f.manager.inspect(owner, info.sessionId)).scriptErrors, 0);
    f.page.emit("pageerror", privateError);
    const first = await f.manager.inspect(owner, info.sessionId);
    assert.equal(first.scriptErrors, 1);
    assert.doesNotMatch(JSON.stringify(first), /private|message|stack/);
    for (let index = 0; index < 1005; index++) f.page.emit("pageerror", privateError);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).scriptErrors, 1000);
    await f.manager.close(owner, info.sessionId);
    f.page.emit("pageerror", privateError);
    await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_session_expired"));
    assert.equal(privateReads, 0);
  } finally { await f.manager.closeAll(); }
  const fresh = fixture();
  try {
    const info = await fresh.manager.start(owner, source);
    assert.equal((await fresh.manager.inspect(owner, info.sessionId)).scriptErrors, 0);
  } finally { await fresh.manager.closeAll(); }
});

test("会话资源只保留去重主机/类型/结果，主动阻断不重复计失败且有30条上限", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const blocked = diagnosticRequest("https://private-user:private-password@blocked.example.test/private/path?token=private-secret");
    await f.requestRoute()({ request: () => blocked, abort: async () => undefined } as unknown as Route);
    f.page.emit("requestfailed", blocked);
    const failed = diagnosticRequest("https://img.bosszhipin.com/private-script.js?credential=private-secret");
    f.page.emit("requestfailed", failed);
    f.page.emit("requestfailed", diagnosticRequest("https://img.bosszhipin.com/another-script.js?other=private-secret"));
    const http = diagnosticRequest("https://m.zhipin.com/private/api?token=private-secret", "xhr");
    f.page.emit("response", { status: () => 403, request: () => http });
    f.page.emit("response", { status: () => 500, request: () => http });
    f.page.emit("response", { status: () => 200, request: () => diagnosticRequest("https://unreported.test/") });
    f.page.emit("requestfailed", diagnosticRequest("https://unreported.test/private.mp4", "media"));
    f.page.emit("requestfailed", diagnosticRequest("data:text/javascript,private-secret"));
    for (const url of ["https://127.0.0.1/private", "https://[::1]/private", "https://localhost/private", "https://bad_label.example/private", "https://trailing.example./private", "https://empty..example/private", `https://${"a".repeat(64)}.example/private`, `https://${Array(5).fill("a".repeat(63)).join(".")}/private`]) {
      f.page.emit("requestfailed", diagnosticRequest(url));
    }
    const inspection = await f.manager.inspect(owner, info.sessionId);
    assert.deepEqual(inspection.resources, [
      { host: "blocked.example.test", type: "script", outcome: "blocked_by_tool", detail: "blocked_by_tool", frame: "unknown" },
      { host: "img.bosszhipin.com", type: "script", outcome: "load_failed", detail: "unknown", frame: "unknown" },
      { host: "m.zhipin.com", type: "xhr", outcome: "http_error", detail: "http", frame: "unknown", httpStatus: 403 },
      { host: "m.zhipin.com", type: "xhr", outcome: "http_error", detail: "http", frame: "unknown", httpStatus: 500 },
    ]);
    assert.doesNotMatch(JSON.stringify(inspection), /private|path|token|credential|password|unreported|https?:/);
    inspection.resources[0]!.host = "mutated.test";
    assert.equal((await f.manager.inspect(owner, info.sessionId)).resources[0]!.host, "blocked.example.test");
    for (let index = 0; index < 26; index++) f.page.emit("requestfailed", diagnosticRequest(`https://resource${index}.example.test/private`, index % 2 ? "fetch" : "stylesheet"));
    assert.equal((await f.manager.inspect(owner, info.sessionId)).truncated, false);
    f.page.emit("requestfailed", diagnosticRequest("https://overflow.example.test/private"));
    const full = await f.manager.inspect(owner, info.sessionId);
    assert.equal(full.resources.length, 30);
    assert.equal(full.truncated, true);
    assert.equal(full.resources.some((item) => item.host === "overflow.example.test"), false);
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
  const clean = fixture();
  try {
    const fresh = await clean.manager.start(owner, source);
    assert.deepEqual((await clean.manager.inspect(owner, fresh.sessionId)).resources, []);
  } finally { await clean.manager.closeAll(); }
});

test("验证依赖的图片与字体失败也纳入诊断，仅返回主机且忽略media/other", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const image = diagnosticRequest("https://image.example.test/private-challenge.png?ticket=private-secret", "image");
    f.page.emit("requestfailed", image);
    f.page.emit("requestfailed", diagnosticRequest("https://image.example.test/another-challenge.png?ticket=other-secret", "image"));
    const font = diagnosticRequest("https://font.example.test/private-font.woff2?token=private-secret", "font");
    f.page.emit("response", { status: () => 403, request: () => font });
    f.page.emit("requestfailed", diagnosticRequest("https://ignored.example.test/private-video.mp4?token=private-secret", "media"));
    f.page.emit("requestfailed", diagnosticRequest("https://ignored.example.test/private-resource?token=private-secret", "other"));
    const inspection = await f.manager.inspect(owner, info.sessionId);
    assert.deepEqual(inspection.resources, [
      { host: "image.example.test", type: "image", outcome: "load_failed", detail: "unknown", frame: "unknown" },
      { host: "font.example.test", type: "font", outcome: "http_error", detail: "http", frame: "unknown", httpStatus: 403 },
    ]);
    assert.equal(inspection.truncated, false);
    assert.doesNotMatch(JSON.stringify(inspection), /private|challenge|ticket|token|secret|ignored|https?:/);
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
});

test("资源失败只按固定Chromium错误码归类，未知及异常字段不泄露原文", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const samples = [
      ["net::ERR_ABORTED", "cancelled"],
      ["net::ERR_NAME_NOT_RESOLVED", "dns"],
      ["net::ERR_TUNNEL_CONNECTION_FAILED", "proxy"],
      ["net::ERR_CONNECTION_RESET", "connection"],
      ["net::ERR_CERT_AUTHORITY_INVALID", "tls"],
      ["net::ERR_CONNECTION_TIMED_OUT", "timeout"],
      ["net::ERR_UNRECOGNIZED_PRIVATE_CODE", "other"],
      ["net::ERR_CONNECTION_RESET private-url?token=private-secret", "other"],
      ["private-secret with net::ERR_NAME_NOT_RESOLVED inside", "other"],
    ] as const;
    for (const [index, [code, detail]] of samples.entries()) {
      const host = `failure${index}.example.test`;
      const request = diagnosticRequest(`https://${host}/private-resource?token=private-secret`, "fetch", {
        failure: () => ({ errorText: code }), frame: () => f.page.mainFrame(),
      });
      f.page.emit("requestfailed", request);
      const resources = (await f.manager.inspect(owner, info.sessionId)).resources;
      assert.deepEqual(resources.find((item) => item.host === host), { host, type: "fetch", outcome: "load_failed", detail, frame: "main" });
    }
    f.page.emit("requestfailed", diagnosticRequest("https://missing.example.test/private", "script", { failure: () => null }));
    f.page.emit("requestfailed", diagnosticRequest("https://throwing.example.test/private", "script", {
      failure: () => { throw new Error("private-failure-message"); },
      frame: () => { throw new Error("private-frame-message"); },
    }));
    const inspection = await f.manager.inspect(owner, info.sessionId);
    assert.equal(inspection.resources.filter((item) => item.detail === "other").length, 3, "错误码前后附带文本不能命中白名单");
    assert.deepEqual(inspection.resources.find((item) => item.host === "throwing.example.test"), {
      host: "throwing.example.test", type: "script", outcome: "load_failed", detail: "unknown", frame: "unknown",
    });
    assert.equal(inspection.resources.every((item) => !Object.hasOwn(item, "httpStatus")), true);
    assert.doesNotMatch(JSON.stringify(inspection), /private|ERR_|errorText|message|stack|https?:|token/);
    assert.deepEqual(f.navigations, [source]);
  } finally { await f.manager.closeAll(); }
});

test("资源frame测量不可得不误中断允许的导航，HTTP错误只返回合法状态码", async () => {
  const f = fixture();
  let continued = 0;
  let aborted = 0;
  let failureReads = 0;
  try {
    const info = await f.manager.start(owner, source);
    const missingFrame = diagnosticRequest(source, "document", {
      isNavigationRequest: () => true,
      frame: () => { throw new Error("private-frame-not-ready"); },
      failure: () => { failureReads += 1; throw new Error("private-failure-not-needed"); },
    });
    await f.requestRoute()({ request: () => missingFrame, continue: async () => { continued += 1; }, abort: async () => { aborted += 1; } } as unknown as Route);
    assert.equal(continued, 1);
    assert.equal(aborted, 0);
    for (const status of [99, 200, 399, 600, 401.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      f.page.emit("response", { request: () => missingFrame, status: () => status });
    }
    assert.deepEqual((await f.manager.inspect(owner, info.sessionId)).resources, []);
    for (const status of [400, 599]) f.page.emit("response", { request: () => missingFrame, status: () => status });
    const childFrame = { page: () => f.page } as unknown as Frame;
    const child = diagnosticRequest("https://m.zhipin.com/private-child", "document", { frame: () => childFrame });
    f.page.emit("response", { request: () => child, status: () => 404 });
    const main = diagnosticRequest(source, "document", { frame: () => f.page.mainFrame() });
    f.page.emit("response", { request: () => main, status: () => 403 });
    const result = await f.manager.inspect(owner, info.sessionId);
    assert.deepEqual(result.resources.map(({ frame, detail, httpStatus }) => ({ frame, detail, httpStatus })), [
      { frame: "unknown", detail: "http", httpStatus: 400 },
      { frame: "unknown", detail: "http", httpStatus: 599 },
      { frame: "child", detail: "http", httpStatus: 404 },
      { frame: "main", detail: "http", httpStatus: 403 },
    ]);
    assert.equal(failureReads, 0, "HTTP错误不读取request.failure");
    assert.doesNotMatch(JSON.stringify(result), /private|not-ready|not-needed/);
  } finally { await f.manager.closeAll(); }
});

test("主文档只跟踪最新主frame导航，旧响应或iframe不覆盖且重导航清除旧状态", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const inspectDocument = async () => (await f.manager.inspect(owner, info.sessionId)).mainDocument;
    assert.deepEqual(await inspectDocument(), { state: "response", status: 200 });
    const first = diagnosticRequest(`${source}&private=first`, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    const second = diagnosticRequest(`${source}&private=second`, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame(), failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }) });
    f.page.emit("request", first);
    assert.deepEqual(await inspectDocument(), { state: "pending" });
    for (const status of [100, 200, 302, 399, 400, 599]) {
      f.page.emit("response", { request: () => first, status: () => status });
      assert.deepEqual(await inspectDocument(), { state: "response", status });
    }
    for (const status of [0, 99, 600, 403.5, Number.NaN]) {
      f.page.emit("response", { request: () => first, status: () => status });
      assert.deepEqual(await inspectDocument(), { state: "unknown" });
    }
    f.page.emit("response", { request: () => first, status: () => 503 });
    const beforeNavigation = await inspectDocument();
    beforeNavigation.status = 418;
    assert.deepEqual(await inspectDocument(), { state: "response", status: 503 }, "返回副本不能修改当前状态");
    f.page.emit("request", second);
    assert.deepEqual(await inspectDocument(), { state: "pending" });
    f.page.emit("response", { request: () => first, status: () => 200 });
    f.page.emit("requestfailed", first);
    const child = diagnosticRequest("https://m.zhipin.com/private-child", "document", { isNavigationRequest: () => true, frame: () => ({ page: () => f.page }) as unknown as Frame });
    const resource = diagnosticRequest("https://m.zhipin.com/private.js", "script", { frame: () => f.page.mainFrame() });
    const unknown = diagnosticRequest("https://m.zhipin.com/private-unknown", "document", { isNavigationRequest: () => true, frame: () => { throw new Error("private-frame"); } });
    for (const request of [child, resource, unknown]) {
      f.page.emit("request", request);
      f.page.emit("response", { request: () => request, status: () => 404 });
      f.page.emit("requestfailed", request);
    }
    assert.deepEqual(await inspectDocument(), { state: "pending" }, "迟到旧导航/子页面/子资源不能覆盖新导航");
    f.page.emit("requestfailed", second);
    assert.deepEqual(await inspectDocument(), { state: "failed" });
    f.page.emit("request", first);
    assert.deepEqual(await inspectDocument(), { state: "pending" }, "失败后新导航不继承旧状态或HTTP状态");
    f.page.emit("response", { request: () => first, status: () => 200 });
    assert.deepEqual(await inspectDocument(), { state: "response", status: 200 });
    assert.doesNotMatch(JSON.stringify(await f.manager.inspect(owner, info.sessionId)), /private|ERR_|https?:|token|errorText/);
    await f.manager.close(owner, info.sessionId);
    f.page.emit("request", second);
    f.page.emit("response", { request: () => first, status: () => 503 });
    f.page.emit("requestfailed", first);
    await assert.rejects(inspectDocument(), isFailure("browser_session_expired"));
  } finally { await f.manager.closeAll(); }
  const fresh = fixture();
  try {
    const info = await fresh.manager.start(owner, source);
    assert.deepEqual((await fresh.manager.inspect(owner, info.sessionId)).mainDocument, { state: "response", status: 200 });
  } finally { await fresh.manager.closeAll(); }
});

test("主页面请求计数仅累计网络主导航并封顶，子资源/子帧/同文档导航不计入且新会话重置", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    const inspectCount = async () => (await f.manager.inspect(owner, info.sessionId)).mainDocumentRequests;
    assert.equal(await inspectCount(), 1);
    f.page.emit("framenavigated", f.page.mainFrame());
    const child = diagnosticRequest("https://m.zhipin.com/private-child", "document", { isNavigationRequest: () => true, frame: () => ({ page: () => f.page }) as unknown as Frame });
    const resource = diagnosticRequest("https://m.zhipin.com/private-resource", "xhr", { frame: () => f.page.mainFrame() });
    const nonNavigation = diagnosticRequest(source, "document", { frame: () => f.page.mainFrame() });
    for (const request of [child, resource, nonNavigation]) f.page.emit("request", request);
    assert.equal(await inspectCount(), 1, "同文档地址变化及非主导航请求均不计数");
    const request = diagnosticRequest(source, "document", { isNavigationRequest: () => true, frame: () => f.page.mainFrame() });
    for (let count = 0; count < 1005; count++) f.page.emit("request", request);
    assert.equal(await inspectCount(), 1000, "只对外报告封顶值，内部导航代数继续推进");
    assert.equal(await inspectCount(), 1000, "重复检查不制造主页面请求");
    assert.deepEqual(f.navigations, [source]);
    await f.manager.close(owner, info.sessionId);
    f.page.emit("request", request);
    await assert.rejects(inspectCount(), isFailure("browser_session_expired"));
  } finally { await f.manager.closeAll(); }
  const fresh = fixture();
  try {
    const next = await fresh.manager.start(owner, source);
    assert.equal((await fresh.manager.inspect(owner, next.sessionId)).mainDocumentRequests, 1);
  } finally { await fresh.manager.closeAll(); }
});

test("inspect受owner/TTL约束，不允许其他页面获取会话诊断", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    await assert.rejects(f.manager.inspect("http://evil.test\nevil.test", info.sessionId), isFailure("browser_session_expired"));
    assert.equal(f.count().snapshots, 0);
    assert.equal(f.count().closed, 0);
    f.advance(600_001);
    await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_session_expired"));
    assert.equal(f.count().snapshots, 0);
    assert.equal(f.count().closed, 1);
  } finally { await f.manager.closeAll(); }
});

test("检查记录弹窗与WebSocket的主动阻止次数，仅context新页计一次且上限1000", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    let closed = 0;
    let socketClosed = 0;
    const popup = { close: async () => { closed += 1; } };
    f.page.emit("popup", popup);
    f.context.emit("page", popup);
    f.context.emit("page", f.page);
    f.socketRoute()({ close: () => { socketClosed += 1; } });
    let inspection = await f.manager.inspect(owner, info.sessionId);
    assert.equal(inspection.blockedPopups, 1);
    assert.equal(inspection.blockedSockets, 1);
    assert.equal(closed, 2);
    assert.equal(socketClosed, 1);
    for (let index = 0; index < 1005; index++) {
      f.context.emit("page", popup);
      f.socketRoute()({ close: () => undefined });
    }
    inspection = await f.manager.inspect(owner, info.sessionId);
    assert.equal(inspection.blockedPopups, 1000);
    assert.equal(inspection.blockedSockets, 1000);
    assert.deepEqual(inspection.resources, []);
  } finally { await f.manager.closeAll(); }
});

test("inspect与read互斥，取消或硬超时保留原页，晚快照settle前仍互斥", async () => {
  const f = fixture();
  const info = await f.manager.start(owner, source);
  const waiting = deferred<unknown>();
  f.page.evaluate = () => waiting.promise;
  const cancellation = new AbortController();
  const inspection = f.manager.inspect(owner, info.sessionId, cancellation.signal);
  await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("browser_unavailable"));
  await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_unavailable"));
  assert.deepEqual(f.navigations, [source]);
  cancellation.abort();
  await assert.rejects(inspection, { name: "AbortError" });
  await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_unavailable"));
  waiting.resolve({ html, url: source, title: "" });
  await nextTurn();
  assert.equal(f.count().closed, 0);
  f.page.evaluate = async () => ({ html, url: source, title: "" });
  assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
  await f.manager.closeAll();

  const second = fixture();
  const next = await second.manager.start(owner, source);
  const pending = deferred<unknown>(); second.page.evaluate = () => pending.promise;
  const timeout = second.manager.inspect(owner, next.sessionId);
  second.timer(10_000);
  await assert.rejects(timeout, isFailure("timeout"));
  assert.equal(second.count().closed, 0);
  await assert.rejects(second.manager.read(owner, next.sessionId), isFailure("browser_unavailable"));
  pending.resolve({ html, url: source, title: "" });
  await nextTurn();
  second.page.evaluate = async () => ({ html, url: source, title: "" });
  assert.equal((await second.manager.inspect(owner, next.sessionId)).pageState, "original_job");
  await second.manager.closeAll();
});

test("空的平台中转页立即返回unsupported并指导自行回岗，保留窗口且不自动导航", async () => {
  const f = fixture();
  f.setNavigation(() => ({ html: "<html><body></body></html>", url: "https://wow.liepin.com/t1012695/4410f519.html", title: "" }));
  try {
    const info = await f.manager.start(owner, "https://m.liepin.com/job/1984701079.shtml?mscid=anonymous");
    await assert.rejects(f.manager.read(owner, info.sessionId), error => {
      assert.ok(error instanceof JdExtractionError);
      assert.equal(error.failure.code, "unsupported_page");
      assert.match(error.failure.message, /自行返回原岗位/);
      assert.match(error.failure.message, /窗口已保留/);
      return true;
    });
    assert.equal(f.count().snapshots, 1);
    assert.deepEqual(f.navigations, ["https://m.liepin.com/job/1984701079.shtml?mscid=anonymous"]);
    assert.equal(f.page.url(), "https://wow.liepin.com/t1012695/4410f519.html");
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("错岗位或仅有不可见结构化内容不能被人工会话当成成功JD", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    f.setSnapshot({ html, url: "https://m.zhipin.com/mpa/html/weijd/weijd-job/differentJob", title: "匿名研发职位" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("job_mismatch"));
    assert.equal(f.count().snapshots, 1);
    assert.deepEqual(f.navigations, [source]);
    f.setSnapshot({ html, url: "https://m.zhipin.com.evil.test/", title: "匿名研发职位", gate: "login_required" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("job_mismatch"));
    assert.equal(f.count().snapshots, 2);
    assert.deepEqual(f.navigations, [source]);
    const structured = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "匿名研发职位", url: source, description })}</script>`;
    f.setSnapshot({ html: `<title>匿名研发职位</title>${structured}`, url: source, title: "匿名研发职位" });
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("unsupported_page"));
    assert.equal(f.count().closed, 0);
  } finally { await f.manager.closeAll(); }
});

test("路由逐资源校验并拒绝弹窗导航，验证页允许显示，WebSocket关闭", async () => {
  const f = fixture();
  try {
    await f.manager.start(owner, source);
    for (const [url, expected] of [
      ["https://m.zhipin.com/web/passport/zp/security.html", "continue"],
      ["https://img.bosszhipin.com/anonymous.png", "continue"],
      ["https://m.zhipin.com.evil.test/", "abort"],
      ["https://127.0.0.1/", "abort"],
      ["https://www.liepin.com/", "abort"],
    ]) {
      let action = "";
      const route = { request: () => ({ url: () => url, isNavigationRequest: () => true, frame: () => ({ page: () => f.page }) }), abort: async () => { action = "abort"; }, continue: async () => { action = "continue"; } } as unknown as Route;
      await f.requestRoute()(route);
      assert.equal(action, expected);
    }
    let popupAborted = false;
    await f.requestRoute()({ request: () => ({ url: () => source, isNavigationRequest: () => true, frame: () => ({ page: () => ({}) }) }), abort: async () => { popupAborted = true; } } as unknown as Route);
    assert.equal(popupAborted, true);
    let socketClosed = false; f.socketRoute()({ close: () => { socketClosed = true; } }); assert.equal(socketClosed, true);
    let popupClosed = false; f.page.emit("popup", { close: async () => { popupClosed = true; } }); assert.equal(popupClosed, true);
    let downloadCancelled = false; f.page.emit("download", { cancel: async () => { downloadCancelled = true; } }); assert.equal(downloadCancelled, true);
  } finally { await f.manager.closeAll(); }
});

test("取消start期间迟到的launch也关闭，不创建页面，不占用后续会话", async () => {
  const pending = deferred<Browser>();
  const launched = deferred<void>();
  const f = fixture({ launch: async () => { launched.resolve(); return pending.promise; } });
  const controller = new AbortController();
  const start = f.manager.start(owner, source, controller.signal);
  await launched.promise;
  controller.abort();
  await assert.rejects(start, { name: "AbortError" });
  pending.resolve(f.browser);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.count().closed, 1);
  assert.equal(f.contexts.length, 0);
  await f.manager.closeAll();
});

test("read取消包括预取消保留本会话，未完成的底层读取继续互斥", async () => {
  const f = fixture();
  const info = await f.manager.start(owner, source);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.manager.read(owner, info.sessionId, controller.signal), { name: "AbortError" });
  assert.equal(f.count().closed, 0);
  assert.equal((await f.manager.read(owner, info.sessionId)).provenance.url, source);
  await f.manager.closeAll();
  const second = fixture();
  const info2 = await second.manager.start(owner, source);
  const waiting = deferred<unknown>();
  second.page.evaluate = () => waiting.promise;
  const cancellation = new AbortController();
  const read = second.manager.read(owner, info2.sessionId, cancellation.signal);
  await Promise.resolve(); cancellation.abort();
  await assert.rejects(read, { name: "AbortError" });
  assert.equal(second.count().closed, 0);
  await assert.rejects(second.manager.read(owner, info2.sessionId), isFailure("browser_unavailable"));
  waiting.resolve({ html, url: source, title: "匿名研发职位" });
  await nextTurn();
  second.page.evaluate = async () => ({ html, url: source, title: "匿名研发职位" });
  assert.equal((await second.manager.read(owner, info2.sessionId)).provenance.url, source);
  await second.manager.closeAll();
});

test("启动硬超时与TTL仍关闭，read硬超时保留，外部关窗和closeAll幂等清理", async () => {
  const pending = deferred<Browser>(); const called = deferred<void>();
  const f = fixture({ launch: async () => { called.resolve(); return pending.promise; } });
  const start = f.manager.start(owner, source); await called.promise;
  f.timer(30_000); await assert.rejects(start, isFailure("timeout"));
  pending.resolve(f.browser); await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.count().closed, 1);
  const second = fixture(); const info = await second.manager.start(owner, source);
  const hanging = deferred<unknown>(); second.page.evaluate = () => hanging.promise;
  const read = second.manager.read(owner, info.sessionId); await Promise.resolve(); second.timer(45_000);
  await assert.rejects(read, isFailure("timeout")); assert.equal(second.count().closed, 0);
  await assert.rejects(second.manager.inspect(owner, info.sessionId), isFailure("browser_unavailable"));
  hanging.resolve({ html, url: source, title: "" }); await nextTurn();
  second.page.evaluate = async () => ({ html, url: source, title: "" });
  assert.equal((await second.manager.inspect(owner, info.sessionId)).pageState, "original_job");
  await second.manager.closeAll(); assert.equal(second.count().closed, 1);
  const ttl = fixture(); const third = await ttl.manager.start(owner, source); ttl.timer(600_000);
  await assert.rejects(ttl.manager.read(owner, third.sessionId), isFailure("browser_session_expired")); assert.equal(ttl.count().closed, 1);
  const external = fixture(); const fourth = await external.manager.start(owner, source); external.page.emit("close");
  await assert.rejects(external.manager.read(owner, fourth.sessionId), isFailure("browser_session_expired"));
  await external.manager.closeAll(); await external.manager.closeAll(); assert.equal(external.count().closed, 1);
  const during = fixture(); const fifth = await during.manager.start(owner, source);
  const waiting = deferred<unknown>(); during.page.evaluate = () => waiting.promise;
  const reading = during.manager.read(owner, fifth.sessionId); await Promise.resolve(); during.page.emit("close");
  await assert.rejects(reading, isFailure("browser_session_expired")); waiting.resolve({ html, url: source, title: "" });
  await during.manager.closeAll();
});

test("重复close无害且旧ID不关闭新会话，closeAll等待已在关闭和迟到launch", async () => {
  const f = fixture();
  const first = await f.manager.start(owner, source);
  await f.manager.close(owner, first.sessionId);
  assert.deepEqual(await f.manager.close(owner, first.sessionId), { closed: true });
  const replacement = await f.manager.start(owner, source);
  await f.manager.close(owner, first.sessionId);
  assert.equal(f.count().closed, 1);
  await f.manager.close(owner, replacement.sessionId);
  const closePending = deferred<void>();
  const second = fixture();
  const next = await second.manager.start(owner, source);
  second.browser.close = () => closePending.promise;
  const closing = second.manager.close(owner, next.sessionId);
  let drained = false;
  const shutdown = second.manager.closeAll().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  closePending.resolve(); await closing; await shutdown; assert.equal(drained, true);

  const launchPending = deferred<Browser>(); const started = deferred<void>();
  const late = fixture({ launch: async () => { started.resolve(); return launchPending.promise; } });
  const controller = new AbortController();
  const start = late.manager.start(owner, source, controller.signal); await started.promise;
  controller.abort(); await assert.rejects(start, { name: "AbortError" });
  let settled = false;
  const all = late.manager.closeAll().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  launchPending.resolve(late.browser); await all; assert.equal(late.count().closed, 1);
});

test("人工会话HTTP接口必须严格本机同源且每个动作受owner隔离，正常响应不取消会话", async () => {
  const f = fixture();
  const server = createServer((request, response) => { void browserSessionMiddleware(request, response, f.manager); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoint = `${origin}/api/jd/browser-session`;
  const submit = (body: unknown, requestOrigin: string | undefined = origin) => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(body) });
  try {
    const withoutOrigin = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", input: source }) });
    assert.equal(withoutOrigin.status, 403);
    assert.equal((await submit({ action: "start", input: source }, "https://evil.test")).status, 403);
    const hostile = await new Promise<number>((resolve, reject) => { const request = httpRequest(endpoint, { method: "POST", headers: { Host: "evil.test", Origin: "http://evil.test", "Content-Type": "application/json" } }, (response) => { response.resume(); resolve(response.statusCode!); }); request.on("error", reject); request.end("{}"); });
    assert.equal(hostile, 403);
    const started = await submit({ action: "start", input: source });
    assert.equal(started.status, 200);
    const info = await started.json() as { sessionId: string };
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.count().closed, 0);
    const inspected = await submit({ action: "inspect", sessionId: info.sessionId, target: "https://evil.test" });
    assert.equal(inspected.status, 200);
    const diagnostic = await inspected.json();
    assert.deepEqual(diagnostic, { pageState: "original_job", resources: [], mainDocument: { state: "response", status: 200 }, mainDocumentRequests: 1, truncated: false, blockedPopups: 0, blockedSockets: 0, snapshotState: "ready", pageLoad: unknownPageLoad, scriptErrors: 0 });
    const beforeFocus = f.count();
    const focused = await submit({ action: "focus", sessionId: info.sessionId, target: "https://evil.test" });
    assert.equal(focused.status, 200);
    assert.deepEqual(await focused.json(), { activationRequested: true });
    assert.equal(f.activations(), 2);
    assert.deepEqual(f.count(), beforeFocus, "activation does not read or navigate the document");
    assert.deepEqual(f.navigations, [source]);
    const read = await submit({ action: "read", sessionId: info.sessionId, target: "https://evil.test" });
    assert.equal(read.status, 200);
    assert.equal((await read.json() as { provenance: { url: string } }).provenance.url, source);
    assert.ok(f.navigations.every((url) => url === source));
    const result = await submit({ action: "close", sessionId: info.sessionId });
    assert.deepEqual(await result.json(), { closed: true });
    assert.equal((await submit({ action: "read", sessionId: info.sessionId })).status, 422);
    assert.equal((await submit({ action: "inspect", sessionId: info.sessionId })).status, 422);
    assert.equal((await submit({ action: "inspect", sessionId: "x" })).status, 400);
    assert.equal((await submit({ action: "focus", sessionId: "x" })).status, 400);
    assert.equal((await submit({ action: "focus", sessionId: info.sessionId }, "https://evil.test")).status, 403);
    assert.equal((await submit({ action: "read", sessionId: "x" })).status, 400);
  } finally { await f.manager.closeAll(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("显示岗位页只激活owned原页，拒绝不同owner/旧ID且不读取正文或延长TTL", async () => {
  const f = fixture();
  try {
    const info = await f.manager.start(owner, source);
    assert.equal(f.activations(), 1, "explicit start activates its job tab");
    await assert.rejects(f.manager.focus(`${owner}-other`, info.sessionId), isFailure("browser_session_expired"));
    await assert.rejects(f.manager.focus(owner, "previous-session-123456"), isFailure("browser_session_expired"));
    assert.equal(f.activations(), 1);
    const before = f.count();
    assert.deepEqual(await f.manager.focus(owner, info.sessionId), { activationRequested: true });
    assert.equal(f.activations(), 2);
    assert.deepEqual(f.count(), before);
    assert.deepEqual(f.navigations, [source]);
    f.advance(599_000);
    assert.deepEqual(await f.manager.focus(owner, info.sessionId), { activationRequested: true });
    f.advance(1_001);
    await assert.rejects(f.manager.focus(owner, info.sessionId), isFailure("browser_session_expired"));
    assert.equal(f.activations(), 3, "focus does not renew the original ten-minute lifetime");
  } finally { await f.manager.closeAll(); }
});

test("显示请求取消不关闭验证页，未settle的激活保持busy，预取消和晚结果不冒充成功", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const pending = deferred<void>();
  try {
    const info = await f.manager.start(owner, source);
    let calls = 0;
    Object.assign(f.page, { bringToFront: async () => { calls += 1; entered.resolve(); await pending.promise; } });
    const controller = new AbortController();
    const reason = new DOMException("cancel activation", "AbortError");
    const focusing = f.manager.focus(owner, info.sessionId, controller.signal);
    await entered.promise;
    await assert.rejects(f.manager.focus(owner, info.sessionId), isFailure("browser_unavailable"));
    await assert.rejects(f.manager.read(owner, info.sessionId), isFailure("browser_unavailable"));
    await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_unavailable"));
    controller.abort(reason);
    await assert.rejects(focusing, (error: unknown) => error === reason);
    assert.equal(f.count().closed, 0);
    await assert.rejects(f.manager.focus(owner, info.sessionId), isFailure("browser_unavailable"));
    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const preCancelled = new AbortController();
    preCancelled.abort(reason);
    await assert.rejects(f.manager.focus(owner, info.sessionId, preCancelled.signal), (error: unknown) => error === reason);
    assert.equal(calls, 1);
    assert.deepEqual(await f.manager.focus(owner, info.sessionId), { activationRequested: true });
    assert.equal(calls, 2);
    assert.equal(f.count().closed, 0);
  } finally { pending.resolve(); await f.manager.closeAll(); }
});

test("显示请求超时或激活失败保留岗位页，显式start激活失败仍可检查原页", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const pending = deferred<void>();
  try {
    Object.assign(f.page, { bringToFront: async () => { throw new Error("synthetic activation error"); } });
    const info = await f.manager.start(owner, source);
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    await assert.rejects(f.manager.focus(owner, info.sessionId), isFailure("browser_unavailable"));
    assert.equal(f.count().closed, 0);
    Object.assign(f.page, { bringToFront: async () => { entered.resolve(); await pending.promise; } });
    const focusing = f.manager.focus(owner, info.sessionId);
    await entered.promise;
    f.timer(5_000);
    await assert.rejects(focusing, isFailure("timeout"));
    assert.equal(f.count().closed, 0);
    await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_unavailable"));
    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
  } finally { pending.resolve(); await f.manager.closeAll(); }
});

test("启动的激活命令挂起五秒仍返回可用会话，busy保持到settle，显式取消仍收尾", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const pending = deferred<void>();
  try {
    Object.assign(f.page, { bringToFront: async () => { entered.resolve(); await pending.promise; } });
    const starting = f.manager.start(owner, source);
    await entered.promise;
    f.timer(5_000);
    const info = await starting;
    assert.equal(f.count().closed, 0, "activation timeout preserves the created job page");
    await assert.rejects(f.manager.inspect(owner, info.sessionId), isFailure("browser_unavailable"));
    await assert.rejects(f.manager.focus(owner, info.sessionId), isFailure("browser_unavailable"));
    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.manager.inspect(owner, info.sessionId)).pageState, "original_job");
    assert.deepEqual(f.navigations, [source]);
  } finally { pending.resolve(); await f.manager.closeAll(); }
  const cancelled = fixture();
  const enteredCancelled = deferred<void>();
  const lateActivation = deferred<void>();
  try {
    Object.assign(cancelled.page, { bringToFront: async () => { enteredCancelled.resolve(); await lateActivation.promise; } });
    const controller = new AbortController();
    const reason = new DOMException("cancel startup activation", "AbortError");
    const starting = cancelled.manager.start(owner, source, controller.signal);
    await enteredCancelled.promise;
    controller.abort(reason);
    await assert.rejects(starting, (error: unknown) => error === reason);
    assert.equal(cancelled.count().closed, 1);
    lateActivation.resolve();
  } finally { lateActivation.resolve(); await cancelled.manager.closeAll(); }
});

test("关闭中拒绝显示，close打断当前激活且旧ID不能激活后继岗位页", async () => {
  const next = fixture();
  const releaseGate = deferred<void>();
  const activationEntered = deferred<void>();
  const activationGate = deferred<void>();
  let acquisitions = 0;
  const f = fixture({ acquire: async () => {
    const page = ++acquisitions === 1 ? f.page : next.page;
    return { page: page as unknown as Page, context: f.context as unknown as BrowserContext, release: async () => { await releaseGate.promise; await page.close(); }, releasePage: async () => { await releaseGate.promise; await page.close(); } };
  } });
  try {
    const first = await f.manager.start(owner, source);
    Object.assign(f.page, { bringToFront: async () => { activationEntered.resolve(); await activationGate.promise; } });
    const focusing = f.manager.focus(owner, first.sessionId);
    await activationEntered.promise;
    const rejectedFocus = assert.rejects(focusing, isFailure("browser_session_expired"));
    const closing = f.manager.close(owner, first.sessionId);
    await rejectedFocus;
    await assert.rejects(f.manager.focus(owner, first.sessionId), isFailure("browser_session_expired"));
    await assert.rejects(f.manager.start(owner, source), isFailure("browser_unavailable"));
    releaseGate.resolve();
    activationGate.resolve();
    await closing;
    const replacement = await f.manager.start(owner, source);
    assert.equal(next.activations(), 1);
    await assert.rejects(f.manager.focus(owner, first.sessionId), isFailure("browser_session_expired"));
    assert.equal(next.activations(), 1);
    assert.deepEqual(await f.manager.focus(owner, replacement.sessionId), { activationRequested: true });
    assert.equal(next.activations(), 2);
    assert.deepEqual(next.navigations, [source]);
  } finally { releaseGate.resolve(); activationGate.resolve(); await f.manager.closeAll(); await next.manager.closeAll(); }
});
