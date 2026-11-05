import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { UnderstandingCapability, UnderstandingReasoner } from "@better-me/agent-contracts";
import type { RuntimeRegistry } from "../runtime/registry.js";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../identity/private-json.js";
import { ApiAuthorization, ClaudeAuthorizationCode, ClaudeNativeAuth, NativeCredential, NativeId, NativeOutput, nativeDefaults, nativeLaunch } from "./adapters.js";
import { IsolatedNativeProcess, NativeToolError, type NativeProcessRunner } from "./process.js";

export type NativeLease = { session: string; valid: () => Promise<boolean> };
export type NativeCapability = UnderstandingCapability & {
  code: NonNullable<UnderstandingCapability["code"]>;
  authMethods: ("device" | "browser" | "api-key")[]; model?: string; verifiedAt?: string; authorizationMode?: "native" | "api-key";
};
export type NativeLogin = { state: "pending" | "complete" | "failed"; verificationUrl?: string; userCode?: string; expiresAt?: number; runtimeId?: string; acceptsCode?: boolean };
type Pending = { lease: NativeLease; generation: string; controller: AbortController; public: NativeLogin; done: Promise<void>; runtime?: NativeId; write?: (text: string) => void; state?: string };
const supportedIds = new Set<string>(NativeId.options);

/** Per authenticated owner, not per browser-provided workspace/project id.
 * The only imported credentials are fresh, explicitly authorized credentials
 * created in this owner's private directory. No ambient auth-file discovery. */
export class NativeAccountTools {
  private readonly runner: NativeProcessRunner;
  private probes = new Map<string, Promise<"passed" | "protocol_incompatible" | "managed_policy_unavailable" | "runtime_terminated">>();
  private generation = new Map<string, string>();
  private pending?: Pending;
  private active = new Map<string, Set<AbortController>>();
  private turns = new Map<string, { session: string; runtime: string; cancel: () => Promise<unknown>; timer: ReturnType<typeof setTimeout> }>();
  private queue: Promise<unknown> = Promise.resolve();
  private changes: Promise<unknown> = Promise.resolve();
  private closed = false;
  private execution = new Map<string, Promise<unknown>>();
  private revokedSessions = new Set<string>();
  private sessionProcesses = new Map<string, Set<AbortController>>();
  constructor(private readonly options: { directory: string; registry: RuntimeRegistry; runner?: NativeProcessRunner }) {
    this.runner = options.runner ?? new IsolatedNativeProcess();
  }
  private filename(id: NativeId, name = "connection.json") { return path.join(this.options.directory, id, name); }
  private transaction<T>(action: () => Promise<T>): Promise<T> {
    const work = this.queue.then(action); this.queue = work.catch(() => undefined); return work;
  }
  private mutation<T>(action: () => Promise<T>): Promise<T> {
    const work = this.changes.then(action); this.changes = work.catch(() => undefined); return work;
  }
  private async current(id: NativeId): Promise<NativeCredential | undefined> {
    const raw = await readPrivateJson(this.filename(id));
    return raw === undefined ? undefined : NativeCredential.parse(raw);
  }
  private async assertLease(lease: NativeLease): Promise<void> {
    if (this.closed || !lease.session || this.revokedSessions.has(lease.session) || !await lease.valid() || this.revokedSessions.has(lease.session)) throw new NativeToolError("identity_changed", 409);
  }
  private async checkProtocol(id: NativeId, command: string) {
    const stat = await fs.stat(command).catch(() => undefined);
    const key = `${id}:${command}:${stat?.mtimeMs}:${stat?.size}`;
    let probe = this.probes.get(key);
    if (!probe) {
      probe = (async (): Promise<"passed" | "protocol_incompatible" | "managed_policy_unavailable" | "runtime_terminated"> => {
        await privateDirectory(this.options.directory);
        const directory = await fs.mkdtemp(path.join(this.options.directory, "probe-"));
        try {
          const help = await this.runner.run({ command, args: nativeDefaults[id].help, directory, hosts: [], timeoutMs: 15_000 });
          if (!nativeDefaults[id].flags.every(flag => help.includes(flag))) return "protocol_incompatible";
          if (id === "codex") {
            // --help and debug prompt-input do not exercise mandatory policy
            // synchronization. Start with synthetic credentials and NO allowed
            // provider hosts, and stop on the first valid startup event. No
            // actual authorization, user source or model call can be used.
            const launch = await nativeLaunch(id, { generation: randomUUID(), mode: "api-key", apiKey: "betterme-offline-preflight-only", model: "synthetic-model", endpoint: "https://offline.invalid/v1" }, directory);
            const controller = new AbortController(); let initialized = false, buffer = "";
            try {
              await this.runner.run({ ...launch, command, directory, hosts: [], stdin: "BetterMe synthetic startup check", signal: controller.signal, timeoutMs: 10_000,
                onOutput: chunk => { buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) if (line.trim() && JSON.parse(line).type === "thread.started") { initialized = true; controller.abort(); } },
              });
            } catch (error) { if (!initialized) throw error; }
            if (!initialized) throw new NativeToolError("protocol_incompatible");
          }
          return "passed";
        } catch (error) { return error instanceof NativeToolError && (error.code === "managed_policy_unavailable" || error.code === "runtime_terminated") ? error.code : "protocol_incompatible"; }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
      })();
      this.probes.set(key, probe);
    }
    return probe;
  }
  async capabilities(): Promise<NativeCapability[]> {
    const isolated = await this.runner.isolation();
    return Promise.all(this.options.registry.list().map(async runtime => {
      const parsed = NativeId.safeParse(runtime.id);
      const credential = parsed.success ? await this.current(parsed.data) : undefined;
      const base = { id: runtime.id, name: runtime.name, available: runtime.status === "available", supported: false,
        authorized: Boolean(credential),
        ...(credential ? { authorizationMode: credential.mode } : {}),
        authMethods: (runtime.id === "codex" ? ["device", "api-key"] : runtime.id === "claude-code" ? ["browser", "api-key"] : ["api-key"]) as NativeCapability["authMethods"] };
      if (!base.available || !runtime.resolvedCommand) return { ...base, code: "not_installed" as const, reason: "未找到本机可执行文件；不会自动安装。" };
      if (!supportedIds.has(runtime.id)) return { ...base, authMethods: [], code: "adapter_missing" as const, reason: "已安装，但尚无经过验证的账号隔离适配。" };
      if (!isolated) return { ...base, code: "sandbox_unavailable" as const, reason: "操作系统强制隔离未通过检查；不会降级为普通进程运行。当前仅支持已验证的 macOS 沙箱。" };
      const id = NativeId.parse(runtime.id);
      const protocol = await this.checkProtocol(id, runtime.resolvedCommand);
      if (protocol !== "passed") return { ...base, code: protocol, reason: protocol === "managed_policy_unavailable"
        ? "已安装，但当前 Codex 在强制隔离中无法完成 macOS 管理策略同步。未跳过管理员策略，也未发送资料；需要兼容的 CLI 版本或受支持的系统配置。"
        : protocol === "runtime_terminated" ? "已安装，但此 CLI 在隔离启动时被操作系统终止；不是未登录。未开放额外系统权限或降级运行，需要处理版本兼容。"
        : "当前 CLI 版本缺少受控运行参数，或隔离环境中的协议检查失败。" };
      if (id === (this.pending?.runtime ?? "codex") && this.pending?.public.state === "pending") return { ...base, code: "authorization_pending" as const, reason: "等待本账号完成官方原生登录；尚未允许读取资料。" };
      if (!credential) return { ...base, code: "needs_authorization" as const, reason: id === "codex" || id === "claude-code" ? "已安装且隔离协议通过；优先为本 BetterMe 账号单独原生登录，也可明确选择 API 通道。" : "已安装且隔离协议通过；当前隔离适配支持独立 API 授权，原生交互登录尚未适配；不会复制电脑上的登录。" };
      return { ...base, supported: true, code: credential.verifiedAt ? "ready" as const : "needs_verification" as const,
        model: credential.model, verifiedAt: credential.verifiedAt,
        reason: credential.verifiedAt ? "本账号授权及实际运行协议已验证；每轮资料仍需单独授权。" : "本账号授权已保存；尚未验证真实模型调用，不代表供应商连接已成功。" };
    }));
  }
  private async usable(id: NativeId): Promise<string> {
    const capability = (await this.capabilities()).find(item => item.id === id);
    if (!capability || ["not_installed", "adapter_missing", "sandbox_unavailable", "protocol_incompatible", "managed_policy_unavailable", "runtime_terminated"].includes(capability.code)) {
      throw new NativeToolError(capability?.code ?? "not_installed");
    }
    return this.options.registry.get(id)!.resolvedCommand!;
  }
  async authorizeApi(idValue: string, body: unknown, lease: NativeLease): Promise<void> {
    const id = NativeId.parse(idValue), input = ApiAuthorization.parse(body);
    return this.mutation(async () => {
    await this.usable(id); await this.assertLease(lease);
    await this.revokeWork(id);
    await this.transaction(async () => {
      await this.assertLease(lease);
      const credential: NativeCredential = { generation: randomUUID(), mode: "api-key", model: input.model, apiKey: input.apiKey,
        ...(input.endpoint ? { endpoint: input.endpoint } : {}) };
      this.generation.set(id, credential.generation);
      await writePrivateJson(this.filename(id), credential);
    });
    });
  }
  async disconnect(idValue: string, lease: NativeLease): Promise<void> {
    const id = NativeId.parse(idValue); await this.assertLease(lease);
    return this.mutation(async () => {
    await this.revokeWork(id);
    await this.transaction(async () => {
      await this.assertLease(lease); this.generation.set(id, randomUUID());
      // Only this feature's two explicit files, never an owner or legacy root.
      for (const name of ["connection.json", "auth.json"]) {
        const file = this.filename(id, name); await readPrivateJson(file); await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    });
    });
  }
  async startDeviceLogin(lease: NativeLease): Promise<NativeLogin> {
    return this.mutation(async () => {
    const command = await this.usable("codex"); await this.assertLease(lease);
    if (this.pending?.public.state === "pending") {
      if (this.pending.lease.session !== lease.session || this.pending.runtime && this.pending.runtime !== "codex") throw new NativeToolError("authorization_in_progress", 409);
      return this.loginStatus(lease);
    }
    await this.revokeWork("codex");
    await privateDirectory(this.options.directory);
    const directory = await fs.mkdtemp(path.join(this.options.directory, "device-"));
    try { await this.assertLease(lease); } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
    const generation = randomUUID(); this.generation.set("codex", generation);
    const controller = new AbortController();
    const pending: Pending = { lease, generation, controller, runtime: "codex", public: { state: "pending", expiresAt: Date.now() + 10 * 60_000 }, done: Promise.resolve() };
    this.pending = pending;
    let capture = "";
    pending.done = (async () => {
      try {
        await this.runner.run({ command, args: ["-c", "cli_auth_credentials_store=\"file\"", "login", "--device-auth"],
          directory, hosts: ["auth.openai.com"], signal: controller.signal, timeoutMs: 10 * 60_000,
          onControlOutput: chunk => {
            // CLI ANSI control sequences, not user-authored text.
            // eslint-disable-next-line no-control-regex
            capture = (capture + chunk).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").slice(-16_000);
            const url = capture.match(/https:\/\/auth\.openai\.com\/(?:codex\/)?device\b/)?.[0];
            const code = capture.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/)?.[0];
            if (url && code) { pending.public.verificationUrl = url; pending.public.userCode = code; }
          },
        });
        const auth = await readPrivateJson(path.join(directory, "codex", "auth.json"));
        if (!auth || typeof auth !== "object" || !("auth_mode" in auth) || auth.auth_mode !== "chatgpt" || !("tokens" in auth) || !auth.tokens || typeof auth.tokens !== "object"
          || !("access_token" in auth.tokens) || typeof auth.tokens.access_token !== "string") throw new NativeToolError("authorization_failed");
        await this.transaction(async () => {
          await this.assertLease(lease);
          if (controller.signal.aborted || this.generation.get("codex") !== generation) throw new NativeToolError("authorization_cancelled", 409);
          await writePrivateJson(this.filename("codex", "auth.json"), auth);
          await writePrivateJson(this.filename("codex"), { generation, mode: "native" });
          pending.public = { state: "complete" };
        });
      } catch {
        pending.public = { state: "failed" };
        if (this.generation.get("codex") === generation) {
          const previous = await this.current("codex").catch(() => undefined);
          if (previous) this.generation.set("codex", previous.generation);
        }
      }
      finally { capture = ""; await fs.rm(directory, { recursive: true, force: true }); }
    })();
    // Login output is never a log/event/record. The code is delivered only to
    // the exact authenticated session that started this short-lived flow.
    return this.loginStatus(lease);
    });
  }
  async loginStatus(lease: NativeLease): Promise<NativeLogin> {
    await this.assertLease(lease);
    if (!this.pending || this.pending.lease.session !== lease.session) return { state: "failed" };
    return { ...this.pending.public };
  }
  async startClaudeLogin(lease: NativeLease): Promise<NativeLogin> {
    return this.mutation(async () => {
      const id = "claude-code", command = await this.usable(id); await this.assertLease(lease);
      if (this.pending?.public.state === "pending") {
        if (this.pending.lease.session !== lease.session || this.pending.runtime !== id) throw new NativeToolError("authorization_in_progress", 409);
        return this.loginStatus(lease);
      }
      await this.revokeWork(id); await privateDirectory(this.options.directory);
      const directory = await fs.mkdtemp(path.join(this.options.directory, "claude-login-"));
      const generation = randomUUID(); this.generation.set(id, generation);
      const pending: Pending = { lease, generation, runtime: id, controller: new AbortController(), public: { state: "pending", runtimeId: id, acceptsCode: true, expiresAt: Date.now() + 10 * 60_000 }, done: Promise.resolve() };
      this.pending = pending; let capture = "";
      pending.done = (async () => {
        try {
          await this.runner.run({ command, args: ["auth", "login", "--claudeai"], directory, hosts: ["claude.ai", "claude.com", "platform.claude.com", "api.anthropic.com"],
            environment: { BROWSER: "/usr/bin/false" }, loopbackLoginListener: true, timeoutMs: 10 * 60_000, signal: pending.controller.signal,
            onStdinReady: write => { pending.write = write; }, onControlOutput: chunk => {
              // eslint-disable-next-line no-control-regex
              capture = (capture + chunk).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").slice(-16_000);
              const raw = capture.match(/https:\/\/(?:claude\.ai\/oauth|claude\.com\/cai\/oauth)\/authorize\?[^\s<>]+/)?.[0];
              if (!raw) return;
              const url = new URL(raw);
              if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("state")
                || url.searchParams.get("redirect_uri") !== "https://platform.claude.com/oauth/code/callback") return;
              pending.state = url.searchParams.get("state")!; pending.public.verificationUrl = url.href;
            } });
          const auth = ClaudeNativeAuth.parse(await readPrivateJson(path.join(directory, "claude", ".credentials.json")));
          await this.transaction(async () => {
            await this.assertLease(lease);
            if (pending.controller.signal.aborted || this.generation.get(id) !== generation) throw new NativeToolError("authorization_cancelled", 409);
            await writePrivateJson(this.filename(id, "auth.json"), auth);
            await writePrivateJson(this.filename(id), { generation, mode: "native" }); pending.public = { state: "complete", runtimeId: id };
          });
        } catch {
          pending.public = { state: "failed", runtimeId: id };
          if (this.generation.get(id) === generation) { const previous = await this.current(id).catch(() => undefined); if (previous) this.generation.set(id, previous.generation); }
        } finally { capture = ""; pending.write = undefined; pending.state = undefined; await fs.rm(directory, { recursive: true, force: true }); }
      })();
      return this.loginStatus(lease);
    });
  }
  async submitClaudeCode(value: unknown, lease: NativeLease) {
    const { code } = ClaudeAuthorizationCode.parse(value); await this.assertLease(lease);
    const pending = this.pending;
    if (!pending || pending.runtime !== "claude-code" || pending.lease.session !== lease.session || pending.public.state !== "pending" || !pending.write || !pending.state || code.split("#")[1] !== pending.state) throw new NativeToolError("authorization_code_invalid", 409);
    pending.write(`${code}\n`);
  }
  async cancelDeviceLogin(lease: NativeLease): Promise<void> {
    return this.mutation(async () => {
    await this.assertLease(lease);
    const pending = this.pending;
    if (!pending || pending.lease.session !== lease.session) return;
    pending.controller.abort(); await pending.done;
    if (this.pending === pending) this.pending = undefined;
    });
  }
  watchTurn(id: string, runtime: string, lease: NativeLease, cancel: () => Promise<unknown>): () => void {
    if (this.revokedSessions.has(lease.session)) throw new NativeToolError("identity_changed", 409);
    const key = `${lease.session}:${id}`;
    // An idempotent delivery retry must not replace/remove the watcher of the
    // still-running original turn when its own onSettled fires immediately.
    if (this.turns.has(key)) return () => undefined;
    const timer = setTimeout(() => this.turns.delete(key), 24 * 60 * 60_000); timer.unref();
    this.turns.set(key, { session: lease.session, runtime, cancel, timer });
    return () => { if (this.turns.get(key)?.timer === timer) { clearTimeout(timer); this.turns.delete(key); } };
  }
  async invalidateSession(session: string): Promise<void> {
    this.revokedSessions.add(session);
    for (const controller of this.sessionProcesses.get(session) ?? []) controller.abort();
    if (this.pending?.lease.session === session) { this.pending.controller.abort(); await this.pending.done; }
    for (const [key, turn] of this.turns) if (turn.session === session) {
      clearTimeout(turn.timer); this.turns.delete(key); await turn.cancel().catch(() => undefined);
    }
    await this.queue;
    await this.changes;
  }
  private async revokeWork(id: string): Promise<void> {
    this.generation.set(id, randomUUID());
    if (id === (this.pending?.runtime ?? "codex") && this.pending?.public.state === "pending") { this.pending.controller.abort(); await this.pending.done; }
    for (const controller of this.active.get(id) ?? []) controller.abort();
    for (const [key, turn] of this.turns) if (turn.runtime === id) {
      clearTimeout(turn.timer); this.turns.delete(key); await turn.cancel().catch(() => undefined);
    }
  }
  async reasoner(idValue: string, lease: NativeLease): Promise<UnderstandingReasoner> {
    const parsed = NativeId.safeParse(idValue);
    if (!parsed.success) throw new NativeToolError("runtime_identity_isolation_required", 403);
    const id = parsed.data, command = await this.usable(id);
    await this.assertLease(lease);
    const initial = await this.current(id);
    if (!initial) throw new NativeToolError("authorization_required", 403);
    if (!this.generation.has(id)) this.generation.set(id, initial.generation);
    if (this.generation.get(id) !== initial.generation) throw new NativeToolError("authorization_changed", 409);
    return (prompt, signal) => {
      const previous = this.execution.get(id) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => this.execute(id, command, initial.generation, prompt, signal, lease));
      this.execution.set(id, next); void next.finally(() => { if (this.execution.get(id) === next) this.execution.delete(id); }).catch(() => undefined);
      return next;
    };
  }
  private async execute(id: NativeId, command: string, generation: string, prompt: string, signal: AbortSignal, lease: NativeLease): Promise<string> {
    signal.throwIfAborted(); await this.assertLease(lease);
    const credential = await this.current(id);
    if (!credential || credential.generation !== generation || this.generation.get(id) !== generation) throw new NativeToolError("authorization_changed", 409);
    if (!prompt.trim() || Buffer.byteLength(prompt) > 1_000_000) throw new NativeToolError("prompt_limit");
    await privateDirectory(this.options.directory);
    const directory = await fs.mkdtemp(path.join(this.options.directory, "run-"));
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
    const active = this.active.get(id) ?? new Set<AbortController>(); active.add(controller); this.active.set(id, active);
    const processes = this.sessionProcesses.get(lease.session) ?? new Set<AbortController>(); processes.add(controller); this.sessionProcesses.set(lease.session, processes);
    const secrets = credential.apiKey ? [credential.apiKey] : [];
    try {
      await fs.mkdir(path.join(directory, "codex"), { mode: 0o700 });
      if (credential.mode === "native") {
        const auth = await readPrivateJson(this.filename(id, "auth.json"));
        if (!auth) throw new NativeToolError("authorization_required", 403);
        const tokens = id === "claude-code" ? ClaudeNativeAuth.parse(auth).claudeAiOauth : (auth as { tokens?: Record<string, unknown> }).tokens ?? {};
        for (const value of Object.values(tokens)) if (typeof value === "string" && value.length > 16) secrets.push(value);
        await writePrivateJson(path.join(directory, id === "claude-code" ? "claude" : "codex", id === "claude-code" ? ".credentials.json" : "auth.json"), auth);
      }
      const launch = await nativeLaunch(id, credential, directory);
      const decoder = new NativeOutput(id);
      await this.runner.run({ command, ...launch, directory, stdin: prompt, signal: combined, onOutput: chunk => decoder.feed(chunk) });
      const answer = decoder.finish();
      const refreshed = credential.mode === "native" ? await readPrivateJson(path.join(directory, id === "claude-code" ? "claude" : "codex", id === "claude-code" ? ".credentials.json" : "auth.json")) : undefined;
      const tokens = id === "claude-code" && refreshed ? ClaudeNativeAuth.parse(refreshed).claudeAiOauth : (refreshed as { tokens?: Record<string, unknown> } | undefined)?.tokens ?? {};
      for (const value of Object.values(tokens)) if (typeof value === "string" && value.length > 16) secrets.push(value);
      if (secrets.some(secret => answer.includes(secret))) throw new NativeToolError("sensitive_output");
      await this.transaction(async () => {
        combined.throwIfAborted(); await this.assertLease(lease);
        const current = await this.current(id);
        if (current?.generation !== generation || this.generation.get(id) !== generation) throw new NativeToolError("authorization_changed", 409);
        if (credential.mode === "native") {
          if (refreshed) await writePrivateJson(this.filename(id, "auth.json"), refreshed);
        }
        await writePrivateJson(this.filename(id), { ...credential, verifiedAt: new Date().toISOString() });
      });
      return answer;
    } finally { active.delete(controller); processes.delete(controller); if (!processes.size) this.sessionProcesses.delete(lease.session); await fs.rm(directory, { recursive: true, force: true }); }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.pending) { this.pending.controller.abort(); await this.pending.done; }
    for (const controllers of this.active.values()) for (const controller of controllers) controller.abort();
    for (const turn of this.turns.values()) { clearTimeout(turn.timer); await turn.cancel().catch(() => undefined); }
    this.turns.clear(); await this.changes; await this.queue; await Promise.allSettled(this.execution.values());
  }
}
