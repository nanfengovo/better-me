import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { SOCIAL_PROVIDERS, type SocialChannel, type SocialLoginCatalog, type SocialProviderId } from "@better-me/agent-contracts";
import { IdentityError } from "./service.js";

const Provider = z.object({ name: z.string().min(1).max(100), category: z.string(), type: z.string(),
  subType: z.string().optional(), clientId: z.string().optional(), clientSecret: z.string().optional(),
  clientId2: z.string().optional(), clientSecret2: z.string().optional() });
const Application = z.object({ clientId: z.string(), disableSignin: z.boolean().optional(),
  organizationObj: z.object({ disableSignin: z.boolean().optional() }).nullish(),
  signinMethods: z.array(z.object({ name: z.string() })).nullish(),
  providers: z.array(z.object({ name: z.string(), canSignIn: z.boolean(), canSignUp: z.boolean(),
    bindingRule: z.array(z.string()).nullish(), provider: Provider.nullish() })).max(200).nullish(),
});
type Entry = { id: SocialProviderId; name: string; state: SocialChannel["state"]; message: string; canSignUp: boolean; context: "browser" | "wechat" | "any" };
type Snapshot = { ready: boolean; entries: Entry[]; unifiedLoginAvailable: boolean };
export type SocialLoginOptions = { issuer: string; clientId: string; callbackUrl: string };
const unavailable = (configured: boolean): SocialLoginCatalog => ({ casdoor: configured,
  service: configured ? "offline" : "not_configured", unifiedLoginAvailable: false,
  message: configured ? "统一登录服务暂时离线或配置未通过核对，可重试或使用本机账号。" : "尚未配置统一登录，仍可使用本机账号。",
  channels: SOCIAL_PROVIDERS.filter(provider => provider.primary).map(({ id, label }) => ({ id, label, state: configured ? "unavailable" : "not_configured",
    message: configured ? "统一登录服务不可用" : "此登录方式尚未开通", canSignUp: false })),
});
export const unconfiguredSocialLogin = () => unavailable(false);

/** One Casdoor adapter: discovers the configured application and projects only allow-listed capabilities. */
export class SocialLoginCatalogModule {
  private cached?: { expiresAt: number; snapshot: Snapshot };
  private pending?: Promise<Snapshot>;
  constructor(private options: SocialLoginOptions, private fetcher: typeof fetch = fetch, private clock: () => number = Date.now) {}

  private async discover(): Promise<Snapshot> {
    // This is the same public, redirect-validating endpoint used by the pinned Casdoor login page.
    const url = new URL("/api/get-app-login", this.options.issuer);
    const nonce = randomBytes(32).toString("base64url");
    url.search = new URLSearchParams({ clientId: this.options.clientId, responseType: "code", redirectUri: this.options.callbackUrl,
      type: "code", scope: "openid profile", state: nonce, nonce, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(nonce).digest("base64url") }).toString();
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(4000), redirect: "error", credentials: "omit", cache: "no-store" });
    if (!response.ok || !response.body) throw new Error("catalog_unavailable");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) throw new Error("catalog_too_large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const result = z.object({ status: z.literal("ok"), data: Application }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const app = result.data;
    if (app.clientId !== this.options.clientId) throw new Error("catalog_client_mismatch");
    const disabled = app.disableSignin || app.organizationObj?.disableSignin;
    // provider_hint is a UI hint, not an authenticated restriction. The broker may offer other
    // providers, so every enabled OAuth source must disable contact/name-based auto-binding.
    const unsafe = (app.providers ?? []).some(item => item.canSignIn && item.provider?.category === "OAuth"
      && (!Array.isArray(item.bindingRule) || item.bindingRule.length > 0));
    const entries: Entry[] = [];
    for (const item of app.providers ?? []) {
      const provider = item.provider;
      const definition = SOCIAL_PROVIDERS.find(value => value.type === provider?.type);
      if (!provider || provider.category !== "OAuth" || !definition || item.name !== provider.name) continue;
      let state: Entry["state"] = "available", message = "已配置，将前往官方授权页面";
      if (!item.canSignIn || disabled) { state = "disabled"; message = "管理员尚未启用此渠道登录"; }
      else if (!Array.isArray(item.bindingRule) || item.bindingRule.length) {
        state = "unsafe_binding"; message = "需关闭按邮箱、手机号或同名自动合并后再启用";
      } else if (provider.type === "WeChat" && provider.subType === "Mobile"
        ? !provider.clientId2 || !provider.clientSecret2 : !provider.clientId || !provider.clientSecret) {
        state = "not_configured"; message = "尚未配置完整的平台应用凭据";
      } else if (unsafe) {
        state = "unsafe_binding"; message = "需关闭此应用所有启用渠道的自动合并后再启用";
      }
      entries.push({ id: definition.id, name: provider.name, state, message, canSignUp: item.canSignUp,
        context: provider.type === "WeChat" ? provider.subType === "Mobile" ? "wechat" : "browser" : "any" });
    }
    return { ready: true, entries, unifiedLoginAvailable: !disabled && !unsafe &&
      (Boolean(app.signinMethods?.length) || entries.some(entry => entry.state === "available")) };
  }

  private snapshot(fresh: boolean): Promise<Snapshot> {
    if (!fresh && this.cached && this.cached.expiresAt > this.clock()) return Promise.resolve(this.cached.snapshot);
    this.pending ??= this.discover().catch((): Snapshot => ({ ready: false, entries: [], unifiedLoginAvailable: false }))
      .then(snapshot => { this.cached = { snapshot, expiresAt: this.clock() + 10_000 }; return snapshot; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private select(snapshot: Snapshot, id: SocialProviderId, userAgent: string): Entry | undefined {
    const context = /MicroMessenger/i.test(userAgent) ? "wechat" : "browser";
    const entries = snapshot.entries.filter(entry => entry.id === id && (entry.context === "any" || entry.context === context));
    return entries.find(entry => entry.state === "available") ?? entries[0];
  }
  async list(userAgent = "", fresh = false): Promise<SocialLoginCatalog> {
    const snapshot = await this.snapshot(fresh);
    if (!snapshot.ready) return { ...unavailable(true), authorizeOrigin: new URL(this.options.issuer).origin };
    return { casdoor: true, service: "ready", authorizeOrigin: new URL(this.options.issuer).origin,
      unifiedLoginAvailable: snapshot.unifiedLoginAvailable,
      message: "首次登录需在官方页面授权；已有资料请先登录原账号，再关联登录方式。",
      // Optional providers appear only when actually attached to this application. Installing
      // another adapter must not manufacture more unconfigured login buttons for everyone.
      channels: SOCIAL_PROVIDERS.filter(provider => provider.primary || snapshot.entries.some(entry => entry.id === provider.id)).map(({ id, label }) => {
        const entry = this.select(snapshot, id, userAgent);
        if (entry) return { id, label, state: entry.state, message: entry.message, canSignUp: entry.canSignUp };
        const otherContext = snapshot.entries.some(entry => entry.id === id);
        return { id, label, state: otherContext ? "unsupported_context" : "not_configured", canSignUp: false,
          message: otherContext ? "当前浏览器未配置对应微信登录方式，请切换浏览器或联系管理员" : "此登录方式尚未开通" };
      }) };
  }
  /** Recheck at flow start; a stale or forged browser catalog cannot enable a channel. */
  async resolve(id: SocialProviderId | undefined, userAgent = ""): Promise<string | undefined> {
    const snapshot = await this.snapshot(true);
    if (!snapshot.ready) throw new IdentityError(503, "oidc_service_unavailable");
    if (!id) {
      if (!snapshot.unifiedLoginAvailable) throw new IdentityError(409, "social_provider_unavailable");
      return undefined;
    }
    const entry = this.select(snapshot, id, userAgent);
    if (!entry || entry.state !== "available") throw new IdentityError(409, "social_provider_unavailable");
    return entry.name;
  }
}
