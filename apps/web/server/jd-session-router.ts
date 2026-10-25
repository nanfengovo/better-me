import { normalizeJobShare, type JdImportResult } from "../src/lib/jd-source";
import { JdExtractionError } from "../src/lib/jd-errors";
import type { BrowserSessionInfo, BrowserSessionInspection } from "./jd-browser-session";
import type { NativeBrowserStopMode } from "./jd-native-liepin-browser";
import { jdStartRequestCreatedAt, JD_START_REQUEST_WINDOW_MS, JD_START_REQUEST_FUTURE_SKEW_MS } from "../src/lib/jd-start-request";
import { buildPlatformSearchRequest, type PlatformSearchInput } from "@better-me/source-adapters/platform-search";
import type { JobSearchCaptureResult } from "./jd-search-capture";

export type JobSessionBackend = {
  start(owner: string, input: string, signal?: AbortSignal): Promise<BrowserSessionInfo>;
  startSearch?(owner: string, input: PlatformSearchInput, signal?: AbortSignal): Promise<BrowserSessionInfo>;
  startSearchRequest?(owner: string, input: PlatformSearchInput, requestId: string, signal?: AbortSignal): Promise<BrowserSessionInfo>;
  cancelSearchStart?(owner: string, input: PlatformSearchInput, requestId: string): Promise<{ cancelled: true; closed: boolean }>;
  readSearch?(owner: string, id: string, signal?: AbortSignal): Promise<JobSearchCaptureResult>;
  startRequest?(owner: string, input: string, requestId: string, signal?: AbortSignal): Promise<BrowserSessionInfo>;
  cancelStart?(owner: string, input: string, requestId: string): Promise<{ cancelled: true; closed: boolean }>;
  read(owner: string, id: string, signal?: AbortSignal): Promise<JdImportResult>;
  inspect(owner: string, id: string, signal?: AbortSignal): Promise<BrowserSessionInspection>;
  focus(owner: string, id: string, signal?: AbortSignal): Promise<{ activationRequested: true }>;
  extend?(owner: string, id: string, signal?: AbortSignal): Promise<BrowserSessionInfo>;
  close(owner: string, id: string): Promise<{ closed: true }>;
  closeAll(): Promise<void>;
  stopBrowser(mode?: NativeBrowserStopMode): Promise<void>;
  recoverExited?(): Promise<boolean>;
  retryEnded?(owner: string): Promise<void>;
  owns(id: string): boolean;
  /** Ownership may include ended pages whose release failed. This only tests usable sessions. */
  isActive?(owner: string, id: string): boolean;
  hasSession(): boolean;
};

/** Keep the planned origin, route and conditions while allowing platform paging/tracking additions. */
export function matchesPlannedJobSearchUrl(current: string, planned: string): boolean {
  try {
    const actual = new URL(current), expected = new URL(planned);
    if (actual.username || actual.password || actual.origin !== expected.origin
      || actual.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "")) return false;
    for (const key of new Set(expected.searchParams.keys())) {
      const wanted = expected.searchParams.getAll(key), found = actual.searchParams.getAll(key);
      if (wanted.length === 1 && wanted[0] === "" && found.length === 0) continue;
      if (wanted.length !== found.length || wanted.some((value, index) => value !== found[index])) return false;
    }
    return true;
  } catch { return false; }
}

/** Select a reader once at start, retaining one active job across all engines. */
export function createJobSessionRouter(standard: JobSessionBackend, liepin: JobSessionBackend, options: { useNativeLiepin?: boolean; useNativeBoss?: boolean; useNative51Job?: boolean; nativeBoss?: JobSessionBackend; native51Job?: JobSessionBackend; requestOptions?: { now?: () => number; maxRecords?: number; startTimeoutMs?: number; cancelWaitMs?: number } } = {}) {
  let useNativeLiepin = options.useNativeLiepin ?? false;
  let useNativeBoss = options.useNativeBoss ?? false;
  let useNative51Job = options.useNative51Job ?? false;
  const boss = options.nativeBoss;
  const job51 = options.native51Job;
  const engines = [...new Set([standard, liepin, ...(boss ? [boss] : []), ...(job51 ? [job51] : [])])];
  let starting: { abort: AbortController; pending: Promise<BrowserSessionInfo> } | undefined;
  let draining: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stoppingMode: NativeBrowserStopMode | undefined;
  const now = options.requestOptions?.now ?? Date.now;
  const maxRecords = options.requestOptions?.maxRecords ?? 256;
  type StartRequest = {
    owner: string; url: string; kind: "detail" | "search"; selected: JobSessionBackend; createdAt: number;
    abort: AbortController; pending?: Promise<BrowserSessionInfo>; settled: boolean;
    ended: boolean; info?: BrowserSessionInfo; error?: unknown; cleanup?: Promise<boolean>;
  };
  const requests = new Map<string, StartRequest>();
  const backend = (id: string) => job51?.owns(id) ? job51 : boss?.owns(id) ? boss : liepin.owns(id) ? liepin : standard;
  const unavailable = () => new JdExtractionError({ code: "browser_unavailable", stage: "service", message: "已有岗位会话正在运行或关闭，请先结束当前岗位页。" });
  const expired = () => new JdExtractionError({ code: "browser_session_expired", stage: "service", message: "本次启动请求已结束，请重新点击浏览器读取。" });
  const sourceFor = (input: string) => {
    try { return normalizeJobShare(input); }
    catch { throw new JdExtractionError({ code: "invalid_link", stage: "service", message: "请提供单个有效的官方岗位分享链接。" }); }
  };
  const searchSourceFor = (input: PlatformSearchInput) => {
    try { return buildPlatformSearchRequest(input); }
    catch { throw new JdExtractionError({ code: "invalid_link", stage: "service", message: "平台搜索条件无效，请使用已配置的平台和地区。" }); }
  };
  const searchInput = (source: ReturnType<typeof searchSourceFor>): PlatformSearchInput => ({
    provider: source.provider, keyword: source.keyword, ...(source.region ? { regionId: source.region.id } : {}),
  });
  const selectSearch = (source: ReturnType<typeof searchSourceFor>) => {
    // Search routing is independent of legacy detail-route configuration.
    const selected = source.platform === "51JOB" ? job51 : source.platform === "BOSS直聘" ? boss : source.platform === "猎聘" ? liepin : standard;
    if (!selected?.startSearch) throw new JdExtractionError({ code: "service_unavailable", stage: "service", message: "当前平台尚未提供搜索页读取，请更新本地服务。" });
    return selected;
  };
  const select = (source: ReturnType<typeof sourceFor>) => {
    const { platform } = source;
    const url = new URL(source.url);
    // The established mobile reader keeps its own persistent profile. Native
    // 51job is opt-in only for the exact desktop detail route at start time;
    // extraction failures never select another backend for the same session.
    const native51 = useNative51Job && platform === "51JOB" && url.protocol === "https:" && url.hostname === "jobs.51job.com"
      && !url.username && !url.password && (!url.port || url.port === "443") && /^\/(?!jobs\/)[^/]+\/\d+\.html$/i.test(url.pathname);
    if (useNativeBoss && platform === "BOSS直聘" && !boss) throw unavailable();
    if (native51 && !job51) throw unavailable();
    return native51 ? job51! : useNativeBoss && platform === "BOSS直聘" ? boss! : useNativeLiepin && platform === "猎聘" ? liepin : standard;
  };
  const active = (request: StartRequest) => !request.ended && !!request.info
    && Date.parse(request.info.expiresAt) > now() && request.selected.isActive?.(request.owner, request.info.sessionId) === true;
  const cleared = (request: StartRequest) => request.info
    ? !request.selected.owns(request.info.sessionId) : !request.selected.hasSession();
  const prune = () => {
    for (const [key, request] of requests) {
      // Never evict pending work, active pages, or ownership retained after a failed release.
      if (now() > request.createdAt + JD_START_REQUEST_WINDOW_MS && request.settled && !request.cleanup && !active(request) && cleared(request)) requests.delete(key);
    }
  };
  type RequestSource = { url: string; kind: StartRequest["kind"]; select: () => JobSessionBackend; open: (signal: AbortSignal) => Promise<BrowserSessionInfo> };
  const binding = (owner: string, source: Pick<RequestSource, "url" | "kind">, requestId: string, purpose: "start" | "cancel" = "start") => {
    const createdAt = jdStartRequestCreatedAt(requestId);
    if (!Number.isFinite(createdAt)) throw new JdExtractionError({ code: "invalid_link", stage: "service", message: "启动请求标识无效，请刷新本地工作台。" });
    prune();
    const existing = requests.get(requestId);
    // A logical request retains its original engine even after an idle routing
    // change. Replays cannot start again, and exact cleanup targets that engine.
    if (existing && (existing.owner !== owner || existing.url !== source.url || existing.kind !== source.kind)) throw new JdExtractionError({ code: "job_mismatch", stage: "service", message: "启动请求已绑定其他岗位、搜索或窗口，未操作已有会话。" });
    // An old ID cannot launch a new page, but exact cancellation remains useful
    // after a user pauses or a completed record has already been pruned.
    if (!existing && (createdAt > now() + JD_START_REQUEST_FUTURE_SKEW_MS || (purpose === "start" && now() > createdAt + JD_START_REQUEST_WINDOW_MS))) throw expired();
    if (!existing && requests.size >= maxRecords) throw new JdExtractionError({ code: "browser_unavailable", stage: "service", message: "近期启动请求尚在处理或等待清理，请稍后再试。" });
    return { existing, createdAt };
  };
  const cleanupRequest = (request: StartRequest): Promise<boolean> => {
    if (request.cleanup) return request.cleanup;
    const pending = (async () => {
      if (request.info) await request.selected.close(request.owner, request.info.sessionId);
      return cleared(request);
    })().finally(() => { if (request.cleanup === pending) request.cleanup = undefined; });
    request.cleanup = pending;
    return pending;
  };
  const waitForRequest = (pending: Promise<BrowserSessionInfo>, ...optionalSignals: (AbortSignal | undefined)[]): Promise<BrowserSessionInfo> => {
    const signals = optionalSignals.filter((signal): signal is AbortSignal => signal !== undefined);
    for (const signal of signals) signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => { for (const signal of signals) signal.removeEventListener("abort", cancelled); };
      const cancelled = () => { const signal = signals.find(item => item.aborted); cleanup(); reject(signal?.reason); };
      for (const signal of signals) signal.addEventListener("abort", cancelled, { once: true });
      void pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signals.some(signal => signal.aborted)) cancelled();
    });
  };
  const startBoundRequest = (owner: string, source: RequestSource, requestId: string, signal?: AbortSignal): Promise<BrowserSessionInfo> => {
    signal?.throwIfAborted();
    const { existing, createdAt } = binding(owner, source, requestId);
    if (existing) {
      if (existing.ended) throw existing.error ?? expired();
      if (existing.settled && !active(existing)) { existing.ended = true; throw expired(); }
      return waitForRequest(existing.settled && existing.info ? Promise.resolve(existing.info) : existing.pending!, signal, existing.abort.signal);
    }
    const request: StartRequest = { owner, url: source.url, kind: source.kind, selected: source.select(), createdAt, abort: new AbortController(), settled: false, ended: false };
    requests.set(requestId, request);
    // Waiter cancellation only detaches that HTTP call. Exact cancellation,
    // lifecycle cleanup, or the finite logical deadline owns this launch.
    const timer = setTimeout(() => { request.ended = true; request.abort.abort(expired()); }, options.requestOptions?.startTimeoutMs ?? 60_000);
    timer.unref?.();
    request.pending = source.open(request.abort.signal).then(async info => {
      request.info = info;
      if (request.ended || request.abort.signal.aborted) { await cleanupRequest(request); throw request.abort.signal.reason ?? expired(); }
      return info;
    }).catch(error => { request.ended = true; request.error = error; throw error; }).finally(() => { request.settled = true; clearTimeout(timer); });
    void request.pending.catch(() => undefined);
    return waitForRequest(request.pending, signal, request.abort.signal);
  };
  const cancelBoundRequest = async (owner: string, source: RequestSource, requestId: string): Promise<{ cancelled: true; closed: boolean }> => {
    const { existing, createdAt } = binding(owner, source, requestId, "cancel");
    const request: StartRequest = existing ?? { owner, url: source.url, kind: source.kind, selected: source.select(), createdAt, abort: new AbortController(), settled: true, ended: true };
    // Preserve a pre-launch cancellation so a delayed POST cannot reopen it.
    if (!existing) requests.set(requestId, request);
    request.ended = true; request.abort.abort(expired());
    if (request.pending && !request.settled) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, options.requestOptions?.cancelWaitMs ?? 1000);
        void request.pending!.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
      });
      // A bounded wait is not proof that an ignored-abort acquisition closed.
      if (!request.settled) return { cancelled: true, closed: false };
    }
    return { cancelled: true, closed: await cleanupRequest(request) };
  };
  const endRequests = () => {
    for (const request of requests.values()) { request.ended = true; request.abort.abort(expired()); }
  };
  const settle = async (tasks: Promise<unknown>[]) => {
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  const launch = async (owner: string, selected: JobSessionBackend, open: (signal: AbortSignal) => Promise<BrowserSessionInfo>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (starting || draining || stopping) throw unavailable();
    const abort = new AbortController();
    const cancelled = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const pending = Promise.resolve().then(async () => {
      abort.signal.throwIfAborted();
      // Detail and search reserve this same slot before any asynchronous recovery.
      await settle(engines.map(engine => engine.recoverExited?.() ?? Promise.resolve(false)));
      abort.signal.throwIfAborted();
      await settle(engines.map(engine => engine.retryEnded?.(owner) ?? Promise.resolve()));
      abort.signal.throwIfAborted();
      if (engines.some(engine => engine.hasSession())) throw unavailable();
      const info = await open(abort.signal);
      if (abort.signal.aborted) {
        await selected.close(owner, info.sessionId);
        abort.signal.throwIfAborted();
      }
      return info;
    });
    const reservation = { abort, pending };
    starting = reservation;
    try { return await pending; }
    finally { signal?.removeEventListener("abort", cancelled); if (starting === reservation) starting = undefined; }
  };
  const router = {
    async start(owner: string, input: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (starting || draining || stopping) throw unavailable();
      const selected = select(sourceFor(input));
      return launch(owner, selected, operationSignal => selected.start(owner, input, operationSignal), signal);
    },
    async startSearch(owner: string, input: PlatformSearchInput, signal?: AbortSignal): Promise<BrowserSessionInfo> {
      signal?.throwIfAborted();
      if (starting || draining || stopping) throw unavailable();
      const request = searchSourceFor(input), selected = selectSearch(request), validated = searchInput(request);
      return launch(owner, selected, operationSignal => selected.startSearch!(owner, validated, operationSignal), signal);
    },
    async startRequest(owner: string, input: string, requestId: string, signal?: AbortSignal): Promise<BrowserSessionInfo> {
      signal?.throwIfAborted();
      const source = sourceFor(input);
      return startBoundRequest(owner, { url: source.url, kind: "detail", select: () => select(source), open: operationSignal => router.start(owner, source.url, operationSignal) }, requestId, signal);
    },
    async cancelStart(owner: string, input: string, requestId: string): Promise<{ cancelled: true; closed: boolean }> {
      const source = sourceFor(input);
      return cancelBoundRequest(owner, { url: source.url, kind: "detail", select: () => select(source), open: operationSignal => router.start(owner, source.url, operationSignal) }, requestId);
    },
    async startSearchRequest(owner: string, input: PlatformSearchInput, requestId: string, signal?: AbortSignal): Promise<BrowserSessionInfo> {
      signal?.throwIfAborted();
      const source = searchSourceFor(input), validated = searchInput(source);
      return startBoundRequest(owner, { url: source.url, kind: "search", select: () => selectSearch(source), open: operationSignal => router.startSearch(owner, validated, operationSignal) }, requestId, signal);
    },
    async cancelSearchStart(owner: string, input: PlatformSearchInput, requestId: string): Promise<{ cancelled: true; closed: boolean }> {
      const source = searchSourceFor(input), validated = searchInput(source);
      return cancelBoundRequest(owner, { url: source.url, kind: "search", select: () => selectSearch(source), open: operationSignal => router.startSearch(owner, validated, operationSignal) }, requestId);
    },
    read: (owner: string, id: string, signal?: AbortSignal) => backend(id).read(owner, id, signal),
    readSearch: (owner: string, id: string, signal?: AbortSignal): Promise<JobSearchCaptureResult> => {
      const selected = backend(id);
      if (!selected.readSearch) return Promise.reject(new JdExtractionError({ code: "service_unavailable", stage: "service", message: "本地服务尚不支持读取平台搜索结果。" }));
      return selected.readSearch(owner, id, signal);
    },
    inspect: (owner: string, id: string, signal?: AbortSignal) => backend(id).inspect(owner, id, signal),
    focus: (owner: string, id: string, signal?: AbortSignal) => backend(id).focus(owner, id, signal),
    async extend(owner: string, id: string, signal?: AbortSignal): Promise<BrowserSessionInfo> {
      signal?.throwIfAborted();
      if (starting || draining || stopping) throw unavailable();
      const selected = backend(id);
      if (!selected.extend) throw new JdExtractionError({ code: "service_unavailable", stage: "service", message: "岗位服务尚不支持延长当前会话，请更新本地服务。" });
      const info = await selected.extend(owner, id, signal);
      // A close/cancel may run while an asynchronous backend is returning.
      // Never publish a renewed receipt for an already ended page.
      if (draining || stopping || !selected.owns(id) || (selected.isActive && !selected.isActive(owner, id))) throw expired();
      for (const request of requests.values()) {
        if (!request.ended && request.owner === owner && request.selected === selected && request.info?.sessionId === id) request.info = { ...info };
      }
      // The backend may already have committed the deadline when its HTTP
      // waiter disappears. Preserve that live receipt before rejecting only
      // this waiter, so a recoverable start never replays the old deadline.
      signal?.throwIfAborted();
      return info;
    },
    close: (owner: string, id: string) => {
      for (const request of requests.values()) if (request.owner === owner && request.info?.sessionId === id) request.ended = true;
      return backend(id).close(owner, id);
    },
    async readOnce(owner: string, input: string, signal?: AbortSignal): Promise<JdImportResult> {
      const info = await router.start(owner, input, signal);
      try {
        const timeoutMs = 60_000;
        const start = Date.now();
        let lastError: unknown;
        let focused = false;
        while (Date.now() - start < timeoutMs) {
          signal?.throwIfAborted();
          try {
            return await router.read(owner, info.sessionId, signal);
          } catch (err) {
            lastError = err;
            if (
              err instanceof JdExtractionError &&
              (err.failure.code === "verification_required" ||
                err.failure.code === "login_required" ||
                (err.failure.code === "unsupported_page" &&
                  typeof err.failure.message === "string" &&
                  err.failure.message.includes("中转")))
            ) {
              if (!focused) {
                focused = true;
                void router.focus(owner, info.sessionId, signal).catch(() => undefined);
              }
              await new Promise((resolve) => setTimeout(resolve, 1500));
              continue;
            }
            throw err;
          }
        }
        throw lastError ?? new JdExtractionError({
          code: "verification_required",
          stage: "page",
          message: "等待平台安全验证超时，请在浏览器中完成验证后重试。",
        });
      } finally {
        await router.close(owner, info.sessionId);
      }
    },
    closeAll() {
      if (draining) return draining;
      endRequests();
      const launch = starting;
      launch?.abort.abort(unavailable());
      const pending = (async () => {
        const results = await Promise.allSettled(engines.map(engine => engine.closeAll()));
        if (launch) {
          await Promise.allSettled([launch.pending]);
          await settle(engines.map(engine => engine.closeAll()));
        }
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })().finally(() => { if (draining === pending) draining = undefined; });
      draining = pending;
      return pending;
    },
    stopBrowser(mode: NativeBrowserStopMode = "explicit") {
      if (stopping) {
        if (mode === "explicit" && stoppingMode === "owned-only") return Promise.reject(unavailable());
        return stopping;
      }
      stoppingMode = mode;
      const pending = (async () => {
        // A failed tab release must not prevent either owned browser from stopping.
        await router.closeAll().catch(() => undefined);
        await settle(engines.map(engine => engine.stopBrowser(mode)));
      })().finally(() => { if (stopping === pending) { stopping = undefined; stoppingMode = undefined; } });
      stopping = pending;
      return pending;
    },
    configure(settings: { useNativeLiepin: boolean; useNativeBoss?: boolean; useNative51Job?: boolean }) {
      const nextBoss = settings.useNativeBoss ?? useNativeBoss;
      const next51Job = settings.useNative51Job ?? useNative51Job;
      if (settings.useNativeLiepin === useNativeLiepin && nextBoss === useNativeBoss && next51Job === useNative51Job) return;
      if (router.hasSession()) throw unavailable();
      if (nextBoss && !boss) throw unavailable();
      if (next51Job && !job51) throw unavailable();
      useNativeLiepin = settings.useNativeLiepin;
      useNativeBoss = nextBoss;
      useNative51Job = next51Job;
    },
    owns: (id: string) => engines.some(engine => engine.owns(id)),
    hasSession: (): boolean => !!starting || !!draining || !!stopping || engines.some(engine => engine.hasSession()),
  };
  return router;
}
