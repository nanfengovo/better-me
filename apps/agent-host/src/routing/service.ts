import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentRoutingPolicySchema, AgentRoutingUpdateSchema, defaultAgentRoutingPolicy,
  type AgentRoutingPolicy, type AgentRoutingTrace, type UnderstandingReasoner,
} from "@better-me/agent-contracts";
import { readPrivateJson, writePrivateJson } from "../identity/private-json.js";
import { NativeAccountTools, type NativeLease } from "../native-tools/service.js";
import { NativeToolError } from "../native-tools/process.js";

export class RoutingError extends NativeToolError {
  constructor(code: string, readonly trace?: AgentRoutingTrace, status = 409) { super(code, status); }
}
const safeCodes = new Set(["not_installed", "adapter_missing", "sandbox_unavailable", "protocol_incompatible", "managed_policy_unavailable", "runtime_terminated", "authorization_required"]);
type Pin = { current?: { id: string; reasoner: UnderstandingReasoner } };
type ResultFence = { controller: AbortController; releases: (() => void)[] };

/** One owner-scoped decision seam. The CLI is a replaceable reasoner, not an
 * owner of Workspace records. No ambient credentials, default API or retry of
 * an already-dispatched request enters this module. */
export class AgentRouting {
  private changes: Promise<unknown> = Promise.resolve();
  private active = new Set<AbortController>();
  private sessions = new Set<string>();
  private inFlight = new Map<string, { session: string; digest: string; fence: ResultFence; promise: Promise<{ text: string; trace: AgentRoutingTrace }> }>();
  private latest?: AgentRoutingTrace;
  private turns = new Map<string, { session: string; cancel: () => Promise<unknown>; release: () => void }>();
  private closed = false;
  constructor(private readonly options: { directory: string; native: NativeAccountTools; scan: () => Promise<void> }) {}
  private async assert(lease: NativeLease) {
    if (this.closed || this.sessions.has(lease.session) || !await lease.valid() || this.sessions.has(lease.session)) throw new RoutingError("identity_changed");
  }
  async policy(): Promise<AgentRoutingPolicy> {
    const value = await readPrivateJson(path.join(this.options.directory, "policy.json"));
    return value === undefined ? structuredClone(defaultAgentRoutingPolicy) : AgentRoutingPolicySchema.parse(value);
  }
  async update(value: unknown, lease: NativeLease): Promise<AgentRoutingPolicy> {
    const input = AgentRoutingUpdateSchema.parse(value);
    const operation = this.changes.then(async () => {
      await this.assert(lease);
      const previous = await this.policy();
      if (previous.revision !== input.expectedRevision) throw new RoutingError("routing_revision_conflict");
      await this.options.scan();
      const ids = new Set((await this.options.native.capabilities()).map(item => item.id));
      if (![input.preferred, ...input.backups].every(id => ids.has(id))) throw new RoutingError("unknown_runtime", undefined, 400);
      const next = AgentRoutingPolicySchema.parse({ revision: previous.revision + 1, mode: input.mode,
        preferred: input.preferred, backups: input.backups, allowApiBackups: input.allowApiBackups });
      await this.assert(lease);
      // Selection changes are a consent-generation boundary, not an instruction
      // to replay an in-progress request on another provider.
      for (const controller of this.active) controller.abort();
      for (const turn of this.turns.values()) await turn.cancel().catch(() => undefined);
      await writePrivateJson(path.join(this.options.directory, "policy.json"), next);
      return next;
    });
    this.changes = operation.catch(() => undefined); return operation;
  }
  async status() { return { policy: await this.policy(), ...(this.latest ? { trace: structuredClone(this.latest) } : {}) }; }
  async reasoner(revision: number, lease: NativeLease): Promise<UnderstandingReasoner> {
    await this.assert(lease);
    if ((await this.policy()).revision !== revision) throw new RoutingError("routing_revision_conflict");
    const pin: Pin = {};
    // One broker turn stays pinned after its first dispatch. Revoking or
    // replacing that authorization cannot move subsequent read decisions to
    // another provider behind the user's back.
    return async (prompt, signal) => (await this.run(randomUUID(), revision, prompt, signal, lease, pin)).text;
  }
  async watchTurn(id: string, lease: NativeLease, cancel: () => Promise<unknown>): Promise<() => void> {
    await this.assert(lease); const key = `${lease.session}:${id}`;
    if (this.turns.has(key)) return () => undefined;
    const policy = await this.policy();
    await this.assert(lease);
    if (this.turns.has(key)) return () => undefined;
    const releases = [policy.preferred, ...(policy.mode === "auto" ? policy.backups : [])].map(runtime => this.options.native.watchTurn(`routing:${id}:${runtime}`, runtime, lease, cancel));
    const release = () => { for (const remove of releases) remove(); this.turns.delete(key); };
    this.turns.set(key, { session: lease.session, cancel, release }); return release;
  }
  run(id: string, revision: number, prompt: string, signal: AbortSignal, lease: NativeLease, pin?: Pin) {
    const digest = createHash("sha256").update(JSON.stringify([revision, prompt])).digest("hex");
    const previous = this.inFlight.get(id);
    if (previous) {
      if (previous.session !== lease.session || previous.digest !== digest) return Promise.reject(new RoutingError("routing_request_conflict"));
      const check = async () => {
        signal.throwIfAborted(); await this.assert(lease); await this.changes;
        if (previous.fence.controller.signal.aborted) throw new RoutingError("authorization_changed");
        if ((await this.policy()).revision !== revision) throw new RoutingError("routing_revision_conflict");
      };
      return (async () => { await check(); const result = await previous.promise; await check(); return result; })();
    }
    const fence: ResultFence = { controller: new AbortController(), releases: [] };
    const promise = this.execute(id, revision, prompt, signal, lease, fence, pin);
    this.inFlight.set(id, { session: lease.session, digest, fence, promise });
    // Keep the idempotency result in memory briefly. A persisted receipt is a
    // non-replay marker after restart, never a cache of source/model output.
    const timer = setTimeout(() => { for (const release of fence.releases) release(); this.inFlight.delete(id); }, 10 * 60_000); timer.unref();
    return promise;
  }
  private async execute(id: string, revision: number, prompt: string, signal: AbortSignal, lease: NativeLease, fence: ResultFence, pin?: Pin) {
    await this.assert(lease); signal.throwIfAborted(); await this.changes;
    const policy = await this.policy();
    if (policy.revision !== revision) throw new RoutingError("routing_revision_conflict");
    if (policy.mode === "legacy") throw new RoutingError("routing_not_enabled");
    const file = path.join(this.options.directory, "receipts", `${id}.json`);
    if (await readPrivateJson(file)) throw new RoutingError("routing_result_unknown");
    const controller = fence.controller, combined = AbortSignal.any([signal, controller.signal]);
    for (const runtime of [policy.preferred, ...(policy.mode === "auto" ? policy.backups : [])]) {
      fence.releases.push(this.options.native.watchTurn(`routing-request:${id}:${runtime}`, runtime, lease, async () => { controller.abort(); }));
    }
    this.active.add(controller);
    const trace: AgentRoutingTrace = { id, policyRevision: revision, state: "running", at: new Date().toISOString(), attempts: [] };
    const save = async () => { await this.assert(lease); this.latest = structuredClone(trace); await writePrivateJson(file, trace); };
    const check = async () => {
      combined.throwIfAborted(); await this.assert(lease);
      if ((await this.policy()).revision !== revision) throw new RoutingError("routing_revision_conflict");
    };
    try {
      await save(); await this.options.scan(); await check();
      const capabilities = await this.options.native.capabilities();
      const ids = pin?.current ? [pin.current.id] : policy.mode === "manual" ? [policy.preferred] : [policy.preferred, ...policy.backups];
      // Native login first within the user's approved chain. An API credential
      // is NEVER treated as an interchangeable subscription login.
      if (policy.mode === "auto") ids.sort((a, b) => Number(capabilities.find(c => c.id === a)?.authorizationMode === "api-key") - Number(capabilities.find(c => c.id === b)?.authorizationMode === "api-key"));
      for (const runtimeId of ids) {
        await check();
        const capability = capabilities.find(item => item.id === runtimeId);
        const apiDenied = policy.mode === "auto" && capability?.authorizationMode === "api-key" && !policy.allowApiBackups;
        if (!capability?.supported || apiDenied) {
          trace.attempts.push({ runtimeId, status: "skipped", code: apiDenied ? "api_backup_not_approved" : capability?.code ?? "not_installed",
            reason: apiDenied ? "这是 API Key 通道；没有授权自动使用其额度，已跳过。" : capability?.reason ?? "本机工具不可用。" });
          await save();
          if (policy.mode === "manual" || pin?.current) throw new RoutingError("selected_runtime_unavailable", trace, 422);
          continue;
        }
        let reasoner: UnderstandingReasoner;
        try { reasoner = pin?.current?.reasoner ?? await this.options.native.reasoner(runtimeId, lease); }
        catch (error) {
          if (pin?.current || policy.mode !== "auto" || !(error instanceof NativeToolError) || !safeCodes.has(error.code)) throw error;
          trace.attempts.push({ runtimeId, status: "skipped", code: error.code, reason: "启动前可用性复核未通过，未发送本轮内容；检查下一个已授权备选。" }); await save(); continue;
        }
        trace.runtimeId = runtimeId;
        if (pin && !pin.current) pin.current = { id: runtimeId, reasoner };
        trace.attempts.push({ runtimeId, status: "selected", code: "approved_selection", reason: policy.mode === "auto" ? "选择本账号已授权且检查通过的首个备选；没有改用未批准的 API。" : "按本人手动选择执行；不会自动改用其他底座。" });
        await save(); await check();
        // From here onwards delivery/usage may have occurred. Even malformed
        // output or timeout is not proof of non-delivery. Do not replay it.
        const text = await reasoner(prompt, combined); await check();
        trace.state = "completed";
        trace.attempts.push({ runtimeId, status: "completed", code: "completed", reason: "本轮完成；输出仍需经过各业务入口的校验与本人采纳。" });
        await save(); await check(); return { text, trace };
      }
      throw new RoutingError("no_approved_runtime", trace, 422);
    } catch (error) {
      trace.state = combined.aborted ? "cancelled" : "failed";
      if (trace.runtimeId) trace.attempts.push({ runtimeId: trace.runtimeId, status: "stopped", code: combined.aborted ? "cancelled" : error instanceof NativeToolError ? error.code : "delivery_unknown",
        reason: "本轮已停止；可能已发送或消耗额度，未自动重放、放宽权限或切换 API。" });
      // A lost identity cannot publish a result into a later owner's UI.
      await save().catch(() => undefined);
      if (this.latest?.id === trace.id) this.latest = structuredClone(trace); // cancellation metadata only, never model output
      throw new RoutingError(error instanceof NativeToolError ? error.code : combined.aborted ? "cancelled" : "delivery_unknown", trace, error instanceof NativeToolError ? error.status : 422);
    } finally { this.active.delete(controller); if (trace.state !== "completed") for (const release of fence.releases) release(); }
  }
  async invalidateSession(session: string) { this.sessions.add(session); for (const turn of this.turns.values()) if (turn.session === session) { await turn.cancel().catch(() => undefined); turn.release(); } }
  async close() { this.closed = true; for (const controller of this.active) controller.abort(); for (const entry of this.inFlight.values()) for (const release of entry.fence.releases) release(); for (const turn of this.turns.values()) { await turn.cancel().catch(() => undefined); turn.release(); } await this.changes; }
}
