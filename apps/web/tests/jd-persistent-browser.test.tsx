import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page, Route } from "playwright-core";
import { createPersistentJobBrowser, type PersistentJobBrowserLaunch } from "../server/jd-persistent-browser.ts";
import type { JobPlatform } from "../src/lib/jd-source.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";
import type { NetworkOperation } from "../server/network-proxy.ts";
import { createBrowserSessionManager } from "../server/jd-browser-session.ts";
import { createJobSessionRouter, type JobSessionBackend } from "../server/jd-session-router.ts";

const source = "https://m.zhipin.com/mpa/html/weijd/weijd-job/test";
const operation = (proxyUrl: string | undefined = "http://127.0.0.1:17891"): NetworkOperation => ({
  fetch: async () => assert.fail("persistent browser must not send an independent HTTP request"),
  routeFor: () => ({ mode: proxyUrl ? "manual" : "direct", source: "unit test", ...(proxyUrl ? { proxyUrl } : {}) }),
});
const allowedResource = (input: string, platform: JobPlatform): boolean => {
  try {
    const url = new URL(input);
    const domain = { "51JOB": "51job.com", BOSS直聘: "zhipin.com", 猎聘: "liepin.com", LinkedIn: "linkedin.com" }[platform];
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
};
const isUnavailable = (error: unknown) => error instanceof JdExtractionError && error.failure.code === "browser_unavailable";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class TestPage extends EventEmitter {
  closed = false;
  closes = 0;
  closeFailures = 0;
  closeWithoutConfirmation = false;
  location = "about:blank";
  readonly frame = {};
  readonly routes: Array<(route: Route) => unknown> = [];
  constructor(readonly owner: TestContext, readonly openerPage: TestPage | null = null) { super(); }
  url() { return this.location; }
  isClosed() { return this.closed; }
  mainFrame() { return this.frame; }
  opener() { return Promise.resolve(this.openerPage as unknown as Page | null); }
  async route(_pattern: string, handler: (route: Route) => unknown) { this.routes.push(handler); }
  async goto(url: string) { this.location = url; this.emit("framenavigated", this.frame); }
  async close() {
    if (this.closed) return;
    this.closes += 1;
    if (this.closeFailures > 0) { this.closeFailures -= 1; throw new Error("fixture page close rejected while still open"); }
    if (this.closeWithoutConfirmation) return;
    this.closed = true;
    this.emit("close");
  }
  asPage() { return this as unknown as Page; }
}

class TestContext extends EventEmitter {
  readonly allPages: TestPage[] = [];
  readonly routes: Array<(route: Route) => Promise<void>> = [];
  socketHandler?: (socket: { close(): unknown }) => unknown;
  newPageHook?: () => Promise<TestPage>;
  closeGate?: Promise<void>;
  closes = 0;
  closeFailures = 0;
  closeWithoutConfirmation = false;
  closed = false;
  constructor(startup = true) { super(); if (startup) this.addPage(); }
  addPage(opener: TestPage | null = null) {
    const page = new TestPage(this, opener);
    this.allPages.push(page);
    this.emit("page", page.asPage());
    return page;
  }
  pages() { return this.allPages.filter((page) => !page.closed).map((page) => page.asPage()); }
  async newPage() {
    const hook = this.newPageHook;
    this.newPageHook = undefined;
    return (hook ? await hook() : this.addPage()).asPage();
  }
  async route(_pattern: string, handler: (route: Route) => Promise<void>) { this.routes.push(handler); }
  async routeWebSocket(_pattern: string, handler: (socket: { close(): unknown }) => unknown) { this.socketHandler = handler; }
  async close() {
    if (this.closed) return;
    this.closes += 1;
    if (this.closeFailures > 0) { this.closeFailures -= 1; throw new Error("fixture context close rejected while still open"); }
    if (this.closeWithoutConfirmation) return;
    this.closed = true;
    await this.closeGate;
    await Promise.all(this.allPages.map((page) => page.close()));
    this.emit("close");
  }
  isClosed() { return this.closed; }
  asContext() { return this as unknown as BrowserContext; }
}

async function fixture(t: test.TestContext, launch?: PersistentJobBrowserLaunch) {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "betterme-persistent-browser-"));
  const calls: Array<{ profile: string; options: Parameters<PersistentJobBrowserLaunch>[1]; context: TestContext }> = [];
  const runtime = createPersistentJobBrowser({ rootDirectory, allowedResource, launch: launch ?? (async (profile, options) => {
    const context = new TestContext();
    calls.push({ profile, options, context });
    return context.asContext();
  }) });
  t.after(async () => {
    await runtime.closeAll();
    // mkdtemp created this explicit task directory; never remove a profile root
    // supplied by a person or discovered from a daily browser installation.
    assert.ok(path.resolve(rootDirectory).startsWith(path.join(os.tmpdir(), "betterme-persistent-browser-")));
    await rm(rootDirectory, { recursive: true, force: true });
  });
  return { rootDirectory, runtime, calls };
}

test("岗位读取只关闭自己的新页，常驻Edge、保活页和专用profile在后续读取中复用", async (t) => {
  const { runtime, calls, rootDirectory } = await fixture(t);
  const first = await runtime.acquire("BOSS直聘", operation(), undefined, source);
  assert.equal(calls.length, 1);
  const { context, profile, options } = calls[0];
  const base = context.allPages[1];
  assert.equal(profile, path.join(rootDirectory, "boss", "profile"));
  assert.equal(options.channel, "msedge");
  assert.equal(options.headless, false);
  assert.equal(options.serviceWorkers, "block");
  assert.equal(options.acceptDownloads, false);
  assert.deepEqual(options.proxy, { server: "http://127.0.0.1:17891", bypass: "<-loopback>" });
  assert.equal(context.allPages[0].closed, true, "the startup tab is replaced with the owned base page");
  assert.notEqual(first.page, base.asPage());
  assert.equal(first.context, context.asContext());
  assert.deepEqual(runtime.status(), [{ platform: "BOSS直聘", state: "ready", activePages: 1 }]);
  await Promise.all([first.release(), first.releasePage(), first.release()]);
  assert.equal((first.page as unknown as TestPage).closes, 1);
  assert.equal(context.closes, 0);
  assert.equal(base.closed, false);
  assert.equal(base.url(), "about:blank");
  const second = await runtime.acquirePage("BOSS直聘", operation(), { targetUrl: source });
  assert.equal(calls.length, 1);
  assert.equal(second.context, first.context);
  assert.notEqual(second.page, first.page);
  await second.releasePage();
  assert.equal(context.closes, 0);
  assert.deepEqual(context.pages(), [base.asPage()]);
  await runtime.closeAll();
  assert.equal(context.closes, 1);
  await access(profile);
  assert.deepEqual(runtime.status(), []);
});

test("各平台用固定子目录隔离，精确原URL决定网络快照，不接受平台路径注入", async (t) => {
  const { runtime, calls, rootDirectory } = await fixture(t);
  const targets: string[] = [];
  const network = operation(undefined);
  network.routeFor = (url) => { targets.push(url.href); return { mode: "direct", source: "fixture" }; };
  const urls = [source, "https://msearch.51job.com/jobs/all/123.html", "https://m.liepin.com/job/123.shtml", "https://www.linkedin.com/jobs/view/123"];
  const platforms = ["BOSS直聘", "51JOB", "猎聘", "LinkedIn"] as const;
  for (let i = 0; i < platforms.length; i += 1) await (await runtime.acquire(platforms[i], network, undefined, urls[i])).release();
  assert.deepEqual(targets, urls);
  assert.deepEqual(calls.map((call) => call.profile), ["boss", "51job", "liepin", "linkedin"].map((name) => path.join(rootDirectory, name, "profile")));
  assert.equal(new Set(calls.map((call) => call.profile)).size, 4);
  for (const call of calls) {
    assert.equal(call.options.proxy, undefined);
    assert.deepEqual(call.options.args, ["--no-proxy-server"]);
    assert.ok(!path.relative(rootDirectory, call.profile).startsWith(".."));
  }
  await assert.rejects(runtime.acquire("../Default" as JobPlatform, network), isUnavailable);
  await assert.rejects(runtime.acquire("BOSS直聘", network, undefined, "https://m.liepin.com/job/123.shtml"), isUnavailable);
  assert.equal(calls.length, 4);
});

test("同平台并发只启动一个context，释放其中一页不影响另一页", async (t) => {
  const launched = deferred<BrowserContext>();
  const started = deferred<void>();
  let launches = 0;
  const { runtime } = await fixture(t, async () => { launches += 1; started.resolve(); return launched.promise; });
  const first = runtime.acquire("BOSS直聘", operation());
  const second = runtime.acquire("BOSS直聘", operation());
  await started.promise;
  assert.equal(launches, 1);
  const context = new TestContext();
  launched.resolve(context.asContext());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.context, b.context);
  assert.notEqual(a.page, b.page);
  assert.equal(runtime.status()[0].activePages, 2);
  await a.release();
  assert.equal(b.page.isClosed(), false);
  assert.equal(context.closes, 0);
  assert.equal(runtime.status()[0].activePages, 1);
  await b.release();
  assert.equal(context.pages().length, 1);
});

test("启动前取消不创建目录或启动Edge", async (t) => {
  const { runtime, calls, rootDirectory } = await fixture(t);
  const controller = new AbortController();
  const reason = new DOMException("cancel before persistent launch", "AbortError");
  controller.abort(reason);
  await assert.rejects(runtime.acquire("BOSS直聘", operation(), controller.signal), (error) => error === reason);
  assert.equal(calls.length, 0);
  await assert.rejects(access(path.join(rootDirectory, "boss")), { code: "ENOENT" });
});

test("唯一等待者取消后迟到launch必须回收，期间不能重复争用profile，closeAll等待清理", async (t) => {
  const launched = deferred<BrowserContext>();
  const started = deferred<void>();
  const controller = new AbortController();
  const reason = new DOMException("cancel while persistent launch pending", "AbortError");
  let launches = 0;
  const { runtime } = await fixture(t, async () => { launches += 1; started.resolve(); return launched.promise; });
  const pending = runtime.acquire("BOSS直聘", operation(), controller.signal);
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.deepEqual(runtime.status(), []);
  await assert.rejects(runtime.acquire("BOSS直聘", operation()), isUnavailable);
  assert.equal(launches, 1);
  let closed = false;
  const closing = runtime.closeAll().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  const context = new TestContext();
  launched.resolve(context.asContext());
  await closing;
  assert.equal(context.closes, 1);
  assert.equal(context.allPages.length, 1, "cancelled launch creates no base or job pages");
});

test("并发启动的一个等待者取消不终止另一等待者或常驻context", async (t) => {
  const launched = deferred<BrowserContext>();
  const started = deferred<void>();
  const controller = new AbortController();
  const reason = new DOMException("cancel one waiter", "AbortError");
  const { runtime } = await fixture(t, async () => { started.resolve(); return launched.promise; });
  const a = runtime.acquire("BOSS直聘", operation(), controller.signal);
  const b = runtime.acquire("BOSS直聘", operation());
  await started.promise;
  controller.abort(reason);
  await assert.rejects(a, (error) => error === reason);
  const context = new TestContext();
  launched.resolve(context.asContext());
  const lease = await b;
  assert.equal(context.closes, 0);
  assert.equal(runtime.status()[0].activePages, 1);
  await lease.release();
  assert.equal(context.closes, 0);
});

test("显式关闭启动中的平台会立即拒绝等待者，迟到context退出后才允许同profile重开", async (t) => {
  const firstLaunch = deferred<BrowserContext>();
  const started = deferred<void>();
  const profiles: string[] = [];
  const contexts: TestContext[] = [];
  const { runtime } = await fixture(t, async (profile) => {
    profiles.push(profile);
    if (profiles.length === 1) { started.resolve(); return firstLaunch.promise; }
    const context = new TestContext(); contexts.push(context); return context.asContext();
  });
  const pending = runtime.acquire("BOSS直聘", operation());
  await started.promise;
  const closing = runtime.closePlatform("BOSS直聘");
  await assert.rejects(pending, isUnavailable);
  await assert.rejects(runtime.acquire("BOSS直聘", operation()), isUnavailable);
  const old = new TestContext(); firstLaunch.resolve(old.asContext());
  await closing;
  assert.equal(old.closes, 1);
  const fresh = await runtime.acquire("BOSS直聘", operation());
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0], profiles[1]);
  assert.equal(fresh.context, contexts[0].asContext());
  await fresh.release();
});

test("已有context创建岗位页期间取消，迟到页单独回收且不关闭保活页或登录context", async (t) => {
  const { runtime, calls } = await fixture(t);
  await (await runtime.acquire("BOSS直聘", operation())).release();
  const context = calls[0].context;
  const base = context.allPages[1];
  const pageResult = deferred<TestPage>();
  const started = deferred<void>();
  context.newPageHook = () => { started.resolve(); return pageResult.promise; };
  const controller = new AbortController();
  const reason = new DOMException("cancel while new job page pending", "AbortError");
  const pending = runtime.acquire("BOSS直聘", operation(), controller.signal);
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(context.closes, 0);
  assert.equal(base.closed, false);
  const late = context.addPage();
  pageResult.resolve(late);
  await tick();
  assert.equal(late.closed, true);
  const fresh = await runtime.acquire("BOSS直聘", operation());
  assert.equal(calls.length, 1);
  assert.equal(fresh.context, context.asContext());
  await fresh.release();
});

test("常驻context固定打开时的网络路线，改代理须显式关闭后再用同profile重开", async (t) => {
  const { runtime, calls } = await fixture(t);
  const lease = await runtime.acquire("BOSS直聘", operation());
  await assert.rejects(runtime.acquire("BOSS直聘", operation("http://127.0.0.1:7890")), (error) => {
    assert.ok(isUnavailable(error));
    assert.match((error as Error).message, /网络设置.*明确关闭/);
    return true;
  });
  assert.equal(lease.page.isClosed(), false);
  assert.equal(calls[0].context.closes, 0);
  await runtime.resetPlatform("BOSS直聘");
  assert.equal(lease.page.isClosed(), true);
  await lease.release();
  const next = await runtime.acquire("BOSS直聘", operation("http://127.0.0.1:7890"));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].profile, calls[1].profile);
  assert.deepEqual(calls[1].options.proxy, { server: "http://127.0.0.1:7890", bypass: "<-loopback>" });
  await next.release();
});

test("关掉保活页会补充aboutblank，基础页永不承担岗位，浏览器崩溃后惰性重建同profile", async (t) => {
  const { runtime, calls } = await fixture(t);
  const lease = await runtime.acquire("BOSS直聘", operation());
  const context = calls[0].context;
  const originalBase = context.allPages[1];
  await originalBase.goto(source);
  assert.equal(originalBase.url(), "about:blank");
  await originalBase.close();
  await tick();
  const replacement = context.allPages.at(-1)!;
  assert.notEqual(replacement, originalBase);
  assert.equal(replacement.url(), "about:blank");
  assert.notEqual(lease.page, replacement.asPage());
  assert.equal(lease.page.isClosed(), false);
  await lease.release();
  assert.equal(replacement.closed, false);
  await context.close();
  assert.deepEqual(runtime.status(), []);
  const recovered = await runtime.acquire("BOSS直聘", operation());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].profile, calls[1].profile);
  assert.notEqual(recovered.context, context.asContext());
  await recovered.release();
});

test("启动失败可重试，路由策略和WebSocket限制适用于持久context，release不接管其他手开页", async (t) => {
  let launches = 0;
  const context = new TestContext();
  const { runtime } = await fixture(t, async () => {
    launches += 1;
    if (launches === 1) throw new Error("fixture launch failed");
    return context.asContext();
  });
  await assert.rejects(runtime.acquire("BOSS直聘", operation()), isUnavailable);
  const lease = await runtime.acquire("BOSS直聘", operation());
  const outcomes: string[] = [];
  for (const url of [source, "https://m.liepin.com/job/123.shtml", "http://m.zhipin.com/", "https://m.zhipin.com.evil.test/"]) {
    await context.routes[0]({ request: () => ({ url: () => url }), continue: async () => { outcomes.push("continue"); }, abort: async () => { outcomes.push("abort"); } } as unknown as Route);
  }
  assert.deepEqual(outcomes, ["continue", "abort", "abort", "abort"]);
  let sockets = 0;
  await context.socketHandler!({ close: () => { sockets += 1; } });
  assert.equal(sockets, 1);
  const popup = context.addPage(lease.page as unknown as TestPage);
  const manual = context.addPage();
  await tick();
  assert.equal(popup.closed, true);
  await lease.release();
  assert.equal(manual.closed, false);
  assert.equal(context.closes, 0);
  await runtime.closeAll();
  assert.equal(manual.closed, true);
  assert.equal(context.closes, 1);
});

test("保活页恢复失败会清理context，旧窗口尚未退出时拒绝争用同profile，关闭全部也等待退出", async (t) => {
  const { runtime, calls } = await fixture(t);
  const lease = await runtime.acquire("BOSS直聘", operation());
  const context = calls[0].context;
  const closingGate = deferred<void>();
  context.closeGate = closingGate.promise;
  context.newPageHook = async () => { throw new Error("fixture base replacement failed"); };
  await context.allPages[1].close();
  await tick();
  assert.equal(context.closes, 1);
  assert.deepEqual(runtime.status(), []);
  await assert.rejects(runtime.acquire("BOSS直聘", operation()), isUnavailable);
  assert.equal(calls.length, 1);
  let stopped = false;
  const closing = runtime.closeAll().then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false);
  closingGate.resolve();
  await closing;
  await lease.release();
  const recovered = await runtime.acquire("BOSS直聘", operation());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].profile, calls[1].profile);
  await recovered.release();
});

test("显式关闭只影响目标平台，closeAll幂等且完成后可继续使用原专用profile", async (t) => {
  const { runtime, calls } = await fixture(t);
  const boss = await runtime.acquire("BOSS直聘", operation());
  const liepin = await runtime.acquire("猎聘", operation());
  await runtime.closePlatform("BOSS直聘");
  assert.equal(boss.page.isClosed(), true);
  assert.equal(liepin.page.isClosed(), false);
  assert.deepEqual(runtime.status(), [{ platform: "猎聘", state: "ready", activePages: 1 }]);
  await Promise.all([runtime.closeAll(), runtime.closeAll()]);
  assert.equal(calls[0].context.closes, 1);
  assert.equal(calls[1].context.closes, 1);
  await Promise.all([boss.release(), liepin.release()]);
  const again = await runtime.acquire("BOSS直聘", operation());
  assert.equal(calls.length, 3);
  assert.equal(calls[0].profile, calls[2].profile);
  await again.release();
});

test("岗位页close拒绝且仍打开时release报错并保留跟踪，后续重试才删除且并发只关闭一次", async (t) => {
  const { runtime, calls } = await fixture(t);
  const lease = await runtime.acquire("BOSS直聘", operation());
  const page = lease.page as unknown as TestPage;
  page.closeFailures = 1;
  await assert.rejects(lease.release(), (error) => {
    assert.ok(isUnavailable(error));
    assert.match((error as Error).message, /未能确认本次岗位页已经关闭.*重试/);
    return true;
  });
  assert.equal(page.isClosed(), false);
  assert.equal(page.closes, 1);
  assert.equal(calls[0].context.closes, 0);
  assert.deepEqual(runtime.status(), [{ platform: "BOSS直聘", state: "close_failed", activePages: 1 }]);
  await Promise.all([lease.release(), lease.releasePage()]);
  assert.equal(page.isClosed(), true);
  assert.equal(page.closes, 2);
  assert.deepEqual(runtime.status(), [{ platform: "BOSS直聘", state: "ready", activePages: 0 }]);
  await lease.release();
  assert.equal(page.closes, 2);
});

test("岗位页close只resolve而未确认关闭也拒绝，重试不复用失败的release promise", async (t) => {
  const { runtime } = await fixture(t);
  const lease = await runtime.acquire("BOSS直聘", operation());
  const page = lease.page as unknown as TestPage;
  page.closeWithoutConfirmation = true;
  await assert.rejects(lease.release(), isUnavailable);
  assert.equal(page.isClosed(), false);
  assert.equal(runtime.status()[0].activePages, 1);
  page.closeWithoutConfirmation = false;
  await lease.release();
  assert.equal(page.closes, 2);
  assert.equal(runtime.status()[0].activePages, 0);
});

test("context关闭失败必须报错并保留窗口/profile所有权，显式重试确认前不允许新launch", async (t) => {
  const { runtime, calls } = await fixture(t);
  const lease = await runtime.acquire("BOSS直聘", operation());
  const context = calls[0].context;
  context.closeFailures = 1;
  await assert.rejects(runtime.closePlatform("BOSS直聘"), (error) => {
    assert.ok(isUnavailable(error));
    assert.match((error as Error).message, /未能确认专用 Edge 窗口已经关闭.*重试/);
    return true;
  });
  assert.equal(context.isClosed(), false);
  assert.equal(lease.page.isClosed(), false);
  assert.equal(context.closes, 1);
  assert.deepEqual(runtime.status(), [{ platform: "BOSS直聘", state: "close_failed", activePages: 1 }]);
  await assert.rejects(runtime.acquire("BOSS直聘", operation()), isUnavailable);
  assert.equal(calls.length, 1);
  await runtime.closeAll();
  assert.equal(context.isClosed(), true);
  assert.equal(context.closes, 2);
  assert.deepEqual(runtime.status(), []);
  const fresh = await runtime.acquire("BOSS直聘", operation());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].profile, calls[1].profile);
  await fresh.release();
});

test("context close只resolve而无关闭确认时stop不成功，保留上下文直至再次明确关闭", async (t) => {
  const { runtime, calls } = await fixture(t);
  await (await runtime.acquire("BOSS直聘", operation())).release();
  const context = calls[0].context;
  context.closeWithoutConfirmation = true;
  await assert.rejects(runtime.closeAll(), isUnavailable);
  assert.equal(context.isClosed(), false);
  assert.equal(runtime.status()[0].state, "close_failed");
  await assert.rejects(runtime.acquire("BOSS直聘", operation()), isUnavailable);
  context.closeWithoutConfirmation = false;
  await runtime.closeAll();
  assert.equal(context.closes, 2);
  assert.deepEqual(runtime.status(), []);
});

test("closeAll等待所有平台的关闭结果后才报告失败，并保留失败平台供再次关闭", async (t) => {
  const { runtime, calls } = await fixture(t);
  await runtime.acquire("BOSS直聘", operation());
  await runtime.acquire("猎聘", operation());
  calls[0].context.closeFailures = 1;
  const gate = deferred<void>();
  calls[1].context.closeGate = gate.promise;
  let settled = false;
  const closing = runtime.closeAll().finally(() => { settled = true; });
  const rejected = assert.rejects(closing, isUnavailable);
  try {
    await tick();
    assert.equal(settled, false);
    gate.resolve();
    await rejected;
    assert.equal(calls[0].context.isClosed(), false);
    assert.equal(calls[1].context.isClosed(), true);
    assert.deepEqual(runtime.status(), [{ platform: "BOSS直聘", state: "close_failed", activePages: 1 }]);
    await runtime.closeAll();
    assert.equal(calls[0].context.closes, 2);
    assert.equal(calls[1].context.closes, 1);
    assert.deepEqual(runtime.status(), []);
  } finally { gate.resolve(); await closing.catch(() => undefined); }
});

test("取消后迟到launch的close失败不能被stop当成功，失败context保留到重试确认关闭", async (t) => {
  const launched = deferred<BrowserContext>();
  const started = deferred<void>();
  let launches = 0;
  const { runtime } = await fixture(t, async () => {
    launches += 1;
    if (launches === 1) { started.resolve(); return launched.promise; }
    return new TestContext().asContext();
  });
  const controller = new AbortController();
  const reason = new DOMException("cancel pending launch with late close failure", "AbortError");
  const pending = runtime.acquire("BOSS直聘", operation(), controller.signal);
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  const stopping = runtime.closeAll();
  const rejected = assert.rejects(stopping, isUnavailable);
  const context = new TestContext();
  context.closeFailures = 1;
  launched.resolve(context.asContext());
  await rejected;
  assert.equal(context.isClosed(), false);
  assert.equal(context.closes, 1);
  assert.deepEqual(runtime.status(), [{ platform: "BOSS直聘", state: "close_failed", activePages: 0 }]);
  await assert.rejects(runtime.acquire("BOSS直聘", operation()), isUnavailable);
  assert.equal(launches, 1);
  await runtime.closeAll();
  assert.equal(context.closes, 2);
  assert.equal(context.isClosed(), true);
  await (await runtime.acquire("BOSS直聘", operation())).release();
  assert.equal(launches, 2);
});

test("取消后迟到岗位页close失败仍被跟踪，后续关闭专用context能再次回收", async (t) => {
  const { runtime, calls } = await fixture(t);
  await (await runtime.acquire("BOSS直聘", operation())).release();
  const context = calls[0].context;
  const arrived = deferred<TestPage>();
  const started = deferred<void>();
  context.newPageHook = () => { started.resolve(); return arrived.promise; };
  const controller = new AbortController();
  const reason = new DOMException("cancel pending page with close failure", "AbortError");
  const pending = runtime.acquire("BOSS直聘", operation(), controller.signal);
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  const late = context.addPage();
  late.closeFailures = 1;
  arrived.resolve(late);
  await tick();
  assert.equal(late.isClosed(), false);
  assert.deepEqual(runtime.status(), [{ platform: "BOSS直聘", state: "close_failed", activePages: 1 }]);
  await runtime.closeAll();
  assert.equal(late.isClosed(), true);
  assert.equal(late.closes, 2);
  assert.deepEqual(runtime.status(), []);
});

for (const ending of ["cancel", "startup-timeout"] as const) {
  test(`51job ${ending} keeps the pool's undelivered late page reserved and recovers it on the same owner's next start`, async (t) => {
    const { runtime, calls } = await fixture(t);
    const link = "https://msearch.51job.com/jobs/all/166761768.html";
    await (await runtime.acquire("51JOB", operation(), undefined, link)).release();
    const context = calls[0].context, base = context.allPages[1];
    const arrived = deferred<TestPage>(), started = deferred<void>();
    context.newPageHook = () => { started.resolve(); return arrived.promise; };
    const timers = new Map<number, () => void>();
    const manager = createBrowserSessionManager({
      acquire: runtime.acquire, getOperation: async () => operation(), stopBrowser: runtime.closeAll,
      setTimer: (callback, ms) => { timers.set(ms, callback); return ms as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    });
    let nativeActive = false, nativeStarts = 0;
    const next = "https://m.liepin.com/job/1984701079.shtml";
    const native: JobSessionBackend = {
      start: async (_owner, input) => { nativeActive = true; nativeStarts++; return { sessionId: "next-native", platform: "猎聘", url: input, expiresAt: new Date().toISOString() }; },
      read: async () => assert.fail("no job reading in this lifecycle fixture"),
      inspect: async () => assert.fail("no inspection in this lifecycle fixture"),
      focus: async () => ({ activationRequested: true }),
      close: async () => { nativeActive = false; return { closed: true }; },
      closeAll: async () => { nativeActive = false; }, stopBrowser: async () => assert.fail("page recovery must not stop a browser"),
      owns: (id) => nativeActive && id === "next-native", hasSession: () => nativeActive,
    };
    const router = createJobSessionRouter(manager, native, { useNativeLiepin: true });
    const controller = new AbortController();
    let late: TestPage | undefined;
    try {
      const launching = router.start("original-owner", link, controller.signal);
      await started.promise;
      if (ending === "cancel") controller.abort(); else { assert.ok(timers.get(30_000)); timers.get(30_000)!(); }
      await assert.rejects(launching);
      await manager.retryEnded("original-owner");
      assert.equal(manager.hasSession(), true, "unfinished newPage remains reserved after cancellation returned");
      await assert.rejects(router.start("original-owner", next), isUnavailable);
      assert.equal(nativeStarts, 0);
      late = context.addPage(); late.closeFailures = 2; arrived.resolve(late);
      await tick();
      assert.equal(late.closes, 1); assert.equal(late.isClosed(), false); assert.equal(manager.hasSession(), true);
      await assert.rejects(router.start("other-owner", next), isUnavailable);
      assert.equal(late.closes, 1, "an unreturned lease still belongs to its original request owner");
      await assert.rejects(router.start("original-owner", next), isUnavailable);
      assert.equal(late.closes, 2); assert.equal(manager.hasSession(), true); assert.equal(nativeStarts, 0);
      const fresh = await router.start("original-owner", next);
      assert.equal(fresh.sessionId, "next-native"); assert.equal(nativeStarts, 1);
      assert.equal(late.closes, 3); assert.equal(late.isClosed(), true); assert.equal(manager.hasSession(), false);
      assert.equal(context.closes, 0); assert.equal(base.isClosed(), false); assert.equal(calls.length, 1);
      assert.deepEqual(runtime.status(), [{ platform: "51JOB", state: "ready", activePages: 0 }]);
    } finally {
      if (late) late.closeFailures = 0;
      await router.closeAll();
    }
  });
}

test("cancelled pool acquisition that never produces a page releases the reservation without a browser stop", async (t) => {
  const { runtime, calls } = await fixture(t);
  const link = "https://msearch.51job.com/jobs/all/166761768.html";
  await (await runtime.acquire("51JOB", operation(), undefined, link)).release();
  const context = calls[0].context, result = deferred<TestPage>(), started = deferred<void>();
  context.newPageHook = () => { started.resolve(); return result.promise; };
  const manager = createBrowserSessionManager({ acquire: runtime.acquire, getOperation: async () => operation() });
  const controller = new AbortController();
  try {
    const launching = manager.start("owner", link, controller.signal);
    await started.promise; controller.abort(); await assert.rejects(launching);
    assert.equal(manager.hasSession(), true);
    result.reject(new Error("fixture newPage failed without creating a resource"));
    await tick();
    assert.equal(manager.hasSession(), false);
    assert.equal(context.closes, 0); assert.equal(context.allPages[1].isClosed(), false);
    assert.deepEqual(runtime.status(), [{ platform: "51JOB", state: "ready", activePages: 0 }]);
  } finally { await manager.closeAll(); }
});

test("closeAll waits for the cancelled pool's late page cleanup and releases a successful acquisition reservation", async (t) => {
  const { runtime, calls } = await fixture(t);
  const link = "https://msearch.51job.com/jobs/all/166761768.html";
  await (await runtime.acquire("51JOB", operation(), undefined, link)).release();
  const context = calls[0].context, result = deferred<TestPage>(), started = deferred<void>();
  context.newPageHook = () => { started.resolve(); return result.promise; };
  const manager = createBrowserSessionManager({ acquire: runtime.acquire, getOperation: async () => operation() });
  const controller = new AbortController();
  const launching = manager.start("owner", link, controller.signal);
  await started.promise; controller.abort(); await assert.rejects(launching);
  let drained = false;
  const closing = manager.closeAll().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.equal(manager.hasSession(), true);
  const late = context.addPage(); result.resolve(late);
  await closing;
  assert.equal(late.isClosed(), true); assert.equal(late.closes, 1); assert.equal(manager.hasSession(), false);
  assert.equal(context.closes, 0); assert.equal(context.allPages[1].isClosed(), false);
  assert.deepEqual(runtime.status(), [{ platform: "51JOB", state: "ready", activePages: 0 }]);
});
