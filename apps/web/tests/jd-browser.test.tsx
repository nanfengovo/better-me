import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { EventEmitter } from "node:events";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response as BrowserResponse, type Route } from "playwright-core";
import { allowedBrowserResource, fetchBrowserJd, isBrowserVerificationUrl, isObservedBrowserLogin, isObservedLiepinVerification, VISIBLE_JOB_SNAPSHOT } from "../server/jd-browser.ts";
import { extractPublicJobHtml } from "../server/jd-extractor.ts";
import type { NetworkOperation } from "../server/network-proxy.ts";
import { JdExtractionError, type JdFailureCode } from "../src/lib/jd-errors.ts";

const source = "https://m.zhipin.com/mpa/html/weijd/weijd-job/fixtureToken?fromSource=2";
const description = "岗位职责：开发设备通信服务并维护自动化回归测试。任职要求：熟悉异步编程、SQL Server、单元测试与接口文档。";
const liepinVerification = "行为异常。尊敬的客户您好，猎聘安全中心发现您的帐号或IP可能存在异常，为了保障您的账号及资源安全，请进行安全验证。";
const html = (body: string, extraHead = "") => `<!doctype html><html><head><title>合成研发岗位</title>${extraHead}</head><body>${body}</body></html>`;
const posting = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "合成研发岗位", url: source, description })}</script>`;
const isFailure = (code: JdFailureCode) => (error: unknown) => error instanceof JdExtractionError && error.failure.code === code;
const operation = (body = html('<div id="app"></div>')): NetworkOperation => ({
  fetch: async () => new Response(body, { headers: { "Content-Type": "text/html" } }),
  routeFor: () => ({ mode: "manual", source: "test-only route", proxyUrl: "http://127.0.0.1:17891" }),
});

function navigationCommit(events: EventEmitter, options: { signal?: AbortSignal } = {}): Promise<BrowserResponse | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { events.removeListener("commit", onCommit); options.signal?.removeEventListener("abort", onAbort); };
    const onCommit = (response: BrowserResponse | null) => { cleanup(); resolve(response); };
    const onAbort = () => { cleanup(); reject(options.signal?.reason); };
    events.once("commit", onCommit);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function nativeDocument(events: EventEmitter, frame: object, options: { url?: string; status?: number; headers?: Record<string, string>; body?: string | Buffer | (() => Promise<Buffer>); requestOnly?: boolean; commit?: boolean } = {}) {
  const request = { url: () => options.url ?? source, resourceType: () => "document", isNavigationRequest: () => true, frame: () => frame } as unknown as Request;
  const response = {
    url: request.url,
    request: () => request,
    status: () => options.status ?? 200,
    headers: () => options.headers ?? {},
    body: async () => typeof options.body === "function" ? options.body() : Buffer.from(options.body ?? html('<div id="app"></div>')),
  } as unknown as BrowserResponse;
  events.emit("request", request);
  if (!options.requestOnly) events.emit("response", response);
  const commit = () => { events.emit("framenavigated", frame); events.emit("commit", response); };
  if ((options.commit ?? !options.requestOnly) && ((options.status ?? 200) < 300 || (options.status ?? 200) >= 400)) commit();
  return { request, response, commit };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function snapshotBrowser(initialUrl: string, read: (evaluation: number, navigate: (url: string, main?: boolean) => void) => unknown) {
  const events = new EventEmitter();
  const mainFrame = { parentFrame: () => null };
  let url = initialUrl;
  let evaluations = 0;
  let closes = 0;
  let continued = 0;
  let handler: ((route: Route) => Promise<void>) | undefined;
  const navigate = (nextUrl: string, main = true) => {
    if (main) url = nextUrl;
    events.emit("framenavigated", main ? mainFrame : {});
  };
  const page = {
    off: events.off.bind(events),
    route: async (_pattern: string, value: (route: Route) => Promise<void>) => { handler = value; },
    on: events.on.bind(events), url: () => url, mainFrame: () => mainFrame, isClosed: () => false,
    waitForNavigation: (options: { signal?: AbortSignal }) => navigationCommit(events, options),
    goto: async () => {
      const document = nativeDocument(events, mainFrame, { url: initialUrl, requestOnly: true });
      assert.ok(handler);
      await handler({
        request: () => document.request,
        continue: async () => { continued += 1; },
        fetch: async () => { assert.fail("native navigation must not call route.fetch"); },
        fulfill: async () => { assert.fail("native navigation must not call route.fulfill"); },
        abort: async () => { assert.fail("allowed native document must not abort"); },
      } as unknown as Route);
      events.emit("response", document.response);
      document.commit();
    },
    evaluate: async () => read(++evaluations, navigate),
  };
  const context = { routeWebSocket: async () => undefined, route: async (_pattern: string, value: (route: Route) => Promise<void>) => { handler = value; }, newPage: async () => page };
  return {
    browser: { newContext: async () => context, close: async () => { closes += 1; } } as unknown as Browser,
    events, mainFrame, navigate, page, context,
    get evaluations() { return evaluations; },
    get closes() { return closes; },
    get continued() { return continued; },
  };
}

test("浏览器资源仅允许同平台HTTPS域名边界，不接受凭据、端口或跨平台", () => {
  for (const url of ["https://zhipin.com/a.js", "https://static.zhipin.com/bundle.js", "https://m.zhipin.com:443/app", "https://ZHIPIN.COM/css"]) assert.equal(allowedBrowserResource(url, "BOSS直聘"), true, url);
  for (const url of ["https://zhipin.com.evil.test/a.js", "https://evilzhipin.com/a", "https://liepin.com/a", "http://static.zhipin.com/a", "https://user:pass@zhipin.com/a", "https://zhipin.com:8443/a", "https://127.0.0.1/", "https://[::1]/", "file:///temp/page.html", "javascript:void(0)", "bad-url"]) assert.equal(allowedBrowserResource(url, "BOSS直聘"), false, url);
  assert.equal(allowedBrowserResource("https://static.licdn.com/a.js", "LinkedIn"), true);
  assert.equal(allowedBrowserResource("https://static.licdn.com/a.js", "BOSS直聘"), false);
  assert.equal(allowedBrowserResource("https://licdn.com.evil.test/a.js", "LinkedIn"), false);
  assert.equal(allowedBrowserResource("https://msearch.51job.com/detail", "51JOB"), true);
  assert.equal(allowedBrowserResource("https://wow.liepin.com/transit.html", "猎聘"), true);
});

test("已观察的三国内平台CDN按精确HTTPS主机和平台允许，父域与后缀冒充拒绝", () => {
  const allowed = [
    ["js.51jobcdn.com", "51JOB"],
    ["img01.51jobcdn.com", "51JOB"],
    ["img04.51jobcdn.com", "51JOB"],
    ["o.alicdn.com", "51JOB"],
    ["img.alicdn.com", "51JOB"],
    ["g.alicdn.com", "51JOB"],
    ["x.alicdn.com", "51JOB"],
    ["93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open.aliyuncs.com", "51JOB"],
    ["93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open-b.aliyuncs.com", "51JOB"],
    ["93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com", "51JOB"],
    ["93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open-b.aliyuncs.com", "51JOB"],
    ["upload.captcha-pro-open.aliyuncs.com", "51JOB"],
    ["upload.captcha-pro-open-b.aliyuncs.com", "51JOB"],
    ["device.captcha-open.aliyuncs.com", "51JOB"],
    ["img.bosszhipin.com", "BOSS直聘"],
    ["concat.lietou-static.com", "猎聘"],
    ["image0.lietou-static.com", "猎聘"],
  ] as const;
  for (const [host, platform] of allowed) {
    for (const url of [`https://${host}/fixture-resource`, `https://${host}:443/fixture-resource`, `https://${host.toUpperCase()}/fixture-resource`]) {
      assert.equal(allowedBrowserResource(url, platform), true, url);
    }
    for (const otherPlatform of ["BOSS直聘", "猎聘", "51JOB", "LinkedIn"] as const) {
      if (otherPlatform !== platform) assert.equal(allowedBrowserResource(`https://${host}/fixture-resource`, otherPlatform), false);
    }
    for (const url of [
      `http://${host}/resource`,
      `https://user:secret@${host}/resource`,
      `https://user@${host}/resource`,
      `https://${host}:80/resource`,
      `https://${host}:8443/resource`,
      `https://${host}.evil.test/resource`,
      `https://extra.${host}/resource`,
      `https://evil-${host}/resource`,
    ]) assert.equal(allowedBrowserResource(url, platform), false, url);
  }
  for (const host of ["51jobcdn.com", "img02.51jobcdn.com", "other.51jobcdn.com", "bosszhipin.com", "lietou-static.com", "image1.lietou-static.com", "other.bosszhipin.com", "concat-lietou-static.com", "alicdn.com", "y.alicdn.com", "other.alicdn.com", "aliyuncs.com", "captcha-pro-open.aliyuncs.com", "captcha-pro-open-b.aliyuncs.com", "other.captcha-pro-open.aliyuncs.com", "other.captcha-pro-open-b.aliyuncs.com", "00000000000000000000000000000000.captcha-pro-open.aliyuncs.com", "00000000000000000000000000000000.captcha-pro-open-b.aliyuncs.com", "captcha-open.aliyuncs.com", "other.captcha-open.aliyuncs.com", "upload.captcha-open.aliyuncs.com", "errors.aliyun.com", "api.map.baidu.com", "hm.baidu.com"]) {
    for (const platform of ["51JOB", "BOSS直聘", "猎聘", "LinkedIn"] as const) assert.equal(allowedBrowserResource(`https://${host}/resource`, platform), false, `${platform}: ${host}`);
  }
});

test("BOSS现场被阻断的验证组件仅恢复五个精确HTTPS443资源主机", () => {
  for (const host of ["api.geetest.com", "api.geevisit.com", "static.geetest.com", "monitor.geetest.com", "static.geevisit.com"]) {
    for (const url of [`https://${host}/fixture.js`, `https://${host}:443/fixture.js`, `https://${host.toUpperCase()}/fixture.js`]) {
      assert.equal(allowedBrowserResource(url, "BOSS直聘"), true, url);
      for (const platform of ["猎聘", "51JOB", "LinkedIn"] as const) assert.equal(allowedBrowserResource(url, platform), false, `${platform}: ${url}`);
    }
    for (const url of [`http://${host}/fixture.js`, `https://${host}:80/fixture.js`, `https://${host}:8443/fixture.js`, `https://user:secret@${host}/fixture.js`, `https://user@${host}/fixture.js`, `https://${host}.evil.test/fixture.js`, `https://extra.${host}/fixture.js`, `https://evil-${host}/fixture.js`]) assert.equal(allowedBrowserResource(url, "BOSS直聘"), false, url);
  }
  for (const host of ["geetest.com", "geevisit.com", "other.geetest.com", "other.geevisit.com", "monitor.geevisit.com", "api.geetest.net", "api.geevisit.net"]) {
    for (const platform of ["BOSS直聘", "猎聘", "51JOB", "LinkedIn"] as const) assert.equal(allowedBrowserResource(`https://${host}/fixture.js`, platform), false, `${platform}: ${host}`);
  }
});

for (const parent of ["qcloud.com", "gtimg.com"]) {
test(`猎聘真实检查发现的 ${parent} 验证资源仅按精确HTTPS主机允许，不扩大平台或父域`, () => {
  const host = `turing.captcha.${parent}`;
  for (const url of [`https://${host}/fixture.js`, `https://${host}:443/fixture.js`, `https://${host.toUpperCase()}/fixture.js`]) {
    assert.equal(allowedBrowserResource(url, "猎聘"), true, url);
    for (const platform of ["BOSS直聘", "51JOB", "LinkedIn"] as const) assert.equal(allowedBrowserResource(url, platform), false, `${platform}: ${url}`);
  }
  for (const url of [
    `http://${host}/fixture.js`,
    `https://user:secret@${host}/fixture.js`,
    `https://user@${host}/fixture.js`,
    `https://${host}:8443/fixture.js`,
    `https://${host}.evil.test/fixture.js`,
    `https://extra.${host}/fixture.js`,
    `https://evil-${host}/fixture.js`,
    `https://captcha.${parent}/fixture.js`,
    `https://${parent}/fixture.js`,
    `https://other.captcha.${parent}/fixture.js`,
    "https://apm.volccdn.com/fixture.js",
  ]) assert.equal(allowedBrowserResource(url, "猎聘"), false, url);
});
}

test("BOSS已知移动和桌面安全页精确归为验证，冒充来源不命中", () => {
  const security = "https://m.zhipin.com/web/passport/zp/security.html";
  assert.equal(isBrowserVerificationUrl(security, "BOSS直聘"), true);
  assert.equal(isBrowserVerificationUrl(`${security}?from=fixture#fragment`, "BOSS直聘"), true);
  for (const host of ["m.zhipin.com", "www.zhipin.com"]) {
    assert.equal(isBrowserVerificationUrl(`https://${host}/web/common/security-check.html`, "BOSS直聘"), true);
    assert.equal(isBrowserVerificationUrl(`https://${host}/web/passport/zp/security.html`, "BOSS直聘"), true);
  }
  for (const platform of ["51JOB", "猎聘", "LinkedIn"] as const) assert.equal(isBrowserVerificationUrl(security, platform), false);
  for (const url of [
    "https://m.zhipin.com.evil.test/web/passport/zp/security.html",
    "https://evil-m.zhipin.com/web/passport/zp/security.html",
    "https://static.zhipin.com/web/common/security-check.html",
    "https://www.zhipin.com/web/common/security-check.html/",
    "https://m.liepin.com/web/passport/zp/security.html",
    "https://m.zhipin.com/web/passport/zp/security.html/",
    "https://m.zhipin.com/web/passport/zp/security.html.evil",
    "https://m.zhipin.com/web/passport/zp/security.htm",
    "https://m.zhipin.com/WEB/passport/zp/security.html",
    "https://m.zhipin.com/job_detail/fixture.html?next=/web/passport/zp/security.html",
    "https://user:password@m.zhipin.com/web/passport/zp/security.html",
    "https://m.zhipin.com:8443/web/passport/zp/security.html",
    "http://m.zhipin.com/web/passport/zp/security.html",
    "bad-url",
  ]) assert.equal(isBrowserVerificationUrl(url, "BOSS直聘"), false, url);
});

test("猎聘登录落地页只按已观察的来源路径与真实登录容器共同识别", () => {
  const loginUrl = "https://wow.liepin.com/t1012695/4410f519.html";
  const loginHtml = html('<main class="login4c-main-container"><p>微信扫码登录</p><p>我已有账号，直接登录</p></main>');
  assert.equal(isObservedBrowserLogin(loginHtml, loginUrl, "猎聘"), true);
  for (const text of ["微信扫码登录", "我已有账号，直接登录", "我已有账号,直接登录"]) {
    assert.equal(isObservedBrowserLogin(html(`<div class="login4c-main-container">${text}</div>`), loginUrl, "猎聘"), true);
  }
  for (const platform of ["BOSS直聘", "51JOB", "LinkedIn"] as const) assert.equal(isObservedBrowserLogin(loginHtml, loginUrl, platform), false);
  for (const url of [
    "https://wow.liepin.com.evil.test/t1012695/4410f519.html",
    "https://evil-wow.liepin.com/t1012695/4410f519.html",
    "https://m.liepin.com/t1012695/4410f519.html",
    "https://wow.zhipin.com/t1012695/4410f519.html",
    "https://wow.liepin.com/t1012695/4410f519.html/",
    "https://wow.liepin.com/t1012695/4410f519.html.evil",
    "https://wow.liepin.com/t1012695/other.html",
    "https://wow.liepin.com/t1012695/transit.html",
    "https://user:secret@wow.liepin.com/t1012695/4410f519.html",
    "https://wow.liepin.com:8443/t1012695/4410f519.html",
    "http://wow.liepin.com/t1012695/4410f519.html",
    "bad-url",
  ]) assert.equal(isObservedBrowserLogin(loginHtml, url, "猎聘"), false, url);
  for (const body of [
    '<div class="job-intro-content">职责：开发微信扫码登录与账号安全模块，交付接口及回归测试。</div>',
    '<main>微信扫码登录；我已有账号，直接登录</main>',
    '<main data-class="login4c-main-container">微信扫码登录</main>',
    '<main class="login4c-main-container">岗位职责：开发设备通信服务。</main>',
    '<script>const fixture="<div class=login4c-main-container>微信扫码登录</div>"</script>',
  ]) assert.equal(isObservedBrowserLogin(html(body), loginUrl, "猎聘"), false, body);
});

test("BOSS已观察注册登录标题还需可见登录选项或表单标签，来源限官方域", () => {
  const title = "【BOSS直聘注册登录】boss直聘在线注册登录-BOSS直聘";
  const loginPage = (body: string, pageTitle = title) => `<!doctype html><html><head><title>${pageTitle}</title></head><body>${body}</body></html>`;
  for (const body of ["<main>扫码登录</main>", "<main>短信登录</main>", "<main>账号密码登录</main>", "<main><label>手机号</label><label>验证码</label></main>"]) {
    for (const url of ["https://zhipin.com/", "https://www.zhipin.com/web/user/", "https://m.zhipin.com/observed-login"]) {
      assert.equal(isObservedBrowserLogin(loginPage(body), url, "BOSS直聘"), true, `${url} ${body}`);
    }
  }
  assert.equal(isObservedBrowserLogin(loginPage("<main>扫码登录</main>", "登录 - BOSS直聘"), source, "BOSS直聘"), true);
  for (const url of ["https://zhipin.com.evil.test/", "https://evil-zhipin.com/", "https://api.geetest.com/", "https://www.liepin.com/", "http://www.zhipin.com/", "https://user:secret@www.zhipin.com/", "https://www.zhipin.com:8443/", "bad-url"]) {
    assert.equal(isObservedBrowserLogin(loginPage("<main>扫码登录</main>"), url, "BOSS直聘"), false, url);
  }
  for (const platform of ["猎聘", "51JOB", "LinkedIn"] as const) assert.equal(isObservedBrowserLogin(loginPage("<main>扫码登录</main>"), source, platform), false);
});

test("BOSS链接和标题不单独判登录，隐藏提示、输入值与岗位中的登录技术不能误报", () => {
  const title = "【BOSS直聘注册登录】boss直聘在线注册登录-BOSS直聘";
  const loginPage = (body: string, pageTitle = title) => `<!doctype html><html><head><title>${pageTitle}</title></head><body>${body}</body></html>`;
  for (const body of [
    "<main>页面正在加载</main>",
    '<script>const login="扫码登录"</script>',
    "<template>扫码登录</template>",
    "<noscript>扫码登录</noscript>",
    "<div hidden>扫码登录</div>",
    '<section aria-hidden="true"><p>扫码登录</p></section>',
    '<section style="display:none"><p>扫码登录</p></section>',
    '<section style="visibility:hidden"><p>扫码登录</p></section>',
    '<section style="opacity:0.0 !important"><p>扫码登录</p></section>',
    '<input value="手机号 验证码 扫码登录">',
  ]) assert.equal(isObservedBrowserLogin(loginPage(body), "https://www.zhipin.com/web/user/", "BOSS直聘"), false, body);
  const job = `<h1>单点登录研发工程师</h1><div class="job-sec-text">${description}开发扫码登录和账号密码登录模块。</div>`;
  assert.equal(isObservedBrowserLogin(loginPage(job, "单点登录研发工程师 - BOSS直聘"), source, "BOSS直聘"), false);
  assert.equal(isObservedBrowserLogin(loginPage("<main>扫码登录</main>", "合成研发岗位"), "https://www.zhipin.com/web/user/?login=true", "BOSS直聘"), false);
});

test("猎聘已观察安全提示仅按真实平台域及完整组合句识别，兼容帐号写法与空白", () => {
  for (const account of ["帐号", "账号"]) {
    for (const protectedAccount of ["帐号", "账号"]) {
      const notice = `猎聘安全中心发现您的${account}或 IP 可能存在异常，\n为了保障您的${protectedAccount}及资源安全， 请进行安全验证`;
      for (const url of ["https://liepin.com/", "https://m.liepin.com/job/123.shtml", "https://wow.liepin.com/observed-intermediate"]) {
        assert.equal(isObservedLiepinVerification(html(`<h1>行为异常</h1><main>${notice}</main>`), url, "猎聘"), true, `${url} ${account}/${protectedAccount}`);
      }
    }
  }
  const noticeHtml = html(`<main>${liepinVerification}</main>`);
  for (const platform of ["BOSS直聘", "51JOB", "LinkedIn"] as const) assert.equal(isObservedLiepinVerification(noticeHtml, "https://wow.liepin.com/observed-intermediate", platform), false);
  for (const url of [
    "https://liepin.com.evil.test/", "https://evil-liepin.com/", "https://m.zhipin.com/", "https://image0.lietou-static.com/",
    "http://wow.liepin.com/", "https://user:secret@wow.liepin.com/", "https://wow.liepin.com:8443/", "bad-url",
  ]) assert.equal(isObservedLiepinVerification(noticeHtml, url, "猎聘"), false, url);
  for (const body of [
    "岗位职责：维护猎聘安全中心系统，识别帐号或IP异常，并开发账号安全验证功能。任职要求：熟悉行为异常分析。",
    "行为异常，请进行安全验证。",
    "猎聘安全中心发现您的帐号或IP可能存在异常，请进行安全验证。",
    "为了保障您的账号及资源安全，请进行安全验证。",
    "猎聘安全中心发现您的帐号或IP可能存在异常，为了保障您的账号及资源安全。",
    `<script>const notice=${JSON.stringify(liepinVerification)}</script>`,
    `<template>${liepinVerification}</template>`,
    `<div hidden>${liepinVerification}</div>`,
    `<div aria-hidden="true">${liepinVerification}</div>`,
  ]) assert.equal(isObservedLiepinVerification(html(`<main>${body}</main>`), "https://wow.liepin.com/observed-intermediate", "猎聘"), false, body);
});

test("请求已取消时既不发静态请求也不启动浏览器", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel before launch", "AbortError");
  controller.abort(reason);
  let requests = 0;
  let launches = 0;
  const runtime = operation();
  runtime.fetch = async () => { requests += 1; throw new Error("preflight must not run"); };
  await assert.rejects(fetchBrowserJd(source, runtime, controller.signal, { launch: async () => { launches += 1; throw new Error("launch must not run"); } }), (error: unknown) => error === reason);
  assert.equal(requests, 0);
  assert.equal(launches, 0);
});

test("显式浏览器模式直接按原链接与路线读取，不先发独立静态请求", { timeout: 5000 }, async () => {
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  const fixture = snapshotBrowser(source, () => ({ html: visible, url: source, title: "合成研发岗位" }));
  const runtime = operation();
  let requests = 0;
  let launches = 0;
  runtime.fetch = async () => { requests += 1; throw new Error("an independent request cannot decide the browser response"); };
  runtime.routeFor = (url) => {
    assert.equal(url.href, source);
    return { mode: "manual", source: "test-only route", proxyUrl: "http://127.0.0.1:17891" };
  };
  const result = await fetchBrowserJd(source, runtime, undefined, { launch: async (options) => {
    launches += 1;
    assert.deepEqual(options.proxy, { server: "http://127.0.0.1:17891", bypass: "<-loopback>" });
    return fixture.browser;
  } });
  assert.equal(requests, 0);
  assert.equal(launches, 1);
  assert.match(result.text, /设备通信服务/);
  assert.equal(result.provenance.url, source);
  assert.equal(fixture.closes, 1);
  assert.equal(fixture.continued, 1);
});

test("原生主文档的HTTP、声明与实际大小、原始gate和重定向最终来源仍检查，不采用残留正文", async () => {
  const cases = [
    { body: html("", '<meta name="aliyun_waf_fixture" content="inert-test">'), code: "verification_required" },
    { body: "<title>安全验证</title><main>请完成访问验证</main>", code: "verification_required" },
    { body: "<title>登录 - BOSS直聘</title><main>请先登录</main>", code: "login_required" },
    { body: "<title>岗位已下线</title>", code: "unavailable" },
    ...[[401, "login_required"], [403, "access_denied"], [429, "rate_limited"], [500, "unavailable"]].map(([status, code]) => ({ status: status as number, code: code as JdFailureCode })),
    { headers: { "content-length": String(2 * 1024 * 1024 + 1) }, code: "unsupported_page" },
    { body: Buffer.alloc(2 * 1024 * 1024 + 1), code: "unsupported_page" },
    { url: "https://m.zhipin.com/web/passport/zp/security.html", code: "verification_required" },
    { url: "https://m.liepin.com/job/123.shtml", code: "job_mismatch" },
  ] satisfies Array<{ url?: string; status?: number; headers?: Record<string, string>; body?: string | Buffer; code: JdFailureCode }>;
  for (const testCase of cases) {
    let handler: ((route: Route) => Promise<void>) | undefined;
    let aborted = 0;
    let continued = 0;
    let evaluations = 0;
    let closes = 0;
    const events = new EventEmitter();
    const mainFrame = { parentFrame: () => null };
    const route = {
      request: () => ({ url: () => source, resourceType: () => "document", isNavigationRequest: () => true, frame: () => mainFrame }),
      fetch: async () => { assert.fail("native navigation must not call route.fetch"); },
      abort: async () => { aborted += 1; },
      fulfill: async () => { assert.fail("native navigation must not call route.fulfill"); },
      continue: async () => { continued += 1; },
    } as unknown as Route;
    const page = {
      on: events.on.bind(events), mainFrame: () => mainFrame,
      waitForNavigation: (options: { signal?: AbortSignal }) => navigationCommit(events, options),
      goto: async () => {
        assert.ok(handler); await handler(route);
        // The final native redirect response does not re-enter the route handler.
        nativeDocument(events, mainFrame, testCase);
      },
      evaluate: async () => { evaluations += 1; throw new Error("raw response check must finish before extraction"); },
    };
    const context = { routeWebSocket: async () => undefined, route: async (_pattern: string, value: (route: Route) => Promise<void>) => { handler = value; }, newPage: async () => page };
    const browser = { newContext: async () => context, close: async () => { closes += 1; } } as unknown as Browser;
    await assert.rejects(fetchBrowserJd(source, operation(), undefined, { launch: async () => browser }), isFailure(testCase.code));
    assert.equal(aborted, 0);
    assert.equal(continued, 1);
    assert.equal(evaluations, 0);
    assert.equal(closes, 1);
  }
});

test("路由仍在原生请求前阻止已知BOSS验证URL", async () => {
  let handler: ((route: Route) => Promise<void>) | undefined;
  let aborted = 0;
  let closes = 0;
  const route = {
    request: () => ({ url: () => "https://m.zhipin.com/web/passport/zp/security.html", resourceType: () => "document", isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) }),
    continue: async () => { assert.fail("known security URL must not continue"); },
    abort: async () => { aborted += 1; },
  } as unknown as Route;
  const page = { on: () => undefined, goto: async () => { assert.ok(handler); await handler(route); throw new Error("blocked navigation"); } };
  const context = { routeWebSocket: async () => undefined, route: async (_pattern: string, value: (route: Route) => Promise<void>) => { handler = value; }, newPage: async () => page };
  const browser = { newContext: async () => context, close: async () => { closes += 1; } } as unknown as Browser;
  await assert.rejects(fetchBrowserJd(source, operation(), undefined, { launch: async () => browser }), isFailure("verification_required"));
  assert.equal(aborted, 1);
  assert.equal(closes, 1);
});

test("原生response早于提交且body检查迟到时先等待，原始WAF不能被可见正文掩盖", { timeout: 3000 }, async () => {
  const body = deferred<Buffer>();
  const started = deferred<void>();
  const fixture = snapshotBrowser(source, () => assert.fail("pending raw document must stop snapshot extraction"));
  fixture.page.goto = async () => {
    nativeDocument(fixture.events, fixture.mainFrame, { body: () => { started.resolve(); return body.promise; } });
    fixture.navigate(source);
  };
  let settled = false;
  const pending = fetchBrowserJd(source, operation(), undefined, { launch: async () => fixture.browser }).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, isFailure("verification_required"));
  await started.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fixture.evaluations, 0);
  body.resolve(Buffer.from(html("", '<meta name="aliyun_waf_fixture">')));
  await rejected;
  assert.equal(fixture.closes, 1);
});

test("旧同URL响应迟到不能误伤新文档或解除新文档的待检查状态", { timeout: 5000 }, async () => {
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  for (const newerGate of [false, true]) {
    const oldBody = deferred<Buffer>();
    const newBody = deferred<Buffer>();
    const started = deferred<void>();
    const fixture = snapshotBrowser(source, () => ({ html: visible, url: source, title: "合成研发岗位" }));
    fixture.page.goto = async () => {
      nativeDocument(fixture.events, fixture.mainFrame, { body: () => oldBody.promise });
      fixture.navigate(source);
      setImmediate(() => {
        nativeDocument(fixture.events, fixture.mainFrame, { body: () => { started.resolve(); return newBody.promise; } });
        fixture.navigate(source);
        oldBody.resolve(Buffer.from(newerGate ? html("") : html("", '<meta name="aliyun_waf_fixture">')));
      });
    };
    let settled = false;
    const pending = fetchBrowserJd(source, operation(), undefined, { launch: async () => fixture.browser }).finally(() => { settled = true; });
    const result = newerGate ? assert.rejects(pending, isFailure("verification_required")) : pending;
    await started.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the previous body's completion must not release the new check");
    assert.equal(fixture.evaluations, 0);
    newBody.resolve(Buffer.from(newerGate ? html("", '<meta name="aliyun_waf_fixture">') : visible));
    await result;
    assert.equal(fixture.closes, 1);
  }
});

test("同URL新主文档body成功但未提交不能采用旧DOM，同文档或别的Request提交也不能放行", { timeout: 4000 }, async () => {
  const originalNow = Date.now;
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  const controller = new AbortController();
  const responseSeen = deferred<void>();
  let next: ReturnType<typeof nativeDocument> | undefined;
  let now = originalNow();
  Date.now = () => now;
  const fixture = snapshotBrowser(source, (evaluation) => {
    now += 450;
    if (evaluation === 2) {
      next = nativeDocument(fixture.events, fixture.mainFrame, { requestOnly: true });
      setImmediate(() => { fixture.events.emit("response", next!.response); responseSeen.resolve(); });
      return { html: visible, url: source, title: "合成研发岗位", gate: "verification_required" };
    }
    return { html: visible, url: source, title: "合成研发岗位" };
  });
  let settled = false;
  const pending = fetchBrowserJd(source, operation(), controller.signal, { launch: async () => fixture.browser }).finally(() => { settled = true; });
  try {
    await responseSeen.promise;
    await new Promise((resolve) => setImmediate(resolve));
    now += 1500;
    // A same-document navigation has no new main-resource response. An arbitrary
    // framenavigated event alone cannot prove that next.request replaced the DOM.
    fixture.navigate(source);
    fixture.events.emit("commit", null);
    await new Promise((resolve) => setImmediate(resolve));
    const other = nativeDocument(new EventEmitter(), {}, { commit: false });
    fixture.events.emit("commit", other.response);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(fixture.evaluations, 2, "a checked response cannot expose the previous document while waiting for its own commit");
    assert.ok(next);
    next.commit();
    const result = await pending;
    assert.match(result.text, /设备通信服务/);
    assert.equal(fixture.evaluations, 5);
    assert.equal(fixture.closes, 1);
  } finally { controller.abort(); await pending.catch(() => undefined); Date.now = originalNow; }
});

test("待提交主文档被同URL新请求替换后旧提交不放行，新提交或取消正确收敛", { timeout: 4000 }, async () => {
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const reason = new DOMException("cancel before native document commit", "AbortError");
    const started = deferred<void>();
    let original: ReturnType<typeof nativeDocument> | undefined;
    const fixture = snapshotBrowser(source, () => ({ html: visible, url: source, title: "合成研发岗位" }));
    fixture.page.goto = async () => {
      original = nativeDocument(fixture.events, fixture.mainFrame, { commit: false });
      started.resolve();
    };
    let settled = false;
    const pending = fetchBrowserJd(source, operation(), controller.signal, { launch: async () => fixture.browser }).finally(() => { settled = true; });
    const result = cancel ? assert.rejects(pending, (error: unknown) => error === reason) : pending;
    try {
      await started.promise;
      await new Promise((resolve) => setImmediate(resolve));
      const newer = nativeDocument(fixture.events, fixture.mainFrame, { commit: false });
      assert.ok(original);
      original.commit();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(fixture.evaluations, 0);
      if (cancel) controller.abort(reason);
      else newer.commit();
      await result;
      assert.ok(fixture.closes >= 1);
    } finally { controller.abort(reason); await pending.catch(() => undefined); }
  }
});

test("最后稳定快照出现新response时仍须等待检查，取消与迟到body不得返回成功", { timeout: 5000 }, async () => {
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  const originalNow = Date.now;
  try {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      const reason = new DOMException("cancel pending native body", "AbortError");
      const body = deferred<Buffer>();
      const started = deferred<void>();
      let now = originalNow();
      Date.now = () => now;
      const fixture = snapshotBrowser(source, (evaluation) => {
        now += 450;
        if (evaluation === 3) nativeDocument(fixture.events, fixture.mainFrame, { body: () => { started.resolve(); return body.promise; } });
        return { html: visible, url: source, title: "合成研发岗位" };
      });
      let settled = false;
      const pending = fetchBrowserJd(source, operation(), controller.signal, { launch: async () => fixture.browser }).finally(() => { settled = true; });
      const rejected = assert.rejects(pending, cancel ? (error: unknown) => error === reason : isFailure("verification_required"));
      await started.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(fixture.evaluations, 3);
      if (cancel) controller.abort(reason);
      else body.resolve(Buffer.from(html("", '<meta name="aliyun_waf_fixture">')));
      await rejected;
      // A body that completes after cancellation/cleanup must not classify or succeed.
      if (cancel) body.resolve(Buffer.from(visible));
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(fixture.closes >= 1);
    }
  } finally { Date.now = originalNow; }
});

test("原生重定向不读3xx body，子帧错误不覆盖主文档；主请求失败会结束等待", { timeout: 3000 }, async () => {
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  const fixture = snapshotBrowser(source, () => {
    nativeDocument(fixture.events, {}, { status: 403, body: html("", '<meta name="aliyun_waf_fixture">') });
    return { html: visible, url: source, title: "合成研发岗位" };
  });
  fixture.page.goto = async () => {
    nativeDocument(fixture.events, fixture.mainFrame, { status: 302, headers: { location: source }, body: async () => assert.fail("redirect responses have no readable body") });
    nativeDocument(fixture.events, fixture.mainFrame, { body: visible });
    fixture.navigate(source);
  };
  assert.match((await fetchBrowserJd(source, operation(), undefined, { launch: async () => fixture.browser })).text, /设备通信服务/);
  assert.equal(fixture.closes, 1);
  const failed = snapshotBrowser(source, () => assert.fail("failed main request cannot be extracted"));
  failed.page.goto = async () => {
    const document = nativeDocument(failed.events, failed.mainFrame, { requestOnly: true });
    setImmediate(() => failed.events.emit("requestfailed", document.request));
  };
  await assert.rejects(fetchBrowserJd(source, operation(), undefined, { launch: async () => failed.browser }), isFailure("network"));
  assert.equal(failed.closes, 1);
});

test("显式浏览器模式不会用独立静态结果替代浏览器启动", async () => {
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  assert.match(extractPublicJobHtml(visible, "BOSS直聘", source).text, /设备通信服务/);
  let launches = 0;
  await assert.rejects(fetchBrowserJd(source, operation(visible), undefined, { launch: async () => { launches += 1; throw new Error("synthetic browser unavailable"); } }), isFailure("browser_unavailable"));
  assert.equal(launches, 1);
});

test("取消期间迟到的launch返回后仍关闭浏览器，不创建页面", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancel during launch", "AbortError");
  let closes = 0;
  let contexts = 0;
  const browser = { close: async () => { closes += 1; }, newContext: async () => { contexts += 1; throw new Error("context must not open"); } } as unknown as Browser;
  await assert.rejects(fetchBrowserJd(source, operation(), controller.signal, { launch: async (options) => {
    assert.deepEqual(options.proxy, { server: "http://127.0.0.1:17891", bypass: "<-loopback>" });
    controller.abort(reason);
    await Promise.resolve();
    return browser;
  } }), (error: unknown) => error === reason);
  assert.equal(closes, 1);
  assert.equal(contexts, 0);
});

test("自动默认acquire租约只释放岗位页，持久登录路径禁写DOM诊断", async () => {
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  const f = snapshotBrowser(source, () => ({ html: visible, url: source, title: "合成研发岗位" }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-persistent-diagnostics-"));
  let releases = 0;
  try {
    const result = await fetchBrowserJd(source, operation(), undefined, {
      diagnosticsDirectory: directory,
      acquire: async (platform, _operation, signal, target) => {
        assert.equal(platform, "BOSS直聘"); assert.equal(target, source); assert.equal(signal?.aborted, false);
        const release = async () => { releases += 1; };
        return { page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release };
      },
    });
    assert.match(result.text, /设备通信服务/);
    assert.equal(releases, 1); assert.equal(f.closes, 0);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("持久acquire保留网络变更恢复指引，迟到取消只释放取得的岗位页", async () => {
  const recovery = new JdExtractionError({ code: "browser_unavailable", stage: "service", message: "请先关闭旧网络的专用浏览器" });
  await assert.rejects(fetchBrowserJd(source, operation(), undefined, { acquire: async () => { throw recovery; } }), (error: unknown) => error === recovery);
  const controller = new AbortController();
  const reason = new DOMException("late persistent page", "AbortError");
  let released = 0;
  const release = async () => { released += 1; };
  await assert.rejects(fetchBrowserJd(source, operation(), controller.signal, { acquire: async () => {
    controller.abort(reason);
    return { page: {} as Page, context: {} as BrowserContext, release, releasePage: release };
  } }), (error: unknown) => error === reason);
  assert.equal(released, 1);
});

test("自动读取不能吞掉岗位页关闭失败，报错后仍允许后续读取", async () => {
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  const f = snapshotBrowser(source, () => ({ html: visible, url: source, title: "合成研发岗位" }));
  const closingFailure = new JdExtractionError({ code: "browser_unavailable", stage: "service", message: "未能确认岗位页关闭" });
  const release = async () => { throw closingFailure; };
  await assert.rejects(fetchBrowserJd(source, operation(), undefined, {
    acquire: async () => ({ page: f.page as unknown as Page, context: f.context as unknown as BrowserContext, release, releasePage: release }),
  }), (error: unknown) => error === closingFailure);
  const nextFailure = new JdExtractionError({ code: "browser_unavailable", stage: "service", message: "下一次实际acquire" });
  await assert.rejects(fetchBrowserJd(source, operation(), undefined, { acquire: async () => { throw nextFailure; } }), (error: unknown) => error === nextFailure);
});

test("页面goto失败按网络阶段报告并关闭临时浏览器", async () => {
  let closes = 0;
  let navigations = 0;
  const page = {
    on: () => undefined,
    goto: async (url: string) => { navigations += 1; assert.equal(url, source); throw new Error("synthetic navigation failure"); },
  };
  const context = { routeWebSocket: async () => undefined, route: async () => undefined, newPage: async () => page };
  const browser = {
    newContext: async (options: unknown) => { assert.deepEqual(options, { serviceWorkers: "block", acceptDownloads: false, locale: "zh-CN" }); return context; },
    close: async () => { closes += 1; },
  } as unknown as Browser;
  await assert.rejects(fetchBrowserJd(source, operation(), undefined, { launch: async () => browser }), (error: unknown) => {
    assert.ok(error instanceof JdExtractionError);
    assert.equal(error.failure.code, "network");
    assert.equal(error.failure.stage, "connect");
    return true;
  });
  assert.equal(navigations, 1);
  assert.equal(closes, 1);
});

test("允许来源的图片字体媒体正常放行，跨平台资源仍由边界阻断", async () => {
  for (const [url, resourceHost, blockedHost] of [
    ["https://msearch.51job.com/jobs/all/123.html", "js.51jobcdn.com", "image0.lietou-static.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "img01.51jobcdn.com", "y.alicdn.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "img04.51jobcdn.com", "other.alicdn.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "o.alicdn.com", "y.alicdn.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "img.alicdn.com", "alicdn.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "g.alicdn.com", "alicdn.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "x.alicdn.com", "extra.x.alicdn.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open.aliyuncs.com", "captcha-pro-open.aliyuncs.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open-b.aliyuncs.com", "other.captcha-pro-open-b.aliyuncs.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com", "other-verify.captcha-pro-open.aliyuncs.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open-b.aliyuncs.com", "other-verify.captcha-pro-open-b.aliyuncs.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "upload.captcha-pro-open.aliyuncs.com", "errors.aliyun.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "upload.captcha-pro-open-b.aliyuncs.com", "aliyuncs.com"],
    ["https://msearch.51job.com/jobs/all/123.html", "device.captcha-open.aliyuncs.com", "captcha-open.aliyuncs.com"],
    [source, "img.bosszhipin.com", "image0.lietou-static.com"],
    ["https://m.liepin.com/job/123.shtml", "image0.lietou-static.com", "img.bosszhipin.com"],
  ]) {
    let handler: ((route: Route) => Promise<void>) | undefined;
    const continued: string[] = [];
    const aborted: string[] = [];
    const page = {
      on: () => undefined,
      goto: async () => {
        assert.ok(handler);
        for (const kind of ["image", "font", "media", "script", "stylesheet", "fetch", "xhr"]) {
          const route = {
            request: () => ({ url: () => `https://${resourceHost}/fixture`, resourceType: () => kind }),
            continue: async () => { continued.push(kind); },
            abort: async () => { aborted.push(kind); },
          } as unknown as Route;
          await handler(route);
        }
        await handler({
          request: () => ({ url: () => `https://${blockedHost}/fixture.png`, resourceType: () => "image" }),
          continue: async () => { continued.push("cross-platform"); },
          abort: async () => { aborted.push("cross-platform"); },
        } as unknown as Route);
        throw new Error("synthetic stop after resource routing");
      },
    };
    const context = { routeWebSocket: async () => undefined, route: async (_pattern: string, value: (route: Route) => Promise<void>) => { handler = value; }, newPage: async () => page };
    let closes = 0;
    const browser = { newContext: async () => context, close: async () => { closes += 1; } } as unknown as Browser;
    await assert.rejects(fetchBrowserJd(url!, operation(), undefined, { launch: async () => browser }), isFailure("network"));
    assert.deepEqual(continued, ["image", "font", "media", "script", "stylesheet", "fetch", "xhr"]);
    assert.deepEqual(aborted, ["cross-platform"]);
    assert.equal(closes, 1);
  }
});

test("导航短暂销毁evaluate上下文后继续读取，成功也关闭临时浏览器", { timeout: 5000 }, async () => {
  let closes = 0;
  let evaluations = 0;
  let navigations = 0;
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  const events = new EventEmitter();
  const mainFrame = {};
  const page = {
    on: events.on.bind(events), mainFrame: () => mainFrame,
    waitForNavigation: (options: { signal?: AbortSignal }) => navigationCommit(events, options),
    isClosed: () => false,
    url: () => source,
    goto: async (url: string) => { navigations += 1; assert.equal(url, source); nativeDocument(events, mainFrame); },
    evaluate: async (expression: string) => {
      assert.equal(expression, VISIBLE_JOB_SNAPSHOT);
      evaluations += 1;
      if (evaluations === 1) throw new Error("Execution context was destroyed, most likely because of a navigation.");
      return { html: visible, url: source, title: "合成研发岗位" };
    },
  };
  const context = { routeWebSocket: async () => undefined, route: async () => undefined, newPage: async () => page };
  const browser = { newContext: async () => context, close: async () => { closes += 1; } } as unknown as Browser;
  const result = await fetchBrowserJd(source, operation(), undefined, { launch: async () => browser });
  assert.equal(navigations, 1);
  assert.ok(evaluations >= 4, "the navigation error is retried and visible text must settle before success");
  assert.match(result.text, /设备通信服务/);
  assert.match(result.method, /浏览器加载/);
  assert.equal(result.provenance.url, source);
  assert.equal(closes, 1);
});

test("猎聘同平台中转先为空壳再出现登录DOM时等待渲染并准确归登录", { timeout: 5000 }, async () => {
  let evaluations = 0;
  let closes = 0;
  const originalUrl = "https://m.liepin.com/job/123.shtml";
  const transitUrl = "https://wow.liepin.com/t1012695/4410f519.html";
  const events = new EventEmitter();
  const mainFrame = {};
  const page = {
    on: events.on.bind(events), mainFrame: () => mainFrame,
    waitForNavigation: (options: { signal?: AbortSignal }) => navigationCommit(events, options),
    url: () => transitUrl,
    goto: async () => { nativeDocument(events, mainFrame, { url: transitUrl }); },
    evaluate: async () => {
      evaluations += 1;
      return { url: transitUrl, title: "猎聘", html: evaluations === 1 ? html('<div id="app"></div>') : html('<main class="login4c-main-container"><p>微信扫码登录</p><p>我已有账号，直接登录</p></main>') };
    },
  };
  const context = { routeWebSocket: async () => undefined, route: async () => undefined, newPage: async () => page };
  const browser = { newContext: async () => context, close: async () => { closes += 1; } } as unknown as Browser;
  await assert.rejects(fetchBrowserJd(originalUrl, operation(), undefined, { launch: async () => browser }), isFailure("login_required"));
  assert.equal(evaluations, 2);
  assert.equal(closes, 1);
});

test("猎聘中转页显示完整安全提示时立即归验证，不等待unsupported或采用残留岗位", { timeout: 5000 }, async () => {
  let evaluations = 0;
  let closes = 0;
  const events = new EventEmitter();
  const mainFrame = {};
  const page = {
    on: events.on.bind(events), mainFrame: () => mainFrame,
    waitForNavigation: (options: { signal?: AbortSignal }) => navigationCommit(events, options),
    url: () => "https://wow.liepin.com/observed-intermediate",
    goto: async () => { nativeDocument(events, mainFrame, { url: "https://wow.liepin.com/observed-intermediate" }); },
    evaluate: async () => {
      evaluations += 1;
      return { url: "https://wow.liepin.com/observed-intermediate", title: "猎聘", html: html(`<main>${liepinVerification}</main>`, posting) };
    },
  };
  const context = { routeWebSocket: async () => undefined, route: async () => undefined, newPage: async () => page };
  const browser = { newContext: async () => context, close: async () => { closes += 1; } } as unknown as Browser;
  await assert.rejects(fetchBrowserJd("https://m.liepin.com/job/123.shtml", operation(), undefined, { launch: async () => browser }), (error: unknown) => {
    assert.ok(error instanceof JdExtractionError);
    assert.equal(error.failure.code, "verification_required");
    assert.equal(error.failure.stage, "page");
    assert.match(error.message, /猎聘安全中心.*自行完成安全验证/);
    return true;
  });
  assert.equal(evaluations, 1);
  assert.equal(closes, 1);
});

test("同平台中转始终无正文归unsupported，外域和不同岗位仍立即拒绝", { timeout: 5000 }, async () => {
  const originalNow = Date.now;
  const originalUrl = "https://m.liepin.com/job/123.shtml";
  try {
    for (const [url, code] of [
      ["https://wow.liepin.com/t1012695/4410f519.html", "unsupported_page"],
      ["https://untrusted.example/job/123.shtml", "job_mismatch"],
      ["https://m.liepin.com/job/999.shtml", "job_mismatch"],
    ] as const) {
      let now = originalNow();
      Date.now = () => now;
      let evaluations = 0;
      let closes = 0;
      const events = new EventEmitter();
      const mainFrame = {};
      const page = {
        on: events.on.bind(events), mainFrame: () => mainFrame,
        waitForNavigation: (options: { signal?: AbortSignal }) => navigationCommit(events, options),
        url: () => url,
        goto: async () => { nativeDocument(events, mainFrame, { url }); },
        evaluate: async () => {
          evaluations += 1;
          now += 26_000;
          return { url, title: "合成页面", html: html('<div id="app"></div>') };
        },
      };
      const context = { routeWebSocket: async () => undefined, route: async () => undefined, newPage: async () => page };
      const browser = { newContext: async () => context, close: async () => { closes += 1; } } as unknown as Browser;
      await assert.rejects(fetchBrowserJd(originalUrl, operation(), undefined, { launch: async () => browser }), isFailure(code));
      assert.equal(evaluations, url === "https://untrusted.example/job/123.shtml" ? 0 : 1);
      assert.equal(closes, 1);
    }
  } finally { Date.now = originalNow; }
});

test("无效快照或与协议来源不一致时不采用残留正文和gate，且不泄露快照值", { timeout: 5000 }, async () => {
  const originalNow = Date.now;
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  const privateValue = "private-fixture-token";
  try {
    for (const [protocolUrl, value] of [
      [source, null],
      [source, { html: visible, url: source, title: { secret: privateValue } }],
      [source, { html: visible, url: `about:blank#${privateValue}`, title: "合成研发岗位", gate: "login_required" }],
      ["https://m.zhipin.com/", { html: visible, url: source, title: "合成研发岗位", gate: "verification_required" }],
    ] as const) {
      let now = originalNow();
      Date.now = () => now;
      const fixture = snapshotBrowser(protocolUrl, () => { now += 26_000; return value; });
      await assert.rejects(fetchBrowserJd(source, operation(), undefined, { launch: async () => fixture.browser }), (error: unknown) => {
        assert.ok(error instanceof JdExtractionError);
        assert.equal(error.failure.code, "unsupported_page");
        assert.doesNotMatch(JSON.stringify(error.failure), new RegExp(`${privateValue}|fixtureToken|about:blank|设备通信服务`));
        return true;
      });
      assert.equal(fixture.evaluations, 1);
      assert.equal(fixture.closes, 1);
    }
  } finally { Date.now = originalNow; }
});

test("evaluate期间协议地址变化或同URL主导航时丢弃旧gate，等待新正文稳定", { timeout: 5000 }, async () => {
  const originalNow = Date.now;
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  try {
    for (const nextUrl of [source, source + "&reload=1"]) {
      let now = originalNow();
      Date.now = () => now;
      const fixture = snapshotBrowser(source, (evaluation, navigate) => {
        now += 450;
        if (evaluation === 1) {
          navigate(nextUrl);
          return { html: visible, url: source, title: "合成研发岗位", gate: "verification_required" };
        }
        return { html: visible, url: nextUrl, title: "合成研发岗位" };
      });
      const result = await fetchBrowserJd(source, operation(), undefined, { launch: async () => fixture.browser });
      assert.match(result.text, /设备通信服务/);
      assert.equal(fixture.evaluations, 4, "an in-flight snapshot cannot classify a gate or seed text stability");
      assert.equal(fixture.closes, 1);
    }
  } finally { Date.now = originalNow; }
});

test("稳定正文之间出现来源无效的快照时必须重新稳定，不能沿用前一段计时", { timeout: 3000 }, async () => {
  const originalNow = Date.now;
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  let now = originalNow();
  Date.now = () => now;
  const fixture = snapshotBrowser(source, (evaluation) => {
    now += 450;
    return { html: visible, url: evaluation === 2 ? "about:blank" : source, title: "合成研发岗位" };
  });
  try {
    const result = await fetchBrowserJd(source, operation(), undefined, { launch: async () => fixture.browser });
    assert.match(result.text, /设备通信服务/);
    assert.equal(fixture.evaluations, 5);
    assert.equal(fixture.closes, 1);
  } finally { Date.now = originalNow; }
});

test("最后一次稳定快照返回时已取消，必须拒绝且关闭浏览器，不能再返回岗位成功", { timeout: 3000 }, async () => {
  const originalNow = Date.now;
  const controller = new AbortController();
  const reason = new DOMException("cancel as final snapshot returns", "AbortError");
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  let now = originalNow();
  Date.now = () => now;
  const fixture = snapshotBrowser(source, (evaluation) => {
    now += 450;
    if (evaluation === 3) controller.abort(reason);
    return { html: visible, url: source, title: "合成研发岗位" };
  });
  try {
    await assert.rejects(fetchBrowserJd(source, operation(), controller.signal, { launch: async () => fixture.browser }), (error: unknown) => error === reason);
    assert.equal(fixture.evaluations, 3, "cancellation coincides with the snapshot that would otherwise satisfy stability");
    assert.ok(fixture.closes >= 1);
  } finally { Date.now = originalNow; }
});

test("两次读取间主帧同URL或A-B-A导航重置稳定时间，子帧导航保留稳定时间", { timeout: 7000 }, async () => {
  const originalNow = Date.now;
  const visible = html(`<div class="job-sec-text">${description}</div>`, posting);
  try {
    for (const navigation of ["same-url", "away-and-back", "child-frame"] as const) {
      let now = originalNow();
      Date.now = () => now;
      const fixture = snapshotBrowser(source, (evaluation, navigate) => {
        now += 450;
        if (evaluation === 2) setTimeout(() => {
          if (navigation === "away-and-back") navigate("https://m.zhipin.com/");
          navigate(source, navigation !== "child-frame");
        }, 0);
        return { html: visible, url: source, title: "合成研发岗位" };
      });
      const result = await fetchBrowserJd(source, operation(), undefined, { launch: async () => fixture.browser });
      assert.match(result.text, /设备通信服务/);
      assert.equal(fixture.evaluations, navigation === "child-frame" ? 3 : 5, navigation);
      assert.equal(fixture.closes, 1);
    }
  } finally { Date.now = originalNow; }
});

test("猎聘同岗位移动端转桌面端且快照来源一致时可读取，保留原分享来源", { timeout: 3000 }, async () => {
  const originalNow = Date.now;
  const originalUrl = "https://m.liepin.com/job/123.shtml?mscid=fixture";
  const desktopUrl = "https://www.liepin.com/job/123.shtml?mscid=fixture";
  const visible = html(`<h1>合成研发岗位</h1><div class="job-desc-content">${description}</div>`);
  let now = originalNow();
  Date.now = () => now;
  const fixture = snapshotBrowser(desktopUrl, () => {
    now += 450;
    return { html: visible, url: desktopUrl, title: "合成研发岗位" };
  });
  try {
    const result = await fetchBrowserJd(originalUrl, operation(), undefined, { launch: async () => fixture.browser });
    assert.match(result.text, /设备通信服务/);
    assert.equal(result.provenance.url, originalUrl);
    assert.equal(fixture.evaluations, 3);
    assert.equal(fixture.closes, 1);
  } finally { Date.now = originalNow; }
});

const edgeExecutable = process.platform === "win32" ? [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .filter((root): root is string => !!root)
  .map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
  .find((candidate) => existsSync(candidate)) : undefined;

test("真实本地Edge只加载合成HTML验证可见DOM快照", { skip: edgeExecutable ? false : "当前平台没有探测到已安装的Edge；不下载浏览器", timeout: 30_000 }, async (t) => {
  const browser = await chromium.launch({
    executablePath: edgeExecutable,
    headless: true,
    args: ["--no-proxy-server", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--no-first-run"],
  });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    type LocalSnapshot = { html: string; url: string; title: string; gate?: string; oversized?: boolean };
    const snapshot = async () => {
      const value = await page.evaluate(VISIBLE_JOB_SNAPSHOT) as LocalSnapshot;
      assert.ok(value && typeof value === "object", "exported evaluate string must return the snapshot object, not a function");
      assert.equal(typeof value.html, "string");
      assert.equal(value.url, "about:blank");
      return value;
    };
    const extract = (value: LocalSnapshot) => extractPublicJobHtml(value.html, "BOSS直聘", source, { requireVisibleDescription: true });

    await t.test("初始空壳不成功，网页脚本延迟加入职责后能取得可见正文", async () => {
      await page.setContent(html(`<div id="app"></div><script>window.addEventListener('fixture-load',()=>setTimeout(()=>{document.getElementById('app').innerHTML=${JSON.stringify(`<div id="loaded" class="job-sec-text">${description}</div>`) }},50),{once:true})</script>`));
      const initial = await snapshot();
      assert.throws(() => extract(initial), isFailure("unsupported_page"));
      await page.evaluate(() => window.dispatchEvent(new Event("fixture-load")));
      await page.waitForSelector("#loaded");
      const value = await snapshot();
      assert.match(extract(value).text, /设备通信服务/);
      assert.doesNotMatch(value.html, /setTimeout/);
    });

    await t.test("祖先CSS隐藏的正文和推荐岗位不会成为目标JD", async () => {
      for (const style of ["display:none", "visibility:hidden", "opacity:0"]) {
        await page.setContent(html(`<section class="invisible"><div class="job-sec-text">${description}</div></section>`, `<style>.invisible{${style}}</style>`));
        const awaitSnapshot = await snapshot();
        assert.throws(() => extract(awaitSnapshot), isFailure("unsupported_page"));
      }
      await page.setContent(html(`<div class="job-sec-text">${description}</div><aside><div class="job-sec-text">推荐的其他岗位职责：${description}</div></aside><div class="recommend"><div class="job-sec-text">推荐岗位不应出现${description}</div></div>`));
      const value = await snapshot();
      assert.match(extract(value).text, /设备通信服务/);
      assert.doesNotMatch(extract(value).text, /推荐/);
    });

    await t.test("html或body整体隐藏时不能把残留正文当成可见岗位", async () => {
      for (const tag of ["html", "body"]) {
        for (const style of ["display:none", "visibility:hidden", "opacity:0"]) {
          await page.setContent(html(`<div class="job-sec-text">${description}</div>`, `<style>${tag}{${style}}</style>`));
          const value = await snapshot();
          assert.throws(() => extract(value), isFailure("unsupported_page"), `${tag} ${style}`);
        }
      }
    });

    await t.test("可见登录或验证modal阻断背景职责", async () => {
      for (const [text, gate] of [["请先登录后查看完整岗位", "login_required"], ["请完成安全验证，输入验证码", "verification_required"]]) {
        await page.setContent(html(`<div class="job-sec-text">${description}</div><div role="dialog" style="position:fixed;inset:0;background:white">${text}</div>`));
        const value = await snapshot();
        assert.equal(value.gate, gate);
        assert.equal(value.html, "");
      }
    });

    await t.test("祖先隐藏的登录modal不误拦截可见正文", async () => {
      for (const style of ["display:none", "visibility:hidden", "opacity:0"]) {
        await page.setContent(html(`<div class="job-sec-text">${description}</div><section style="${style}"><div role="dialog" style="width:300px;height:100px">请先登录后查看完整岗位</div></section>`));
        const value = await snapshot();
        assert.equal(value.gate, undefined, style);
        assert.match(extract(value).text, /设备通信服务/);
      }
    });

    await t.test("猎聘完整安全提示须在可见快照中出现，CSS隐藏提示不误拦安全岗位", async () => {
      const liepinUrl = "https://wow.liepin.com/observed-intermediate";
      await page.setContent(html(`<h1>行为异常</h1><main>${liepinVerification}</main>`));
      assert.equal(isObservedLiepinVerification((await snapshot()).html, liepinUrl, "猎聘"), true);
      for (const style of ["display:none", "visibility:hidden", "opacity:0"]) {
        await page.setContent(html(`<div class="job-desc-content">岗位职责：维护账号安全和行为异常分析服务。${description}</div><section style="${style}">${liepinVerification}</section>`));
        assert.equal(isObservedLiepinVerification((await snapshot()).html, liepinUrl, "猎聘"), false, style);
      }
    });

    await t.test("结构化JSON-LD不能代替浏览器未显示的隐藏职责", async () => {
      await page.setContent(html('<h1>合成研发岗位</h1><main>页面仍在加载</main>', posting));
      const value = await snapshot();
      assert.match(value.html, /application\/ld\+json/);
      assert.throws(() => extract(value), isFailure("unsupported_page"));
      await page.setContent(html(`<div class="job-sec-text">${description}</div>`, posting));
      assert.match(extract(await snapshot()).text, /设备通信服务/);
    });
    await context.close();
  } finally { await browser.close(); }
});
