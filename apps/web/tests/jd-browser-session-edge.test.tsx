import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Page, type Route } from "playwright-core";
import { createBrowserSessionManager } from "../server/jd-browser-session.ts";
import { JdExtractionError } from "../src/lib/jd-errors.ts";

// All responses below are synthetic and intercepted before network access. This
// checks actual browser session semantics without touching a website or profile.
test("真实本地Edge的51job读取或检查取消超时保留同一DOM，迟到CDP快照settle后同SID可重试", { timeout: 25_000 }, async () => {
  const original = "https://msearch.51job.com/jobs/all/166761768.html";
  const description = "岗位职责：开发本地合成设备通信服务并维护接口文档和自动化测试。任职要求：掌握 C#、SQL Server、异步编程和单元测试。";
  const owner = "http://localhost:5175";
  const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; ms: number }>();
  let page: Page | undefined, snapshotWork: Promise<unknown> | undefined, navigations = 0;
  const manager = createBrowserSessionManager({
    setTimer: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); timers.set(timer, { callback, ms }); return timer; },
    clearTimer: timer => { clearTimeout(timer); timers.delete(timer); },
    getOperation: async () => ({ fetch: async () => { throw new Error("no synthetic preflight"); }, routeFor: () => ({ mode: "manual", source: "local snapshot preservation fixture", proxyUrl: "http://127.0.0.1:1" }) }),
    launch: async options => {
      const browser = await chromium.launch({ ...options, headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async contextOptions => {
        const context = await newContext(contextOptions), newPage = context.newPage.bind(context);
        context.newPage = async () => {
          // Register after the manager's guard so this synthetic handler is
          // always the first route; no request may reach the real origin.
          await context.route("**/*", async route => {
            if (route.request().url() === original) {
              if (route.request().isNavigationRequest()) navigations++;
              await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<title>合成51job岗位</title><input id="fixture-progress"><div class="job_msg">${description}</div>` });
            } else await route.abort("blockedbyclient");
          });
          page = await newPage();
          const evaluate = page.evaluate.bind(page);
          page.evaluate = ((expression: Parameters<Page["evaluate"]>[0], argument?: unknown) => {
            const work = evaluate(expression, argument);
            if (typeof expression === "string" && expression.includes("const unknownLoad=")) snapshotWork = work;
            return work;
          }) as Page["evaluate"];
          return page;
        };
        return context;
      };
      return browser;
    },
  });
  const busy = (error: unknown) => error instanceof JdExtractionError && error.failure.code === "browser_unavailable";
  try {
    const info = await manager.start(owner, original);
    assert.ok(page);
    await page.locator("#fixture-progress").fill("same live DOM");
    for (const action of ["read", "inspect"] as const) for (const ending of ["abort", "timeout"] as const) {
      await page.evaluate(`(() => {
        const nativeEval=window.eval;
        window.__fixtureNativeEval=nativeEval;
        window.__fixturePending=false;
        window.eval=function(expression){
          if(typeof expression==='string'&&expression.includes('const unknownLoad='))return new Promise(resolve=>{
            window.__fixturePending=true;
            window.__fixtureRelease=()=>resolve(nativeEval(expression));
          });
          return nativeEval(expression);
        };
      })()`);
      const cancellation = new AbortController();
      const operation = manager[action](owner, info.sessionId, cancellation.signal);
      const rejected = assert.rejects(operation, ending === "abort" ? { name: "AbortError" } : (error: unknown) => error instanceof JdExtractionError && error.failure.code === "timeout");
      await page.waitForFunction("window.__fixturePending === true");
      assert.ok(snapshotWork);
      if (ending === "abort") cancellation.abort();
      else {
        const timer = [...timers.values()].find(value => value.ms === (action === "read" ? 45_000 : 10_000));
        assert.ok(timer); timer.callback();
      }
      await rejected;
      assert.equal(page.isClosed(), false);
      assert.equal(manager.isActive(owner, info.sessionId), true);
      await assert.rejects(manager.read(owner, info.sessionId), busy);
      await assert.rejects(manager.inspect(owner, info.sessionId), busy);
      const pending = snapshotWork;
      await page.evaluate("window.eval=window.__fixtureNativeEval;window.__fixtureRelease()");
      await pending; await new Promise(resolve => setImmediate(resolve));
      assert.equal((await manager.inspect(owner, info.sessionId)).pageState, "original_job");
      assert.match((await manager.read(owner, info.sessionId)).text, /本地合成设备通信服务/);
      assert.equal(await page.locator("#fixture-progress").inputValue(), "same live DOM");
      assert.equal(navigations, 1);
    }
    await manager.close(owner, info.sessionId);
    assert.equal(page.isClosed(), true);
  } finally { await manager.closeAll(); }
});

test("真实Edge人工接续保留登录完成页，用户返回原岗位后读取且新会话不继承登录", { timeout: 35_000 }, async () => {
  const original = "https://m.zhipin.com/mpa/html/weijd/weijd-job/sessionFixtureToken";
  const complete = "https://m.zhipin.com/fixture-auth-complete";
  const security = "https://m.zhipin.com/web/passport/zp/security.html";
  const description = "岗位职责：开发设备通信服务，维护接口文档及自动化回归测试。任职要求：熟悉 C#、SQL Server、异步编程和单元测试。";
  const posting = JSON.stringify({ "@type": "JobPosting", title: "合成设备研发岗位", url: original, description });
  const pages: Page[] = [];
  const requested: string[] = [];
  const fixture = async (route: Route) => {
    const request = route.request();
    const url = request.url();
    if (request.isNavigationRequest()) requested.push(url);
    if (url === complete) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "Set-Cookie": "fixture_session=ok; Secure; HttpOnly; Path=/; SameSite=Lax" }, body: "<h1>合成测试登录完成</h1>" });
    } else if (url === security) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: '<html><head><title>合成访问验证</title></head><body><div role="dialog">请进行安全验证<input aria-label="合成验证进度" /></div></body></html>' });
    } else if (url === original) {
      // This header belongs only to the test's in-memory, synthetic origin.
      if ((await request.headerValue("cookie"))?.includes("fixture_session=ok")) {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<html><head><title>合成设备研发岗位</title><script type="application/ld+json">${posting}</script></head><body><h1>合成设备研发岗位</h1><main>${description}</main></body></html>` });
      } else await route.fulfill({ contentType: "text/html; charset=utf-8", body: "<html><head><title>登录 - BOSS直聘</title></head><body><h1>请先登录</h1></body></html>" });
    } else await route.abort("blockedbyclient");
  };
  const manager = createBrowserSessionManager({
    getOperation: async () => ({
      fetch: async () => { throw new Error("人工会话不进行静态预检"); },
      routeFor: () => ({ mode: "manual", source: "isolated synthetic fixture", proxyUrl: "http://127.0.0.1:1" }),
    }),
    launch: async (options) => {
      const browser = await chromium.launch({ ...options, headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (contextOptions) => {
        const context = await newContext(contextOptions);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          await context.route("**/*", fixture);
          const page = await newPage();
          pages.push(page);
          return page;
        };
        return context;
      };
      return browser;
    },
  });
  const owner = "http://[::1]:5175";
  try {
    const first = await manager.start(owner, original);
    const inspectAfterNavigation = async () => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const inspection = await manager.inspect(owner, first.sessionId);
        // goto/load and the manager's independent commit observer can settle
        // in different turns. Retry only the public navigation-pending state;
        // ready-but-unknown and failed snapshots must still fail immediately.
        if (inspection.snapshotState !== "navigation_in_progress" || Date.now() >= deadline) {
          assert.equal(inspection.snapshotState, "ready", "主文档导航应在有界等待内生成有效快照");
          return inspection;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const afterStart = requested.length;
    await assert.rejects(manager.read(owner, first.sessionId), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "login_required");
    assert.equal(requested.length, afterStart, "read遇到当前登录提示不能刷新页面");
    assert.equal(pages.length, 1);
    assert.equal(pages[0].isClosed(), false, "登录业务失败保留原会话");
    const beforeInspect = requested.length;
    const loginStatus = await manager.inspect(owner, first.sessionId);
    assert.equal(loginStatus.gate, "login_required");
    assert.equal(loginStatus.pageState, "unknown");
    assert.equal(loginStatus.mainDocumentRequests, afterStart);
    assert.equal(requested.length, beforeInspect, "检查当前窗口不重新请求原岗位或导航");
    await pages[0].goto(security);
    await pages[0].getByRole("textbox", { name: "合成验证进度" }).fill("fixture-progress");
    const beforeSecurityRead = requested.length;
    await assert.rejects(manager.read(owner, first.sessionId), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "verification_required");
    assert.equal(requested.length, beforeSecurityRead, "read遇到当前访问验证不能刷新页面");
    assert.equal(pages[0].url(), security);
    assert.equal(await pages[0].getByRole("textbox", { name: "合成验证进度" }).inputValue(), "fixture-progress", "合成验证页面的现场状态仍保留");
    await pages[0].goto(complete);
    const afterLogin = requested.length;
    const intermediateStatus = await inspectAfterNavigation();
    assert.equal(intermediateStatus.pageState, "platform_intermediate");
    assert.equal(intermediateStatus.gate, undefined);
    assert.equal(pages[0].url(), complete, "检查不会把刚完成登录的页面跳回原岗位");
    assert.equal(requested.length, afterLogin);
    for (let repeat = 0; repeat < 2; repeat++) {
      await assert.rejects(manager.read(owner, first.sessionId), (error: unknown) => {
        assert.ok(error instanceof JdExtractionError);
        assert.equal(error.failure.code, "unsupported_page");
        assert.match(error.failure.message, /自行返回原岗位/);
        return true;
      });
      const repeatedStatus = await manager.inspect(owner, first.sessionId);
      assert.equal(repeatedStatus.pageState, "platform_intermediate");
      assert.equal(repeatedStatus.mainDocumentRequests, afterLogin, "中转页重复read和inspect不增加主页面请求计数");
      assert.equal(pages[0].url(), complete, "重复读取也保留登录完成页面，由用户决定何时回岗");
      assert.equal(requested.length, afterLogin, "中转页读取与检查均不触发导航");
      assert.equal(pages[0].isClosed(), false);
    }
    // Explicitly simulate the user's own return; the manager must never do it during read.
    await pages[0].goto(original, { waitUntil: "load" });
    const afterManualReturn = requested.length;
    const result = await manager.read(owner, first.sessionId);
    assert.match(result.text, /开发设备通信服务/);
    assert.match(result.text, /SQL Server/);
    assert.equal(result.provenance.url, original);
    assert.equal(result.provenance.platform, "BOSS直聘");
    assert.equal(pages[0].url(), original);
    assert.equal(requested.length, afterManualReturn, "用户回到原岗位后读取仍不导航");
    const beforeAutomaticReload = await manager.inspect(owner, first.sessionId);
    assert.equal(beforeAutomaticReload.mainDocumentRequests, afterManualReturn);
    const automaticReloaded = pages[0].waitForEvent("load");
    await pages[0].evaluate("setTimeout(() => location.reload(), 0)");
    await automaticReloaded;
    const afterAutomaticReload = await inspectAfterNavigation();
    assert.equal(afterAutomaticReload.mainDocumentRequests, afterManualReturn + 1, "合成网页自行reload会增加主页面请求计数");
    assert.equal(requested.length, afterManualReturn + 1, "只有页面自行触发的一次主网络请求");
    const afterRead = requested.length;
    const jobStatus = await manager.inspect(owner, first.sessionId);
    assert.equal(jobStatus.pageState, "original_job");
    assert.equal(jobStatus.gate, undefined);
    assert.equal(requested.length, afterRead, "检查原岗位也不会发起新导航");
    const repeated = await manager.read(owner, first.sessionId);
    assert.equal(repeated.text, result.text);
    assert.equal(requested.length, afterRead, "原岗位重复read不重新发出网络导航");
    assert.equal((await manager.inspect(owner, first.sessionId)).mainDocumentRequests, afterAutomaticReload.mainDocumentRequests, "网页reload结束后read与inspect不再增加计数");
    await pages[0].goto("about:blank");
    assert.equal(requested.length, afterRead, "about:blank不发出网络请求");
    const blank = await inspectAfterNavigation();
    assert.equal(blank.snapshotState, "ready");
    assert.equal(blank.pageState, "blank");
    assert.equal(blank.gate, undefined);
    assert.deepEqual(blank.mainDocument, { state: "response", status: 200 }, "空白页保留最近主文档网络状态，不伪造新HTTP响应");
    const blankReadStarted = Date.now();
    await assert.rejects(manager.read(owner, first.sessionId), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "unsupported_page");
    assert.ok(Date.now() - blankReadStarted >= 2_000, "持续空白先有界等待恢复，而非立即误报错岗位");
    assert.equal(pages[0].url(), "about:blank", "read保留持续空白现场，不自动导航");
    assert.equal(pages[0].isClosed(), false);
    assert.equal(requested.length, afterRead, "持续空白read没有新增网络请求");
    const stillBlank = await manager.inspect(owner, first.sessionId);
    assert.equal(stillBlank.pageState, "blank", "业务失败后仍可继续检查同一会话");
    await pages[0].goto(original, { waitUntil: "load" });
    const afterBlankRecovery = requested.length;
    assert.equal((await manager.read(owner, first.sessionId)).text, result.text, "用户恢复原岗位后同一会话继续读取");
    assert.equal(requested.length, afterBlankRecovery, "恢复后的原岗位read也不刷新");
    assert.equal(pages.length, 1, "read没有创建新页面或context");
    await manager.close(owner, first.sessionId);
    assert.equal(pages[0].isClosed(), true);
    const second = await manager.start(owner, original);
    assert.equal(pages.length, 2);
    await assert.rejects(manager.read(owner, second.sessionId), (error: unknown) => error instanceof JdExtractionError && error.failure.code === "login_required");
    assert.ok(requested.every((url) => [original, complete, security].includes(url)), "fixture不访问其他站点");
  } finally { await manager.closeAll(); }
  assert.ok(pages.every((page) => page.isClosed()), "真实浏览器会话全部回收");
});

test("本地普通Edge合成页只报告空白、可见文字、可见iframe与脚本异常次数", { timeout: 30_000 }, async () => {
  const original = "https://m.zhipin.com/mpa/html/weijd/weijd-job/loadDiagnosticsFixture";
  let page: Page | undefined;
  const manager = createBrowserSessionManager({
    getOperation: async () => ({
      fetch: async () => { throw new Error("合成诊断禁止静态请求"); },
      routeFor: () => ({ mode: "direct", source: "ordinary local synthetic fixture" }),
    }),
    launch: async (options) => {
      const browser = await chromium.launch({ ...options, headless: true, args: [...(options.args ?? []), "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"], ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (contextOptions) => {
        const context = await newContext(contextOptions);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          await context.route("**/*", async (route) => {
            if (route.request().url() === original) await route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><html><head><title>private-title</title></head><body></body></html>" });
            else await route.abort("blockedbyclient");
          });
          page = await newPage();
          return page;
        };
        return context;
      };
      return browser;
    },
  });
  const fixtureOwner = "http://localhost:5175";
  try {
    const info = await manager.start(fixtureOwner, original);
    assert.ok(page);
    const inspect = () => manager.inspect(fixtureOwner, info.sessionId);
    const empty = await inspect();
    assert.equal(empty.snapshotState, "ready");
    assert.deepEqual(empty.pageLoad, { readyState: "complete", content: "empty", visibleFrames: 0 });
    assert.equal(empty.scriptErrors, 0);

    await page.setContent("<main>private-page-visible-text</main>");
    assert.deepEqual((await inspect()).pageLoad, { readyState: "complete", content: "visible_text", visibleFrames: 0 });

    const visibleFrame = '<iframe style="width:160px;height:90px" title="private-frame-title" srcdoc="<p>private-iframe-content</p>"></iframe>';
    await page.setContent(visibleFrame);
    await page.evaluate(`(() => {
      const frame = document.querySelector("iframe");
      for (const key of ["contentDocument", "contentWindow"]) Object.defineProperty(frame, key, { get() { throw new Error("private-frame-read-forbidden"); } });
    })()`);
    const embedded = await inspect();
    assert.deepEqual(embedded.pageLoad, { readyState: "complete", content: "embedded_content", visibleFrames: 1 });
    assert.doesNotMatch(JSON.stringify(embedded), /private|iframe-content|frame-title|https?:/);

    for (const style of ["display:none", "visibility:hidden", "opacity:0"]) {
      await page.setContent(`<section style="${style}"><p>private-hidden-text</p>${visibleFrame}</section>`);
      assert.deepEqual((await inspect()).pageLoad, { readyState: "complete", content: "empty", visibleFrames: 0 }, style);
      await page.setContent(`<style>body{${style}}</style><p>private-hidden-text</p>${visibleFrame}`);
      assert.deepEqual((await inspect()).pageLoad, { readyState: "complete", content: "empty", visibleFrames: 0 }, `body ${style}`);
    }
    for (const attribute of ["hidden", 'aria-hidden="true"']) {
      await page.setContent(`<section ${attribute}><p>private-hidden-text</p>${visibleFrame}</section>`);
      assert.deepEqual((await inspect()).pageLoad, { readyState: "complete", content: "empty", visibleFrames: 0 }, attribute);
    }
    await page.setContent(`${visibleFrame}<section style="opacity:0">${visibleFrame}</section><main>private-visible-text</main>`);
    assert.deepEqual((await inspect()).pageLoad, { readyState: "complete", content: "visible_text", visibleFrames: 1 });

    await page.setContent(`${visibleFrame}<div role="dialog" style="position:fixed;inset:0">请完成安全验证</div>`);
    const gate = await inspect();
    assert.equal(gate.gate, "verification_required");
    assert.deepEqual(gate.pageLoad, { readyState: "complete", content: "visible_text", visibleFrames: 1 }, "gate早返回也保留准确的加载状态");

    const errorEvent = page.waitForEvent("pageerror");
    await page.setContent('<main>private-visible-text</main><script>throw new Error("private-script-error-token");</script>');
    await errorEvent;
    await page.evaluate('console.error("private-console-error-not-counted")');
    const errored = await inspect();
    assert.equal(errored.scriptErrors, 1);
    assert.deepEqual(errored.pageLoad, { readyState: "complete", content: "visible_text", visibleFrames: 0 });
    assert.doesNotMatch(JSON.stringify(errored), /private|token|message|stack|title|https?:/);
    await manager.close(fixtureOwner, info.sessionId);
    assert.equal(page.isClosed(), true);
  } finally { await manager.closeAll(); }
});

test("真实本地Edge区分主文档状态、iframe HTTP错误与连接重置，诊断不导航也不泄露资源URL", { timeout: 30_000 }, async () => {
  const original = "https://m.zhipin.com/mpa/html/weijd/weijd-job/documentDiagnosticsFixture?ticket=private-ticket";
  const child = "https://m.zhipin.com/private-child-frame?token=private-token";
  const script = "https://m.zhipin.com/private-reset-script.js?token=private-token";
  const unavailable = "https://m.zhipin.com/private-unavailable?token=private-token";
  const pending = "https://m.zhipin.com/private-pending-failure?token=private-token";
  const requests: string[] = [];
  let page: Page | undefined;
  let reachedPending!: () => void;
  const pendingRequested = new Promise<void>((resolve) => { reachedPending = resolve; });
  let releasePending!: () => void;
  const pendingReleased = new Promise<void>((resolve) => { releasePending = resolve; });
  const fixture = async (route: Route) => {
    const url = route.request().url();
    requests.push(url);
    if (url === original) await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><title>private-title</title></head><body><main>合成主文档</main><iframe src="${child}"></iframe><script src="${script}"></script></body></html>` });
    else if (url === child) await route.fulfill({ status: 404, contentType: "text/html; charset=utf-8", body: "<main>private-child-error</main>" });
    else if (url === script) await route.abort("connectionreset");
    else if (url === unavailable) await route.fulfill({ status: 503, contentType: "text/html; charset=utf-8", body: "<main>合成主文档暂不可用</main>" });
    else if (url === pending) { reachedPending(); await pendingReleased; await route.abort("connectionreset").catch(() => undefined); }
    else await route.abort("blockedbyclient");
  };
  const manager = createBrowserSessionManager({
    getOperation: async () => ({
      fetch: async () => { throw new Error("合成诊断禁止静态请求"); },
      routeFor: () => ({ mode: "manual", source: "isolated document diagnostics fixture", proxyUrl: "http://127.0.0.1:1" }),
    }),
    launch: async (options) => {
      const browser = await chromium.launch({ ...options, headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (contextOptions) => {
        const context = await newContext(contextOptions);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          await context.route("**/*", fixture);
          page = await newPage();
          return page;
        };
        return context;
      };
      return browser;
    },
  });
  const fixtureOwner = "http://localhost:5175";
  try {
    const info = await manager.start(fixtureOwner, original);
    assert.ok(page);
    await page.waitForLoadState("load");
    const inspect = async () => {
      const before = requests.length;
      const result = await manager.inspect(fixtureOwner, info.sessionId);
      assert.equal(requests.length, before, "检查不引发任何新文档或资源请求");
      assert.doesNotMatch(JSON.stringify(result), /private|ticket|token|https?:|ERR_CONNECTION_RESET|errorText|stack/);
      return result;
    };
    const initial = await inspect();
    assert.deepEqual(initial.mainDocument, { state: "response", status: 200 });
    assert.ok(initial.resources.some((item) => item.host === "m.zhipin.com" && item.type === "document" && item.outcome === "http_error" && item.detail === "http" && item.frame === "child" && item.httpStatus === 404));
    assert.ok(initial.resources.some((item) => item.host === "m.zhipin.com" && item.type === "script" && item.outcome === "load_failed" && item.detail === "connection" && item.frame === "main" && !Object.hasOwn(item, "httpStatus")));

    await page.goto(unavailable, { waitUntil: "load" });
    const serverError = await inspect();
    assert.deepEqual(serverError.mainDocument, { state: "response", status: 503 });
    assert.ok(serverError.resources.some((item) => item.type === "document" && item.outcome === "http_error" && item.detail === "http" && item.frame === "main" && item.httpStatus === 503));

    const failedNavigation = page.goto(pending, { waitUntil: "load" }).then(() => undefined, (error: unknown) => error);
    await pendingRequested;
    const pendingInspectionStarted = Date.now();
    for (let repeat = 0; repeat < 2; repeat++) {
      const loading = await inspect();
      assert.deepEqual(loading.mainDocument, { state: "pending" }, "新主导航开始后不保留旧503状态");
      assert.equal(loading.snapshotState, "navigation_in_progress");
      assert.equal(loading.pageState, "unknown");
      assert.deepEqual(loading.pageLoad, { readyState: "unknown", content: "unknown", visibleFrames: 0 });
      assert.equal(loading.gate, undefined);
      assert.equal(page.isClosed(), false, "检查挂起导航应保留原浏览器会话");
    }
    assert.ok(Date.now() - pendingInspectionStarted < 3_000, "连续检查挂起导航快速返回，不等待整次10秒硬超时");
    const errorDocumentCommitted = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page!.mainFrame(), timeout: 5_000 });
    releasePending();
    assert.ok(await failedNavigation instanceof Error);
    await errorDocumentCommitted;
    await page.waitForLoadState("load");
    const failed = await inspect();
    assert.deepEqual(failed.mainDocument, { state: "failed" });
    assert.ok(failed.resources.some((item) => item.type === "document" && item.outcome === "load_failed" && item.detail === "connection" && item.frame === "main" && !Object.hasOwn(item, "httpStatus")));

    await page.goto(original, { waitUntil: "load" });
    assert.deepEqual((await inspect()).mainDocument, { state: "response", status: 200 }, "恢复主文档200后iframe404与脚本失败不能覆盖主文档状态");
    assert.ok(requests.every((url) => [original, child, script, unavailable, pending].includes(url)), "所有合成响应均本地拦截，无真实站点请求");
  } finally { releasePending(); await manager.closeAll(); }
  assert.equal(page?.isClosed(), true);
});
test("真实本地Edge拒绝主世界eval伪造的空白与原岗快照，保留窗口并可恢复", { timeout: 30_000 }, async () => {
  const original = "https://m.zhipin.com/mpa/html/weijd/weijd-job/snapshotOriginFixture";
  const differentJob = "https://m.zhipin.com/mpa/html/weijd/weijd-job/differentSnapshotFixture";
  const description = "岗位职责：开发合成设备通信服务并维护接口文档。任职要求：掌握 C#、SQL Server、异步编程和完整自动化回归测试。";
  const html = `<!doctype html><html><head><title>合成来源校验岗位</title></head><body><h1>合成来源校验岗位</h1><div class="job-sec-text">${description}</div></body></html>`;
  const requests: string[] = [];
  let page: Page | undefined;
  const manager = createBrowserSessionManager({
    getOperation: async () => ({
      fetch: async () => { throw new Error("合成快照测试禁止静态请求"); },
      routeFor: () => ({ mode: "manual", source: "isolated snapshot origin fixture", proxyUrl: "http://127.0.0.1:1" }),
    }),
    launch: async (options) => {
      const browser = await chromium.launch({ ...options, headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (contextOptions) => {
        const context = await newContext(contextOptions);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          await context.route("**/*", async (route) => {
            const url = route.request().url();
            requests.push(url);
            if (url === original || url === differentJob) await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
            else await route.abort("blockedbyclient");
          });
          page = await newPage();
          return page;
        };
        return context;
      };
      return browser;
    },
  });
  const fixtureOwner = "http://localhost:5175";
  try {
    const info = await manager.start(fixtureOwner, original);
    assert.ok(page);
    assert.equal((await manager.inspect(fixtureOwner, info.sessionId)).pageState, "original_job");
    assert.match((await manager.read(fixtureOwner, info.sessionId)).text, /SQL Server/);
    for (const actual of [original, differentJob]) {
      if (page.url() !== actual) await page.goto(actual, { waitUntil: "load" });
      const candidate = actual === original
        ? { html: "", url: "about:blank", title: "", pageLoad: { readyState: "complete", content: "empty", visibleFrames: 0 } }
        : { html, url: original, title: "合成来源校验岗位" };
      // The override is intentionally confined to the synthetic page. Other
      // evaluation expressions still use the native evaluator, including restore.
      await page.evaluate(`(() => {
        const nativeEval=window.eval;
        window.__restoreSnapshotFixtureEval=()=>{window.eval=nativeEval;delete window.__restoreSnapshotFixtureEval;};
        window.eval=function(expression){
          if(typeof expression==='string'&&expression.includes('const unknownLoad=')) return ${JSON.stringify(candidate)};
          return nativeEval(expression);
        };
      })()`);
      const before = requests.length;
      const inspection = await manager.inspect(fixtureOwner, info.sessionId);
      assert.equal(inspection.snapshotState, "failed");
      assert.equal(inspection.pageState, "unknown", "eval返回的about:blank不能冒充真实窗口为空白");
      assert.equal(inspection.gate, undefined);
      assert.deepEqual(inspection.pageLoad, { readyState: "unknown", content: "unknown", visibleFrames: 0 });
      assert.deepEqual(inspection.mainDocument, { state: "response", status: 200 });
      const started = Date.now();
      await assert.rejects(manager.read(fixtureOwner, info.sessionId), (error: unknown) => {
        assert.ok(error instanceof JdExtractionError);
        assert.equal(error.failure.code, "unsupported_page");
        assert.match(error.failure.message, /快照.*来源一致/);
        return true;
      });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 2_000 && elapsed < 8_000, "来源不一致有界失败，不能等到整次读取超时");
      assert.equal(page.url(), actual, "读取不能导航、改写快照URL或采用错来源HTML");
      assert.equal(requests.length, before, "检查与失败读取没有新增网络请求");
      assert.equal(page.isClosed(), false, "来源不一致保留窗口供核对");
      await page.evaluate("window.__restoreSnapshotFixtureEval()");
      const recovered = await manager.inspect(fixtureOwner, info.sessionId);
      assert.equal(recovered.snapshotState, "ready");
      assert.equal(recovered.pageState, actual === original ? "original_job" : "different_job");
    }
    await page.goto(original, { waitUntil: "load" });
    const beforeRecoveredRead = requests.length;
    assert.match((await manager.read(fixtureOwner, info.sessionId)).text, /合成设备通信服务/);
    assert.equal(requests.length, beforeRecoveredRead);
    assert.ok(requests.every((url) => [original, differentJob].includes(url)), "全部响应本地拦截，不访问真实网站");
  } finally { await manager.closeAll(); }
  assert.equal(page?.isClosed(), true);
});
