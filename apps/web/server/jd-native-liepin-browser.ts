import path from "node:path";
import { isIP } from "node:net";
import { allowedBrowserResource, isBrowserVerificationUrl } from "./jd-browser";
import type { BrowserSessionInspection } from "./jd-browser-session";
import type { BrowserSnapshot } from "./jd-browser-snapshot";
import { closeNativeTarget, nativeUnavailable, type NativeTargetList } from "./jd-native-cdp";
import { abortNative, startNativeEdge, inspectNativeProfileOccupancy, NativeEdgeStartupError, type NativeEdge } from "./jd-native-edge";
import { NATIVE_SNAPSHOT_STYLES, NATIVE_LIEPIN_PARAGRAPH_STYLES, isOriginalLiepinJob, projectNativeDomSnapshot, NativeDomSnapshotError } from "./jd-cdp-dom-snapshot";
import { createNativeTargetPolicy, isNativeBrowserSetupTarget } from "./jd-native-target-policy";
import type { SnapshotFailure } from "../src/lib/jd-capture-diagnostics";
import { JdExtractionError } from "../src/lib/jd-errors";
import { planBossDescriptionExpansion, type BossExpandPlan } from "./jd-boss-expand";
import { performBossDescriptionExpansion } from "./jd-native-boss-expand";
import { createVerificationNetworkRecorder } from "./jd-verification-network";
import { MAX_VERIFICATION_REQUESTS, VERIFICATION_HOSTS_51JOB, VERIFICATION_RESOURCE_TYPES } from "../src/lib/jd-verification-network";

type Frame = { id: string; loaderId: string; url: string };
/** Page.Frame keeps its fragment in a separate optional protocol field. */
function documentFrame(value: unknown): Frame | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (typeof frame.id !== "string" || typeof frame.loaderId !== "string" || typeof frame.url !== "string") return undefined;
  if (frame.urlFragment !== undefined && (typeof frame.urlFragment !== "string" || frame.url.includes("#") || (frame.urlFragment !== "" && !frame.urlFragment.startsWith("#")))) return undefined;
  return { id: frame.id, loaderId: frame.loaderId, url: frame.url + (frame.urlFragment ?? "") };
}
const networkDocumentUrl = (url: string) => url.split("#", 1)[0]!;
function sameDocumentRoute(original: string, current: string): boolean {
  try {
    const first = new URL(original); const last = new URL(current);
    return first.origin === last.origin && first.pathname === last.pathname && first.username === last.username && first.password === last.password;
  } catch { return false; }
}
type RootDocument = { nodeType?: unknown; backendNodeId?: unknown; documentURL?: unknown; compatibilityMode?: unknown; frameId?: unknown };
const rootDocument = (value: unknown): RootDocument | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as RootDocument : undefined;
const rootIdentity = (value: RootDocument | undefined) => JSON.stringify([value?.nodeType, value?.backendNodeId, value?.documentURL, value?.compatibilityMode, value?.frameId]);
const validRootDocument = (value: RootDocument | undefined, frame: Frame): boolean => value?.nodeType === 9
  && typeof value.backendNodeId === "number" && Number.isSafeInteger(value.backendNodeId) && value.backendNodeId > 0
  && value.documentURL === frame.url && value.compatibilityMode === "NoQuirksMode"
  && (value.frameId === undefined || value.frameId === frame.id);
type DocumentRequest = { id: string; loader: string; generation: number; url: string; state: "pending" | "committed" | "failed"; status?: number; responseUrl?: string; commit?: Readonly<{ frameId: string; loader: string; url: string }> };
export type NativeJobPlatform = "猎聘" | "BOSS直聘" | "51JOB";
export type NativeCapture = { state: "ready" | "navigation_in_progress" | "failed" | "oversized"; snapshot?: BrowserSnapshot; identity?: string; failure?: "visibility_unsupported" | "snapshot_invalid"; diagnostic?: SnapshotFailure; expansionPlan?: BossExpandPlan; frameId?: string };
export type NativeLiepinPage = {
  navigate(url: string, signal: AbortSignal): Promise<void>;
  capture(signal: AbortSignal, timeoutMs?: number, sourceUrl?: string): Promise<NativeCapture>;
  expandDescription?(signal: AbortSignal, sourceUrl: string, expectedIdentity: string): Promise<boolean>;
  current(identity: string, signal: AbortSignal): Promise<boolean>;
  verifyNetwork?(signal: AbortSignal): Promise<void>;
  inspect(): Pick<BrowserSessionInspection, "resources" | "mainDocument" | "mainDocumentRequests" | "truncated" | "blockedPopups" | "blockedSockets" | "scriptErrors" | "verificationNetwork"> & { scriptErrorsCollected?: false };
  focus(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
  readonly closed: boolean;
};
export type NativeBrowserStopMode = "explicit" | "owned-only";
export type NativeLiepinBrowser = { acquire(proxyUrl: string | undefined, signal: AbortSignal): Promise<NativeLiepinPage>; stop(mode?: NativeBrowserStopMode): Promise<void>; recoverExited?(): Promise<boolean>; hasUnclosed?(): boolean };
export type NativeBrowserOptions = { platform?: NativeJobPlatform; profileDirectory?: string; launch?: typeof startNativeEdge; inspectProfileOccupancy?: typeof inspectNativeProfileOccupancy; networkMode?: "strict" | "managed-proxy"; verifyManagedProxy?: (proxyUrl: string) => Promise<boolean> };
export class NativePageAcquisitionError extends Error {
  constructor(readonly page: NativeLiepinPage) { super("专用岗位页初始化或关闭尚未确认，请重试关闭本次会话。"); this.name = "NativePageAcquisitionError"; }
}
/** Browser-account onboarding is distinct from recruitment-site login or verification. */
export class NativeBrowserSetupRequiredError extends JdExtractionError {
  constructor() {
    super({ code: "browser_setup_required", stage: "service", message: "专用 Edge 正在显示首次设置或同步提示。请在该窗口自行完成或跳过，随后再次点击“浏览器读取”；工具会复用原窗口。" });
    this.name = "NativeBrowserSetupRequiredError";
  }
}
/** Retains the existing local failure category while carrying only fixed capture diagnostics. */
export class NativeCaptureError extends JdExtractionError {
  readonly diagnostic: SnapshotFailure;
  constructor(error: unknown, diagnostic: SnapshotFailure) {
    super(error instanceof JdExtractionError ? { ...error.failure } : nativeUnavailable().failure);
    this.name = "NativeCaptureError";
    this.diagnostic = { stage: diagnostic.stage, reason: diagnostic.reason };
  }
}

const NATIVE_PROFILES: Record<NativeJobPlatform, string> = { 猎聘: "liepin-native", BOSS直聘: "boss-native", "51JOB": "51job-native" };
const VERIFICATION_HOSTS = new Set<string>(VERIFICATION_HOSTS_51JOB);
const VERIFICATION_TYPES = new Set<string>(VERIFICATION_RESOURCE_TYPES);

/** A separate persistent native profile; a page lease never owns the browser. */
export function createNativeLiepinBrowser(options: NativeBrowserOptions = {}): NativeLiepinBrowser {
  const platform = options.platform ?? "猎聘";
  const profile = path.resolve(options.profileDirectory ?? path.join(import.meta.dirname, "../../../data/recruitment-browser", NATIVE_PROFILES[platform], "profile"));
  let edge: NativeEdge | undefined; let baseId = ""; let proxy: string | undefined;
  let starting: Promise<void> | undefined; let stopping: Promise<void> | undefined;
  let stoppingMode: NativeBrowserStopMode | undefined;
  let recovering: Promise<boolean> | undefined;
  let initialized = false; let failed = false; let setupPending = false; let disposeBaseEvents: (() => void) | undefined;
  let transportEpoch = 0; let lifecycleEpoch = 0; let acquiring: Promise<NativeLiepinPage> | undefined;
  let setupRevision = 0; let disposeSetupEvents: (() => void) | undefined;
  const setupTargets = new Set<string>();
  let policy: ReturnType<typeof createNativeTargetPolicy> | undefined;
  let resourceIssue: ((url: string, type: string) => void) | undefined;
  let popupBlocked: (() => void) | undefined; let socketBlocked: (() => void) | undefined;
  const pages = new Set<NativeLiepinPage>();
  const releaseExitedPages = new Map<NativeLiepinPage, () => void>();
  const managed = options.networkMode === "managed-proxy";
  const pendingPopups = new Set<Promise<void>>();
  async function verifyNetwork(proxyUrl: string | undefined, expectedEdge = edge, ownsLease: () => boolean = () => true) {
    const expectedTransport = transportEpoch;
    if (managed && (!proxyUrl || !options.verifyManagedProxy || !await options.verifyManagedProxy(proxyUrl))) { if (edge === expectedEdge && transportEpoch === expectedTransport && ownsLease()) failed = true; throw nativeUnavailable("当前网络路线尚未核验为本任务专用招聘代理，未启动或采用原生浏览器内容。"); }
    if (!ownsLease()) throw nativeUnavailable("本次岗位页已结束，未采用迟到的网络核验结果。");
  }
  function recoverExited(): Promise<boolean> {
    if (recovering) return recovering;
    const previous = edge;
    if (!previous || starting || stopping || previous.alive || !previous.confirmExited) return Promise.resolve(false);
    const pending = (async () => {
      try {
        if (!await previous.confirmExited!()) return false;
        if (edge !== previous || starting || stopping) return false;
        // Only an OS-confirmed exit releases old leases without target queries.
        // No browser command or process termination belongs to this path.
        for (const release of [...releaseExitedPages.values()]) release();
        disposeProtocol();
        pendingPopups.clear();
        resourceIssue = undefined; popupBlocked = undefined; socketBlocked = undefined;
        edge = undefined; baseId = ""; proxy = undefined; initialized = false; failed = false; setupPending = false;
        return true;
      } catch { return false; }
    })().finally(() => { if (recovering === pending) recovering = undefined; });
    recovering = pending;
    return pending;
  }
  async function networkSettled() {
    if (managed) { await Promise.all([...pendingPopups]); if (failed) throw nativeUnavailable("岗位浏览器的代理或弹窗关闭状态尚未确认，请显式关闭后重试。"); }
    else await policy!.settled();
  }
  function requireSetupComplete(targets: NativeTargetList, ownedEdge: NativeEdge, revision: number) {
    if (edge !== ownedEdge || stopping || !ownedEdge.alive) throw nativeUnavailable();
    const observed = targets.targetInfos.filter(isNativeBrowserSetupTarget);
    for (const target of observed) setupTargets.add(target.targetId);
    if (observed.length || setupRevision === revision) setupPending = observed.length > 0;
    if (setupPending) throw new NativeBrowserSetupRequiredError();
  }
  async function setupSettled(ownedEdge: NativeEdge) {
    if (setupPending && edge === ownedEdge) { const revision = setupRevision; requireSetupComplete(await ownedEdge.cdp.send<NativeTargetList>("Target.getTargets"), ownedEdge, revision); }
    if (edge !== ownedEdge || stopping || !ownedEdge.alive) throw nativeUnavailable();
  }
  function preserveSetup(ownedEdge: NativeEdge, id: string, target: NativeTargetList["targetInfos"][number] | undefined) {
    if (edge !== ownedEdge) return true;
    if (isNativeBrowserSetupTarget(target) || setupTargets.has(id)) { setupTargets.add(id); setupPending = true; setupRevision++; return true; }
    return false;
  }
  function disposeProtocol() {
    transportEpoch++;
    policy?.dispose(); policy = undefined;
    disposeBaseEvents?.(); disposeBaseEvents = undefined;
    disposeSetupEvents?.(); disposeSetupEvents = undefined;
    setupTargets.clear(); setupRevision++;
  }
  function onlyOriginalBase(targets: NativeTargetList, expectedBase: string) {
    const pageTargets = targets.targetInfos.filter(target => target.type === "page");
    return pageTargets.length === 1 && pageTargets[0].targetId === expectedBase && pageTargets[0].url === "about:blank";
  }
  async function initializeProtocol(ownedEdge: NativeEdge, expectedBase?: string, operationSignal?: AbortSignal) {
    const cdp = ownedEdge.cdp; const epoch = ++transportEpoch;
    const isCurrent = () => edge === ownedEdge && transportEpoch === epoch;
    const assertCurrent = () => { abortNative(operationSignal); if (!isCurrent() || stopping || !ownedEdge.alive) throw nativeUnavailable(); };
    disposeSetupEvents = cdp.on((event) => {
      if (!isCurrent()) return;
      const params = event.params ?? {};
      const info = params.targetInfo as { type?: unknown; url?: unknown; targetId?: unknown } | undefined;
      if ((event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") && isNativeBrowserSetupTarget(info)) {
        setupPending = true; setupRevision++; if (typeof info?.targetId === "string") setupTargets.add(info.targetId);
      }
    });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }); assertCurrent();
    const existingRevision = setupRevision;
    const existing = await cdp.send<NativeTargetList>("Target.getTargets"); assertCurrent();
    requireSetupComplete(existing, ownedEdge, existingRevision);
    if (expectedBase && !onlyOriginalBase(existing, expectedBase)) throw nativeUnavailable("岗位浏览器空闲页状态已变化，未关闭任何其他页面。");
    baseId = expectedBase ?? existing.targetInfos.find((item) => item.type === "page" && item.url === "about:blank")?.targetId ?? (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
    assertCurrent();
    if (!baseId) throw nativeUnavailable();
    for (const target of existing.targetInfos) if (target.type === "page" && target.targetId !== baseId) {
      const closed = await closeNativeTarget(cdp, target.targetId, baseId, 3000, (current) => !isCurrent() || preserveSetup(ownedEdge, target.targetId, current)); assertCurrent();
      if (closed.preserved) throw new NativeBrowserSetupRequiredError();
      if (!closed.confirmed) throw nativeUnavailable("启动遗留页尚未确认关闭，请显式关闭工具浏览器后重开。");
    }
    const baseSession = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: baseId, flatten: true })).sessionId; assertCurrent();
    disposeBaseEvents = cdp.on((event) => {
      if (!isCurrent()) return;
      const params = event.params ?? {};
      if (event.method === "Target.targetDestroyed" && params.targetId === baseId) failed = true;
      if (event.sessionId !== baseSession) return;
      if (event.method === "Fetch.requestPaused") void cdp.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, baseSession).catch(() => { if (isCurrent()) failed = true; });
      if (event.method === "Page.frameNavigated") {
        const frame = params.frame as { url?: string; parentId?: string } | undefined;
        if (frame && !frame.parentId && frame.url !== "about:blank") failed = true;
      }
    });
    await cdp.send("Page.enable", {}, baseSession); assertCurrent();
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, baseSession); assertCurrent();
    await cdp.send("Target.setDiscoverTargets", { discover: true }); assertCurrent();
    if (!managed) {
      policy = createNativeTargetPolicy(cdp, baseId, { allow: (url) => allowedBrowserResource(url, platform), onFailure: () => { if (isCurrent()) failed = true; }, onSetup: (id) => { if (isCurrent()) { setupTargets.add(id); setupPending = true; setupRevision++; } }, onIssue: (url, type) => { if (isCurrent()) resourceIssue?.(url, type); }, onPopup: () => { if (isCurrent()) popupBlocked?.(); }, onBlockedSocket: () => { if (isCurrent()) socketBlocked?.(); } });
      await policy.install(); await policy.settled(); assertCurrent();
    }
    if (expectedBase) {
      const finalTargets = await cdp.send<NativeTargetList>("Target.getTargets"); assertCurrent();
      if (!onlyOriginalBase(finalTargets, expectedBase)) throw nativeUnavailable("岗位浏览器空闲页状态已变化，未创建新的岗位页。");
    }
    initialized = true;
  }
  async function ready(proxyUrl: string | undefined, signal: AbortSignal, expectedEpoch: number) {
    let reconnectedBase: string | undefined;
    await recoverExited();
    abortNative(signal);
    if (expectedEpoch !== lifecycleEpoch || stopping) throw nativeUnavailable("岗位专用浏览器正在关闭，请等待完成。");
    await verifyNetwork(proxyUrl);
    abortNative(signal);
    if (expectedEpoch !== lifecycleEpoch || stopping) throw nativeUnavailable("岗位专用浏览器正在关闭，请等待完成。");
    if (managed && !starting && edge && !edge.alive && !failed && initialized && !setupPending && !pages.size && !pendingPopups.size && proxy === proxyUrl && edge.reconnect) {
      const ownedEdge = edge; const expectedBase = baseId;
      reconnectedBase = expectedBase;
      starting = (async () => {
        // Old transport promises can reject while reconnect replaces its socket.
        // Retire those listeners before awaiting, without releasing the browser.
        disposeProtocol(); initialized = false;
        if (!await ownedEdge.reconnect!(signal)) throw nativeUnavailable("尚未核实原岗位专用浏览器连接，未启动替代浏览器。");
        abortNative(signal);
        if (edge !== ownedEdge || stopping || failed || setupPending || pages.size || pendingPopups.size) throw nativeUnavailable();
        const targets = await ownedEdge.cdp.send<NativeTargetList>("Target.getTargets"); abortNative(signal);
        if (edge !== ownedEdge || stopping || failed || setupPending || pages.size || pendingPopups.size || !onlyOriginalBase(targets, expectedBase)) throw nativeUnavailable("岗位浏览器空闲页状态已变化，未关闭其他页面或创建新岗位页。");
        await initializeProtocol(ownedEdge, expectedBase, signal);
      })().catch((error) => { failed = true; throw error; }).finally(() => { starting = undefined; });
    }
    if (starting) await starting;
    abortNative(signal);
    if (expectedEpoch !== lifecycleEpoch || stopping) throw nativeUnavailable("岗位专用浏览器正在关闭，请等待完成。");
    if (failed || (edge && !initialized && !setupPending)) throw nativeUnavailable("岗位专用浏览器初始化尚未完成或基础页丢失，请显式关闭工具浏览器后重开。");
    if (edge && (!edge.alive || proxy !== proxyUrl)) throw nativeUnavailable("岗位专用浏览器连接或代理已变化，请先显式关闭工具浏览器再重开。");
    if ((!edge || (setupPending && !initialized)) && !starting) {
      proxy = proxyUrl;
      starting = (async () => {
        edge ??= await (options.launch ?? startNativeEdge)(profile, proxyUrl);
        const ownedEdge = edge;
        if (disposeSetupEvents) disposeProtocol();
        await initializeProtocol(ownedEdge);
      })().catch((error) => { if (error instanceof NativeEdgeStartupError) edge = error.edge; if (!(error instanceof NativeBrowserSetupRequiredError)) failed = true; throw error; }).finally(() => { starting = undefined; });
    }
    if (starting) await starting;
    abortNative(signal);
    if (expectedEpoch !== lifecycleEpoch || stopping) throw nativeUnavailable("岗位专用浏览器正在关闭，请等待完成。");
    if (proxy !== proxyUrl || !edge?.alive) throw nativeUnavailable("岗位专用浏览器正在使用另一条网络路线，请显式关闭后重开。");
    const ownedEdge = edge; const revision = setupRevision;
    const targets = await ownedEdge.cdp.send<NativeTargetList>("Target.getTargets"); abortNative(signal);
    if (expectedEpoch !== lifecycleEpoch || stopping) throw nativeUnavailable("岗位专用浏览器正在关闭，请等待完成。");
    if (reconnectedBase && !onlyOriginalBase(targets, reconnectedBase)) { failed = true; throw nativeUnavailable("岗位浏览器空闲页状态已变化，未关闭其他页面或创建新岗位页。"); }
    requireSetupComplete(targets, ownedEdge, revision);
    if (!targets.targetInfos.some((item) => item.targetId === baseId && item.url === "about:blank")) { failed = true; throw nativeUnavailable("岗位浏览器基础页已结束，请显式关闭工具浏览器后重开。"); }
  }
  async function acquirePage(proxyUrl: string | undefined, signal: AbortSignal, expectedEpoch: number): Promise<NativeLiepinPage> {
    await ready(proxyUrl, signal, expectedEpoch); const ownedEdge = edge!; const cdp = ownedEdge.cdp;
    if (pages.size) throw nativeUnavailable("已有专用岗位页尚未结束，请先关闭本次会话。");
    if (setupPending) throw new NativeBrowserSetupRequiredError();
    const targetId = (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
    if (!targetId || targetId === baseId) throw nativeUnavailable();
    let released = false; let releasePromise: Promise<void> | undefined; let detached = false;
    let sessionId = ""; let mainFrame = ""; let generation = 0; let mainDocumentRequests = 0; let current: DocumentRequest | undefined; let committed: Frame | undefined;
    const confirmCommit = () => {
      if (!current || current.commit || !committed || current.state === "failed" || current.status === undefined || current.responseUrl === undefined
        || current.loader !== committed.loaderId || networkDocumentUrl(current.responseUrl) !== networkDocumentUrl(committed.url)) return;
      // Keep the response/loader commit proof immutable when history later changes the logical URL.
      current.commit = Object.freeze({ frameId: committed.id, loader: committed.loaderId, url: current.responseUrl });
      current.state = "committed";
    };
    let blockedPopups = 0; let blockedSockets = 0; let truncated = false;
    const resources: BrowserSessionInspection["resources"] = [];
    const lifecycle = new Map<string, { dom: boolean; load: boolean }>();
    const verificationNetwork = platform === "51JOB" ? createVerificationNetworkRecorder(platform) : undefined;
    const verificationRequests = new Map<string, object>();
    let verificationRequestCount = 0;
    // Natural events only. Never inspect headers, bodies, cookies or remote error text.
    const observeVerification = (method: string | undefined, params: Record<string, unknown>) => {
      if (!verificationNetwork || released || detached || edge !== ownedEdge) return;
      try {
        const id = params.requestId;
        if (typeof id !== "string" || !/^[a-z\d._:-]{1,128}$/i.test(id)) return;
        const previous = verificationRequests.get(id);
        if (method === "Network.requestWillBeSent") {
          if (previous && params.redirectResponse && typeof params.redirectResponse === "object") {
            verificationNetwork.response(previous, (params.redirectResponse as Record<string, unknown>).status);
            verificationNetwork.finished(previous);
            verificationRequests.delete(id);
          } else if (previous) return;
          const request = params.request && typeof params.request === "object" ? params.request as Record<string, unknown> : undefined;
          const type = typeof params.type === "string" ? params.type.toLowerCase() : "";
          if (typeof request?.url !== "string" || !VERIFICATION_TYPES.has(type)) return;
          const url = new URL(request.url);
          if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !VERIFICATION_HOSTS.has(url.hostname)) return;
          const token = {};
          verificationNetwork.request(token, request.url, type);
          if (verificationRequestCount < MAX_VERIFICATION_REQUESTS) {
            verificationRequests.set(id, token);
            verificationRequestCount++;
          }
        } else if (previous && method === "Network.responseReceived") {
          const response = params.response && typeof params.response === "object" ? params.response as Record<string, unknown> : undefined;
          verificationNetwork.response(previous, response?.status);
        } else if (previous && (method === "Network.loadingFinished" || method === "Network.loadingFailed")) {
          if (method === "Network.loadingFinished") verificationNetwork.finished(previous);
          else verificationNetwork.failed(previous);
          verificationRequests.delete(id);
        }
      } catch { /* Malformed diagnostic metadata cannot affect the page lifecycle. */ }
    };
    const issue = (url: string, type: string, outcome: "blocked_by_tool" | "load_failed" | "http_error", status?: number) => {
      if (!["document", "script", "stylesheet", "xhr", "fetch", "image", "font"].includes(type)) return;
      let host: string;
      try { const source = new URL(url); if (source.protocol !== "http:" && source.protocol !== "https:") return; host = source.hostname; } catch { return; }
      if (!host.includes(".") || host.length > 253 || isIP(host)
        || !host.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return;
      if (outcome === "http_error" && (!Number.isInteger(status) || status! < 400 || status! > 599)) return;
      const detail = outcome === "blocked_by_tool" ? "blocked_by_tool" : outcome === "http_error" ? "http" : "unknown";
      if (resources.some((item) => item.host === host && item.type === type && item.outcome === outcome && item.detail === detail && item.httpStatus === status)) return;
      if (resources.length >= 30) { truncated = true; return; }
      resources.push({ host, type, outcome, detail, frame: "unknown", ...(outcome === "http_error" ? { httpStatus: status } : {}) });
    };
    const disposeEvents = cdp.on((event) => {
      const p = event.params ?? {};
      if (event.method === "Target.targetDestroyed" && p.targetId === targetId) { detached = true; generation++; verificationNetwork?.close(); verificationRequests.clear(); }
      if (managed && event.method === "Target.targetCreated") {
        const info = p.targetInfo as { targetId?: string; type?: string; url?: string; openerId?: string; parentId?: string } | undefined;
        if (isNativeBrowserSetupTarget(info)) { if (edge === ownedEdge) setupPending = true; return; }
        if (info?.type === "page" && info.targetId && info.targetId !== baseId && info.targetId !== targetId) {
          const closing = closeNativeTarget(cdp, info.targetId, baseId, 3000, (current) => preserveSetup(ownedEdge, info.targetId!, current)).then((result) => { if (edge !== ownedEdge || result.preserved) return; if (!result.confirmed) { failed = true; throw nativeUnavailable("岗位弹窗尚未确认关闭，未采用本次正文。"); } popupBlocked?.(); }).catch((error) => { if (edge === ownedEdge) failed = true; throw error; });
          pendingPopups.add(closing); void closing.finally(() => pendingPopups.delete(closing)).catch(() => undefined);
        }
      }
      if (event.sessionId !== sessionId) return;
      observeVerification(event.method, p);
      if (event.method === "Page.frameNavigated") {
        const rawFrame = p.frame as (Frame & { parentId?: string }) | undefined;
        if (rawFrame && !rawFrame.parentId) {
          generation++; committed = documentFrame(rawFrame);
          if (committed) { mainFrame = committed.id; confirmCommit(); }
        }
      }
      if (event.method === "Page.navigatedWithinDocument" && p.frameId === mainFrame) {
        generation++;
        if (current?.state === "committed" && current.commit && committed && current.status === 200
          && current.commit.frameId === committed.id && current.commit.loader === committed.loaderId && current.loader === committed.loaderId
          && typeof p.url === "string" && sameDocumentRoute(current.commit.url, p.url)) committed = { ...committed, url: p.url };
      }
      if (event.method === "Page.lifecycleEvent" && p.frameId === mainFrame && typeof p.loaderId === "string") {
        const known = lifecycle.get(p.loaderId) ?? { dom: false, load: false };
        if (p.name === "DOMContentLoaded") known.dom = true; if (p.name === "load") known.load = true; lifecycle.set(p.loaderId, known);
      }
      if (event.method === "Network.requestWillBeSent" && p.type === "Document" && p.frameId === mainFrame) {
        generation++; mainDocumentRequests++; const request = p.request as { url: string };
        current = { id: String(p.requestId), loader: String(p.loaderId), generation, url: request.url, state: "pending" };
      }
      const activeDoc = current;
      if (event.method === "Network.responseReceived" && p.type === "Document" && p.frameId === mainFrame && activeDoc && p.requestId === activeDoc.id && p.loaderId === activeDoc.loader) {
        const response = p.response as { status: number; url: string };
        activeDoc.status = response.status; activeDoc.responseUrl = response.url;
        confirmCommit();
      }
      if (event.method === "Network.loadingFailed" && activeDoc && p.requestId === activeDoc.id) { activeDoc.state = "failed"; generation++; }
    });
    async function frame(timeoutMs = 1000) {
      const value = await cdp.send<{ frameTree?: { frame?: Frame } }>("Page.getFrameTree", {}, sessionId, timeoutMs);
      const frame = documentFrame(value.frameTree?.frame);
      if (!frame) throw nativeUnavailable();
      return frame;
    }
    const identity = (frame: Frame) => JSON.stringify([generation, current?.generation, current?.id, frame.id, frame.loaderId, frame.url]);
    const frameFailure = (frame: Frame): SnapshotFailure["reason"] | undefined => {
      if (released || detached || !cdp.connected) return "protocol_unavailable";
      if (failed || setupPending || (managed ? pendingPopups.size > 0 : !policy?.healthy)) return "network_unavailable";
      if (!current) return "main_not_committed";
      if (current.state === "pending") return "main_pending";
      if (current.state === "failed") return "main_failed";
      if (current.status !== 200) return "response_not_200";
      if (!committed || !current.commit) return "main_not_committed";
      if (current.loader !== frame.loaderId || committed.loaderId !== frame.loaderId || current.commit.loader !== frame.loaderId
        || current.commit.frameId !== frame.id || committed.id !== frame.id) return "frame_loader_mismatch";
      if (current.responseUrl !== current.commit.url || !sameDocumentRoute(current.commit.url, committed.url) || committed.url !== frame.url) return "frame_url_mismatch";
      return undefined;
    };
    const readyFrame = (frame: Frame) => frameFailure(frame) === undefined;
    const finishRelease = () => {
      if (released) return;
      verificationNetwork?.close(); verificationRequests.clear();
      released = true; disposeEvents(); pages.delete(page); releaseExitedPages.delete(page); policy?.forget(targetId);
      if (!pages.size) { resourceIssue = undefined; popupBlocked = undefined; socketBlocked = undefined; }
    };
    const page: NativeLiepinPage = {
      get closed() { return released || detached || !cdp.connected; },
      async verifyNetwork(operationSignal) {
        abortNative(operationSignal);
        if (page.closed) throw new NativeCaptureError(nativeUnavailable(), { stage: "document_state", reason: "protocol_unavailable" });
        await setupSettled(ownedEdge); abortNative(operationSignal);
        try { await verifyNetwork(proxyUrl, ownedEdge, () => !released && !detached); abortNative(operationSignal); }
        catch (error) { abortNative(operationSignal); throw new NativeCaptureError(error, { stage: "document_state", reason: "network_unavailable" }); }
      },
      async navigate(url, operationSignal) {
        abortNative(operationSignal); if (released || detached) throw nativeUnavailable();
        await setupSettled(ownedEdge); abortNative(operationSignal);
        const response = await cdp.send<{ errorText?: string }>("Page.navigate", { url }, sessionId, 7000);
        abortNative(operationSignal); if (response.errorText) throw nativeUnavailable("原岗位未完成导航，请核对网络路线与工具窗口。");
      },
      async capture(operationSignal, timeoutMs = 1000, sourceUrl) {
        abortNative(operationSignal); if (page.closed) throw new NativeCaptureError(nativeUnavailable(), { stage: "document_state", reason: "protocol_unavailable" });
        await setupSettled(ownedEdge); abortNative(operationSignal);
        try { await networkSettled(); abortNative(operationSignal); }
        catch (error) { abortNative(operationSignal); throw new NativeCaptureError(error, { stage: "document_state", reason: "network_unavailable" }); }
        let before: Frame;
        try { before = await frame(timeoutMs); abortNative(operationSignal); }
        catch (error) { abortNative(operationSignal); throw new NativeCaptureError(error, { stage: "document_state", reason: "protocol_unavailable" }); }
        // Intermediate/gate pages may be inspected after commit, but never when a newer document is pending.
        if (current?.state === "pending") return { state: "navigation_in_progress", diagnostic: { stage: "document_state", reason: "main_pending" } };
        if (before.url === "about:blank") return { state: "ready", snapshot: { html: "<html><body></body></html>", url: "about:blank", title: "", pageLoad: { readyState: "complete", content: "empty", visibleFrames: 0 } }, identity: identity(before) };
        if (current?.state === "failed") return { state: "failed", diagnostic: { stage: "document_state", reason: "main_failed" } };
        const beforeFailure = frameFailure(before);
        if (beforeFailure) return { state: "failed", diagnostic: { stage: "document_state", reason: beforeFailure } };
        const key = identity(before);
        if (!allowedBrowserResource(before.url, platform)) return { state: "failed", failure: "snapshot_invalid", diagnostic: { stage: "document_state", reason: "source_rejected" } };
        const url = new URL(before.url);
        const knownGate = isBrowserVerificationUrl(before.url, platform) ? "verification_required"
          : platform === "猎聘" && url.hostname === "wow.liepin.com" && url.pathname === "/t1012695/4410f519.html" ? "login_required" : undefined;
        if (knownGate) {
          if (!await page.current(key, operationSignal)) return { state: "navigation_in_progress", diagnostic: { stage: "post_projection", reason: "navigation_changed" } };
          abortNative(operationSignal);
          return { state: "ready", identity: key, snapshot: { html: "<html><body></body></html>", url: before.url, title: "", gate: knownGate, pageLoad: { readyState: "unknown", content: "unknown", visibleFrames: 0 } } };
        }
        const rootScroll = platform === "猎聘" && isOriginalLiepinJob(before.url, sourceUrl);
        let rootBefore: RootDocument | undefined; let rootAfter: RootDocument | undefined;
        let raw: unknown; let after: Frame;
        try {
          if (rootScroll) { rootBefore = rootDocument((await cdp.send<{ root?: unknown }>("DOM.getDocument", { depth: 0, pierce: false }, sessionId, timeoutMs)).root); abortNative(operationSignal); }
          raw = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [...(rootScroll ? NATIVE_LIEPIN_PARAGRAPH_STYLES : NATIVE_SNAPSHOT_STYLES)], includeDOMRects: true, includeTextColorOpacities: true }, sessionId, timeoutMs);
          abortNative(operationSignal);
          if (rootScroll) { rootAfter = rootDocument((await cdp.send<{ root?: unknown }>("DOM.getDocument", { depth: 0, pierce: false }, sessionId, timeoutMs)).root); abortNative(operationSignal); }
          after = await frame(timeoutMs); abortNative(operationSignal);
        } catch (error) { abortNative(operationSignal); throw new NativeCaptureError(error, { stage: "capture", reason: "protocol_unavailable" }); }
        const afterFailure = frameFailure(after);
        if (afterFailure || key !== identity(after)) return { state: "navigation_in_progress", diagnostic: { stage: "capture", reason: afterFailure ?? "navigation_changed" } };
        if (rootScroll && rootIdentity(rootBefore) !== rootIdentity(rootAfter)) return { state: "navigation_in_progress", diagnostic: { stage: "capture", reason: "navigation_changed" } };
        if (rootScroll && (!validRootDocument(rootBefore, before) || !validRootDocument(rootAfter, after))) return { state: "failed", failure: "visibility_unsupported", diagnostic: { stage: "capture", reason: "snapshot_visibility_unsupported", detail: "overflow_clip_or_scroll" } };
        const observed = lifecycle.get(after.loaderId);
        let snapshot: BrowserSnapshot;
        try {
          snapshot = projectNativeDomSnapshot(raw, after, { readyState: observed?.load ? "complete" : observed?.dom ? "interactive" : "unknown" },
            platform === "BOSS直聘" ? { scope: "boss-share", sourceUrl } : rootScroll ? { scope: "liepin-job", rootScroll: "liepin", sourceUrl, rootDocument: rootAfter } : platform === "51JOB" ? { detect51JobWaf: true } : {});
        } catch (error) {
          abortNative(operationSignal);
          const reason = error instanceof NativeDomSnapshotError ? error.code : "projection_internal_error";
          const diagnostic: SnapshotFailure = { stage: "projection", reason, ...(error instanceof NativeDomSnapshotError && error.detail ? { detail: error.detail } : {}) };
          if (reason === "document_body_missing" && !observed?.dom) return { state: "navigation_in_progress", diagnostic };
          if (platform === "BOSS直聘" && sourceUrl && error instanceof NativeDomSnapshotError && error.detail === "boss_description_collapsed") {
            const plan = planBossDescriptionExpansion(raw, after, sourceUrl);
            abortNative(operationSignal);
            if (plan && await page.current(key, operationSignal)) {
              abortNative(operationSignal);
              return { state: "failed", failure: "visibility_unsupported", diagnostic, expansionPlan: plan, identity: key, frameId: after.id };
            }
          }
          return { state: reason === "snapshot_limit_exceeded" ? "oversized" : "failed", failure: reason === "snapshot_visibility_unsupported" ? "visibility_unsupported" : "snapshot_invalid", diagnostic };
        }
        let adopted: Frame;
        try { adopted = await frame(timeoutMs); abortNative(operationSignal); }
        catch { abortNative(operationSignal); return { state: "failed", failure: "snapshot_invalid", diagnostic: { stage: "post_projection", reason: "protocol_unavailable" } }; }
        try { await networkSettled(); abortNative(operationSignal); }
        catch { abortNative(operationSignal); return { state: "failed", failure: "snapshot_invalid", diagnostic: { stage: "post_projection", reason: "network_unavailable" } }; }
        await setupSettled(ownedEdge); abortNative(operationSignal);
        const adoptedFailure = frameFailure(adopted);
        if (adoptedFailure || key !== identity(adopted)) return { state: "navigation_in_progress", diagnostic: { stage: "post_projection", reason: adoptedFailure ?? "navigation_changed" } };
        return { state: "ready", snapshot, identity: key };
      },
      async expandDescription(operationSignal, sourceUrl, expectedIdentity) {
        abortNative(operationSignal);
        if (platform !== "BOSS直聘" || page.closed) return false;
        return performBossDescriptionExpansion({
          cdp, sessionId, signal: operationSignal, expectedIdentity,
          capturePlan: async () => {
            const captured = await page.capture(operationSignal, 1000, sourceUrl);
            abortNative(operationSignal);
            return captured.expansionPlan && captured.identity && captured.frameId
              ? { plan: captured.expansionPlan, identity: captured.identity, frameId: captured.frameId } : undefined;
          },
          current: key => page.current(key, operationSignal),
          isCurrent: key => !!committed && readyFrame(committed) && key === identity(committed),
        });
      },
      async current(key, operationSignal) {
        abortNative(operationSignal);
        if (page.closed) throw new NativeCaptureError(nativeUnavailable(), { stage: "post_projection", reason: "protocol_unavailable" });
        await setupSettled(ownedEdge); abortNative(operationSignal);
        try { await verifyNetwork(proxyUrl, ownedEdge, () => !released && !detached); await networkSettled(); abortNative(operationSignal); }
        catch (error) { abortNative(operationSignal); throw new NativeCaptureError(error, { stage: "post_projection", reason: "network_unavailable" }); }
        let position: Frame;
        try { position = await frame(); abortNative(operationSignal); }
        catch (error) { abortNative(operationSignal); throw new NativeCaptureError(error, { stage: "post_projection", reason: "protocol_unavailable" }); }
        await setupSettled(ownedEdge); abortNative(operationSignal);
        return !!readyFrame(position) && key === identity(position);
      },
      inspect() {
        const state = current?.state === "pending" ? "pending" : current?.state === "failed" ? "failed" : current?.status ? "response" : "unknown";
        return { resources: resources.map((item) => ({ ...item })), mainDocument: { state, ...(state === "response" ? { status: current!.status } : {}) }, mainDocumentRequests: Math.min(1000, mainDocumentRequests), ...(verificationNetwork ? { verificationNetwork: verificationNetwork.snapshot() } : {}), truncated, blockedPopups, blockedSockets, scriptErrors: 0, scriptErrorsCollected: false };
      },
      async focus(operationSignal) { abortNative(operationSignal); await cdp.send("Target.activateTarget", { targetId }, undefined, 4000); abortNative(operationSignal); },
      release() {
        if (released) return Promise.resolve();
        if (!releasePromise) releasePromise = (async () => {
          const result = await closeNativeTarget(cdp, targetId, baseId);
          if (!result.confirmed) {
            await recoverExited();
            if (!released) throw nativeUnavailable("尚未确认本次专用岗位页已关闭；请重试结束会话或显式关闭工具浏览器。");
          } else finishRelease();
        })().finally(() => { releasePromise = undefined; });
        return releasePromise;
      },
    };
    pages.add(page);
    releaseExitedPages.set(page, finishRelease);
    try {
      sessionId = managed ? (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId : (await policy!.claim(targetId)).sessionId;
      resourceIssue = (url, type) => issue(url, type, "blocked_by_tool"); popupBlocked = () => { blockedPopups = Math.min(1000, blockedPopups + 1); }; socketBlocked = () => { blockedSockets = Math.min(1000, blockedSockets + 1); };
      await cdp.send("Page.enable", {}, sessionId); await cdp.send("Network.enable", {}, sessionId);
      await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
      if (managed) await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
      mainFrame = (await frame()).id;
      abortNative(signal);
      if (expectedEpoch !== lifecycleEpoch || stopping) throw nativeUnavailable("岗位专用浏览器正在关闭，请等待完成。");
      return page;
    } catch (error) { try { await page.release(); } catch { failed = true; throw new NativePageAcquisitionError(page); } throw error; }
  }
  function acquire(proxyUrl: string | undefined, signal: AbortSignal): Promise<NativeLiepinPage> {
    if (acquiring) return Promise.reject(nativeUnavailable("已有专用岗位页正在创建，请等待完成。"));
    const pending = acquirePage(proxyUrl, signal, lifecycleEpoch).finally(() => { if (acquiring === pending) acquiring = undefined; });
    acquiring = pending;
    return pending;
  }
  function stop(mode: NativeBrowserStopMode = "explicit"): Promise<void> {
    if (stopping) {
      if (mode === "explicit" && stoppingMode === "owned-only") return Promise.reject(nativeUnavailable("岗位专用浏览器正在清理自有资源，尚未完成显式关闭核验，请稍后重试。"));
      return stopping;
    }
    lifecycleEpoch++;
    stoppingMode = mode;
    stopping = (async () => {
        if (starting) await starting.catch(() => undefined);
        if (acquiring) await acquiring.catch(() => undefined);
        await Promise.allSettled([...pages].map((page) => page.release()));
        // Build/plugin cleanup only owns this service's acquired handle. It
        // must not inspect unrelated service leftovers or clear failed state.
        if (!edge && mode === "owned-only") return;
        // Explicit stop still closes the owned browser if a page could not close.
        if (edge) await edge.stop();
        else {
          // A previous service can have left the exact tool profile open even
          // though this factory never acquired a handle. Absence of a handle
          // never grants ownership or proves that browser was closed.
          let occupancy = "unknown";
          try { occupancy = await (options.inspectProfileOccupancy ?? inspectNativeProfileOccupancy)(profile); }
          catch { /* An OS query failure cannot prove absence. */ }
          if (occupancy !== "clear") {
            failed = true;
            throw nativeUnavailable(occupancy === "occupied"
              ? "岗位专用目录仍有浏览器进程占用，本次服务未取得关闭归属。请手动关闭该专用窗口，再重试关闭工具浏览器。"
              : "尚未核实岗位专用目录的进程占用，未确认浏览器已关闭。请检查专用窗口后重试。");
          }
        }
        disposeProtocol();
        edge = undefined; baseId = ""; initialized = false; failed = false; setupPending = false; pages.clear(); releaseExitedPages.clear();
      })().finally(() => { stopping = undefined; stoppingMode = undefined; });
    return stopping;
  }
  return {
    acquire,
    recoverExited,
    hasUnclosed: () => !!(failed || starting || stopping || acquiring || pages.size),
    stop,
  };
}
