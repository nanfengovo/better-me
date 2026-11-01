import http from "node:http";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import type { ChatGptIssue, ChatGptModel, ChatGptResponseRequest, ChatGptState } from "@better-me/agent-contracts";
import { ChatGptStore, type ChatGptProfile, type ChatGptTokens } from "./store.js";
import { ChatGptError, failure, providerFailure, safeFailure } from "./errors.js";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const tokenResponse = z.object({ access_token: z.string().min(1), id_token: z.string().min(1).optional(), refresh_token: z.string().min(1).optional(),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"), expires_in: z.number().positive().max(366 * 86400), scope: z.string().optional() });
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint?: string };
type Attempt = NonNullable<ChatGptState["attempt"]> & { state: string; nonce: string; verifier: string; redirectUri: string; profileId: string;
  controller: AbortController; listener: http.Server; timer: ReturnType<typeof setTimeout> };
const random = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Dedicated SIWC transport: no API keys, browser cookies, CLI auth, or billing fallback. */
export class ChatGptPlanService {
  private readonly store: ChatGptStore;
  private readonly fetch: typeof fetch;
  private discovery?: Discovery;
  private attempt?: Attempt;
  private starting = false;
  private closed = false;
  private readonly refreshes = new Map<string, Promise<ChatGptTokens>>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly issues = new Map<string, ChatGptIssue>();
  private readonly completed = new Map<string, string>();
  private readonly disconnecting = new Set<string>();
  constructor(private readonly options: {
    directory: string;
    /** Trusted process injection for isolated tests only; never exposed by HTTP/config. */
    fetch?: typeof fetch; authorizationTimeoutMs?: number; authorizationUnavailableReason?: string;
  }) { this.store = new ChatGptStore(options.directory); this.fetch = options.fetch ?? fetch; }

  async state(): Promise<ChatGptState> {
    const state = await this.store.read();
    return { profiles: state.profiles.map(profile => ({ id: profile.id, label: `${profile.email ?? "ChatGPT 账号"} · ${profile.id.slice(-6)}`,
      state: profile.tokens ? ["resource.invoke", "chatgpt.tokens.use.direct"].every(scope => profile.tokens!.scopes.includes(scope)) ? "connected" : "plan-disabled" : profile.needsReauth ? "reauth-required" : "signed-out",
      ...(this.issues.has(profile.id) ? { issue: this.issues.get(profile.id) } : {}),
      ...(this.completed.has(profile.id) ? { lastCompletedAt: this.completed.get(profile.id) } : {}),
    })), ...(this.attempt ? { attempt: { id: this.attempt.id, profileId: this.attempt.profileId, phase: this.attempt.phase, expiresAt: this.attempt.expiresAt, ...(this.attempt.issue ? { issue: this.attempt.issue } : {}) } } : {}),
      usageUrl: "https://chatgpt.com/settings/usage", automaticBillingFallback: false,
      ...(this.options.authorizationUnavailableReason ? { authorizationUnavailableReason: this.options.authorizationUnavailableReason } : {}) };
  }

  async startSignIn(profileId?: string): Promise<{ attemptId: string; authorizationUrl: string }> {
    if (this.options.authorizationUnavailableReason) throw failure("protocol", "interactive_authorization_unavailable", this.options.authorizationUnavailableReason, 422);
    if (this.closed || this.starting || this.attempt && ["waiting", "exchanging"].includes(this.attempt.phase)) throw failure("auth", "authorization_pending", "已有授权正在进行，请完成或取消后再试。", 409);
    this.starting = true;
    let listener: http.Server | undefined;
    try {
      const discovery = await this.getDiscovery();
      const store = await this.store.read();
      const existing = profileId ? store.profiles.find(item => item.id === profileId) : undefined;
      if (profileId && !existing) throw failure("auth", "profile_not_found", "所选账号记录不存在，请刷新账号列表。", 404);
      // Persist the stable host identity before launching browser authorization.
      await this.store.transaction(() => undefined);
      const controller = new AbortController();
      listener = http.createServer((req, res) => { void this.callback(req, res); });
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      if (this.closed) throw failure("cancelled", "host_closed", "服务已关闭，授权未开始。");
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("callback_not_listening");
      const ttl = this.options.authorizationTimeoutMs ?? 10 * 60_000;
      const attempt: Attempt = { id: randomUUID(), phase: "waiting", expiresAt: new Date(Date.now() + ttl).toISOString(),
        state: random(), nonce: random(), verifier: random(), redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
        profileId: existing?.id ?? `chatgpt_${randomUUID()}`, controller, listener,
        timer: setTimeout(() => { if (this.attempt?.id === attempt.id && ["waiting", "exchanging"].includes(attempt.phase)) this.endAttempt(attempt, "expired", failure("auth", "authorization_expired", "授权等待已超时，请重新发起；输入和对话仍保留。").issue); }, ttl),
      };
      attempt.timer.unref?.(); this.attempt = attempt;
      const url = new URL(discovery.authorization_endpoint);
      const params: Record<string, string> = { client_id: existing?.clientId ?? "dynamic_agent_client", ext_agent_host_id: store.hostId,
        response_type: "code", redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE, state: attempt.state,
        nonce: attempt.nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url") };
      if (!existing) params.agent_name_hint = "BetterMe";
      // No id_token_hint: keeping credentials out of browser responses/URLs is
      // more important than skipping the official account selector.
      if (existing?.tokens && !existing.tokens.scopes.includes("chatgpt.tokens.use.direct")) params.prompt = "consent";
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      return { attemptId: attempt.id, authorizationUrl: url.href };
    } catch (error) { listener?.close(); throw safeFailure(error); }
    finally { this.starting = false; }
  }

  cancelSignIn(id: string): void {
    if (this.attempt?.id === id && ["waiting", "exchanging"].includes(this.attempt.phase)) this.endAttempt(this.attempt, "cancelled");
  }
  private endAttempt(attempt: Attempt, phase: Attempt["phase"], issue?: ChatGptIssue): void {
    attempt.phase = phase; attempt.issue = issue; clearTimeout(attempt.timer);
    attempt.controller.abort(); attempt.listener.close();
    attempt.verifier = ""; attempt.nonce = ""; attempt.state = "";
  }
  private async callback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const attempt = this.attempt;
    const finish = (status: number, message: string) => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); res.end(message); };
    if (!attempt || req.headers.host !== new URL(attempt.redirectUri).host || req.method !== "GET") return finish(400, "无效的授权返回。");
    const url = new URL(req.url ?? "/", attempt.redirectUri);
    if (url.pathname !== "/auth/callback" || attempt.phase !== "waiting" || Date.now() >= Date.parse(attempt.expiresAt)) return finish(400, "授权已结束或过期，请返回 BetterMe。");
    if (url.searchParams.getAll("state").length !== 1 || !equal(url.searchParams.get("state") ?? "", attempt.state)) return finish(400, "授权校验失败，请返回 BetterMe 重新开始。");
    if (url.searchParams.has("error")) {
      this.endAttempt(attempt, url.searchParams.get("error") === "access_denied" ? "cancelled" : "error",
        failure("permission", "authorization_declined", "授权未获同意或未完成，未发送模型请求，也未切换其他计费。").issue);
      return finish(200, "授权未完成。请返回 BetterMe；已有输入不会被清空。");
    }
    attempt.phase = "exchanging";
    try {
      const code = url.searchParams.get("code");
      const state = await this.store.read();
      const prior = state.profiles.find(item => item.id === attempt.profileId);
      const clientId = url.searchParams.get("client_id") ?? prior?.clientId;
      if (!code || code.length > 8000 || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("client_id").length > 1 || !clientId || !/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId) || prior && prior.clientId !== clientId) throw failure("auth", "registration_invalid", "授权返回的注册信息不匹配，未替换账号凭据。");
      await this.store.transaction(store => {
        if (!store.profiles.some(item => item.id === attempt.profileId)) store.profiles.push({ id: attempt.profileId, clientId });
      });
      const discovery = await this.getDiscovery();
      const data = await this.requestToken(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
        code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }), attempt.controller.signal);
      if (!data.id_token) throw failure("auth", "identity_missing", "未收到有效身份凭据，账号未连接。");
      const jwks = await this.json(discovery.jwks_uri, { signal: attempt.controller.signal });
      const verified = await jwtVerify(data.id_token, createLocalJWKSet(jwks as JSONWebKeySet), { issuer: ISSUER, audience: clientId, algorithms: ["RS256", "ES256"], requiredClaims: ["exp", "iat", "sub", "nonce"] });
      if (typeof verified.payload.sub !== "string" || !equal(String(verified.payload.nonce ?? ""), attempt.nonce)
        || prior?.subject && verified.payload.sub !== prior.subject) throw failure("auth", "identity_mismatch", "返回身份与本次授权或所选账号不一致，未替换原凭据。");
      attempt.controller.signal.throwIfAborted();
      const tokens = this.tokens(data, data.id_token);
      await this.store.transaction(store => {
        attempt.controller.signal.throwIfAborted();
        const profile = store.profiles.find(item => item.id === attempt.profileId)!;
        profile.subject = verified.payload.sub;
        profile.email = typeof verified.payload.email === "string" ? verified.payload.email.slice(0, 320) : undefined;
        profile.tokens = tokens; profile.needsReauth = false;
      });
      this.issues.delete(attempt.profileId);
      this.endAttempt(attempt, "completed");
      finish(200, "ChatGPT 授权已完成。请关闭此页并返回 BetterMe 选择模型；尚未发送项目或简历内容。");
    } catch (error) {
      if (attempt.phase === "exchanging") this.endAttempt(attempt, "error", safeFailure(error).issue);
      finish(400, "授权未能完成。请返回 BetterMe 查看状态；没有使用付费 API。");
    }
  }

  async models(profileId: string, signal?: AbortSignal): Promise<ChatGptModel[]> {
    const tokens = await this.access(profileId);
    try {
      const payload = await this.json(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal });
      const catalog = z.object({ models: z.array(z.object({ slug: z.string().min(1).max(200), display_name: z.string().min(1).max(300), visibility: z.string() })).max(2000) }).safeParse(payload);
      if (!catalog.success) throw failure("protocol", "invalid_model_catalog", "ChatGPT 模型目录格式不完整，未使用缓存或猜测的模型。");
      const seen = new Set<string>();
      return catalog.data.models.filter(model => model.visibility === "list" && !seen.has(model.slug) && Boolean(seen.add(model.slug)))
        .map(model => ({ slug: model.slug, displayName: model.display_name }));
    } catch (error) { throw this.record(profileId, error); }
  }

  async respond(input: Omit<ChatGptResponseRequest, "consentToSend">, signal: AbortSignal): Promise<{ text: string; model: string; profileId: string }> {
    const issue = this.issues.get(input.profileId);
    if (issue && ["limit", "eligibility", "permission"].includes(issue.kind)) throw new ChatGptError(issue);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(180_000)]);
    const active = this.controllers.get(input.profileId) ?? new Set<AbortController>();
    active.add(controller); this.controllers.set(input.profileId, active);
    try {
      const models = await this.models(input.profileId, combined);
      if (!models.some(model => model.slug === input.model)) throw failure("model", "model_not_available", "所选模型不在该账号的当前目录中。请刷新后主动选择，不会自动替换模型。", 422);
      const tokens = await this.access(input.profileId);
      combined.throwIfAborted();
      const response = await this.fetch(`${RESOURCE}/responses`, { method: "POST", redirect: "error", signal: combined,
        headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: input.model, instructions: input.instructions, input: input.input, store: false, stream: true }),
      });
      if (!response.ok) throw providerFailure(response.status, await this.body(response), response.headers.get("x-request-id") ?? undefined);
      const text = await this.stream(response, combined);
      combined.throwIfAborted();
      this.issues.delete(input.profileId); this.completed.set(input.profileId, new Date().toISOString());
      return { text, model: input.model, profileId: input.profileId };
    } catch (error) {
      if (signal.aborted || controller.signal.aborted) throw failure("cancelled", "request_cancelled", "本轮已停止，输入和历史仍保留；不会自动重发。");
      throw this.record(input.profileId, error);
    } finally { active.delete(controller); if (!active.size) this.controllers.delete(input.profileId); }
  }

  /** Explicit user action after checking usage; model discovery alone never clears a limit. */
  retry(profileId: string): void { this.issues.delete(profileId); }
  async signOut(profileId: string): Promise<{ remoteRevoked: boolean }> {
    this.disconnecting.add(profileId);
    if (this.attempt?.profileId === profileId && ["waiting", "exchanging"].includes(this.attempt.phase)) this.endAttempt(this.attempt, "cancelled");
    try {
    this.controllers.get(profileId)?.forEach(controller => controller.abort());
    const refresh = this.refreshes.get(profileId); if (refresh) await refresh.catch(() => undefined);
    const profile = await this.profile(profileId);
    let remoteRevoked = !profile.tokens;
    if (profile.tokens?.refreshToken) {
      try {
        const discovery = await this.getDiscovery();
        if (!discovery.revocation_endpoint) throw new Error("missing_revocation_endpoint");
        await this.json(discovery.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: profile.tokens.refreshToken, token_type_hint: "refresh_token", client_id: profile.clientId }) });
        remoteRevoked = true;
      } catch { remoteRevoked = false; }
    }
    await this.store.transaction(state => { const current = state.profiles.find(item => item.id === profileId); if (current) { delete current.tokens; current.needsReauth = false; } });
    this.issues.delete(profileId); this.completed.delete(profileId);
    return { remoteRevoked };
    } finally { this.disconnecting.delete(profileId); }
  }
  dispose(): void { this.closed = true; if (this.attempt) this.endAttempt(this.attempt, "cancelled"); this.controllers.forEach(set => set.forEach(controller => controller.abort())); }

  private async profile(id: string): Promise<ChatGptProfile> {
    const result = (await this.store.read()).profiles.find(profile => profile.id === id);
    if (!result) throw failure("auth", "profile_not_found", "请先连接或重新选择 ChatGPT 账号。", 401);
    return result;
  }
  private async access(id: string): Promise<ChatGptTokens> {
    if (this.closed || this.disconnecting.has(id)) throw failure("auth", "account_disconnecting", "所选 ChatGPT 账号正在断开，未发送请求。", 401);
    const profile = await this.profile(id);
    if (!profile.tokens) throw failure("auth", "authorization_required", "请先登录授权所选 ChatGPT 账号；不会使用 API Key 替代。", 401);
    if (!["resource.invoke", "chatgpt.tokens.use.direct"].every(scope => profile.tokens!.scopes.includes(scope))) throw failure("permission", "plan_permission_missing", "账号已登录，但尚未允许本应用使用 ChatGPT 套餐。请主动重新授权；未发送模型请求。", 403);
    if (profile.tokens.expiresAt > Date.now() + 60_000) return profile.tokens;
    let refresh = this.refreshes.get(id);
    if (!refresh) {
      refresh = this.refresh(profile).finally(() => this.refreshes.delete(id));
      this.refreshes.set(id, refresh);
    }
    return refresh;
  }
  private async refresh(profile: ChatGptProfile): Promise<ChatGptTokens> {
    try {
      if (!profile.tokens?.refreshToken) throw failure("auth", "refresh_unavailable", "ChatGPT 授权已过期，请重新登录该账号。", 401);
      const data = await this.requestToken(new URLSearchParams({ grant_type: "refresh_token", client_id: profile.clientId, refresh_token: profile.tokens.refreshToken, resource: RESOURCE }));
      // Scope omission on refresh retains the original grant. If present, never infer additional scopes.
      const tokens = this.tokens(data, profile.tokens.idToken, profile.tokens);
      await this.store.transaction(state => { const current = state.profiles.find(item => item.id === profile.id)!; current.tokens = tokens; current.needsReauth = false; });
      return tokens;
    } catch (error) {
      const safe = this.record(profile.id, error);
      if (safe.issue.kind === "auth") await this.store.transaction(state => { const current = state.profiles.find(item => item.id === profile.id)!; delete current.tokens; current.needsReauth = true; });
      throw safe;
    }
  }
  private tokens(data: z.infer<typeof tokenResponse>, idToken: string, prior?: ChatGptTokens): ChatGptTokens {
    return { accessToken: data.access_token, idToken, refreshToken: data.refresh_token ?? prior?.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000, scopes: data.scope === undefined ? prior?.scopes ?? [] : data.scope.split(/\s+/).filter(Boolean) };
  }
  private async requestToken(form: URLSearchParams, signal?: AbortSignal): Promise<z.infer<typeof tokenResponse>> {
    const discovery = await this.getDiscovery();
    const response = await this.fetch(discovery.token_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const data = await this.body(response);
    if (!response.ok) {
      const code = data && typeof data === "object" && "error" in data ? data.error : undefined;
      if (["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(String(code))) throw failure("auth", "authorization_expired", "ChatGPT 授权已失效，请重新登录同一账号。", 401);
      if (code === "invalid_client") throw failure("protocol", "invalid_client", "ChatGPT 注册信息未被接受，请核实本应用接入配置。", 422);
      throw providerFailure(response.status, data);
    }
    const parsed = tokenResponse.safeParse(data);
    if (!parsed.success) throw failure("protocol", "invalid_token_response", "ChatGPT 授权返回不完整，未替换凭据。");
    return parsed.data;
  }
  private async getDiscovery(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const payload = await this.json(`${ISSUER}/.well-known/openid-configuration`);
    const parsed = z.object({ issuer: z.literal(ISSUER), authorization_endpoint: z.string().url(), token_endpoint: z.string().url(), jwks_uri: z.string().url(), revocation_endpoint: z.string().url().optional() }).parse(payload);
    for (const endpoint of [parsed.authorization_endpoint, parsed.token_endpoint, parsed.jwks_uri, parsed.revocation_endpoint].filter(Boolean)) {
      const url = new URL(endpoint!);
      if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash) throw failure("protocol", "invalid_discovery", "OpenAI 授权端点校验失败，未发送凭据。");
    }
    this.discovery = parsed; return parsed;
  }
  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]) });
    const data = await this.body(response);
    if (!response.ok) throw providerFailure(response.status, data, response.headers.get("x-request-id") ?? undefined);
    return data;
  }
  private async body(response: Response): Promise<unknown> {
    if (!response.body) return {};
    const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 2_000_000) throw failure("protocol", "response_too_large", "ChatGPT 返回超出限制，未采用。"); chunks.push(item.value); }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return {};
      try { return JSON.parse(text); } catch { return {}; }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private async stream(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw failure("protocol", "invalid_stream", "ChatGPT 未返回有效事件流，未采用结果。");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", total = 0, text = "", completed = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) { buffer += decoder.decode(); break; }
        total += item.value.length;
        if (total > 8_000_000) throw failure("protocol", "stream_too_large", "ChatGPT 事件流超出限制，未采用结果。");
        buffer += decoder.decode(item.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(data) as Record<string, unknown>; } catch { throw failure("protocol", "invalid_event", "ChatGPT 事件格式不完整，未采用结果。"); }
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
          if (text.length > 100_000) throw failure("protocol", "output_too_large", "ChatGPT 答复过长，未采用结果。");
          if (event.type === "response.failed" || event.type === "error") {
            const body = event.type === "response.failed" ? event.response : { error: event };
            const structured = body && typeof body === "object" && "error" in body ? body.error : undefined;
            const code = structured && typeof structured === "object" && "code" in structured ? structured.code : undefined;
            throw providerFailure(code === "subscription_sharing_usage_limit_exceeded" ? 429 : 502, body, response.headers.get("x-request-id") ?? undefined);
          }
          if (event.type === "response.incomplete") throw failure("incomplete", "response_incomplete", "ChatGPT 本轮答复未完成，未把部分内容当作建议。输入和历史已保留。");
          if (event.type === "response.completed") {
            const result = event.response as { status?: string } | undefined;
            if (result?.status !== "completed") throw failure("incomplete", "response_not_completed", "ChatGPT 未确认本轮完整完成，未采用结果。");
            completed = true;
          }
        }
        // A completed terminal event is authoritative. Do not wait for a
        // keep-alive connection to close or accept any later partial output.
        if (completed) break;
      }
      if (!completed || !text.trim()) throw failure("incomplete", "stream_interrupted", "ChatGPT 连接结束但未收到完整成功答复，未采用部分结果。可以保留输入后重试。");
      return text;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private record(id: string, error: unknown): ChatGptError { const safe = safeFailure(error); this.issues.set(id, safe.issue); return safe; }
}
