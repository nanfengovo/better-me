import { readJdPublicationFields } from "../src/lib/jd-source";
import { type Browser, type BrowserContext, type LaunchOptions, type Page, type Request, type Response } from "playwright-core";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { allowedJobUrl, normalizeJobShare, type JdImportResult, type JobPlatform } from "../src/lib/jd-source";
import { JdExtractionError } from "../src/lib/jd-errors";
import type { NetworkOperation } from "./network-proxy";
import { detailIdentity, extractPublicJobHtml, matchesJobUrl } from "./jd-extractor";
import { validateBrowserSnapshot } from "./jd-browser-snapshot";
import { createPersistentJobBrowser, type PersistentJobPageLease } from "./jd-persistent-browser";
import { inspectNativeProfileOccupancy } from "./jd-native-edge";
import { createBossResponseObserver } from "./jd-boss-response";
import { VERIFICATION_HOSTS_51JOB } from "../src/lib/jd-verification-network";
import { rebindPlatformDetailLocations } from "@better-me/source-adapters/browser-contracts";

const TIMEOUT_MS = 60_000;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
let rendering = false;

/** Checks requests observed by route; subsequent HTTP redirect hops may not trigger this check. */
export function allowedBrowserResource(input: string, platform: JobPlatform): boolean {
  let url: URL;
  try { url = new URL(input); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const domain = { "51JOB": "51job.com", BOSS直聘: "zhipin.com", 猎聘: "liepin.com", LinkedIn: "linkedin.com" }[platform];
  const observedCdnHosts: Record<JobPlatform, string[]> = {
    "51JOB": [
      "js.51jobcdn.com", "img01.51jobcdn.com", "img04.51jobcdn.com", "o.alicdn.com", "img.alicdn.com",
      "g.alicdn.com", "x.alicdn.com",
      ...VERIFICATION_HOSTS_51JOB,
    ],
    // Observed blocked scripts needed to display BOSS's own verification UI.
    // Loading these components does not perform or bypass the verification.
    BOSS直聘: ["img.bosszhipin.com", "api.geetest.com", "api.geevisit.com", "static.geetest.com", "monitor.geetest.com", "static.geevisit.com"],
    猎聘: ["concat.lietou-static.com", "image0.lietou-static.com", "turing.captcha.qcloud.com", "turing.captcha.gtimg.com"],
    LinkedIn: [],
  };
  return url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    || observedCdnHosts[platform].includes(url.hostname)
    || (platform === "LinkedIn" && (url.hostname === "licdn.com" || url.hostname.endsWith(".licdn.com")));
}

/** Known BOSS security destinations, restricted to its official browser hosts. */
export function isBrowserVerificationUrl(input: string, platform: JobPlatform): boolean {
  try {
    const url = new URL(input);
    return platform === "BOSS直聘" && allowedBrowserResource(input, platform)
      && ["m.zhipin.com", "www.zhipin.com"].includes(url.hostname)
      && ["/web/passport/zp/security.html", "/web/common/security-check.html"].includes(url.pathname);
  } catch { return false; }
}

/** Call only with the visible DOM snapshot; a destination or page title alone is not a login gate. */
export function isObservedBrowserLogin(html: string, input: string, platform: JobPlatform): boolean {
  let url: URL;
  try { url = new URL(input); } catch { return false; }
  if (!allowedBrowserResource(input, platform)) return false;
  const liepinLanding = platform === "猎聘" && url.hostname === "wow.liepin.com" && url.pathname === "/t1012695/4410f519.html";
  const bossPage = platform === "BOSS直聘" && (url.hostname === "zhipin.com" || url.hostname.endsWith(".zhipin.com"));
  if (!liepinLanding && !bossPage) return false;
  const $ = load(html);
  $("script,style,template,noscript,[hidden],[aria-hidden='true']").remove();
  $("[style]").each((_, element) => {
    const declarations = ($(element).attr("style") ?? "").split(";");
    if (declarations.some((declaration) => /^\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*(?:0(?:\.0*)?|\.0+))\s*(?:!important\s*)?$/i.test(declaration))) $(element).remove();
  });
  if (liepinLanding) return /微信扫码登录|我已有账号[，,\s]*直接登录/.test($(".login4c-main-container").text());
  const title = $("title").first().text().replace(/\s+/g, "");
  const loginTitle = /^(?:【BOSS直聘注册登录】BOSS直聘在线注册登录|BOSS直聘注册登录|(?:注册[/·]?登录|登录[/·]?注册|登录))(?:[-—_|]BOSS直聘)?$/i.test(title);
  if (!loginTitle) return false;
  const visibleText = $("body").text().replace(/\s+/g, "");
  return /(?:微信|手机|账号密码|账号|密码|短信|验证码|扫码)登录|(?:注册[/·]登录|登录[/·]注册)/.test(visibleText)
    || (/(?:手机号|手机号码)/.test(visibleText) && /(?:验证码|密码)/.test(visibleText));
}

/** Call only with the visible DOM snapshot; matches the security notice reported by the user. */
export function isObservedLiepinVerification(html: string, input: string, platform: JobPlatform): boolean {
  let url: URL;
  try { url = new URL(input); } catch { return false; }
  if (platform !== "猎聘" || !allowedBrowserResource(input, platform) || !(url.hostname === "liepin.com" || url.hostname.endsWith(".liepin.com"))) return false;
  const $ = load(html);
  $("script,style,template,noscript,[hidden],[aria-hidden='true']").remove();
  const text = $("body").text().replace(/\s+/g, "");
  return /猎聘安全中心发现您的(?:帐号|账号)或IP可能存在异常[，,。；;：:]*为了保障您的(?:帐号|账号)及资源安全[，,。；;：:]*请进行安全验证/i.test(text);
}

export type BrowserPageLoad = {
  readyState: "loading" | "interactive" | "complete" | "unknown";
  content: "empty" | "visible_text" | "embedded_content" | "unknown";
  visibleFrames: number;
};

// Runs in the product's dedicated browser page. Keep visible DOM and structured source
// evidence, but do not read storage, cookies, input values or arbitrary page globals.
export const VISIBLE_JOB_SNAPSHOT = `(() => {
  const unknownLoad={readyState:'unknown',content:'unknown',visibleFrames:0};
  if (document.querySelectorAll('*').length > 25000) return {html:'',url:location.href,title:document.title,oversized:true,pageLoad:unknownLoad};
  const isVisible=(element)=>{
    for (let ancestor=element;ancestor;ancestor=ancestor.parentElement) {
      const style=getComputedStyle(ancestor);
      if (ancestor.hidden||ancestor.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0') return false;
    }
    return true;
  };
  const pageLoad=(()=>{
    const readyState=document.readyState;
    if (!['loading','interactive','complete'].includes(readyState)||!document.body) return unknownLoad;
    let visibleFrames=0;
    for (const frame of document.querySelectorAll('iframe')) {
      const rect=frame.getBoundingClientRect();
      if (rect.width&&rect.height&&isVisible(frame)) visibleFrames=Math.min(1000,visibleFrames+1);
      if (visibleFrames===1000) break;
    }
    let visibleText=false;
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    const range=document.createRange();
    for (let node=walker.nextNode();node;node=walker.nextNode()) {
      const parent=node.parentElement;
      if (!node.nodeValue.trim()||!parent||parent.closest('script,style,template,noscript,input,textarea,select')||!isVisible(parent)) continue;
      range.selectNodeContents(node);
      const rect=range.getBoundingClientRect();
      if (rect.width&&rect.height) {visibleText=true;break;}
    }
    return {readyState,content:visibleText?'visible_text':visibleFrames?'embedded_content':'empty',visibleFrames};
  })();
  for (const root of [document.documentElement,document.body].filter(Boolean)) {
    const style=getComputedStyle(root);
    if (root.hidden||root.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0') return {html:'<html><body></body></html>',url:location.href,title:document.title,pageLoad};
  }
  for (const modal of document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')) {
    const style=getComputedStyle(modal), rect=modal.getBoundingClientRect();
    if (style.display==='none'||style.visibility==='hidden'||style.opacity==='0'||!rect.width||!rect.height) continue;
    let hidden=false;
    for (let ancestor=modal;ancestor;ancestor=ancestor.parentElement) {
      const style=getComputedStyle(ancestor);
      if (ancestor.hidden||ancestor.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0') {hidden=true;break;}
    }
    if (hidden) continue;
    const text=modal.innerText||'';
    const gate=/(?:安全验证|人机验证|访问验证|请.{0,8}验证码|verify.{0,15}human)/i.test(text)?'verification_required':/(?:请先登录|请登录|登录后查看|sign in to continue)/i.test(text)?'login_required':undefined;
    if (gate) return {html:'',url:location.href,title:document.title,gate,pageLoad};
  }
  const clone = document.documentElement.cloneNode(true);
  const source = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  const remove = [];
  for (let i=0;i<source.length;i++) {
    const element=source[i], copy=copies[i];
    if (!copy) continue;
    const tag=element.tagName.toLowerCase();
    if (tag==='script') { if ((element.getAttribute('type')||'').trim().toLowerCase()!=='application/ld+json') remove.push(copy); continue; }
    if (['style','link','meta','title','head'].includes(tag)) continue;
    const style=getComputedStyle(element);
    if (element.hidden || element.getAttribute('aria-hidden')==='true' || style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' || style.opacity==='0') remove.push(copy);
    if (['iframe','template','noscript','input','textarea','select','button'].includes(tag)) remove.push(copy);
  }
  remove.forEach(element=>element.remove());
  clone.querySelectorAll('nav,aside,footer,.recommend,.recommendation,.recommendations,.job-recommend,.job-recommend-list,.related-jobs').forEach(element=>element.remove());
  const html=clone.outerHTML;
  return {html:html.length<=2097152?html:'',url:location.href,title:document.title,oversized:html.length>2097152,pageLoad};
})()`;

export const persistentJobBrowser = createPersistentJobBrowser({
  rootDirectory: path.resolve(import.meta.dirname, "../../../data/recruitment-browser"),
  allowedResource: allowedBrowserResource,
  inspectProfileOccupancy: inspectNativeProfileOccupancy,
});

export type BrowserReadOptions = {
  /** Isolated launch seam for local tests; production reads use the persistent runtime. */
  launch?: (options: LaunchOptions) => Promise<Browser>;
  acquire?: typeof persistentJobBrowser.acquire;
  diagnosticsDirectory?: string;
};

function failure(code: "unsupported_page" | "browser_unavailable" | "network" | "timeout" | "job_mismatch", message: string, stage: "service" | "page" | "connect" = "page"): JdExtractionError {
  return new JdExtractionError({ code, stage, message });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Explicit browser mode reads this browser's responses; document and visible-page gates still stop extraction. */
export async function fetchBrowserJd(input: string, operation: NetworkOperation, externalSignal?: AbortSignal, options: BrowserReadOptions = {}): Promise<JdImportResult> {
  if (!options.launch && !options.acquire) {
    // Compatibility callers share the product's session reservation and engine
    // selection. Explicit browser injections below are for isolated tests.
    const { browserSessionManager } = await import("./jd-browser-session");
    return browserSessionManager.readOnce(`internal-browser-read:${randomUUID()}`, input, externalSignal);
  }
  const initial = normalizeJobShare(input);
  externalSignal?.throwIfAborted();
  if (rendering) throw failure("browser_unavailable", "另一个岗位正在使用浏览器读取，请取消或等待它结束后再读。", "service");
  rendering = true;
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abort, { once: true });
  if (externalSignal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException("Browser read timed out", "TimeoutError")), TIMEOUT_MS);
  let browser: Browser | undefined;
  let lease: PersistentJobPageLease | undefined;
  let acquiredPage: Page | undefined;
  let context: BrowserContext;
  let bossResponse: ReturnType<typeof createBossResponseObserver> | undefined;
  let finished = false;
  const diagnosticId = randomUUID();
  let diagnosticHtml: string | undefined;
  const closeBrowser = () => {
    if (lease) void lease.release().catch(() => undefined);
    else if (browser) void browser.close().catch(() => undefined);
  };
  controller.signal.addEventListener("abort", closeBrowser, { once: true });
  try {
    // A separate HTTP client can receive a different page; let this browser's
    // document and rendered snapshot checks determine its own result.
    const route = operation.routeFor(new URL(initial.url));
    const launchOptions: LaunchOptions = {
      headless: true, timeout: 12_000,
      ...(process.platform === "win32" ? { channel: "msedge" } : {}),
      ...(route.proxyUrl ? { proxy: { server: route.proxyUrl, bypass: "<-loopback>" } } : { args: ["--no-proxy-server"] }),
    };
    try {
      if (options.launch) {
        browser = await options.launch(launchOptions);
        controller.signal.throwIfAborted();
        context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, locale: "zh-CN" });
        await context.routeWebSocket("**/*", (socket) => socket.close());
      } else {
        lease = await (options.acquire ?? persistentJobBrowser.acquire)(initial.platform, operation, controller.signal, initial.url);
        context = lease.context;
        acquiredPage = lease.page;
      }
    }
    catch (cause) {
      controller.signal.throwIfAborted();
      if (cause instanceof JdExtractionError) throw cause;
      throw new JdExtractionError({ code: "browser_unavailable", stage: "service", message: process.platform === "win32" ? "无法启动独立的 Microsoft Edge 读取会话，请确认本机已安装 Edge；你的日常浏览器不会被接管。" : "岗位读取浏览器不可用，请在本地服务安装 Chromium 运行时。" }, { cause });
    }
    controller.signal.throwIfAborted();
    let pageError: JdExtractionError | undefined;
    const blockedHosts = new Set<string>();
    const requestHandler: Parameters<BrowserContext["route"]>[1] = async (requestRoute) => {
      const request = requestRoute.request();
      try {
        const url = new URL(request.url());
        if (controller.signal.aborted || !allowedBrowserResource(url.href, initial.platform)) {
          blockedHosts.add(url.hostname);
          await requestRoute.abort("blockedbyclient"); return;
        }
        if (request.resourceType() === "document" && isBrowserVerificationUrl(url.href, initial.platform)) {
          throw new JdExtractionError({ code: "verification_required", stage: "page", message: "BOSS 将岗位加载跳转到访问验证页，尚未取得正文。请在原网站自行处理访问验证。" });
        }
        await requestRoute.continue();
      } catch (error) {
        if (!finished && !controller.signal.aborted && (!documentCheck || documentCheck.request === request)
          && request.isNavigationRequest() && request.frame().parentFrame() === null) {
          pageError = error instanceof JdExtractionError ? error : failure("network", "浏览器加载岗位文档失败，请检查当前网络路线。", "connect");
        }
        await requestRoute.abort("failed").catch(() => undefined);
      }
    };
    if (acquiredPage) await acquiredPage.route("**/*", requestHandler);
    else {
      await context.route("**/*", requestHandler);
      acquiredPage = await context.newPage();
    }
    const page = acquiredPage;
    if (!options.launch && initial.platform === "BOSS直聘") {
      const expectedJobId = detailIdentity(new URL(initial.url), initial.platform);
      if (expectedJobId) bossResponse = createBossResponseObserver(page, { expectedJobId, sourceUrl: initial.url, signal: controller.signal });
    }
    let navigation = 0;
    let previous: string | undefined;
    let stableAt = 0;
    const resetStability = () => { previous = undefined; stableAt = 0; };
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      navigation += 1;
      resetStability();
    });
    const position = () => ({ url: page.url(), navigation });
    type DocumentCheck = { request: Request; done: Promise<void>; finish: () => void; started: boolean; checked: boolean; committed: boolean; error?: JdExtractionError };
    let documentCheck: DocumentCheck | undefined;
    let documents = 0;
    const mainDocument = (request: Request) => {
      try { return request.resourceType() === "document" && request.isNavigationRequest() && request.frame() === page.mainFrame(); }
      catch { return false; }
    };
    page.on("request", (request) => {
      if (finished || controller.signal.aborted || !mainDocument(request)) return;
      // A same-URL navigation starts a new document too. Wake a waiter on the old
      // body, but never let that body's late result classify the new document.
      documentCheck?.finish();
      navigation += 1;
      resetStability();
      if (++documents > 32) {
        pageError = failure("unsupported_page", "岗位页面跳转过多，浏览器读取已停止。");
        return;
      }
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const check: DocumentCheck = { request, done, finish, started: false, checked: false, committed: false };
      documentCheck = check;
      // Register before this request can commit. A body that finished loading is
      // not proof that the browser replaced the previous document, even at the
      // same URL. Only the navigation API's actual main-resource Request counts.
      void (async () => {
        while (!finished && !controller.signal.aborted && documentCheck === check) {
          const response = await page.waitForNavigation({ waitUntil: "commit", signal: controller.signal, timeout: 20_000 });
          if (finished || controller.signal.aborted || documentCheck !== check) return;
          if (!response || response.request() !== request) continue;
          check.committed = true;
          if (check.checked) check.finish();
          return;
        }
      })().catch(() => {
        if (!finished && !controller.signal.aborted && documentCheck === check) {
          check.error ??= failure("network", "独立浏览器尚未确认当前岗位主文档已完成页面切换，请检查当前网络路线。", "connect");
          check.finish();
        }
      });
    });
    const inspectDocument = async (response: Response) => {
      const url = new URL(response.url());
      if (!allowedBrowserResource(url.href, initial.platform)) throw failure("job_mismatch", "岗位跳转到了当前来源范围之外，读取已停止。");
      if (isBrowserVerificationUrl(url.href, initial.platform)) throw new JdExtractionError({ code: "verification_required", stage: "page", message: "BOSS 将岗位加载跳转到访问验证页，尚未取得正文。请在原网站自行处理访问验证。" });
      if (Number(response.headers()["content-length"]) > MAX_DOCUMENT_BYTES) throw failure("unsupported_page", "岗位网页超过 2 MB，浏览器读取已停止。");
      if (response.status() >= 400) {
        const status = response.status();
        const code = status === 401 ? "login_required" : status === 403 ? "access_denied" : status === 429 ? "rate_limited" : "unavailable";
        throw new JdExtractionError({ code, stage: "http", status, message: `浏览器加载岗位时网站返回 HTTP ${status}，尚未取得正文。` });
      }
      if (response.status() >= 300 && response.status() < 400) {
        const location = response.headers().location;
        if (!location || !allowedBrowserResource(new URL(location, url).href, initial.platform)) throw failure("job_mismatch", "岗位跳转到了当前来源范围之外，读取已停止。");
        return;
      }
      const body = await response.body();
      if (finished || controller.signal.aborted) return;
      if (body.length > MAX_DOCUMENT_BYTES) throw failure("unsupported_page", "岗位网页超过 2 MB，浏览器读取已停止。");
      try { extractPublicJobHtml(body.toString("utf8"), initial.platform, url.href); }
      catch (error) {
        if (error instanceof JdExtractionError && ["verification_required", "login_required", "unavailable"].includes(error.failure.code)) throw error;
      }
    };
    page.on("response", (response) => {
      const check = documentCheck;
      if (finished || controller.signal.aborted || !check || response.request() !== check.request || check.started) return;
      // Native loading may execute scripts before this check. Await this exact
      // document's check before extracting or adopting any rendered description.
      check.started = true;
      void inspectDocument(response).catch((error: unknown) => {
        if (!finished && !controller.signal.aborted && documentCheck === check) {
          check.error = error instanceof JdExtractionError ? error : failure("network", "浏览器加载岗位文档失败，请检查当前网络路线。", "connect");
        }
      }).finally(() => {
        if (finished || controller.signal.aborted || documentCheck !== check) return;
        check.checked = true;
        if (check.error || check.committed) check.finish();
      });
    });
    page.on("requestfailed", (request) => {
      const check = documentCheck;
      if (finished || controller.signal.aborted || !check || request !== check.request) return;
      check.error = failure("network", "浏览器加载岗位文档失败，请检查当前网络路线。", "connect");
      check.finish();
    });
    const awaitDocumentCheck = async () => {
      for (;;) {
        controller.signal.throwIfAborted();
        if (pageError) throw pageError;
        const check = documentCheck;
        if (!check) throw failure("network", "独立浏览器尚未取得岗位主文档响应，请检查当前网络路线。", "connect");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { controller.signal.removeEventListener("abort", onAbort); reject(controller.signal.reason); };
          controller.signal.addEventListener("abort", onAbort, { once: true });
          void check.done.then(resolve).finally(() => controller.signal.removeEventListener("abort", onAbort));
        });
        controller.signal.throwIfAborted();
        if (pageError) throw pageError;
        if (documentCheck !== check) continue;
        if (check.error) throw check.error;
        return;
      }
    };
    const resources: Array<{ url: string; type: string; status?: number; error?: string }> = [];
    if (options.launch && options.diagnosticsDirectory) {
      page.on("response", (response) => {
        if (resources.length >= 200) return;
        const url = new URL(response.url());
        resources.push({ url: `${url.origin}${url.pathname}`, type: response.request().resourceType(), status: response.status() });
      });
      page.on("requestfailed", (request) => {
        if (resources.length >= 200) return;
        const url = new URL(request.url());
        resources.push({ url: `${url.origin}${url.pathname}`, type: request.resourceType(), error: request.failure()?.errorText });
      });
    }
    page.on("popup", (popup) => { void popup.close(); });
    try { await page.goto(initial.url, { waitUntil: "domcontentloaded", timeout: 20_000 }); }
    catch (error) {
      controller.signal.throwIfAborted();
      if (pageError) throw pageError;
      throw new JdExtractionError({ code: "network", stage: "connect", message: "独立浏览器未能完成岗位页面加载，请检查网络或打开原页核对。" }, { cause: error });
    }
    await awaitDocumentCheck();
    let lastError: JdExtractionError = failure("unsupported_page", "浏览器已加载页面，但尚未找到可确认的岗位正文。");
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await awaitDocumentCheck();
      const before = position();
      let value: unknown;
      try { value = await page.evaluate(VISIBLE_JOB_SNAPSHOT); }
      catch (error) {
        controller.signal.throwIfAborted();
        if (pageError) throw pageError;
        if (error instanceof Error && /Execution context was destroyed|Cannot find context|most likely because of a navigation/.test(error.message) && !page.isClosed()) {
          resetStability();
          await pause(400, controller.signal);
          continue;
        }
        throw error;
      }
      controller.signal.throwIfAborted();
      await awaitDocumentCheck();
      const after = position();
      const validation = validateBrowserSnapshot(value, before, after);
      if (validation.state === "oversized") throw failure("unsupported_page", "岗位页面过大，浏览器读取已停止。");
      if (validation.state !== "ready" || !validation.snapshot) {
        resetStability();
        lastError = failure("unsupported_page", "浏览器尚未取得来源稳定且可确认的岗位正文，请打开原链接核对。");
        await pause(400, controller.signal);
        continue;
      }
      const snapshot = validation.snapshot;
      if (options.launch && options.diagnosticsDirectory) {
        // Only the isolated launch fixture may write DOM diagnostics. A persistent
        // lease can be authenticated and must never create a second DOM archive.
        const changed = snapshot.html !== diagnosticHtml;
        diagnosticHtml = snapshot.html;
        await mkdir(options.diagnosticsDirectory, { recursive: true }).then(() => Promise.all([
          ...(changed ? [writeFile(path.join(options.diagnosticsDirectory!, `browser-${diagnosticId}.html`), snapshot.html, "utf8")] : []),
          writeFile(path.join(options.diagnosticsDirectory!, `browser-${diagnosticId}.json`), JSON.stringify({ ...snapshot, url: new URL(snapshot.url).origin + new URL(snapshot.url).pathname, html: undefined, blockedHosts: [...blockedHosts], resources }, null, 2), "utf8"),
        ])).catch(() => undefined);
      }
      await awaitDocumentCheck();
      // Diagnostics may yield while a new document or same-document navigation commits.
      const current = position();
      if (current.url !== after.url || current.navigation !== after.navigation) {
        resetStability();
        lastError = failure("unsupported_page", "浏览器尚未取得来源稳定且可确认的岗位正文，请打开原链接核对。");
        await pause(400, controller.signal);
        continue;
      }
      if (!allowedBrowserResource(snapshot.url, initial.platform)) throw failure("job_mismatch", "浏览器最终页面超出了原岗位平台的来源范围，请打开原链接核对。");
      if (snapshot.gate) throw new JdExtractionError({ code: snapshot.gate, stage: "page", message: snapshot.gate === "login_required" ? "网站显示了登录后才能查看的提示，尚未取得完整岗位正文。" : "网站显示了访问验证，浏览器读取已停止，请在原网站自行处理。" });
      if (isObservedLiepinVerification(snapshot.html, snapshot.url, initial.platform)) throw new JdExtractionError({ code: "verification_required", stage: "page", message: "猎聘安全中心提示账号或 IP 可能存在异常，需要你在原网站自行完成安全验证，尚未取得岗位正文。" });
      if (isObservedBrowserLogin(snapshot.html, snapshot.url, initial.platform)) throw new JdExtractionError({ code: "login_required", stage: "page", message: "平台当前显示登录或注册页面，尚未返回岗位正文，请在原网站自行完成后再读取。" });
      try { extractPublicJobHtml(snapshot.html, initial.platform); }
      catch (error) {
        if (error instanceof JdExtractionError && ["verification_required", "login_required", "unavailable"].includes(error.failure.code)) throw error;
      }
      let final: ReturnType<typeof allowedJobUrl>;
      try { final = allowedJobUrl(snapshot.url); }
      catch {
        resetStability();
        lastError = failure("unsupported_page", "浏览器正在加载同平台中转或认证页面，尚未取得可确认的岗位正文。");
        await pause(400, controller.signal);
        continue;
      }
      try {
        if (!matchesJobUrl(final.url, new URL(initial.url), initial.platform)) throw failure("job_mismatch", "浏览器显示的岗位与原始分享链接无法确认一致，请打开原岗位核对。");
        const capturedAt = new Date().toISOString();
        const result: ReturnType<typeof extractPublicJobHtml> = (() => {
          try { return extractPublicJobHtml(snapshot.html, initial.platform, final.url, { requireVisibleDescription: true, capturedAt }); }
          catch (error) {
            if (!(error instanceof JdExtractionError) || error.failure.code !== "unsupported_page") throw error;
            const observed = bossResponse?.candidate(snapshot, { committed: documentCheck?.committed === true });
            if (!observed) throw error;
            return { text: observed.text, title: observed.provenance.title, method: observed.method };
          }
        })();
        if (result.text.length > 120_000) throw failure("unsupported_page", "岗位正文超过 12 万字，请核对是否为具体岗位。");
        if (previous !== result.text) { previous = result.text; stableAt = Date.now(); }
        else if (Date.now() - stableAt >= 800) {
          const detailLocations = rebindPlatformDetailLocations(result.detailLocations, initial.url, capturedAt);
          const { detailLocations: _unbound, ...content } = result;
          return { ...content, ...(detailLocations ? { detailLocations } : {}), method: `浏览器加载 · ${result.method}`, provenance: { kind: "link", platform: initial.platform, url: initial.url, observedAt: capturedAt, title: result.title, ...readJdPublicationFields(result) } };
        }
      } catch (error) {
        resetStability();
        if (!(error instanceof JdExtractionError)) {
          lastError = failure("unsupported_page", "浏览器尚未取得可确认的岗位正文，请打开原链接核对。");
        } else if (["verification_required", "login_required", "unavailable", "job_mismatch", "ambiguous_jobs"].includes(error.failure.code)) throw error;
        else lastError = error;
      }
      await pause(400, controller.signal);
    }
    if (blockedHosts.size) lastError = failure("unsupported_page", "浏览器已加载页面，但正文仍未取得；页面还请求了未适配的外部资源，请核对原岗位。");
    throw lastError;
  } catch (error) {
    if (externalSignal?.aborted) throw externalSignal.reason ?? error;
    if (controller.signal.aborted) throw failure("timeout", "浏览器读取超过 60 秒，已结束本次会话。", "page");
    throw error;
  } finally {
    bossResponse?.dispose();
    finished = true;
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", closeBrowser);
    try {
      if (lease) await lease.release();
      else if (browser) await browser.close().catch(() => undefined);
    } finally { rendering = false; }
  }
}
