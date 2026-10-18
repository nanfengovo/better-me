import { JdExtractionError } from "../src/lib/jd-errors";

export type CdpObject = Record<string, unknown>;
export type NativeCdpEvent = { method?: string; params?: CdpObject; sessionId?: string };
export type NativeCdp = {
  send<T = CdpObject>(method: string, params?: CdpObject, sessionId?: string, timeoutMs?: number): Promise<T>;
  on(listener: (event: NativeCdpEvent) => void): () => void;
  close(): void;
  readonly connected: boolean;
};
const METHODS = new Set([
  "Browser.getVersion", "Browser.close", "Browser.setDownloadBehavior",
  "Target.createTarget", "Target.closeTarget", "Target.getTargets", "Target.attachToTarget", "Target.detachFromTarget", "Target.setDiscoverTargets", "Target.setAutoAttach", "Target.activateTarget",
  "Page.enable", "Page.navigate", "Page.getFrameTree", "Page.setLifecycleEventsEnabled", "Page.stopLoading", "Page.getLayoutMetrics",
  "Network.enable", "Network.setBlockedURLs", "Network.setBypassServiceWorker", "Network.setCacheDisabled",
  "DOMSnapshot.captureSnapshot", "DOM.getDocument", "DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads", "DOM.getNodeForLocation",
  "Input.dispatchMouseEvent", "Fetch.enable", "Fetch.continueRequest", "Fetch.failRequest",
  "Runtime.runIfWaitingForDebugger",
]);
const EXPANSION_METHODS = new Set(["DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads", "DOM.getNodeForLocation", "Page.getLayoutMetrics", "Input.dispatchMouseEvent"]);
function exactKeys(params: CdpObject, keys: string[]) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const prototype = Object.getPrototypeOf(params);
  if (prototype !== null && prototype !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(params);
  return ownKeys.length === keys.length && ownKeys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(params, key);
    return typeof key === "string" && keys.includes(key) && descriptor?.enumerable === true && "value" in descriptor;
  });
}
function expansionParamsAllowed(method: string, params: CdpObject) {
  if (method === "Page.getLayoutMetrics") return exactKeys(params, []);
  if (method === "DOM.scrollIntoViewIfNeeded" || method === "DOM.getContentQuads") return exactKeys(params, ["backendNodeId"]) && Number.isSafeInteger(params.backendNodeId) && (params.backendNodeId as number) > 0;
  if (method === "DOM.getNodeForLocation") return exactKeys(params, ["x", "y", "includeUserAgentShadowDOM", "ignorePointerEventsNone"]) && Number.isSafeInteger(params.x) && (params.x as number) >= 0 && Number.isSafeInteger(params.y) && (params.y as number) >= 0 && params.includeUserAgentShadowDOM === false && params.ignorePointerEventsNone === false;
  if (method === "Input.dispatchMouseEvent") {
    const coordinate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
    return exactKeys(params, ["type", "x", "y", "button", "clickCount", "buttons"]) && coordinate(params.x) && coordinate(params.y) && params.button === "left" && params.clickCount === 1 && ((params.type === "mousePressed" && params.buttons === 1) || (params.type === "mouseReleased" && params.buttons === 0));
  }
  return false;
}
export function nativeUnavailable(message = "岗位专用浏览器暂不可用，请核对工具窗口后重试。") {
  return new JdExtractionError({ code: "browser_unavailable", stage: "service", message });
}
export type NativeSocket = Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener">;

/** No Runtime enable/evaluate, Console, Log, page globals or remote error strings. Only resume owned paused targets. */
export function createNativeCdp(socket: NativeSocket): NativeCdp {
  let sequence = 0; let closed = false;
  const listeners = new Set<(event: NativeCdpEvent) => void>();
  const attached = new Map<string, string>();
  const pending = new Map<number, { method: string; params: CdpObject; resolve: (value: CdpObject) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  function end() {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(nativeUnavailable("岗位专用浏览器连接已中断，未采用未完成的正文。")); }
    pending.clear(); attached.clear();
  }
  socket.addEventListener("close", end); socket.addEventListener("error", end);
  socket.addEventListener("message", (event) => {
    if (closed) return;
    const text = (event as MessageEvent).data as unknown;
    // A post-receipt processing bound, not a browser/network streaming cap.
    if (typeof text !== "string" || text.length > 8 * 1024 * 1024) { end(); socket.close(); return; }
    let message: CdpObject;
    try { message = JSON.parse(text) as CdpObject; } catch { end(); socket.close(); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { end(); socket.close(); return; }
    if (typeof message.id === "number") {
      const item = pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(nativeUnavailable("浏览器未完成本次操作，未采用未确认的结果。"));
      else {
        const result = (message.result ?? {}) as CdpObject;
        if (item.method === "Target.attachToTarget" && typeof result.sessionId === "string" && result.sessionId && typeof item.params.targetId === "string" && item.params.targetId) attached.set(result.sessionId, item.params.targetId);
        if (item.method === "Target.detachFromTarget" && typeof item.params.sessionId === "string") attached.delete(item.params.sessionId);
        item.resolve(result);
      }
    } else {
      const params = message.params as CdpObject | undefined;
      if (message.method === "Target.attachedToTarget" && params && typeof params.sessionId === "string" && params.sessionId) {
        const info = params.targetInfo as CdpObject | undefined;
        if (typeof info?.targetId === "string" && info.targetId) attached.set(params.sessionId, info.targetId);
      }
      if (message.method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") attached.delete(params.sessionId);
      if (message.method === "Target.targetDestroyed" && typeof params?.targetId === "string") for (const [session, target] of attached) if (target === params.targetId) attached.delete(session);
      for (const listener of listeners) { try { listener(message as NativeCdpEvent); } catch { end(); socket.close(); break; } }
    }
  });
  return {
    get connected() { return !closed && socket.readyState === 1; },
    send<T = CdpObject>(method: string, params: CdpObject = {}, sessionId?: string, timeoutMs = 5000): Promise<T> {
      if (!METHODS.has(method)) return Promise.reject(nativeUnavailable("原生浏览器拒绝了未授权的协议能力。"));
      if (method === "Runtime.runIfWaitingForDebugger" && (!sessionId || Object.keys(params).length)) return Promise.reject(nativeUnavailable("仅可恢复本工具已暂停的目标会话。"));
      if (method === "DOM.getDocument" && (!sessionId || !attached.has(sessionId) || Object.keys(params).length !== 2 || Object.keys(params).some(key => key !== "depth" && key !== "pierce") || params.depth !== 0 || params.pierce !== false)) return Promise.reject(nativeUnavailable("仅可读取已附岗位会话的顶层文档身份。"));
      if (EXPANSION_METHODS.has(method) && (!sessionId || !attached.has(sessionId) || !expansionParamsAllowed(method, params))) return Promise.reject(nativeUnavailable("仅可在已附岗位会话中执行受限的普通正文展开操作。"));
      if (closed || socket.readyState !== 1) return Promise.reject(nativeUnavailable());
      return new Promise<T>((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(nativeUnavailable("浏览器操作超时，尚未确认操作结果。")); }, Math.max(1, Math.min(timeoutMs, 10_000)));
        pending.set(id, { method, params, resolve: (value) => resolve(value as T), reject, timer });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { clearTimeout(timer); pending.delete(id); reject(nativeUnavailable()); }
      });
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { end(); socket.close(); listeners.clear(); },
  };
}
export async function connectNativeCdp(port: number): Promise<NativeCdp> {
  let endpoint: URL;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const value = await response.json() as { webSocketDebuggerUrl?: string };
    endpoint = new URL(value.webSocketDebuggerUrl ?? "");
  } catch { throw nativeUnavailable(); }
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.port !== String(port) || !endpoint.pathname.startsWith("/devtools/browser/")) throw nativeUnavailable();
  const socket = new WebSocket(endpoint); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(nativeUnavailable()), 4000);
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(nativeUnavailable()), { once: true });
    });
  } catch (error) { socket.close(); throw error; } finally { clearTimeout(timer); }
  return createNativeCdp(socket);
}

export type NativeTargetList = { targetInfos: Array<{ targetId: string; url: string; type?: string; openerId?: string }> };
export type NativeTargetClose = { accepted: boolean | "unknown" | "not_sent"; actualGone: boolean; baseAlive: boolean; confirmed: boolean; queries: number; preserved?: true };
/** One close request, then bounded authoritative queries. Never closes the browser or base. */
export async function closeNativeTarget(cdp: NativeCdp, targetId: string, baseId: string, timeoutMs = 3000, preserve?: (target: NativeTargetList["targetInfos"][number] | undefined) => boolean): Promise<NativeTargetClose> {
  if (!targetId || !baseId || targetId === baseId) throw nativeUnavailable();
  const deadline = Date.now() + timeoutMs;
  let lastTarget: NativeTargetList["targetInfos"][number] | undefined;
  const result: NativeTargetClose = { accepted: "not_sent", actualGone: false, baseAlive: false, confirmed: false, queries: 0 };
  const remaining = () => Math.max(1, Math.min(700, deadline - Date.now()));
  const query = async () => {
    const targets = await cdp.send<NativeTargetList>("Target.getTargets", {}, undefined, remaining()); result.queries++;
    if (!Array.isArray(targets.targetInfos)) throw nativeUnavailable();
    result.actualGone = !targets.targetInfos.some((item) => item.targetId === targetId);
    result.baseAlive = targets.targetInfos.some((item) => item.targetId === baseId && item.url === "about:blank");
    result.confirmed = result.actualGone && result.baseAlive && cdp.connected;
    lastTarget = targets.targetInfos.find((item) => item.targetId === targetId);
    if (preserve?.(lastTarget)) result.preserved = true;
  };
  try {
    await query(); if (result.actualGone || !result.baseAlive || result.preserved) return result;
    // A target-info event can arrive while the query continuation is queued.
    // Recheck its remembered identity synchronously immediately before sending close.
    if (preserve?.(lastTarget)) { result.preserved = true; return result; }
    try { result.accepted = (await cdp.send<{ success?: boolean }>("Target.closeTarget", { targetId }, undefined, remaining())).success === true; }
    catch { result.accepted = "unknown"; }
    while (Date.now() < deadline && cdp.connected) {
      await query(); if (result.actualGone || !result.baseAlive) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
    }
  } catch { result.confirmed = false; }
  return result;
}
