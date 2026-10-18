import { readJdPublicationFields } from "../src/lib/jd-source";
import { randomUUID } from "node:crypto";
import { normalizeJobShare, allowedJobUrl, type JdImportResult } from "../src/lib/jd-source";
import { JdExtractionError, type JdFailureCode } from "../src/lib/jd-errors";
import { getNetworkOperation, type NetworkOperation } from "./network-proxy";
import { allowedBrowserResource, isBrowserVerificationUrl, isObservedBrowserLogin, isObservedLiepinVerification } from "./jd-browser";
import { detailIdentity, extractPublicJobHtml, matchesJobUrl } from "./jd-extractor";
import { validateBrowserSnapshot, type BrowserSnapshot } from "./jd-browser-snapshot";
import type { BrowserSessionInfo, BrowserSessionInspection } from "./jd-browser-session";
import { createNativeLiepinBrowser, NativeCaptureError, NativePageAcquisitionError, type NativeJobPlatform, type NativeBrowserStopMode, type NativeLiepinBrowser, type NativeLiepinPage } from "./jd-native-liepin-browser";
import { abortNative, nativePause } from "./jd-native-edge";
import { isBossDescriptionCollapsed, isSnapshotFailure, type SnapshotFailure } from "../src/lib/jd-capture-diagnostics";
import { buildPlatformSearchRequest, type PlatformSearchInput } from "@better-me/source-adapters/platform-search";
import { extractJobSearchCards, type JobSearchCaptureResult } from "./jd-search-capture";
import { matchesPlannedJobSearchUrl } from "./jd-session-router";

type Session = { id: string; owner: string; url: string; purpose: "detail" | "search"; expires: number; expiryGeneration: number; lifetime: AbortController; page?: NativeLiepinPage; acquiring?: Promise<NativeLiepinPage>; busy: boolean; ended: boolean; closing?: Promise<void>; timer: ReturnType<typeof setTimeout>; proxyUrl?: string };
export type NativeLiepinOptions = {
  platform?: NativeJobPlatform;
  browser?: NativeLiepinBrowser;
  getOperation?: () => Promise<NetworkOperation>;
  now?: () => number;
  sleep?: typeof nativePause;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};
function failure(code: JdFailureCode, message: string, stage: "service" | "page" | "connect" = "page") { return new JdExtractionError({ code, stage, message }); }
const unknownLoad = { readyState: "unknown", content: "unknown", visibleFrames: 0 } as const;
function captureDiagnostic(value: unknown): SnapshotFailure | undefined {
  return isSnapshotFailure(value) ? { stage: value.stage, reason: value.reason, ...(value.detail ? { detail: value.detail } : {}) } : undefined;
}

/** One platform owns its native profile and leases; no Playwright context is borrowed. */
export function createNativeLiepinSessions(options: NativeLiepinOptions = {}) {
  const platform = options.platform ?? "猎聘";
  const browser = options.browser ?? createNativeLiepinBrowser({ platform });
  const sessions = new Map<string, Session>();
  const launching = new Set<Promise<unknown>>();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? nativePause;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let draining: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stoppingMode: NativeBrowserStopMode | undefined;
  let recovering: Promise<boolean> | undefined;
  async function dispose(session: Session) {
    session.ended = true; clearTimer(session.timer); session.lifetime.abort(failure("browser_session_expired", "本次岗位页已结束，请重新打开岗位。"));
    if (!session.closing) session.closing = (async () => {
      if (session.page) await session.page.release();
      // A pending acquisition is still tracked by launching; its continuation owns late release.
      if (!session.acquiring) sessions.delete(session.id);
    })().finally(() => { session.closing = undefined; });
    return session.closing;
  }
  function owned(owner: string, id: string) {
    const session = sessions.get(id);
    if (!session || session.owner !== owner || session.ended || now() >= session.expires) {
      if (session && session.owner === owner && now() >= session.expires) void dispose(session).catch(() => undefined);
      throw failure("browser_session_expired", "本次岗位页已结束，请重新打开岗位。", "service");
    }
    return session;
  }
  function armExpiry(session: Session) {
    if (session.timer) clearTimer(session.timer);
    const generation = ++session.expiryGeneration;
    const expires = session.expires;
    session.timer = setTimer(() => {
      if (sessions.get(session.id) !== session || session.ended || session.expiryGeneration !== generation || session.expires !== expires) return;
      void dispose(session).catch(() => undefined);
    }, Math.max(0, expires - now()));
    session.timer.unref?.();
  }
  async function extend(owner: string, id: string, signal?: AbortSignal): Promise<BrowserSessionInfo> {
    abortNative(signal);
    const session = owned(owner, id);
    if (session.lifetime.signal.aborted || session.page?.closed) throw failure("browser_session_expired", "本次岗位页已结束，不能延长已结束的会话。", "service");
    if (draining || stopping || recovering || session.busy || session.closing || session.acquiring || !session.page) throw failure("browser_unavailable", "本会话正在操作或关闭，请等待完成后再延长。", "service");
    session.expires = Math.max(session.expires, now() + 600_000);
    armExpiry(session);
    return { sessionId: session.id, platform, url: session.url, expiresAt: new Date(session.expires).toISOString() };
  }
  async function run<T>(session: Session, external: AbortSignal | undefined, timeout: number, operation: (signal: AbortSignal) => Promise<T>, closeOnAbort = true): Promise<T> {
    if (session.busy || session.ended) throw failure("browser_unavailable", "本会话正在操作或关闭，请等待完成。", "service");
    session.busy = true;
    const controller = new AbortController();
    const cancel = () => controller.abort(external?.reason ?? failure("timeout", "本次操作已取消。"));
    const ended = () => controller.abort(session.lifetime.signal.reason);
    external?.addEventListener("abort", cancel, { once: true }); session.lifetime.signal.addEventListener("abort", ended, { once: true });
    if (external?.aborted) cancel(); if (session.lifetime.signal.aborted) ended();
    const timer = setTimeout(() => controller.abort(failure("timeout", "本次岗位操作超时，未采用未完成正文。")), timeout);
    let abort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(controller.signal.reason); if (controller.signal.aborted) abort(); else controller.signal.addEventListener("abort", abort, { once: true }); });
    const work = Promise.resolve().then(() => { abortNative(controller.signal); return operation(controller.signal); });
    let settled = false;
    const finish = () => { settled = true; session.busy = false; };
    void work.then(finish, finish);
    try { const result = await Promise.race([work, aborted]); abortNative(controller.signal); if (session.ended) throw failure("browser_session_expired", "本次岗位页已结束。"); return result; }
    catch (error) {
      if (controller.signal.aborted && closeOnAbort) { await dispose(session).catch(() => undefined); }
      throw error;
    } finally {
      clearTimeout(timer); external?.removeEventListener("abort", cancel); session.lifetime.signal.removeEventListener("abort", ended); controller.signal.removeEventListener("abort", abort);
      if (settled) session.busy = false;
    }
  }
  async function start(owner: string, input: string, signal?: AbortSignal): Promise<BrowserSessionInfo> {
    abortNative(signal);
    if (draining || stopping || recovering || sessions.size || launching.size) throw failure("browser_unavailable", "已有专用岗位页正在运行或等待关闭，请先结束本次会话。", "service");
    let source: ReturnType<typeof normalizeJobShare>;
    try { source = normalizeJobShare(input); } catch { throw failure("invalid_link", `请提供有效的${platform}官方岗位分享链接。`, "service"); }
    if (source.platform !== platform) throw failure("invalid_link", `本次原生浏览器仅用于${platform}岗位。`, "service");
    return startValidated(owner, source, "detail", signal);
  }
  async function startSearch(owner: string, input: PlatformSearchInput, signal?: AbortSignal): Promise<BrowserSessionInfo> {
    abortNative(signal);
    let source: ReturnType<typeof buildPlatformSearchRequest>;
    try { source = buildPlatformSearchRequest(input); }
    catch { throw failure("invalid_link", "平台搜索条件无效，请使用已配置的平台和地区。", "service"); }
    if (source.platform !== platform) throw failure("invalid_link", `本次原生浏览器仅用于${platform}搜索。`, "service");
    return startValidated(owner, source, "search", signal);
  }
  async function startValidated(owner: string, source: { url: string }, purpose: Session["purpose"], signal?: AbortSignal): Promise<BrowserSessionInfo> {
    abortNative(signal);
    if (draining || stopping || recovering || sessions.size || launching.size) throw failure("browser_unavailable", "已有专用岗位页正在运行或等待关闭，请先结束本次会话。", "service");
    const session: Session = { id: randomUUID(), owner, url: source.url, purpose, expires: now() + 600_000, expiryGeneration: 0, lifetime: new AbortController(), busy: false, ended: false, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    sessions.set(session.id, session); armExpiry(session);
    try {
      return await run(session, signal, 30_000, async (operationSignal) => {
        const operation = await (options.getOperation ?? getNetworkOperation)(); abortNative(operationSignal);
        session.proxyUrl = operation.routeFor(new URL(session.url)).proxyUrl;
        const acquisition = browser.acquire(session.proxyUrl, operationSignal).then(async (page) => {
          session.page = page;
          if (operationSignal.aborted || session.ended) { await page.release(); sessions.delete(session.id); abortNative(operationSignal); throw failure("browser_session_expired", "本次岗位页已结束。"); }
          return page;
        }, (error: unknown) => { if (error instanceof NativePageAcquisitionError) session.page = error.page; throw error; });
        session.acquiring = acquisition;
        launching.add(acquisition); void acquisition.finally(() => {
          launching.delete(acquisition); session.acquiring = undefined;
          if (session.ended && !session.page) sessions.delete(session.id);
        }).catch(() => undefined);
        const page = await acquisition; abortNative(operationSignal);
        await page.navigate(session.url, operationSignal); abortNative(operationSignal);
        return { sessionId: session.id, platform, url: session.url, expiresAt: new Date(session.expires).toISOString() };
      });
    } catch (error) { await dispose(session).catch(() => undefined); throw error; }
  }
  function gate(snapshot: BrowserSnapshot): "login_required" | "verification_required" | undefined {
    return snapshot.gate ?? (isBrowserVerificationUrl(snapshot.url, platform) || isObservedLiepinVerification(snapshot.html, snapshot.url, platform) ? "verification_required" : isObservedBrowserLogin(snapshot.html, snapshot.url, platform) ? "login_required" : undefined);
  }
  function gated(snapshot: BrowserSnapshot) {
    const reason = gate(snapshot);
    if (reason) throw failure(reason, reason === "verification_required" ? `${platform}要求访问验证，请在专用岗位页自行完成后再读取。` : `${platform}要求登录，请在专用岗位页自行完成后再读取。`);
  }
  async function read(owner: string, id: string, signal?: AbortSignal): Promise<JdImportResult> {
    const session = owned(owner, id);
    if (session.purpose !== "detail") throw failure("unsupported_page", "本会话用于搜索结果，请使用搜索结果读取操作。", "service");
    return run(session, signal, 45_000, async (operationSignal) => {
      const operation = await (options.getOperation ?? getNetworkOperation)(); abortNative(operationSignal);
      if (operation.routeFor(new URL(session.url)).proxyUrl !== session.proxyUrl) throw failure("browser_unavailable", "网络设置已变化，请先显式关闭岗位专用浏览器再重开。", "service");
      const page = session.page!; await page.verifyNetwork?.(operationSignal); abortNative(operationSignal); const deadline = now() + 40_000;
      let previous = ""; let since = 0; let invalidSince: number | undefined; let expansionAttempted = false;
      let last = failure("unsupported_page", "尚未找到可确认的完整岗位正文，请核对专用岗位页后再读取。");
      while (now() < deadline) {
        abortNative(operationSignal); if (page.closed) throw failure("browser_session_expired", "专用岗位页已关闭。", "service");
        const capture = await page.capture(operationSignal, undefined, session.url); abortNative(operationSignal);
        if (platform === "BOSS直聘" && capture.failure === "visibility_unsupported" && isBossDescriptionCollapsed(capture.diagnostic)
          && !expansionAttempted && capture.expansionPlan && capture.identity && page.expandDescription) {
          expansionAttempted = true; previous = ""; invalidSince = undefined;
          const clicked = await page.expandDescription(operationSignal, session.url, capture.identity); abortNative(operationSignal);
          if (clicked) { await sleep(200, operationSignal); continue; }
        }
        if (capture.failure === "visibility_unsupported") throw failure("unsupported_page", platform === "BOSS直聘" && isBossDescriptionCollapsed(capture.diagnostic)
          ? "职位描述仍被折叠，请在原岗位的职位描述区域点击“查看全部”，确认全部显示后再读取。"
          : "当前页面使用了尚未支持的裁剪或特殊文字布局，未采用可能被遮挡或截断的正文。");
        if (capture.state !== "ready" || !capture.snapshot || !capture.identity) {
          previous = "";
          if (capture.state === "navigation_in_progress") invalidSince = undefined;
          else { invalidSince ??= now(); if (now() - invalidSince >= 2400) throw last; }
          await sleep(200, operationSignal); continue;
        }
        const snapshot = capture.snapshot;
        const checked = validateBrowserSnapshot(snapshot, { url: snapshot.url, navigation: 0 }, { url: snapshot.url, navigation: 0 });
        if (checked.state !== "ready") { previous = ""; await sleep(200, operationSignal); continue; }
        gated(snapshot);
        if (snapshot.url === "about:blank") {
          previous = ""; invalidSince ??= now(); if (now() - invalidSince >= 2400) throw last;
          await sleep(200, operationSignal); continue;
        }
        if (!allowedBrowserResource(snapshot.url, platform)) throw failure("unsupported_page", "岗位页已离开本次平台来源，未采用其他页面。");
        let final: ReturnType<typeof allowedJobUrl> | undefined;
        try { final = allowedJobUrl(snapshot.url); } catch { /* A platform transit is not a confirmed job. */ }
        if (!final || final.platform !== platform || !matchesJobUrl(snapshot.url, new URL(session.url), platform)) {
          if (final && detailIdentity(new URL(final.url), final.platform)) throw failure("job_mismatch", "当前窗口不是原岗位，未采用其他职位。");
          previous = ""; invalidSince ??= now(); if (now() - invalidSince >= 2400) throw last;
          await sleep(200, operationSignal); continue;
        }
        invalidSince = undefined;
        try {
          const result = extractPublicJobHtml(snapshot.html, platform, session.url, { requireVisibleDescription: true, allowValidatedBossShareDescription: platform === "BOSS直聘", allowValidatedLiepinDescription: platform === "猎聘" });
          if (result.text.length > 120_000) throw failure("unsupported_page", "正文超过12万字，请确认是具体岗位详情。");
          const key = JSON.stringify([capture.identity, result.text]);
          if (previous !== key) { previous = key; since = now(); }
          else if (now() - since >= 800 && await page.current(capture.identity, operationSignal)) {
            abortNative(operationSignal);
            return { text: result.text, method: `人工接续 · ${result.method}`, provenance: { kind: "link", platform, url: session.url, observedAt: new Date(now()).toISOString(), title: result.title, ...readJdPublicationFields(result) } };
          }
        } catch (error) {
          if (!(error instanceof JdExtractionError)) throw failure("unsupported_page", "当前页面尚未完成岗位正文解析，请核对后再读取。");
          if (["login_required", "verification_required", "unavailable", "job_mismatch", "ambiguous_jobs"].includes(error.failure.code)) throw error;
          last = error; previous = "";
        }
        await sleep(200, operationSignal);
      }
      throw last;
    }, false);
  }
  async function readSearch(owner: string, id: string, signal?: AbortSignal): Promise<JobSearchCaptureResult> {
    const session = owned(owner, id);
    if (session.purpose !== "search") throw failure("unsupported_page", "本会话用于单个岗位详情，不能按搜索列表读取。", "service");
    return run(session, signal, 45_000, async operationSignal => {
      const operation = await (options.getOperation ?? getNetworkOperation)(); abortNative(operationSignal);
      if (operation.routeFor(new URL(session.url)).proxyUrl !== session.proxyUrl) throw failure("browser_unavailable", "网络设置已变化，请先显式关闭岗位专用浏览器再重开。", "service");
      const page = session.page!;
      await page.verifyNetwork?.(operationSignal); abortNative(operationSignal);
      const deadline = now() + 40_000;
      let previous = "", since = 0, invalidSince: number | undefined;
      const last = failure("unsupported_page", "尚未取得可确认的搜索结果，请在专用页面核对登录、地区和关键词后再读取。");
      while (now() < deadline) {
        abortNative(operationSignal);
        if (page.closed) throw failure("browser_session_expired", "专用搜索页已关闭。", "service");
        const capture = await page.capture(operationSignal, 1000, session.url, { purpose: "search" });
        abortNative(operationSignal);
        if (capture.failure === "visibility_unsupported") throw failure("unsupported_page", "搜索页面使用了尚未支持的裁剪或特殊布局，未采用可能被遮挡的结果。");
        if (capture.state !== "ready" || !capture.snapshot || !capture.identity) {
          previous = "";
          if (capture.state === "navigation_in_progress") invalidSince = undefined;
          else { invalidSince ??= now(); if (now() - invalidSince >= 2400) throw last; }
          await sleep(200, operationSignal); continue;
        }
        const snapshot = capture.snapshot;
        const checked = validateBrowserSnapshot(snapshot, { url: snapshot.url, navigation: 0 }, { url: snapshot.url, navigation: 0 });
        if (checked.state === "oversized") throw failure("unsupported_page", "搜索页面过大，请缩小搜索范围后重试。");
        if (checked.state !== "ready") { previous = ""; await sleep(200, operationSignal); continue; }
        gated(snapshot);
        if (snapshot.url === "about:blank") {
          previous = ""; invalidSince ??= now(); if (now() - invalidSince >= 2400) throw last;
          await sleep(200, operationSignal); continue;
        }
        if (!allowedBrowserResource(snapshot.url, platform) || !matchesPlannedJobSearchUrl(snapshot.url, session.url)) throw failure("job_mismatch", "搜索页面的来源、关键词或地区已变化，请返回本次搜索条件后再读取。");
        invalidSince = undefined;
        const result = extractJobSearchCards(snapshot, platform);
        const key = JSON.stringify([capture.identity, result]);
        if (previous !== key) { previous = key; since = now(); }
        else if (now() - since >= 800 && await page.current(capture.identity, operationSignal)) {
          abortNative(operationSignal);
          return result;
        }
        await sleep(200, operationSignal);
      }
      throw last;
    }, false);
  }
  async function inspect(owner: string, id: string, signal?: AbortSignal): Promise<BrowserSessionInspection> {
    const session = owned(owner, id);
    return run(session, signal, 10_000, async (operationSignal) => {
      const page = session.page!;
      try {
        await page.verifyNetwork?.(operationSignal); abortNative(operationSignal); const capture = await page.capture(operationSignal, 1000, session.url, session.purpose === "search" ? { purpose: "search" } : undefined); abortNative(operationSignal);
        const snapshot = capture.snapshot; const reason = snapshot ? gate(snapshot) : undefined;
        let pageState: BrowserSessionInspection["pageState"] = snapshot?.url === "about:blank" ? "blank" : "unknown";
        if (snapshot && capture.state === "ready" && allowedBrowserResource(snapshot.url, platform)) {
          if (session.purpose === "search") {
            // The legacy inspection enum has no search-list state. Preserve
            // unknown rather than claiming a list is a verified single job.
            if (!matchesPlannedJobSearchUrl(snapshot.url, session.url)) pageState = detailIdentity(new URL(snapshot.url), platform) ? "different_job" : "platform_intermediate";
          }
          else if (!matchesJobUrl(snapshot.url, new URL(session.url), platform)) pageState = detailIdentity(new URL(snapshot.url), platform) ? "different_job" : "platform_intermediate";
          else if (!reason) { try { extractPublicJobHtml(snapshot.html, platform, session.url, { requireVisibleDescription: true, allowValidatedBossShareDescription: platform === "BOSS直聘", allowValidatedLiepinDescription: platform === "猎聘" }); pageState = "original_job"; } catch { /* Identity alone does not establish visible job content. */ } }
        }
        if (capture.state === "ready" && capture.identity && snapshot?.url !== "about:blank" && !await page.current(capture.identity, operationSignal)) {
          abortNative(operationSignal); return { ...page.inspect(), snapshotState: "navigation_in_progress", pageState: "unknown", pageLoad: unknownLoad, snapshotFailure: { stage: "post_projection", reason: "navigation_changed" } };
        }
        abortNative(operationSignal);
        const snapshotFailure = capture.state !== "ready" ? captureDiagnostic(capture.diagnostic) : undefined;
        return { ...page.inspect(), snapshotState: capture.state, pageState, pageLoad: snapshot?.pageLoad ?? unknownLoad, ...(reason ? { gate: reason } : {}), ...(snapshotFailure ? { snapshotFailure } : {}) };
      } catch (error) {
        abortNative(operationSignal);
        if (!(error instanceof NativeCaptureError)) throw error;
        const snapshotFailure = captureDiagnostic(error.diagnostic);
        return { ...page.inspect(), snapshotState: "failed", pageState: "unknown", pageLoad: unknownLoad, ...(snapshotFailure ? { snapshotFailure } : {}) };
      }
    }, false);
  }
  async function focus(owner: string, id: string, signal?: AbortSignal): Promise<{ activationRequested: true }> {
    const session = owned(owner, id); return run(session, signal, 5000, async (operationSignal) => { await session.page!.focus(operationSignal); abortNative(operationSignal); return { activationRequested: true }; }, false);
  }
  async function close(owner: string, id: string, signal?: AbortSignal) { abortNative(signal); const session = sessions.get(id); if (session?.owner === owner) await dispose(session); return { closed: true as const }; }
  async function retryEnded(owner: string) {
    const results = await Promise.allSettled([...sessions.values()].filter(session => session.owner === owner && session.ended).map(dispose));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  function closeAll() {
    if (!draining) draining = (async () => {
      const results = await Promise.allSettled([...sessions.values()].map(dispose));
      await Promise.allSettled([...launching]);
      const late = await Promise.allSettled([...sessions.values()].map(dispose));
      if ([...results, ...late].some((result) => result.status === "rejected") || sessions.size) throw failure("browser_unavailable", "部分专用岗位页尚未确认关闭，请重试关闭。", "service");
    })().finally(() => { draining = undefined; });
    return draining;
  }
  function recoverExited(): Promise<boolean> {
    if (recovering) return recovering;
    // Do not supersede work or startup. A disconnected transport alone never
    // authorizes dropping the page/browser reservation.
    if (draining || stopping || launching.size || [...sessions.values()].some(session => session.busy)) return Promise.resolve(false);
    recovering = (async () => {
      if (!await browser.recoverExited?.()) return false;
      // The factory has proved its process tree exited and invalidated its old
      // page leases. Only now can normal disposal release manager ownership.
      await closeAll();
      return true;
    })().finally(() => { recovering = undefined; });
    return recovering;
  }
  function stopBrowser(mode: NativeBrowserStopMode = "explicit") {
    if (stopping) {
      if (mode === "explicit" && stoppingMode === "owned-only") return Promise.reject(failure("browser_unavailable", "正在清理自有浏览器资源，请完成后重试显式关闭。", "service"));
      return stopping;
    }
    stoppingMode = mode;
    const pending = (async () => {
      await closeAll().catch(() => undefined); await browser.stop(mode);
      for (const session of sessions.values()) { clearTimer(session.timer); session.ended = true; session.lifetime.abort(); } sessions.clear();
    })().finally(() => { if (stopping === pending) { stopping = undefined; stoppingMode = undefined; } });
    stopping = pending; return pending;
  }
  return {
    start, startSearch, read, readSearch, inspect, focus, extend, close, closeAll, stopBrowser, recoverExited, retryEnded,
    owns: (id: string) => sessions.has(id),
    isActive: (owner: string, id: string): boolean => {
      const session = sessions.get(id);
      return !!session && session.owner === owner && !session.ended && !session.lifetime.signal.aborted
        && now() < session.expires && !!session.page && !session.page.closed;
    },
    hasSession: () => !!(sessions.size || launching.size || draining || stopping || recovering || browser.hasUnclosed?.()),
  };
}
export const nativeLiepinSessions = createNativeLiepinSessions();
