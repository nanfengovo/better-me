import { readJdPublicationFields } from "../src/lib/jd-source";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { type Browser, type BrowserContext, type LaunchOptions, type Page, type Request } from "playwright-core";
import { allowedJobUrl, normalizeJobShare, type JdImportResult, type JobPlatform } from "../src/lib/jd-source";
import { JdExtractionError, type JdFailureCode } from "../src/lib/jd-errors";
import { getNetworkOperation, type NetworkOperation } from "./network-proxy";
import { allowedBrowserResource, isBrowserVerificationUrl, isObservedBrowserLogin, isObservedLiepinVerification, persistentJobBrowser, VISIBLE_JOB_SNAPSHOT, type BrowserPageLoad } from "./jd-browser";
import type { PersistentJobPage } from "./jd-persistent-browser";
import { detailIdentity, extractPublicJobHtml, matchesJobUrl } from "./jd-extractor";
import { validateBrowserSnapshot, type BrowserSnapshot as Snapshot } from "./jd-browser-snapshot";
import { createBossResponseObserver } from "./jd-boss-response";
import { createJobSessionRouter, matchesPlannedJobSearchUrl, type JobSessionBackend } from "./jd-session-router";
import type { SnapshotFailure } from "../src/lib/jd-capture-diagnostics";
import type { NativeBrowserStopMode } from "./jd-native-liepin-browser";
import { createVerificationNetworkRecorder } from "./jd-verification-network";
import type { VerificationNetworkSnapshot } from "../src/lib/jd-verification-network";
import { buildPlatformSearchRequest, type PlatformSearchInput } from "@better-me/source-adapters/platform-search";
import { extractJobSearchCards, VISIBLE_JOB_SEARCH_SNAPSHOT, type JobSearchCaptureResult } from "./jd-search-capture";

const SESSION_TTL_MS = 10 * 60_000;
const START_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 45_000;
const INSPECT_TIMEOUT_MS = 10_000;
const FOCUS_TIMEOUT_MS = 5_000;
const INSPECT_SNAPSHOT_TIMEOUT_MS = 1_000;
const BLANK_PAGE_WAIT_MS = 2_400;
const MAX_RESOURCE_ISSUES = 30;
const DIAGNOSTIC_RESOURCE_TYPES = new Set(["document", "script", "stylesheet", "xhr", "fetch", "image", "font"]);
type Timer = ReturnType<typeof setTimeout>;
export type BrowserSessionInfo = { sessionId: string; platform: JobPlatform; url: string; expiresAt: string };
export type BrowserSessionInspection = {
  snapshotFailure?: SnapshotFailure;
  pageState: "original_job" | "platform_intermediate" | "different_job" | "blank" | "unknown";
  snapshotState: "ready" | "navigation_in_progress" | "failed" | "oversized";
  pageLoad: BrowserPageLoad;
  gate?: "login_required" | "verification_required";
  resources: Array<{
    host: string; type: string; outcome: "blocked_by_tool" | "load_failed" | "http_error";
    detail: "unknown" | "blocked_by_tool" | "cancelled" | "dns" | "proxy" | "connection" | "tls" | "timeout" | "http" | "other";
    frame: "main" | "child" | "unknown";
    httpStatus?: number;
  }>;
  mainDocument: { state: "pending" | "response" | "failed" | "unknown"; status?: number };
  mainDocumentRequests?: number;
  verificationNetwork?: VerificationNetworkSnapshot;
  truncated: boolean;
  blockedPopups: number;
  blockedSockets: number;
  scriptErrors: number;
  scriptErrorsCollected?: boolean;
};
type Session = {
  id: string; owner: string; url: string; platform: JobPlatform; purpose: "detail" | "search"; expires: number; expiryGeneration: number; lifetime: AbortController;
  browser?: Browser; context?: BrowserContext; page?: Page; lease?: PersistentJobPage; operation?: NetworkOperation; timer?: Timer;
  closed: boolean; busy: boolean; acquiring: number; closePromise?: Promise<JdExtractionError | undefined>; closeError?: JdExtractionError;
  resources: BrowserSessionInspection["resources"]; resourcesTruncated: boolean; blockedRequests: WeakSet<Request>;
  mainDocument: BrowserSessionInspection["mainDocument"]; navigationGeneration: number; snapshotNavigation: number; documentRequests: WeakMap<Request, number>;
  documentNavigation?: { request: Request; state: "pending" | "committed" | "failed"; cancel: AbortController };
  blockedPopups: number; blockedSockets: number; scriptErrors: number;
  bossResponse?: ReturnType<typeof createBossResponseObserver>;
  verificationNetwork?: ReturnType<typeof createVerificationNetworkRecorder>;
};
type ResourceIssue = BrowserSessionInspection["resources"][number];
const NETWORK_FAILURE_DETAILS = new Map<string, ResourceIssue["detail"]>([
  ["net::ERR_ABORTED", "cancelled"],
  ...["ERR_NAME_NOT_RESOLVED", "ERR_NAME_RESOLUTION_FAILED", "ERR_DNS_MALFORMED_RESPONSE", "ERR_DNS_SERVER_FAILED"].map((code) => [`net::${code}`, "dns"] as const),
  ...["ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_NO_SUPPORTED_PROXIES", "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED", "ERR_SOCKS_CONNECTION_FAILED", "ERR_SOCKS_CONNECTION_HOST_UNREACHABLE"].map((code) => [`net::${code}`, "proxy"] as const),
  ...["ERR_CONNECTION_CLOSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_ABORTED", "ERR_CONNECTION_FAILED", "ERR_ADDRESS_UNREACHABLE", "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_ACCESS_DENIED", "ERR_EMPTY_RESPONSE"].map((code) => [`net::${code}`, "connection"] as const),
  ...["ERR_CERT_COMMON_NAME_INVALID", "ERR_CERT_DATE_INVALID", "ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_CONTAINS_ERRORS", "ERR_CERT_REVOKED", "ERR_CERT_INVALID", "ERR_SSL_PROTOCOL_ERROR", "ERR_SSL_VERSION_OR_CIPHER_MISMATCH", "ERR_SSL_CLIENT_AUTH_CERT_NEEDED"].map((code) => [`net::${code}`, "tls"] as const),
  ...["ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ERR_DNS_TIMED_OUT"].map((code) => [`net::${code}`, "timeout"] as const),
]);

function requestFailureDetail(request: Request): ResourceIssue["detail"] {
  try {
    const code = request.failure()?.errorText;
    return typeof code === "string" && code ? NETWORK_FAILURE_DETAILS.get(code) ?? "other" : "unknown";
  } catch { return "unknown"; }
}

function requestFrame(session: Session, request: Request): ResourceIssue["frame"] {
  try {
    if (!session.page) return "unknown";
    const frame = request.frame();
    if (frame === session.page.mainFrame()) return "main";
    return frame.page() === session.page ? "child" : "unknown";
  } catch { return "unknown"; }
}

function documentSnapshotState(session: Session): "navigation_in_progress" | "failed" | undefined {
  if (session.documentNavigation?.state === "pending" || session.mainDocument.state === "pending") return "navigation_in_progress";
  if (session.documentNavigation?.state === "failed") return "failed";
}
export type BrowserSessionOptions = {
  /** Isolated temporary-browser injection for synthetic tests only. */
  launch?: (options: LaunchOptions) => Promise<Browser>;
  acquire?: typeof persistentJobBrowser.acquire;
  getOperation?: () => Promise<NetworkOperation>;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  stopBrowser?: (mode?: NativeBrowserStopMode) => Promise<void>;
};

function failure(code: JdFailureCode, message: string, stage: "service" | "page" | "connect" = "service") {
  return new JdExtractionError({ code, stage, message });
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One owned job page in the application's platform-specific persistent browser. */
export function createBrowserSessionManager(options: BrowserSessionOptions = {}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; });
  const clearTimer = options.clearTimer ?? clearTimeout;
  let active: Session | undefined;
  // A logically ended session can still own a page whose close failed. Keep its
  // owner/id for an explicit retry instead of reporting that unknown id closed.
  const unclosed = new Map<string, Session>();
  const closing = new Set<Promise<JdExtractionError | undefined>>();
  const launching = new Set<Promise<void>>();
  let draining: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stoppingMode: NativeBrowserStopMode | undefined;
  const closeFailure = () => failure("browser_unavailable", "未能确认本次岗位页已经关闭，请重试结束本次会话，或使用“关闭专用浏览器”。平台登录会保留。");
  function trackAcquisition(session: Session, work: Promise<unknown>) {
    session.acquiring++;
    const settled = work.then(() => undefined, () => undefined).then(() => {
      session.acquiring--; launching.delete(settled);
      if (session.closed && !session.acquiring && !session.closeError && !session.closePromise) unclosed.delete(session.id);
    });
    launching.add(settled);
  }
  function retainUnreleased(session: Session, lease: PersistentJobPage) {
    session.lease = lease; session.closeError = closeFailure(); unclosed.set(session.id, session);
  }

  function dispose(session: Session, reason = failure("browser_session_expired", "人工接续会话已关闭，请重新打开岗位。")): Promise<JdExtractionError | undefined> {
    if (session.closePromise) return session.closePromise;
    if (session.closed && !session.closeError) return Promise.resolve(undefined);
    session.closed = true;
    session.bossResponse?.dispose();
    session.verificationNetwork?.close();
    if (active === session) active = undefined;
    session.resources.length = 0;
    session.resourcesTruncated = false;
    session.blockedPopups = 0;
    session.blockedSockets = 0;
    session.scriptErrors = 0;
    session.mainDocument = { state: "unknown" };
    session.navigationGeneration = 0;
    session.snapshotNavigation = 0;
    session.documentRequests = new WeakMap();
    session.documentNavigation?.cancel.abort();
    session.documentNavigation = undefined;
    if (session.timer) clearTimer(session.timer);
    if (!session.lifetime.signal.aborted) session.lifetime.abort(reason);
    session.closeError = undefined;
    unclosed.set(session.id, session);
    // Background TTL, cancellation and close-event cleanup must never reject.
    // The explicit close action checks closeError after this settles and can
    // retry the same lease; the runtime independently retains failed pages.
    const pending = Promise.resolve().then(async () => {
      if (session.lease) await session.lease.release();
      else if (session.browser) await session.browser.close();
    }).then(() => {
      if (!session.acquiring) unclosed.delete(session.id);
      return undefined;
    }, () => {
      session.closeError = closeFailure();
      return session.closeError;
    }).finally(() => {
      closing.delete(pending);
      if (session.closePromise === pending) {
        if (session.closeError || session.acquiring) session.closePromise = undefined;
        // The final acquisition may settle between the success handler and
        // this finally. Neither path can leave a resource-free session owned.
        else unclosed.delete(session.id);
      }
    });
    session.closePromise = pending;
    closing.add(pending);
    return pending;
  }

  function owned(owner: string, sessionId: string): Session {
    if (active && now() >= active.expires) void dispose(active, failure("browser_session_expired", "人工接续会话已超过 10 分钟，请重新打开岗位。"));
    if (!active || active.closed || active.id !== sessionId || active.owner !== owner || active.page?.isClosed()) throw failure("browser_session_expired", "人工接续会话已结束或不可用，请重新打开岗位。");
    return active;
  }

  function armExpiry(session: Session) {
    if (session.timer) clearTimer(session.timer);
    const generation = ++session.expiryGeneration;
    const expires = session.expires;
    session.timer = setTimer(() => {
      // A cleared timer may already be queued. It never owns a renewed lease.
      if (active !== session || session.closed || session.expiryGeneration !== generation || session.expires !== expires) return;
      void dispose(session, failure("browser_session_expired", "人工接续会话已超过 10 分钟，请重新打开岗位。"));
    }, Math.max(0, expires - now()));
  }

  async function extend(owner: string, sessionId: string, signal?: AbortSignal): Promise<BrowserSessionInfo> {
    signal?.throwIfAborted();
    const session = owned(owner, sessionId);
    if (draining || stopping || session.closePromise || session.busy || session.acquiring || !session.page) throw failure("browser_unavailable", "本会话正在操作或关闭，请等待完成后再延长。");
    if (session.lifetime.signal.aborted) throw failure("browser_session_expired", "本次岗位页已结束，不能延长已结束的会话。");
    // This synchronous metadata operation never reads, navigates or activates
    // the page, and cancellation cannot dispose a user's verification flow.
    session.expires = Math.max(session.expires, now() + SESSION_TTL_MS);
    armExpiry(session);
    return { sessionId: session.id, platform: session.platform, url: session.url, expiresAt: new Date(session.expires).toISOString() };
  }

  async function run<T>(session: Session, external: AbortSignal | undefined, limit: number, task: (signal: AbortSignal, track: <R>(work: Promise<R>) => Promise<R>) => Promise<T>, preservePage = false): Promise<T> {
    if (external?.aborted) {
      if (preservePage) session.busy = false; else await dispose(session, external.reason);
      throw external.reason;
    }
    const controller = new AbortController();
    const cancel = () => {
      const reason = external?.reason ?? new DOMException("人工接续请求已取消。", "AbortError");
      controller.abort(reason);
      if (!preservePage) void dispose(session, reason);
    };
    const ended = () => controller.abort(session.lifetime.signal.reason);
    external?.addEventListener("abort", cancel, { once: true });
    session.lifetime.signal.addEventListener("abort", ended, { once: true });
    if (external?.aborted) cancel();
    if (session.lifetime.signal.aborted) ended();
    const timer = setTimer(() => {
      const message = limit === START_TIMEOUT_MS ? "人工接续浏览器启动超过 30 秒，本次会话已关闭。"
        : limit === INSPECT_TIMEOUT_MS ? "检查当前窗口超过 10 秒，岗位页已保留；请等待本次操作结束后重试。" : "人工接续正文读取超过 45 秒，岗位页已保留；请等待本次操作结束后重试。";
      const reason = failure("timeout", message, "page");
      controller.abort(reason);
      if (!preservePage) void dispose(session, reason);
    }, limit);
    let abortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(controller.signal.reason);
      if (controller.signal.aborted) abortListener(); else controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    let taskSettled = false, commands = 0;
    const release = () => { if (preservePage && taskSettled && commands === 0) session.busy = false; };
    const track = <R,>(work: Promise<R>): Promise<R> => {
      commands++;
      const settled = () => { commands--; release(); };
      // An observation timeout cannot cancel a command already sent to Edge.
      // Keep this session's lock until that command settles, even if its result
      // lost an internal snapshot race. Late results are never adopted.
      void work.then(settled, settled);
      return work;
    };
    let work: Promise<T>;
    try { controller.signal.throwIfAborted(); work = task(controller.signal, track); }
    catch (error) { work = Promise.reject(error); }
    const settled = () => { taskSettled = true; release(); };
    void work.then(settled, settled);
    try {
      const result = await Promise.race([work, aborted]);
      controller.signal.throwIfAborted();
      return result;
    }
    finally { clearTimer(timer); external?.removeEventListener("abort", cancel); session.lifetime.signal.removeEventListener("abort", ended); controller.signal.removeEventListener("abort", abortListener); }
  }

  // Only bounded enums, hostnames and status codes live in memory, never resource URLs or error text.
  function resourceIssue(session: Session, request: Request, outcome: ResourceIssue["outcome"], httpStatus?: number) {
    if (session.closed) return;
    const type = request.resourceType();
    if (!DIAGNOSTIC_RESOURCE_TYPES.has(type)) return;
    let host: string;
    try {
      const url = new URL(request.url());
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      host = url.hostname;
    } catch { return; }
    if (!host.includes(".") || host.length > 253 || isIP(host)
      || !host.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return;
    if (outcome === "http_error" && (!Number.isInteger(httpStatus) || httpStatus! < 400 || httpStatus! > 599)) return;
    const detail = outcome === "blocked_by_tool" ? "blocked_by_tool" : outcome === "http_error" ? "http" : requestFailureDetail(request);
    const frame = requestFrame(session, request);
    if (session.resources.some((item) => item.host === host && item.type === type && item.outcome === outcome && item.detail === detail && item.frame === frame && item.httpStatus === httpStatus)) return;
    if (session.resources.length >= MAX_RESOURCE_ISSUES) { session.resourcesTruncated = true; return; }
    session.resources.push({ host, type, outcome, detail, frame, ...(outcome === "http_error" ? { httpStatus } : {}) });
  }

  async function start(owner: string, input: string, signal?: AbortSignal): Promise<BrowserSessionInfo> {
    signal?.throwIfAborted();
    let initial: ReturnType<typeof normalizeJobShare>;
    try { initial = normalizeJobShare(input); }
    catch { throw failure("invalid_link", "请提供单个有效的官方岗位分享链接。"); }
    return startValidated(owner, initial, "detail", signal);
  }

  async function startSearch(owner: string, input: PlatformSearchInput, signal?: AbortSignal): Promise<BrowserSessionInfo> {
    signal?.throwIfAborted();
    let initial: ReturnType<typeof buildPlatformSearchRequest>;
    try { initial = buildPlatformSearchRequest(input); }
    catch { throw failure("invalid_link", "平台搜索条件无效，请使用已配置的平台和地区。"); }
    return startValidated(owner, initial, "search", signal);
  }

  async function startValidated(owner: string, initial: { url: string; platform: JobPlatform }, purpose: Session["purpose"], signal?: AbortSignal): Promise<BrowserSessionInfo> {
    signal?.throwIfAborted();
    if (draining || stopping) throw failure("browser_unavailable", "人工接续浏览器正在关闭，请稍后重新打开岗位。");
    if (active && now() >= active.expires) await dispose(active);
    if (draining || stopping) throw failure("browser_unavailable", "人工接续浏览器正在关闭，请稍后重新打开岗位。");
    if (unclosed.size && !closing.size) throw failure("browser_unavailable", "上次岗位页尚未确认关闭，请重试结束本次会话，或先关闭专用浏览器，再打开另一个岗位。");
    if (active || closing.size || launching.size) throw failure("browser_unavailable", "已有人工接续浏览器会话正在运行或关闭，请等待结束后再打开另一个岗位。");
    const session: Session = { id: randomUUID(), owner, url: initial.url, platform: initial.platform, purpose, expires: now() + SESSION_TTL_MS, expiryGeneration: 0, lifetime: new AbortController(), closed: false, busy: false, acquiring: 0, resources: [], resourcesTruncated: false, blockedRequests: new WeakSet(), blockedPopups: 0, blockedSockets: 0, scriptErrors: 0, mainDocument: { state: "unknown" }, navigationGeneration: 0, snapshotNavigation: 0, documentRequests: new WeakMap() };
    if (session.platform === "51JOB") session.verificationNetwork = createVerificationNetworkRecorder(session.platform, { now });
    active = session;
    armExpiry(session);
    try {
      const info = await run(session, signal, START_TIMEOUT_MS, async (operationSignal) => {
        session.operation = await (options.getOperation ?? getNetworkOperation)();
        operationSignal.throwIfAborted();
        let context: BrowserContext;
        let acquiredPage: Page | undefined;
        if (options.acquire || !options.launch) {
          try {
            const acquired = (options.acquire ?? persistentJobBrowser.acquire)(session.platform, session.operation, operationSignal, session.url, {
              pending: (work) => trackAcquisition(session, work),
              acquired: (lease) => {
                session.lease = lease;
                if (session.closed) retainUnreleased(session, lease);
              },
              released: (lease) => {
                if (session.closed && session.lease === lease) session.closeError = undefined;
              },
            }).then(async (lease) => {
              session.lease = lease;
              if (operationSignal.aborted || session.closed) {
                await session.closePromise;
                retainUnreleased(session, lease);
                await dispose(session);
                operationSignal.throwIfAborted();
                throw failure("browser_session_expired", "人工接续岗位页已结束，请重新打开岗位。");
              }
              return lease;
            });
            trackAcquisition(session, acquired);
            session.lease = await acquired;
            context = session.lease.context;
            acquiredPage = session.lease.page;
          } catch (error) {
            operationSignal.throwIfAborted();
            if (error instanceof JdExtractionError) throw error;
            throw failure("browser_unavailable", "无法取得工具专用的岗位浏览器页面，请确认 Microsoft Edge 和专用浏览器可用。");
          }
        } else {
          const route = session.operation.routeFor(new URL(session.url));
          let browser: Browser;
          try {
            const launched = options.launch({
              headless: false, timeout: 20_000, ...(process.platform === "win32" ? { channel: "msedge" } : {}),
              ...(route.proxyUrl ? { proxy: { server: route.proxyUrl, bypass: "<-loopback>" } } : { args: ["--no-proxy-server"] }),
            }).then(async (result) => {
              if (operationSignal.aborted || session.closed) {
                await result.close().catch(() => undefined);
                operationSignal.throwIfAborted();
                throw failure("browser_session_expired", "人工接续会话已结束，请重新打开岗位。");
              }
              return result;
            });
            const settled = launched.then(() => undefined, () => undefined);
            launching.add(settled);
            void settled.then(() => { launching.delete(settled); });
            browser = await launched;
          } catch {
            operationSignal.throwIfAborted();
            throw failure("browser_unavailable", "无法打开隔离测试浏览器，请确认本机已安装 Microsoft Edge。");
          }
          if (operationSignal.aborted || session.closed) { await browser.close().catch(() => undefined); operationSignal.throwIfAborted(); throw failure("browser_unavailable", "人工接续会话已关闭。"); }
          session.browser = browser;
          browser.on("disconnected", () => { void dispose(session); });
          context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, locale: "zh-CN" });
        }
        session.context = context;
        operationSignal.throwIfAborted();
        const routing = acquiredPage ?? context;
        await routing.routeWebSocket("**/*", (socket) => {
          if (!session.closed) session.blockedSockets = Math.min(1000, session.blockedSockets + 1);
          socket.close();
        });
        await routing.route("**/*", async (route) => {
          const request = route.request();
          try {
            let foreignNavigation = false;
            try { foreignNavigation = request.isNavigationRequest() && !!session.page && request.frame().page() !== session.page; }
            catch { /* Frame metadata may be unavailable during navigation; it must not abort an otherwise allowed resource. */ }
            if (session.closed || !allowedBrowserResource(request.url(), session.platform)
              || foreignNavigation) {
              session.blockedRequests.add(request);
              resourceIssue(session, request, "blocked_by_tool");
              await route.abort("blockedbyclient"); return;
            }
            if (session.lease) await route.fallback();
            else await route.continue();
          } catch { await route.abort("failed").catch(() => undefined); }
        });
        const page = acquiredPage ?? await context.newPage();
        session.page = page;
        if (session.lease && session.platform === "BOSS直聘") {
          const expectedJobId = detailIdentity(new URL(session.url), session.platform);
          if (expectedJobId) session.bossResponse = createBossResponseObserver(page, { expectedJobId, sourceUrl: session.url, signal: session.lifetime.signal, now });
        }
        page.on("framenavigated", (frame) => { if (!session.closed && frame === page.mainFrame()) session.snapshotNavigation += 1; });
        page.on("request", (request) => {
          if (!session.closed && session.verificationNetwork) {
            try { session.verificationNetwork.request(request, request.url(), request.resourceType()); }
            catch { /* Passive diagnostics must not interrupt page traffic. */ }
          }
          if (!session.closed && request.resourceType() === "document" && request.isNavigationRequest() && requestFrame(session, request) === "main") {
            session.documentRequests.set(request, ++session.navigationGeneration);
            session.mainDocument = { state: "pending" };
            session.snapshotNavigation += 1;
            session.documentNavigation?.cancel.abort();
            const navigation = { request, state: "pending" as "pending" | "committed" | "failed", cancel: new AbortController() };
            session.documentNavigation = navigation;
            // Response headers (or a finished body) do not prove that this
            // Request replaced the previous DOM, especially for same-URL reloads.
            // Register while the request is observed and require the public
            // navigation API's actual main-resource Request before reading it.
            void (async () => {
              const navigationSignal = AbortSignal.any([session.lifetime.signal, navigation.cancel.signal]);
              while (!session.closed && !navigationSignal.aborted && session.documentNavigation === navigation) {
                const response = await page.waitForNavigation({ waitUntil: "commit", signal: navigationSignal, timeout: 20_000 });
                if (session.closed || navigationSignal.aborted || session.documentNavigation !== navigation) return;
                if (!response || response.request() !== request) continue;
                navigation.state = "committed";
                return;
              }
            })().catch(() => {
              if (!session.closed && !navigation.cancel.signal.aborted && session.documentNavigation === navigation) navigation.state = "failed";
            });
          }
        });
        page.on("pageerror", () => { if (!session.closed) session.scriptErrors = Math.min(1000, session.scriptErrors + 1); });
        page.on("requestfailed", (request) => {
          if (session.closed) return;
          session.verificationNetwork?.failed(request);
          if (session.documentRequests.get(request) === session.navigationGeneration) {
            session.mainDocument = { state: "failed" };
            if (session.documentNavigation?.request === request) {
              session.documentNavigation.state = "failed";
              session.documentNavigation.cancel.abort();
            }
          }
          if (!session.blockedRequests.has(request)) resourceIssue(session, request, "load_failed");
        });
        page.on("response", (response) => {
          if (session.closed) return;
          const request = response.request();
          const status = response.status();
          session.verificationNetwork?.response(request, status);
          if (session.documentRequests.get(request) === session.navigationGeneration) {
            session.mainDocument = Number.isInteger(status) && status >= 100 && status <= 599 ? { state: "response", status } : { state: "unknown" };
          }
          if (status >= 400) resourceIssue(session, request, "http_error", status);
        });
        page.on("requestfinished", (request) => { if (!session.closed) session.verificationNetwork?.finished(request); });
        page.on("close", () => { void dispose(session); });
        page.on("download", (download) => { void download.cancel().catch(() => undefined); });
        page.on("popup", (popup) => {
          if (session.lease && !session.closed) session.blockedPopups = Math.min(1000, session.blockedPopups + 1);
          void popup.close().catch(() => undefined);
        });
        if (!session.lease) context.on("page", (extra) => {
          if (extra !== page) {
            if (!session.closed) session.blockedPopups = Math.min(1000, session.blockedPopups + 1);
            void extra.close().catch(() => undefined);
          }
        });
        operationSignal.throwIfAborted();
        try { await page.goto(session.url, { waitUntil: "domcontentloaded", timeout: 25_000 }); }
        catch { operationSignal.throwIfAborted(); throw failure("network", "人工接续浏览器未完成岗位页面加载，请检查网络后重新打开。", "connect"); }
        operationSignal.throwIfAborted();
        return { sessionId: session.id, platform: session.platform, url: session.url, expiresAt: new Date(session.expires).toISOString() };
      });
      // Creation/navigation is complete. Activation gets its own bounded wait:
      // a stalled CDP command must not trigger the startup timeout's disposal.
      try { await focus(owner, session.id, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (session.closed || session.page?.isClosed() || active !== session) throw error;
      }
      signal?.throwIfAborted();
      if (owned(owner, session.id) !== session) throw failure("browser_session_expired", "本次岗位页已结束，请重新打开岗位。");
      return info;
    } catch (error) { await dispose(session); throw error; }
  }

  async function focus(owner: string, sessionId: string, signal?: AbortSignal): Promise<{ activationRequested: true }> {
    signal?.throwIfAborted();
    const session = owned(owner, sessionId);
    if (draining || session.closePromise || session.busy || !session.page) throw failure("browser_unavailable", "本会话正在操作，请等待当前操作完成。");
    const page = session.page;
    session.busy = true;
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason ?? new DOMException("显示岗位页请求已取消。", "AbortError"));
    const ended = () => controller.abort(session.lifetime.signal.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    session.lifetime.signal.addEventListener("abort", ended, { once: true });
    if (signal?.aborted) cancel();
    if (session.lifetime.signal.aborted) ended();
    const timer = setTimer(() => controller.abort(failure("timeout", "请求显示本次岗位页超时，尚未确认标签页已激活；请从任务栏打开工具 Edge 核对。")), FOCUS_TIMEOUT_MS);
    let abortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(controller.signal.reason);
      if (controller.signal.aborted) abortListener(); else controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    let activation: Promise<void> | undefined;
    try {
      activation = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        if (owned(owner, sessionId) !== session) throw failure("browser_session_expired", "本次岗位页已结束，请重新打开岗位。");
        await page.bringToFront();
      });
      await Promise.race([activation, aborted]);
      controller.signal.throwIfAborted();
      if (owned(owner, sessionId) !== session) throw failure("browser_session_expired", "本次岗位页已结束，请重新打开岗位。");
      return { activationRequested: true };
    } catch (error) {
      controller.signal.throwIfAborted();
      if (error instanceof JdExtractionError) throw error;
      throw failure("browser_unavailable", "未能请求显示本次岗位页；请从任务栏打开工具 Edge，或检查本次岗位页是否仍有效。");
    } finally {
      clearTimer(timer);
      signal?.removeEventListener("abort", cancel);
      session.lifetime.signal.removeEventListener("abort", ended);
      controller.signal.removeEventListener("abort", abortListener);
      // Focus cancellation must preserve verification. A sent CDP activation
      // cannot be revoked, so keep it busy until that operation settles; an
      // explicit close/TTL may still end the session at any time.
      const settled = () => { session.busy = false; };
      if (activation) void activation.then(settled, settled); else settled();
    }
  }

  async function read(owner: string, sessionId: string, signal?: AbortSignal): Promise<JdImportResult> {
    const session = owned(owner, sessionId);
    if (session.purpose !== "detail") throw failure("unsupported_page", "本会话用于搜索结果，请使用搜索结果读取操作。");
    if (session.busy || !session.page) throw failure("browser_unavailable", "本会话正在读取，请等待当前操作完成。");
    session.busy = true;
    return run(session, signal, READ_TIMEOUT_MS, async (operationSignal, track) => {
        const page = session.page!;
        let previous: string | undefined;
        let stableAt = 0;
        let blankSince: number | undefined;
        let invalidSnapshotSince: number | undefined;
        let previousNavigation = session.snapshotNavigation;
        const resetStability = () => {
          previous = undefined;
          stableAt = 0;
          blankSince = undefined;
        };
        let lastError = failure("unsupported_page", "原岗位页面已打开，但还没有可确认的完整正文，请在接续窗口核对。", "page");
        const deadline = now() + 40_000;
        while (now() < deadline) {
          operationSignal.throwIfAborted();
          if (page.isClosed()) throw failure("browser_session_expired", "接续窗口已关闭，请重新打开岗位。");
          if (previousNavigation !== session.snapshotNavigation) {
            resetStability();
            invalidSnapshotSince = undefined;
            previousNavigation = session.snapshotNavigation;
          }
          if (documentSnapshotState(session) === "navigation_in_progress") {
            resetStability();
            invalidSnapshotSince = undefined;
            await (options.sleep ?? pause)(400, operationSignal);
            continue;
          }
          if (documentSnapshotState(session) === "failed") throw failure("unsupported_page", "尚未确认当前岗位主文档已完成页面切换，窗口已保留，请核对后再读取。", "page");
          const before = { url: page.url(), navigation: session.snapshotNavigation };
          const requestGeneration = session.navigationGeneration;
          let candidate: unknown;
          try { candidate = await track(page.evaluate(VISIBLE_JOB_SNAPSHOT)); }
          catch {
            operationSignal.throwIfAborted();
            resetStability();
            invalidSnapshotSince = undefined;
            await (options.sleep ?? pause)(400, operationSignal);
            continue;
          }
          operationSignal.throwIfAborted();
          const checked = documentSnapshotState(session) || session.navigationGeneration !== requestGeneration
            ? { state: documentSnapshotState(session) ?? "navigation_in_progress" as const }
            : validateBrowserSnapshot(candidate, before, { url: page.url(), navigation: session.snapshotNavigation });
          if (checked.state === "oversized") throw failure("unsupported_page", "岗位页面过大，请核对具体岗位正文。", "page");
          if (checked.state !== "ready" || !checked.snapshot) {
            resetStability();
            if (checked.state === "failed") {
              invalidSnapshotSince ??= now();
              lastError = failure("unsupported_page", "无法确认当前页面快照与实际窗口来源一致，窗口已保留，请核对后再读取。", "page");
              if (now() - invalidSnapshotSince >= BLANK_PAGE_WAIT_MS) throw lastError;
            } else invalidSnapshotSince = undefined;
            await (options.sleep ?? pause)(400, operationSignal);
            continue;
          }
          invalidSnapshotSince = undefined;
          const snapshot = checked.snapshot;
          if (snapshot.url === "about:blank") {
            previous = undefined;
            stableAt = 0;
            blankSince ??= now();
            lastError = failure("unsupported_page", "接续窗口当前为空白页，尚未取得原岗位正文；窗口已保留，请核对后再读取。", "page");
            if (now() - blankSince >= BLANK_PAGE_WAIT_MS) throw lastError;
            await (options.sleep ?? pause)(400, operationSignal);
            continue;
          }
          blankSince = undefined;
          if (!allowedBrowserResource(snapshot.url, session.platform)) throw failure("job_mismatch", "窗口中的页面无法确认属于原岗位，请返回原链接核对。", "page");
          if (snapshot.gate) throw failure(snapshot.gate, snapshot.gate === "login_required" ? "接续窗口仍显示登录提示，请自行完成后再读取。" : "接续窗口仍显示访问验证，请自行完成后再读取。", "page");
          if (isBrowserVerificationUrl(snapshot.url, session.platform)) throw failure("verification_required", "接续窗口仍停留在网站访问验证页，请自行处理后再读取。", "page");
          if (isObservedLiepinVerification(snapshot.html, snapshot.url, session.platform)) throw failure("verification_required", "猎聘安全中心要求安全验证，请在接续窗口自行处理后再读取。", "page");
          if (isObservedBrowserLogin(snapshot.html, snapshot.url, session.platform)) throw failure("login_required", "接续窗口仍显示平台登录或注册页面，请自行完成后再读取。", "page");
          try { extractPublicJobHtml(snapshot.html, session.platform); }
          catch (error) { if (error instanceof JdExtractionError && ["login_required", "verification_required", "unavailable"].includes(error.failure.code)) throw error; }
          let final: ReturnType<typeof allowedJobUrl> | undefined;
          try { final = allowedJobUrl(snapshot.url); }
          catch { /* Official authentication/transit hosts may be outside the static detail host list. */ }
          if (!final || !matchesJobUrl(final.url, new URL(session.url), session.platform)) {
            if (final && (final.platform !== session.platform || detailIdentity(new URL(final.url), final.platform))) throw failure("job_mismatch", "当前窗口不是原岗位，未读取其他职位；请返回原岗位后再试。", "page");
            // Reading never navigates: an unrecognized transit page may still be the user's
            // active login or verification flow. Let the user choose when to return to the job.
            throw failure("unsupported_page", "当前窗口停留在平台中转或非岗位页面，请自行返回原岗位后再读取；当前窗口已保留。", "page");
          }
          try {
            const result = (() => {
              try { return extractPublicJobHtml(snapshot.html, session.platform, final.url, { requireVisibleDescription: true }); }
              catch (error) {
                if (!(error instanceof JdExtractionError) || error.failure.code !== "unsupported_page") throw error;
                const observed = session.bossResponse?.candidate(snapshot, { committed: session.documentNavigation?.state === "committed" });
                if (!observed) throw error;
                return { text: observed.text, title: observed.provenance.title, method: observed.method };
              }
            })();
            if (result.text.length > 120_000) throw failure("unsupported_page", "岗位正文超过 12 万字，请确认这是具体岗位详情。", "page");
            if (previous !== result.text) { previous = result.text; stableAt = now(); }
            else if (now() - stableAt >= 800) return { ...result, method: `人工接续 · ${result.method}`, provenance: { kind: "link", platform: session.platform, url: session.url, observedAt: new Date(now()).toISOString(), title: result.title, ...readJdPublicationFields(result) } };
          } catch (error) {
            previous = undefined;
            if (!(error instanceof JdExtractionError)) throw failure("unsupported_page", "当前页面尚未完成岗位正文解析，窗口已保留，请核对原岗位后再读取。", "page");
            if (["login_required", "verification_required", "unavailable", "job_mismatch", "ambiguous_jobs"].includes(error.failure.code)) throw error;
            lastError = error;
          }
          await (options.sleep ?? pause)(400, operationSignal);
        }
        throw lastError;
      }, true);
  }

  async function readSearch(owner: string, sessionId: string, signal?: AbortSignal): Promise<JobSearchCaptureResult> {
    const session = owned(owner, sessionId);
    if (session.purpose !== "search") throw failure("unsupported_page", "本会话用于单个岗位详情，不能按搜索列表读取。");
    if (session.busy || !session.page) throw failure("browser_unavailable", "本会话正在操作，请等待当前操作完成。");
    session.busy = true;
    return run(session, signal, READ_TIMEOUT_MS, async (operationSignal, track) => {
      const operation = await (options.getOperation ?? getNetworkOperation)();
      operationSignal.throwIfAborted();
      if (operation.routeFor(new URL(session.url)).proxyUrl !== session.operation?.routeFor(new URL(session.url)).proxyUrl) throw failure("browser_unavailable", "网络设置已变化，请先关闭岗位专用浏览器再重开。");
      const page = session.page!;
      const deadline = now() + 40_000;
      let previous = "", stableAt = 0, invalidSince: number | undefined;
      const last = failure("unsupported_page", "尚未取得可确认的搜索结果，请在专用页面核对登录、地区和关键词后再读取。", "page");
      while (now() < deadline) {
        operationSignal.throwIfAborted();
        if (page.isClosed()) throw failure("browser_session_expired", "专用搜索页已关闭。");
        if (documentSnapshotState(session) === "navigation_in_progress") {
          previous = ""; invalidSince = undefined;
          await (options.sleep ?? pause)(400, operationSignal); continue;
        }
        if (documentSnapshotState(session) === "failed") throw last;
        const before = { url: page.url(), navigation: session.snapshotNavigation };
        const requestGeneration = session.navigationGeneration;
        let candidate: unknown;
        try { candidate = await track(page.evaluate(VISIBLE_JOB_SEARCH_SNAPSHOT)); }
        catch {
          operationSignal.throwIfAborted(); previous = "";
          await (options.sleep ?? pause)(400, operationSignal); continue;
        }
        operationSignal.throwIfAborted();
        const checked = documentSnapshotState(session) || session.navigationGeneration !== requestGeneration
          ? { state: documentSnapshotState(session) ?? "navigation_in_progress" as const }
          : validateBrowserSnapshot(candidate, before, { url: page.url(), navigation: session.snapshotNavigation });
        if (checked.state === "oversized") throw failure("unsupported_page", "搜索页面过大，请缩小搜索范围后重试。", "page");
        if (checked.state !== "ready" || !checked.snapshot) {
          previous = "";
          if (checked.state === "failed") { invalidSince ??= now(); if (now() - invalidSince >= BLANK_PAGE_WAIT_MS) throw last; }
          else invalidSince = undefined;
          await (options.sleep ?? pause)(400, operationSignal); continue;
        }
        const snapshot = checked.snapshot;
        if (snapshot.url === "about:blank") {
          previous = ""; invalidSince ??= now(); if (now() - invalidSince >= BLANK_PAGE_WAIT_MS) throw last;
          await (options.sleep ?? pause)(400, operationSignal); continue;
        }
        if (!allowedBrowserResource(snapshot.url, session.platform)) throw failure("job_mismatch", "搜索页面已离开本次平台来源，未采用其他页面。", "page");
        if (snapshot.gate) throw failure(snapshot.gate, snapshot.gate === "login_required" ? "搜索页仍显示登录提示，请自行完成后再读取。" : "搜索页仍显示访问验证，请自行完成后再读取。", "page");
        if (isBrowserVerificationUrl(snapshot.url, session.platform) || isObservedLiepinVerification(snapshot.html, snapshot.url, session.platform)) throw failure("verification_required", "搜索页要求访问验证，请在专用页面自行处理后再读取。", "page");
        if (isObservedBrowserLogin(snapshot.html, snapshot.url, session.platform)) throw failure("login_required", "搜索页要求登录，请在专用页面自行完成后再读取。", "page");
        if (!matchesPlannedJobSearchUrl(snapshot.url, session.url)) throw failure("job_mismatch", "搜索页面的来源、关键词或地区已变化，请返回本次搜索条件后再读取。", "page");
        invalidSince = undefined;
        const captureTruncated = typeof candidate === "object" && candidate !== null
          && "captureTruncated" in candidate && candidate.captureTruncated === true;
        const result = extractJobSearchCards({ ...snapshot, ...(captureTruncated ? { captureTruncated: true } : {}) }, session.platform);
        const key = JSON.stringify([before.navigation, snapshot.url, result]);
        if (previous !== key) { previous = key; stableAt = now(); }
        else if (now() - stableAt >= 800
          && !documentSnapshotState(session) && session.navigationGeneration === requestGeneration
          && session.snapshotNavigation === before.navigation && page.url() === before.url) return result;
        await (options.sleep ?? pause)(400, operationSignal);
      }
      throw last;
    }, true);
  }

  async function inspect(owner: string, sessionId: string, signal?: AbortSignal): Promise<BrowserSessionInspection> {
    const session = owned(owner, sessionId);
    if (session.busy || !session.page) throw failure("browser_unavailable", "本会话正在操作，请等待当前操作完成。");
    session.busy = true;
    return run(session, signal, INSPECT_TIMEOUT_MS, async (operationSignal, track) => {
        // Do not navigate: a refresh can destroy the verification the user is currently attempting.
        let snapshot: Snapshot | undefined;
        let snapshotState: BrowserSessionInspection["snapshotState"];
        const before = { url: session.page!.url(), navigation: session.snapshotNavigation };
        const requestGeneration = session.navigationGeneration;
        const navigationChanged = () => documentSnapshotState(session) === "navigation_in_progress" || session.navigationGeneration !== requestGeneration || session.snapshotNavigation !== before.navigation || session.page!.url() !== before.url;
        if (documentSnapshotState(session) === "navigation_in_progress") snapshotState = "navigation_in_progress";
        else if (documentSnapshotState(session) === "failed") snapshotState = "failed";
        else {
          let snapshotTimer: Timer | undefined;
          let abortSnapshot: () => void = () => undefined;
          const unavailable = new Promise<undefined>((resolve, reject) => {
            snapshotTimer = setTimer(() => resolve(undefined), INSPECT_SNAPSHOT_TIMEOUT_MS);
            abortSnapshot = () => reject(operationSignal.reason);
            operationSignal.addEventListener("abort", abortSnapshot, { once: true });
          });
          try {
            // Navigation may begin after the pending check; a stalled evaluate must not end the user's session.
            const candidate: unknown = await Promise.race([track(session.page!.evaluate(VISIBLE_JOB_SNAPSHOT)), unavailable]);
            const checked = validateBrowserSnapshot(candidate, before, { url: session.page!.url(), navigation: session.snapshotNavigation });
            snapshotState = navigationChanged() ? "navigation_in_progress" : documentSnapshotState(session) ?? checked.state;
            snapshot = snapshotState === "ready" ? checked.snapshot : undefined;
          } catch (error) {
            operationSignal.throwIfAborted();
            snapshotState = navigationChanged()
              || (error instanceof Error && /Execution context was destroyed|Cannot find context|most likely because of a navigation/.test(error.message)) ? "navigation_in_progress" : "failed";
          } finally {
            if (snapshotTimer) clearTimer(snapshotTimer);
            operationSignal.removeEventListener("abort", abortSnapshot);
          }
        }
        operationSignal.throwIfAborted();
        let pageLoad: BrowserPageLoad = { readyState: "unknown", content: "unknown", visibleFrames: 0 };
        const measured = snapshot?.pageLoad;
        if (snapshotState === "ready" && measured
          && ["loading", "interactive", "complete"].includes(measured.readyState)
          && ["empty", "visible_text", "embedded_content"].includes(measured.content)
          && Number.isInteger(measured.visibleFrames) && measured.visibleFrames >= 0 && measured.visibleFrames <= 1000) {
          pageLoad = { readyState: measured.readyState, content: measured.content, visibleFrames: measured.visibleFrames };
        }
        let pageState: BrowserSessionInspection["pageState"] = "unknown";
        let gate: BrowserSessionInspection["gate"];
        if (snapshot && snapshotState === "ready" && snapshot.url === "about:blank") pageState = "blank";
        else if (snapshot && snapshotState === "ready"
          && allowedBrowserResource(snapshot.url, session.platform)) {
          gate = snapshot.gate;
          if (!gate && (isBrowserVerificationUrl(snapshot.url, session.platform)
            || isObservedLiepinVerification(snapshot.html, snapshot.url, session.platform))) gate = "verification_required";
          if (!gate && isObservedBrowserLogin(snapshot.html, snapshot.url, session.platform)) gate = "login_required";
          if (!gate) {
            try { extractPublicJobHtml(snapshot.html, session.platform); }
            catch (error) {
              if (error instanceof JdExtractionError && (error.failure.code === "login_required" || error.failure.code === "verification_required")) gate = error.failure.code;
            }
          }
          let final: ReturnType<typeof allowedJobUrl> | undefined;
          try { final = allowedJobUrl(snapshot.url); }
          catch { pageState = "platform_intermediate"; }
          if (final) {
            if (final.platform !== session.platform || !matchesJobUrl(final.url, new URL(session.url), session.platform)) {
              pageState = detailIdentity(new URL(final.url), final.platform) ? "different_job" : "platform_intermediate";
            }
            else if (!gate) {
              try {
                extractPublicJobHtml(snapshot.html, session.platform, final.url, { requireVisibleDescription: true });
                pageState = "original_job";
              } catch { /* Original URL without a confirmed visible job is still unknown. */ }
            }
          }
        }
        return { pageState, snapshotState, pageLoad, ...(gate ? { gate } : {}), resources: session.resources.map((item) => ({ ...item })), mainDocument: { ...session.mainDocument }, mainDocumentRequests: Math.min(1000, session.navigationGeneration), ...(session.verificationNetwork ? { verificationNetwork: session.verificationNetwork.snapshot() } : {}), truncated: session.resourcesTruncated, blockedPopups: session.blockedPopups, blockedSockets: session.blockedSockets, scriptErrors: session.scriptErrors };
      }, true);
  }

  async function retryEnded(owner: string) {
    const results = await Promise.allSettled([...unclosed.values()].filter(session => session.owner === owner && session.closed).map(session => dispose(session)));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) throw result.value;
    }
  }

  function closeAll(): Promise<void> {
    if (draining) return draining;
    const end = async () => {
      const sessions = new Set(unclosed.values());
      if (active) sessions.add(active);
      await Promise.all([...sessions].map((session) => dispose(session)));
      while (closing.size || launching.size) await Promise.all([...closing, ...launching]);
    };
    draining = end().finally(() => { draining = undefined; });
    return draining;
  }

  return {
    owns: (sessionId: string) => active?.id === sessionId || unclosed.has(sessionId),
    isActive: (owner: string, sessionId: string): boolean => !!active && active.id === sessionId && active.owner === owner
      && !active.closed && !active.lifetime.signal.aborted && now() < active.expires && !!active.page && !active.page.isClosed(),
    hasSession: () => {
      if (active && now() >= active.expires) void dispose(active);
      const runtimeBusy = !options.acquire && !options.launch
        && persistentJobBrowser.status().some((slot) => slot.state !== "ready" || slot.activePages > 0);
      return !!active || unclosed.size > 0 || closing.size > 0 || launching.size > 0 || !!draining || !!stopping || runtimeBusy;
    },
    start, startSearch, read, readSearch, inspect, focus, extend, retryEnded,
    close: async (owner: string, sessionId: string) => {
      // Idempotent for expired/unknown IDs and never closes another owner's/newer session.
      const session = active?.id === sessionId ? active : unclosed.get(sessionId);
      if (session?.owner === owner) {
        const closeError = await dispose(session);
        if (closeError) throw closeError;
      }
      return { closed: true as const };
    },
    closeAll,
    stopBrowser(mode: NativeBrowserStopMode = "explicit") {
      if (stopping) {
        if (mode === "explicit" && stoppingMode === "owned-only") return Promise.reject(failure("browser_unavailable", "正在清理自有浏览器资源，请完成后重试显式关闭。"));
        return stopping;
      }
      stoppingMode = mode;
      const pending = (async () => {
        await closeAll().catch(() => undefined);
        await (options.stopBrowser ?? persistentJobBrowser.stop)(mode);
        // Successful browser shutdown also permits retrying a previously failed
        // page release, so stale session ownership cannot block the next start.
        await closeAll();
      })().finally(() => { if (stopping === pending) { stopping = undefined; stoppingMode = undefined; } });
      stopping = pending;
      return pending;
    },
  };
}

// These modules share extraction helpers. Load the native module only when an
// operation runs, so importing its factory cannot initialize it through a cycle.
function nativeBackend(platform: "猎聘" | "BOSS直聘" | "51JOB"): JobSessionBackend {
  let sessions: ReturnType<typeof import("./jd-native-liepin")["createNativeLiepinSessions"]> | undefined;
  let loading: Promise<NonNullable<typeof sessions>> | undefined;
  const load = () => loading ??= Promise.all([
    import("./jd-native-liepin"), import("./jd-native-liepin-browser"), import("./jd-managed-browser-proxy"),
  ]).then(([manager, browser, proxy]) => sessions = manager.createNativeLiepinSessions({
    platform,
    browser: browser.createNativeLiepinBrowser({ platform, networkMode: "managed-proxy", verifyManagedProxy: proxy.verifyManagedDomesticBrowserProxy }),
  }));
  return {
    start: async (...args) => (await load()).start(...args),
    startSearch: async (...args) => (await load()).startSearch(...args),
    read: async (...args) => (await load()).read(...args),
    readSearch: async (...args) => (await load()).readSearch(...args),
    inspect: async (...args) => (await load()).inspect(...args),
    focus: async (...args) => (await load()).focus(...args),
    extend: async (...args) => (await load()).extend(...args),
    close: async (...args) => (await load()).close(...args),
    closeAll: async () => { const current = sessions ?? (loading ? await loading : undefined); await current?.closeAll(); },
    stopBrowser: async (mode = "explicit") => {
      const current = mode === "owned-only" ? sessions ?? (loading ? await loading : undefined) : await load();
      await current?.stopBrowser(mode);
    },
    recoverExited: async () => sessions ? sessions.recoverExited() : false,
    retryEnded: async (owner) => { if (sessions) await sessions.retryEnded(owner); },
    owns: (id) => sessions?.owns(id) ?? false,
    isActive: (owner, id) => sessions?.isActive(owner, id) ?? false,
    hasSession: () => sessions?.hasSession() ?? false,
  };
}
export const browserSessionManager = createJobSessionRouter(createBrowserSessionManager(), nativeBackend("猎聘"), { nativeBoss: nativeBackend("BOSS直聘"), native51Job: nativeBackend("51JOB") });
