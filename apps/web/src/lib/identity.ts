import { z } from "zod";
import { readRuntimeConnection } from "./runtime-connection";
import { activateStorageOwner } from "./private-storage";
export { privateKey, privateStorage, privateStorageEvent, ownerDatabase, capturePrivateStorage } from "./private-storage";

const Principal = z.object({ id: z.string().uuid(), username: z.string(), displayName: z.string() }).strict();
export type BetterMePrincipal = z.infer<typeof Principal>;
let principal: BetterMePrincipal | undefined;
let epoch = 0;
let lifetime = new AbortController();
export class IdentityBoundaryError extends Error {
  constructor() { super("BetterMe 身份已失效或已在另一窗口切换。本页草稿仍保留，请重新登录原账号；未发送到其他账号或计费通道。"); this.name = "IdentityBoundaryError"; }
}
export function currentPrincipal() { return principal; }
export function activatePrincipal(next: BetterMePrincipal | undefined) {
  lifetime.abort(); lifetime = new AbortController(); epoch++;
  principal = next ? Principal.parse(next) : undefined;
  activateStorageOwner(principal?.id);
}
/** Lock transports without changing storage scope while the old App still has pending cleanup. */
export function invalidateIdentity() { lifetime.abort(); epoch++; }
export function agentOrigin() {
  return readRuntimeConnection()?.origin ?? (typeof window === "undefined" ? "http://127.0.0.1:5179" : window.location.origin);
}
function transportHeaders() { return { Authorization: `Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}` }; }
export class IdentityRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "IdentityRequestError"; }
}
/** Cookie is HttpOnly. Expected owner is a race guard, not an authentication credential. */
export async function identityRequest(route: string, body?: unknown) {
  const response = await fetch(`${agentOrigin()}/api/v1/agent/identity/${route}`, {
    method: body === undefined ? "GET" : "POST", credentials: "include", cache: "no-store",
    headers: { ...transportHeaders(), "Content-Type": "application/json", ...(principal ? { "X-BetterMe-Owner": principal.id } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const code = z.object({ error: z.string() }).safeParse(payload);
    const messages: Record<string, string> = {
      oidc_service_unavailable: "统一登录服务暂时不可用，请重试或使用本机账号。",
      oidc_not_configured: "管理员尚未配置统一登录。",
      social_provider_unavailable: "此登录方式尚未开通、已停用或不适用于当前浏览器，请刷新渠道状态。",
      external_identity_already_linked: "此第三方身份已经关联其他 BetterMe 账号，不能覆盖或合并资料。",
      external_identity_not_linked: "请使用已经关联当前 BetterMe 账号的统一身份；未切换或合并账号。",
      sign_out_before_oidc_login: "请先安全退出当前账号，再选择其他账号登录。",
      identity_changed: "当前账号已变化，请重新打开登录方式设置。",
    };
    const errorCode = code.success ? code.data.error : "identity_request_failed";
    const message = messages[errorCode] ?? (response.status === 429 ? "尝试过于频繁，请稍等一分钟再试。" : response.status === 401 ? "账号或密码不正确，或此账号不能创建。" : "本机账号服务暂不可用，未更改已有资料。");
    throw new IdentityRequestError(errorCode, message);
  }
  return z.object({ principal: Principal.nullable().optional() }).passthrough().parse(payload);
}
/** All private Agent transports cross this seam, including SSE and injected test transports. */
export async function ownedFetch(input: RequestInfo | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  const assertIdentity = captureIdentity();
  assertIdentity();
  const owner = principal, version = epoch, signal = lifetime.signal;
  const headers = new Headers(init.headers);
  if (owner) headers.set("X-BetterMe-Owner", owner.id);
  let response: Response;
  try {
    response = await fetcher(input, { ...init, headers, credentials: "include", cache: "no-store",
      signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
  } catch (error) { if (version !== epoch) throw new IdentityBoundaryError(); throw error; }
  if (version !== epoch) {
    // The identity abort can already have errored this body. Cleanup is best-effort;
    // its rejected cancellation must not escape the authoritative identity denial.
    void response.body?.cancel().catch(() => undefined);
    throw new IdentityBoundaryError();
  }
  if (owner && (response.status === 401 || response.status === 409)) {
    const payload: unknown = await response.clone().json().catch(() => undefined);
    // Decoding an old denial may finish after a different account signed in.
    assertIdentity();
    if (payload && typeof payload === "object" && "error" in payload && ["identity_required", "identity_changed"].includes(String(payload.error))) {
      invalidateIdentity();
      if (typeof window !== "undefined") window.dispatchEvent(new Event("betterme:identity-expired"));
      throw new IdentityBoundaryError();
    }
  }
  // JSON/stream consumption can outlive fetch's header resolution. Refuse late bodies as well.
  const guardResponse = (value: Response): Response => new Proxy(value, { get(target, property) {
    if (property === "clone") return () => { assertIdentity(); return guardResponse(target.clone()); };
    if (["json", "text", "arrayBuffer", "blob", "formData"].includes(String(property))) return async () => {
      assertIdentity();
      try { return await (target[property as "json"] as () => Promise<unknown>).call(target); }
      finally { assertIdentity(); }
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return guardResponse(response);
}
export function captureIdentity() {
  return captureIdentityLease().assert;
}
/** Authentication recovery may start from a locked page, but never survives a later account generation. */
export function captureIdentityTransition() {
  const version = epoch;
  return () => { if (version !== epoch) throw new IdentityBoundaryError(); };
}
/** A task keeps its original identity generation even if the same account signs in again. */
export function captureIdentityLease() {
  const version = epoch, signal = lifetime.signal, ownerId = principal?.id;
  const assert = () => { if (version !== epoch || signal.aborted) throw new IdentityBoundaryError(); };
  return { ownerId, signal, assert };
}
