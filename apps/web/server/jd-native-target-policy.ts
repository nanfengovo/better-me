import { closeNativeTarget, nativeUnavailable, type CdpObject, type NativeCdp, type NativeCdpEvent, type NativeTargetList } from "./jd-native-cdp";

export type NativeTargetPolicyOptions = {
  allow(url: string): boolean;
  /** Only actual Fetch denials in the seven diagnostic resource classes are reported. */
  onIssue(url: string, type: string): void;
  /** Called only after a popup target's disappearance and base survival were confirmed. */
  onPopup(): void;
  onBlockedSocket(): void;
  onFailure(): void;
  onSetup?(targetId: string): void;
};
export type NativeTargetPolicy = {
  install(): Promise<void>;
  claim(targetId: string): Promise<{ sessionId: string }>;
  settled(): Promise<void>;
  readonly healthy: boolean;
  forget(targetId: string): void;
  dispose(): void;
};

const FILTER = [{ type: "page" }, { type: "shared_worker" }, { type: "service_worker" }, { type: "iframe" }, { type: "worker" }, { exclude: true }];
const AUXILIARY = new Set(["worker", "shared_worker", "service_worker", "iframe"]);
const RESOURCE_TYPES = new Set(["document", "script", "stylesheet", "xhr", "fetch", "image", "font"]);
const CLAIM_MS = 2000;
const COMMAND_MS = 1500;
const SETTLE_MS = 10_000;
type TargetInfo = { targetId: string; type: string; url: string; openerId?: string };
/** The sole supported browser-account onboarding target, never recruitment-site authentication. */
export const isNativeBrowserSetupTarget = (target: { type?: unknown; url?: unknown } | undefined) => target?.type === "page" && target.url === "edge://sync-confirmation-dialog/";
type Entry = {
  info: TargetInfo; sessionId: string; waiting: boolean; claimed: boolean;
  mode: "waiting_claim" | "configuring" | "allowed" | "denied" | "closed";
  timer?: ReturnType<typeof setTimeout>;
  completion: Promise<void>; resolve(): void; reject(error: unknown): void;
  sockets: Set<string>;
  preserved?: boolean;
};
const object = (value: unknown): CdpObject | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as CdpObject : undefined;
const policyError = () => nativeUnavailable("招聘浏览器的子页面网络策略尚未确认，未采用本次正文；请结束会话后重试。");
class PreserveBrowserSetup extends Error {}

/**
 * One policy per owned browser connection. Browser-wide auto attach is installed before job creation.
 * A bootstrap request can precede a worker target: real local fixtures must verify the parent policy
 * too. This module does not claim that auto-attach alone controls every target's first request.
 */
export function createNativeTargetPolicy(cdp: NativeCdp, baseId: string, options: NativeTargetPolicyOptions): NativeTargetPolicy {
  const entries = new Map<string, Entry>();
  const sessions = new Map<string, Entry>();
  const forgotten = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const claimWaiters = new Map<string, { resolve(entry: Entry): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let disposeListener: (() => void) | undefined;
  let installation: Promise<void> | undefined;
  let installed = false; let disposed = false;
  let failure: ReturnType<typeof policyError> | undefined;

  function broken() {
    const first = !failure;
    failure ??= policyError();
    if (first && !disposed) { try { options.onFailure(); } catch { /* Fixed failure remains authoritative. */ } }
    return failure;
  }
  function callback(operation: () => void) { try { operation(); } catch { throw broken(); } }
  function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(policyError()), Math.max(1, ms)); })]).finally(() => clearTimeout(timer!));
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  function active(entry: Entry) {
    if (disposed || forgotten.has(entry.info.targetId) || !cdp.connected) throw policyError();
    if (isNativeBrowserSetupTarget(entry.info)) throw new PreserveBrowserSetup();
    if (entry.mode === "closed") throw policyError();
  }
  async function command(method: string, params: CdpObject = {}, sessionId?: string) {
    if (disposed || !cdp.connected) throw policyError();
    return bounded(cdp.send(method, params, sessionId, COMMAND_MS), COMMAND_MS);
  }
  async function targetCommand(entry: Entry, method: string, params: CdpObject = {}) {
    active(entry); const result = await command(method, params, entry.sessionId); active(entry); return result;
  }
  async function configure(entry: Entry, deny: boolean) {
    entry.mode = deny ? "denied" : "configuring";
    await targetCommand(entry, "Network.enable");
    await targetCommand(entry, "Network.setBlockedURLs", { urls: deny ? ["*"] : ["ws://*", "wss://*"] });
    if (entry.info.type === "page" || entry.info.type === "iframe") await targetCommand(entry, "Network.setBypassServiceWorker", { bypass: true });
    await targetCommand(entry, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await targetCommand(entry, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: FILTER });
    if (!deny) {
      // Already-running auxiliary targets may have sent requests before attachment.
      if (!entry.waiting || failure) throw broken();
      entry.mode = "allowed";
      await targetCommand(entry, "Runtime.runIfWaitingForDebugger");
    }
  }
  async function denyAndClose(entry: Entry, popup: boolean) {
    await configure(entry, true);
    active(entry);
    const preserve = (target: NativeTargetList["targetInfos"][number] | undefined) => {
      if (isNativeBrowserSetupTarget(target)) entry.info = { targetId: target!.targetId, type: "page", url: "edge://sync-confirmation-dialog/" };
      return isNativeBrowserSetupTarget(entry.info);
    };
    let result = await bounded(closeNativeTarget(cdp, entry.info.targetId, baseId, 2000, preserve), 2500);
    if (result.preserved) throw new PreserveBrowserSetup();
    active(entry);
    if (!result.confirmed && entry.info.type !== "service_worker" && entry.waiting && result.baseAlive && cdp.connected) {
      // Some close paths need execution to continue. All network is already denied, including
      // any auxiliary targets inherited from this denied parent; no Runtime domain is enabled.
      await targetCommand(entry, "Runtime.runIfWaitingForDebugger");
      entry.waiting = false;
      result = await bounded(closeNativeTarget(cdp, entry.info.targetId, baseId, 2000, preserve), 2500);
      if (result.preserved) throw new PreserveBrowserSetup();
      active(entry);
    }
    if (!result.confirmed) throw broken();
    entry.mode = "closed";
    if (popup) callback(options.onPopup);
  }
  function runEntry(entry: Entry, operation: () => Promise<void>) {
    void operation().then(entry.resolve, (error: unknown) => {
      if (!disposed && error instanceof PreserveBrowserSetup && isNativeBrowserSetupTarget(entry.info)) {
        preserveSetupEntry(entry);
        return;
      }
      if (!disposed && !forgotten.has(entry.info.targetId)) broken();
      entry.reject(failure ?? policyError());
    });
  }
  function preserveSetupEntry(entry: Entry) {
    if (entry.preserved) return;
    entry.preserved = true; callback(() => options.onSetup?.(entry.info.targetId));
    clearTimeout(entry.timer); entry.mode = "closed"; entries.delete(entry.info.targetId); sessions.delete(entry.sessionId);
    void track(command("Target.detachFromTarget", { sessionId: entry.sessionId })).then(entry.resolve, () => { entry.reject(broken()); });
  }
  function makeEntry(info: TargetInfo, sessionId: string, waiting: boolean): Entry {
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const completion = track(new Promise<void>((done, fail) => { resolve = done; reject = fail; }));
    return { info, sessionId, waiting, claimed: false, mode: "configuring", completion, resolve, reject, sockets: new Set() };
  }
  function startClaim(entry: Entry) {
    if (entry.claimed) return;
    if (entry.info.type !== "page" || entry.info.url !== "about:blank" || entry.info.openerId || entry.mode !== "waiting_claim") throw broken();
    clearTimeout(entry.timer); entry.claimed = true;
    runEntry(entry, () => configure(entry, false));
  }
  function attached(event: NativeCdpEvent, params: CdpObject) {
    const infoValue = object(params.targetInfo);
    if (!infoValue || typeof params.sessionId !== "string" || typeof infoValue.targetId !== "string" || typeof infoValue.type !== "string" || typeof infoValue.url !== "string") throw broken();
    const info: TargetInfo = { targetId: infoValue.targetId, type: infoValue.type, url: infoValue.url, ...(typeof infoValue.openerId === "string" && infoValue.openerId ? { openerId: infoValue.openerId } : {}) };
    if (info.targetId === baseId) return; // Never configures, resumes or closes the keepalive target.
    if (/^(?:chrome|edge|ms-browser)-extension:/i.test(info.url) || isNativeBrowserSetupTarget(info)) {
      if (isNativeBrowserSetupTarget(info)) callback(() => options.onSetup?.(info.targetId));
      // Remove only our auto session from extension or exact browser setup UI;
      // do not configure its network, resume it through Runtime, or close its target.
      track(command("Target.detachFromTarget", { sessionId: params.sessionId }).catch(() => { throw broken(); }));
      return;
    }
    if (forgotten.has(info.targetId)) { broken(); return; }
    const existing = entries.get(info.targetId);
    if (existing) { if (existing.sessionId !== params.sessionId) broken(); return; }
    if (entries.size >= 1000) throw broken();
    const entry = makeEntry(info, params.sessionId, params.waitingForDebugger === true);
    entries.set(info.targetId, entry); sessions.set(entry.sessionId, entry);
    const parent = event.sessionId ? sessions.get(event.sessionId) : undefined;
    // Browser-level attachment events may have no parent session. Preserve denial through the
    // opener relationship as well so a denied popup cannot create an allowed auxiliary target.
    const opener = info.openerId ? entries.get(info.openerId) : undefined;
    const inheritedDeny = parent?.mode === "denied" || parent?.mode === "closed" || opener?.mode === "denied" || opener?.mode === "closed";
    if (info.type === "page" && !info.openerId && info.url === "about:blank" && !inheritedDeny) {
      entry.mode = "waiting_claim";
      const waiter = claimWaiters.get(info.targetId);
      if (waiter) { clearTimeout(waiter.timer); claimWaiters.delete(info.targetId); waiter.resolve(entry); }
      entry.timer = setTimeout(() => { if (!entry.claimed && !disposed) runEntry(entry, () => denyAndClose(entry, false)); }, CLAIM_MS);
      return;
    }
    // Match the existing browser context's serviceWorkers:block boundary: never execute a
    // service worker, including as a fallback when a paused target cannot be confirmed closed.
    if (info.type === "service_worker" || info.type === "page" || inheritedDeny) runEntry(entry, () => denyAndClose(entry, info.type === "page" && !!info.openerId));
    else if (AUXILIARY.has(info.type)) runEntry(entry, () => configure(entry, false));
    else { broken(); entry.reject(failure); }
  }
  function listener(event: NativeCdpEvent) {
    if (disposed) return;
    const params = event.params ?? {};
    if (event.method === "Target.targetInfoChanged") {
      const info = object(params.targetInfo);
      if (typeof info?.targetId === "string" && isNativeBrowserSetupTarget(info)) {
        const entry = entries.get(info.targetId);
        if (entry) {
          entry.info = { targetId: info.targetId, type: "page", url: "edge://sync-confirmation-dialog/" };
          if (entry.mode === "waiting_claim" || entry.mode === "allowed") preserveSetupEntry(entry);
        }
      }
      return;
    }
    if (event.method === "Target.attachedToTarget") { attached(event, params); return; }
    if (event.method === "Target.targetDestroyed" && typeof params.targetId === "string") {
      const entry = entries.get(params.targetId);
      if (entry?.mode === "waiting_claim") { clearTimeout(entry.timer); entry.mode = "closed"; entry.reject(broken()); }
      return;
    }
    if (!event.sessionId) return;
    const entry = sessions.get(event.sessionId);
    if (!entry || entry.mode === "closed") return;
    if (event.method === "Fetch.requestPaused") {
      const request = object(params.request);
      if (!request || typeof request.url !== "string" || typeof params.requestId !== "string") throw broken();
      const url = request.url;
      let allowed = false;
      if (entry.mode === "allowed" && !failure) { try { allowed = options.allow(url); } catch { broken(); } }
      const type = typeof params.resourceType === "string" ? params.resourceType.toLowerCase() : "other";
      if (!allowed && RESOURCE_TYPES.has(type)) callback(() => options.onIssue(url, type));
      track(command(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: "BlockedByClient" }, entry.sessionId).catch(() => { throw broken(); }));
    }
    if (event.method === "Network.webSocketCreated" && typeof params.requestId === "string") {
      if (entry.sockets.size >= 1000) throw broken();
      entry.sockets.add(params.requestId);
    }
    if (event.method === "Network.webSocketClosed" && typeof params.requestId === "string") entry.sockets.delete(params.requestId);
    if (event.method === "Network.loadingFailed" && typeof params.requestId === "string" && entry.sockets.delete(params.requestId) && params.errorText === "net::ERR_BLOCKED_BY_CLIENT") callback(options.onBlockedSocket);
  }
  return {
    install() {
      if (!installation) {
        if (disposed || !baseId) return Promise.reject(policyError());
        disposeListener = cdp.on((event) => { try { listener(event); } catch { broken(); } });
        installation = command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: FILTER }).then(() => { if (disposed) throw policyError(); installed = true; }, () => { throw broken(); });
      }
      return installation;
    },
    async claim(targetId) {
      if (!installation || disposed || !targetId || targetId === baseId || forgotten.has(targetId)) throw policyError();
      await installation;
      if (failure) throw failure;
      let entry = entries.get(targetId);
      if (!entry) {
        if (claimWaiters.has(targetId)) throw policyError();
        entry = await track(new Promise<Entry>((resolve, reject) => {
          const timer = setTimeout(() => { claimWaiters.delete(targetId); reject(broken()); }, CLAIM_MS);
          claimWaiters.set(targetId, { resolve, reject, timer });
        }));
      }
      startClaim(entry);
      await bounded(entry.completion, SETTLE_MS);
      if (failure || disposed || entry.mode !== "allowed") throw failure ?? policyError();
      return { sessionId: entry.sessionId };
    },
    async settled() {
      const deadline = Date.now() + SETTLE_MS;
      if (!installation || disposed) throw policyError();
      await installation;
      while (pending.size) {
        if (Date.now() >= deadline) throw broken();
        await bounded(Promise.allSettled([...pending]), deadline - Date.now()).catch(() => { throw broken(); });
      }
      if (failure || disposed || !cdp.connected) throw failure ?? policyError();
    },
    get healthy() { return installed && !disposed && !failure && cdp.connected && pending.size === 0; },
    forget(targetId) {
      forgotten.add(targetId);
      const entry = entries.get(targetId);
      if (entry) { clearTimeout(entry.timer); entry.mode = "closed"; entry.reject(policyError()); entries.delete(targetId); sessions.delete(entry.sessionId); }
      const waiter = claimWaiters.get(targetId);
      if (waiter) { clearTimeout(waiter.timer); waiter.reject(policyError()); claimWaiters.delete(targetId); }
    },
    dispose() {
      disposed = true; disposeListener?.(); disposeListener = undefined;
      for (const entry of entries.values()) { clearTimeout(entry.timer); entry.mode = "closed"; entry.reject(policyError()); }
      for (const waiter of claimWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(policyError()); }
      claimWaiters.clear(); entries.clear(); sessions.clear();
      // Do not disable browser auto-attach here: detaching still-live targets can remove their
      // Fetch barrier. The caller closes/retains its owned browser and targets separately.
    },
  };
}
