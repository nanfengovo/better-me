import { chromium, type BrowserContext, type Page } from "playwright-core";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { JobPlatform } from "../src/lib/jd-source";
import { JdExtractionError } from "../src/lib/jd-errors";
import type { NetworkOperation } from "./network-proxy";

type PersistentLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
export type PersistentJobBrowserLaunch = (userDataDir: string, options: PersistentLaunchOptions) => Promise<BrowserContext>;
export type PersistentJobBrowserOptions = {
  /** A private application-data directory, never a person's daily browser profile. */
  rootDirectory?: string;
  launch?: PersistentJobBrowserLaunch;
  /** Optional Chrome DevTools Protocol endpoint to take over an already opened real browser */
  cdpUrl?: string;
  /** Read-only exact profile inspection; absence cannot prove an explicit stop. */
  inspectProfileOccupancy?: (profileDirectory: string) => Promise<"clear" | "occupied" | "unknown">;
  allowedResource: (input: string, platform: JobPlatform) => boolean;
};
export type PersistentJobPageOptions = { signal?: AbortSignal; targetUrl?: string; acquisition?: PersistentJobPageAcquisitionObserver };
export type PersistentJobPage = {
  page: Page;
  context: BrowserContext;
  /** Closes only this lease's job page; the profile and keep-alive page remain. */
  releasePage: () => Promise<void>;
  release: () => Promise<void>;
};
export type PersistentJobPageLease = PersistentJobPage;
/** Lets the requesting session retain ownership of cleanup that outlives cancellation. */
export type PersistentJobPageAcquisitionObserver = {
  pending: (work: Promise<unknown>) => void;
  acquired: (lease: PersistentJobPage) => void;
  released: (lease: PersistentJobPage) => void;
};
export type PersistentJobBrowserStatus = { platform: JobPlatform; state: "starting" | "ready" | "close_failed"; activePages: number };

const PLATFORMS: Record<JobPlatform, { directory: string; origin: string }> = {
  "51JOB": { directory: "51job", origin: "https://msearch.51job.com" },
  BOSS直聘: { directory: "boss", origin: "https://m.zhipin.com" },
  猎聘: { directory: "liepin", origin: "https://m.liepin.com" },
  LinkedIn: { directory: "linkedin", origin: "https://www.linkedin.com" },
  Seek: { directory: "seek", origin: "https://www.seek.com.au" },
  Indeed: { directory: "indeed", origin: "https://www.indeed.com" },
  GradConnection: { directory: "gradconnection", origin: "https://gradconnection.com" },
};

function unavailable(message: string, cause?: unknown): JdExtractionError {
  return new JdExtractionError({ code: "browser_unavailable", stage: "service", message }, cause === undefined ? undefined : { cause });
}

function platformDetails(platform: JobPlatform) {
  if (!Object.hasOwn(PLATFORMS, platform)) throw unavailable("不支持为该岗位来源创建专用浏览器。");
  return PLATFORMS[platform];
}

type ContextState = {
  context: BrowserContext;
  alive: boolean;
  closed: boolean;
  keepAlive?: Page;
  keepingAlive?: Promise<void>;
  closing?: Promise<void>;
  closeError?: JdExtractionError;
  pages: Set<Page>;
  failedPages: Set<Page>;
};
type Slot = {
  platform: JobPlatform;
  profileDirectory: string;
  proxyUrl?: string;
  ready: Promise<ContextState>;
  initialized: boolean;
  state?: ContextState;
  waiters: number;
  retired: boolean;
  retirementListeners: Set<() => void>;
  reason?: unknown;
};

/**
 * Owns only this application's persistent profiles. A lease never owns the
 * context: normal reads, cancellation and session expiry release one job page.
 * The host explicitly calls closePlatform/closeAll to stop browser windows.
 */
export function createPersistentJobBrowser(options: PersistentJobBrowserOptions) {
  const rootDirectory = path.resolve(options.rootDirectory ?? path.join(process.cwd(), "data", "job-browser"));
  const slots = new Map<JobPlatform, Slot>();
  const initializing = new Set<Slot>();
  // A retired slot can still own a live process/profile after close rejects.
  // Keep that ownership until the context's actual close event is confirmed.
  const unclosed = new Set<Slot>();
  const draining = new Set<Slot>();
  const closing = new Map<JobPlatform, Promise<void>>();
  let closingAll: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stoppingMode: "explicit" | "owned-only" | undefined;
  const unconfirmedProfiles = new Set<JobPlatform>();

  function retire(slot: Slot, reason: unknown) {
    if (slot.retired) return;
    slot.retired = true;
    slot.reason = reason;
    if (slots.get(slot.platform) === slot) slots.delete(slot.platform);
    for (const listener of slot.retirementListeners) listener();
    slot.retirementListeners.clear();
  }

  async function closeContext(slot: Slot, state: ContextState) {
    state.alive = false;
    if (state.closing) return state.closing;
    if (state.closed || state.context.isClosed()) {
      state.closed = true;
      state.closeError = undefined;
      state.pages.clear();
      state.failedPages.clear();
      unclosed.delete(slot);
      return;
    }
    const pending = (async () => {
      let cause: unknown;
      try { await state.context.close(); }
      catch (error) { cause = error; }
      if (!state.closed && !state.context.isClosed()) {
        state.closeError = unavailable("未能确认专用 Edge 窗口已经关闭。请检查该工具的浏览器窗口，再重试关闭；当前不会重新启动同一登录目录。", cause);
        throw state.closeError;
      }
      state.closed = true;
      state.closeError = undefined;
      state.pages.clear();
      state.failedPages.clear();
      unclosed.delete(slot);
    })().finally(() => { if (state.closing === pending) state.closing = undefined; });
    state.closing = pending;
    return pending;
  }

  async function closeOwnedContext(slot: Slot, state: ContextState) {
    draining.add(slot);
    try { await closeContext(slot, state); }
    finally { draining.delete(slot); }
  }

  function trackPage(state: ContextState, page: Page) {
    if (state.pages.has(page) || page.isClosed()) return;
    state.pages.add(page);
    page.on("close", () => { state.pages.delete(page); state.failedPages.delete(page); });
  }

  async function closeJobPage(state: ContextState, page: Page) {
    if (page === state.keepAlive) throw unavailable("基础保活页不能当作岗位页关闭，请使用关闭专用浏览器。");
    trackPage(state, page);
    let cause: unknown;
    if (!page.isClosed()) {
      try { await page.close(); }
      catch (error) { cause = error; }
    }
    if (!page.isClosed()) {
      state.failedPages.add(page);
      throw unavailable("未能确认本次岗位页已经关闭。请重试结束本次会话，或使用关闭专用浏览器；平台登录会保留。", cause);
    }
    state.pages.delete(page);
    state.failedPages.delete(page);
  }

  async function keepAlive(slot: Slot, state: ContextState): Promise<void> {
    if (slot.retired || !state.alive) throw slot.reason ?? unavailable("专用浏览器窗口已经关闭，请重新打开岗位。");
    if (state.keepAlive && !state.keepAlive.isClosed()) return;
    if (state.keepingAlive) return state.keepingAlive;
    const pending = (async () => {
      const page = await state.context.newPage();
      if (slot.retired || !state.alive) {
        await closeJobPage(state, page);
        throw slot.reason ?? unavailable("专用浏览器窗口已经关闭，请重新打开岗位。");
      }
      state.keepAlive = page;
      // The base tab never serves a job and cannot navigate to a login/JD page.
      await page.route("**/*", (route) => route.abort("blockedbyclient"));
      if (page.isClosed()) throw unavailable("专用浏览器的保活页已关闭，请重新打开岗位。");
      const restore = () => {
        if (state.keepAlive !== page || slot.retired || !state.alive) return;
        state.keepAlive = undefined;
        void Promise.resolve().then(async () => {
          await state.keepingAlive?.catch(() => undefined);
          if (!slot.retired && state.alive) await keepAlive(slot, state);
        }).catch(() => {
          retire(slot, unavailable("专用浏览器无法保留基础窗口，请重新打开岗位。"));
          // Background cleanup retains closeError/unclosed on failure. An
          // explicit stop can then report the failure and retry the same slot.
          void closeOwnedContext(slot, state).catch(() => undefined);
        });
      };
      page.on("close", restore);
      page.on("crash", () => {
        restore();
        void closeJobPage(state, page).catch(() => {
          retire(slot, unavailable("保活页崩溃后未能确认关闭，请重试关闭专用浏览器。"));
          void closeOwnedContext(slot, state).catch(() => undefined);
        });
      });
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame() || page.url() === "about:blank" || page.isClosed() || slot.retired || !state.alive) return;
        void page.goto("about:blank").catch(() => undefined);
      });
      if (page.url() !== "about:blank") await page.goto("about:blank");
    })();
    state.keepingAlive = pending;
    try { await pending; }
    finally { if (state.keepingAlive === pending) state.keepingAlive = undefined; }
  }

  async function initialize(slot: Slot): Promise<ContextState> {
    let state: ContextState | undefined;
    try {
      await mkdir(slot.profileDirectory, { recursive: true, mode: 0o700 });
      if (slot.retired) throw slot.reason;
      for (const file of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try {
          await unlink(path.join(slot.profileDirectory, file));
        } catch { /* Best-effort operation: preserve the surrounding fallback on failure. */ }
      }
      const isTestLaunch = Boolean(options.launch);
      const defaultArgs = isTestLaunch ? ["--no-proxy-server"] : [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-proxy-server",
      ];
      const context = await (options.launch ?? chromium.launchPersistentContext.bind(chromium))(slot.profileDirectory, {
        channel: isTestLaunch ? "msedge" : (process.platform === "win32" ? "msedge" : "chrome"),
        headless: false,
        timeout: 12_000,
        serviceWorkers: isTestLaunch ? "block" : "allow",
        acceptDownloads: false,
        locale: "zh-CN",
        ...(slot.proxyUrl ? { proxy: { server: slot.proxyUrl, bypass: "<-loopback>" } } : { args: defaultArgs }),
      });
      state = { context, alive: true, closed: false, pages: new Set(), failedPages: new Set() };
      slot.state = state;
      unclosed.add(slot);
      if (!isTestLaunch) {
        await context.addInitScript(`(() => {
          try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          } catch (_) {}
          try {
            if (!window.chrome) {
              window.chrome = { runtime: {} };
            }
          } catch (_) {}
          try {
            Object.defineProperty(navigator, 'plugins', {
              get: () => [1, 2, 3, 4, 5],
            });
          } catch (_) {}
          try {
            Object.defineProperty(navigator, 'languages', {
              get: () => ['zh-CN', 'zh', 'en'],
            });
          } catch (_) {}
        })()`);
      }
      const currentState = state;
      context.on("close", () => {
        currentState.alive = false;
        currentState.closed = true;
        currentState.closeError = undefined;
        currentState.pages.clear();
        currentState.failedPages.clear();
        unclosed.delete(slot);
        retire(slot, unavailable("专用浏览器窗口已经关闭，请重新打开岗位。"));
      });
      if (slot.retired) throw slot.reason;
      if (isTestLaunch) {
        await context.routeWebSocket("**/*", (socket) => socket.close());
      }
      await context.route("**/*", async (route) => {
        try {
          if (slot.retired || !currentState.alive || !options.allowedResource(route.request().url(), slot.platform)) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        } catch { await route.abort("failed").catch(() => undefined); }
      });
      // Preserve the current popup policy without confusing a new lease or the
      // keep-alive tab with a popup. No existing personal browser is attached.
      context.on("page", (page) => {
        void page.opener().then(async (opener) => { if (opener) await closeJobPage(currentState, page); }).catch(() => undefined);
      });
      const startupPages = context.pages();
      await keepAlive(slot, state);
      await Promise.all(startupPages.map((page) => page === currentState.keepAlive ? Promise.resolve() : closeJobPage(currentState, page)));
      if (slot.retired || !state.alive) throw slot.reason ?? unavailable("专用浏览器窗口已经关闭，请重新打开岗位。");
      slot.initialized = true;
      return state;
    } catch (error) {
      const browserName = options.launch ? "Microsoft Edge" : (process.platform === "win32" ? "Microsoft Edge" : "Google Chrome");
      const reason = error instanceof JdExtractionError ? error : unavailable(`无法启动工具专用的 ${browserName}，请确认 ${browserName} 已安装且专用数据目录可写。`, error);
      retire(slot, reason);
      if (state) await closeOwnedContext(slot, state);
      throw reason;
    }
  }

  function newSlot(platform: JobPlatform, proxyUrl?: string): Slot {
    const details = platformDetails(platform);
    // The platform is selected from fixed names, never used as a filesystem path.
    const profileDirectory = path.join(rootDirectory, details.directory, "profile");
    const slot: Slot = { platform, profileDirectory, proxyUrl, ready: undefined!, initialized: false, waiters: 0, retired: false, retirementListeners: new Set() };
    slots.set(platform, slot);
    initializing.add(slot);
    slot.ready = initialize(slot).finally(() => { initializing.delete(slot); });
    // A cancelled sole waiter may leave an in-flight launch to settle later.
    // Consume its rejection now, and initialize will close any late context.
    void slot.ready.catch(() => undefined);
    return slot;
  }

  function waitFor<T>(pending: Promise<T>, slot: Slot, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { signal?.removeEventListener("abort", onAbort); slot.retirementListeners.delete(onRetire); };
      const onAbort = () => { cleanup(); reject(signal?.reason); };
      const onRetire = () => { cleanup(); reject(slot.reason); };
      // Even a synchronous cancellation must observe an eventual newPage error.
      void pending.catch(() => undefined);
      if (signal?.aborted) { reject(signal.reason); return; }
      if (slot.retired) { reject(slot.reason); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      slot.retirementListeners.add(onRetire);
      void pending.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    });
  }

  async function acquirePage(platform: JobPlatform, operation: NetworkOperation, settings: PersistentJobPageOptions = {}): Promise<PersistentJobPage> {
    platformDetails(platform);
    settings.signal?.throwIfAborted();
    if (stopping || unconfirmedProfiles.has(platform) || closingAll || closing.has(platform) || [...unclosed].some((item) => item.platform === platform && item.retired) || [...draining].some((item) => item.platform === platform)
      || [...initializing].some((item) => item.platform === platform && item.retired)) throw unavailable("专用浏览器正在关闭，请等待关闭完成后再打开岗位。");
    const target = new URL(settings.targetUrl ?? PLATFORMS[platform].origin);
    if (!options.allowedResource(target.href, platform)) throw unavailable("岗位来源不属于该专用浏览器的平台。");
    const route = operation.routeFor(target);
    let slot = slots.get(platform);
    if (slot && slot.proxyUrl !== route.proxyUrl) throw unavailable("该平台的专用浏览器仍使用打开时的网络设置；请先明确关闭该平台浏览器，再使用新网络设置重新打开。");
    slot ??= newSlot(platform, route.proxyUrl);
    slot.waiters += 1;
    let delivered = false;
    let abandoned = false;
    let createdPage: Page | undefined;
    let createdLease: PersistentJobPage | undefined;
    let cleanupAttempted = false;
    const releaseCreated = async () => {
      if (!createdLease) return;
      await createdLease.release();
      settings.acquisition?.released(createdLease);
    };
    try {
      const state = await waitFor(slot.ready, slot, settings.signal);
      await waitFor(keepAlive(slot, state), slot, settings.signal);
      // Register the pending work before even a synchronous test context can
      // produce a page. Cancellation may return before this work settles.
      const pendingPage = Promise.resolve().then(() => state.context.newPage()).then(async (page) => {
        createdPage = page;
        if (page === state.keepAlive) throw unavailable("专用浏览器未能创建独立岗位页。");
        trackPage(state, page);
        let release: Promise<void> | undefined;
        const releasePage = () => release ??= closeJobPage(state, page).catch((error: unknown) => { release = undefined; throw error; });
        createdLease = { page, context: state.context, releasePage, release: releasePage };
        settings.acquisition?.acquired(createdLease);
        if (abandoned || slot.retired || !state.alive || settings.signal?.aborted) {
          cleanupAttempted = true;
          await releaseCreated();
          settings.signal?.throwIfAborted();
          throw slot.reason ?? unavailable("本次岗位页面已取消或关闭。");
        }
        return page;
      });
      settings.acquisition?.pending(pendingPage);
      const page = await waitFor(pendingPage, slot, settings.signal);
      settings.signal?.throwIfAborted();
      if (slot.retired || !state.alive || page.isClosed()) throw slot.reason ?? unavailable("专用浏览器岗位页面已经关闭，请重新打开。");
      if (page === state.keepAlive) throw unavailable("专用浏览器未能创建独立岗位页。");
      delivered = true;
      return createdLease!;
    } catch (error) {
      abandoned = true;
      if (createdPage && slot.state && createdPage !== slot.state.keepAlive && !createdPage.isClosed() && !cleanupAttempted) {
        await releaseCreated();
      }
      throw error;
    } finally {
      slot.waiters -= 1;
      // No caller owns an unfinished launch after its last waiter cancels. A
      // fully initialized context, in contrast, deliberately stays resident.
      if (!delivered && !slot.initialized && slot.waiters === 0) retire(slot, unavailable("本次专用浏览器启动已取消。"));
    }
  }

  async function closeSlot(slot: Slot): Promise<void> {
    retire(slot, unavailable("专用浏览器已按要求关闭，请重新打开岗位。"));
    if (slot.state) await closeOwnedContext(slot, slot.state);
    // Also waits for a non-abortable late launch, which initialize closes.
    await slot.ready.catch(() => undefined);
    if (slot.state && !slot.state.closed) {
      if (slot.state.closeError) throw slot.state.closeError;
      await closeOwnedContext(slot, slot.state);
    }
  }

  function closePlatform(platform: JobPlatform): Promise<void> {
    platformDetails(platform);
    const existing = closing.get(platform);
    if (existing) return existing;
    const targets = new Set([...initializing, ...draining, ...unclosed].filter((slot) => slot.platform === platform));
    const slot = slots.get(platform);
    if (slot) targets.add(slot);
    if (!targets.size) return Promise.resolve();
    const pending = settleClosures([...targets].map(closeSlot)).finally(() => { if (closing.get(platform) === pending) closing.delete(platform); });
    closing.set(platform, pending);
    return pending;
  }

  function closeAll(): Promise<void> {
    if (closingAll) return closingAll;
    const platforms = new Set([...slots.keys(), ...[...initializing, ...draining, ...unclosed].map((slot) => slot.platform)]);
    const pending = settleClosures([...new Set([...platforms].map(closePlatform).concat([...closing.values()]))]).finally(() => { if (closingAll === pending) closingAll = undefined; });
    closingAll = pending;
    return pending;
  }

  function stop(mode: "explicit" | "owned-only" = "explicit"): Promise<void> {
    if (stopping) {
      if (mode === "explicit" && stoppingMode === "owned-only") return Promise.reject(unavailable("正在清理自有浏览器资源，请完成后重试显式关闭。"));
      return stopping;
    }
    stoppingMode = mode;
    const pending = (async () => {
      await closeAll();
      if (mode === "owned-only") return;
      // The fixed profile list belongs to this pool. A process match prevents a
      // false success; it never grants ownership to attach, close, or kill it.
      await Promise.all((Object.keys(PLATFORMS) as JobPlatform[]).map(async (platform) => {
        let occupancy = "unknown";
        try { occupancy = await options.inspectProfileOccupancy?.(path.join(rootDirectory, PLATFORMS[platform].directory, "profile")) ?? "unknown"; }
        catch { /* Unreadable OS evidence cannot prove absence. */ }
        if (occupancy === "clear") unconfirmedProfiles.delete(platform);
        else unconfirmedProfiles.add(platform);
      }));
      if (unconfirmedProfiles.size) throw unavailable("部分岗位专用目录仍被占用或尚未核实，本次服务未确认浏览器已关闭。请手动关闭该工具窗口，再重试关闭专用浏览器。");
    })().finally(() => { if (stopping === pending) { stopping = undefined; stoppingMode = undefined; } });
    stopping = pending;
    return pending;
  }

  return {
    acquirePage,
    acquire: (platform: JobPlatform, operation: NetworkOperation, signal?: AbortSignal, targetUrl?: string, acquisition?: PersistentJobPageAcquisitionObserver) => acquirePage(platform, operation, { signal, targetUrl, acquisition }),
    closePlatform,
    resetPlatform: closePlatform,
    closeAll,
    stop,
    status: (): PersistentJobBrowserStatus[] => [...new Set([...slots.values(), ...[...unclosed].filter((slot) => slot.state?.closeError)])].filter((slot) => !unconfirmedProfiles.has(slot.platform)).map((slot): PersistentJobBrowserStatus => ({
      platform: slot.platform,
      state: slot.state?.closeError || slot.state?.failedPages.size ? "close_failed" : slot.initialized ? "ready" : "starting",
      activePages: slot.state?.pages.size ?? 0,
    })).concat([...unconfirmedProfiles].map((platform) => ({ platform, state: "close_failed" as const, activePages: 0 }))),
  };
}

async function settleClosures(pending: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(pending);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export type PersistentJobBrowser = ReturnType<typeof createPersistentJobBrowser>;
