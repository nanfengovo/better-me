import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  UnderstandingConfirmSchema, UnderstandingCreateSchema,
  UnderstandingSessionSchema, UnderstandingTurnSchema,
  type UnderstandingDecision,
  type UnderstandingReasoner, type UnderstandingSession, type UnderstandingTurnInput,
} from "@better-me/agent-contracts";
import { EvidenceAccessError, EvidenceBroker, type EvidenceResult } from "./evidence-broker.js";
import { ChatGptError } from "../chatgpt/errors.js";

export { UnderstandingError } from "./errors.js";
import { UnderstandingError } from "./errors.js";
import { UnderstandingProtocol, canonicalUnderstanding as canonical } from "./protocol.js";

type Stored = {
  session: UnderstandingSession;
  receipts: Record<string, { fingerprint: string }>;
  /** Earlier agent prose may contain revoked excerpts; user corrections are never dropped. */
  agentContextFloor: number;
  directories?: z.infer<typeof DirectoryCacheSchema>;
};
const DirectoryCacheSchema = z.array(z.object({
  grantId: z.string(), path: z.string(), version: z.string(), at: z.number(),
  entries: z.array(z.object({ path: z.string(), kind: z.enum(["file", "directory"]) })).max(200),
  truncated: z.boolean(),
}));
type Running = { token: string; controller: AbortController; timer: ReturnType<typeof setTimeout> };
const locks = new Map<string, Promise<void>>();
const active = new Map<string, string>();
const idPattern = /^understanding_[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

function event(session: UnderstandingSession, kind: UnderstandingSession["events"][number]["kind"], label: string): void {
  session.events.push({ sequence: (session.events.at(-1)?.sequence ?? 0) + 1, at: now(), kind, label });
}
function changed(session: UnderstandingSession): void { session.revision++; session.updatedAt = now(); }
function invalidate(session: UnderstandingSession, clearUnderstanding = false): void {
  delete session.confirmation; delete session.summaryHash; delete session.question; delete session.error;
  if (clearUnderstanding) delete session.understanding;
}
function revision(session: UnderstandingSession, expected: number): void {
  if (expected !== session.revision) throw new UnderstandingError("revision_conflict", "项目理解已更新，请刷新后再继续。", 409);
}
function invalid(message: string): UnderstandingError { return new UnderstandingError("invalid_input", message); }

/** Durable human-confirmation state. Runtime closures and credentials never enter this store. */
export class ProjectUnderstandingService {
  private readonly storageDir: string;
  private readonly broker: EvidenceBroker;
  private readonly turnTimeoutMs: number;
  private readonly maxToolCalls: number;
  private readonly protocol: UnderstandingProtocol;
  private readonly recovered?: (id: string) => Promise<unknown | undefined>;
  private readonly running = new Map<string, Running>();
  private closed = false;

  constructor(options: { storageDir: string; broker?: EvidenceBroker; turnTimeoutMs?: number; maxToolCalls?: number; recovered?: (id: string) => Promise<unknown | undefined> }) {
    this.storageDir = path.resolve(options.storageDir);
    this.recovered = options.recovered;
    this.broker = options.broker ?? new EvidenceBroker();
    // Includes broker calls plus model synthesis. Real local small-model
    // validation exceeded two minutes; the UI remains cancellable throughout.
    this.turnTimeoutMs = Math.max(10, options.turnTimeoutMs ?? 180_000);
    this.maxToolCalls = Math.max(1, Math.min(100, options.maxToolCalls ?? 12));
    this.protocol = new UnderstandingProtocol(this.maxToolCalls);
  }

  async create(input: { workspaceKey: string; projectKey: string; label: string; sourceText: string }): Promise<UnderstandingSession> {
    this.assertOpen();
    const parsed = UnderstandingCreateSchema.safeParse(input);
    if (!parsed.success) throw invalid("请提供工作区、项目标识、名称和项目原文。");
    const time = now();
    const session: UnderstandingSession = {
      version: 1, id: `understanding_${randomUUID()}`, ...parsed.data, revision: 0, phase: "idle", turnCount: 0,
      createdAt: time, updatedAt: time, grants: [], evidence: [], events: [],
      messages: [{ id: `msg_${randomUUID()}`, role: "user", text: parsed.data.sourceText, at: time }],
    };
    await this.lock(session.id, async () => this.save({ session, receipts: {}, agentContextFloor: 0 }));
    return clone(session);
  }

  async get(id: string): Promise<UnderstandingSession> {
    return this.lock(id, async () => clone((await this.load(id)).session));
  }

  async grant(id: string, explicitPath: string): Promise<UnderstandingSession> {
    this.assertOpen();
    // No source content is read here. A later consented model turn may request it.
    let grant;
    try { grant = await this.broker.grant(explicitPath); }
    catch (error) { throw this.safeError(error); }
    return this.lock(id, async () => {
      const stored = await this.load(id);
      if (stored.session.grants.some(existing => !existing.revokedAt && existing.path === grant.path)) return clone(stored.session);
      this.abortOwned(id, "context_changed");
      invalidate(stored.session);
      stored.session.grants.push(grant);
      stored.session.phase = "idle";
      changed(stored.session);
      event(stored.session, "waiting", "已授权指定源码路径；只有同意发送并开始本轮后才会读取。");
      await this.save(stored);
      return clone(stored.session);
    });
  }

  async revoke(id: string, grantId: string): Promise<UnderstandingSession> {
    this.assertOpen();
    return this.lock(id, async () => {
      const stored = await this.load(id);
      const grant = stored.session.grants.find(item => item.id === grantId);
      if (!grant) throw new UnderstandingError("grant_not_found", "未找到该源码授权。", 404);
      if (grant.revokedAt) return clone(stored.session);
      this.abortOwned(id, "context_changed");
      grant.revokedAt = now();
      stored.directories = stored.directories?.filter(item => item.grantId !== grantId);
      // Keep audit identities/hashes, but never send revoked excerpts or old derived prose again.
      for (const evidence of stored.session.evidence) if (evidence.grantId === grantId) evidence.excerpt = "";
      stored.agentContextFloor = stored.session.messages.length;
      const userMessageIds = new Set(stored.session.messages.filter(message => message.role === "user").map(message => message.id));
      for (const evidence of stored.session.evidence) if (evidence.grantId === "conversation" && !userMessageIds.has(evidence.path)) evidence.excerpt = "";
      invalidate(stored.session, true);
      stored.session.phase = "idle";
      changed(stored.session);
      event(stored.session, "waiting", "已撤销源码授权，旧的派生理解需要重新核对。");
      await this.save(stored);
      return clone(stored.session);
    });
  }

  async updateSource(id: string, input: { expectedRevision: number; sourceText: string }): Promise<UnderstandingSession> {
    this.assertOpen();
    if (!Number.isSafeInteger(input?.expectedRevision) || typeof input?.sourceText !== "string" || !input.sourceText.trim() || input.sourceText.length > 16000) throw invalid("请提供当前版本和 1–16000 字符的项目原文。");
    return this.lock(id, async () => {
      const stored = await this.load(id);
      revision(stored.session, input.expectedRevision);
      if (input.sourceText === stored.session.sourceText) return clone(stored.session);
      this.abortOwned(id, "context_changed");
      stored.session.sourceText = input.sourceText;
      stored.session.messages.push({ id: `msg_${randomUUID()}`, role: "user", text: `用户更新了项目原文：\n${input.sourceText}`, at: now() });
      stored.agentContextFloor = stored.session.messages.length;
      const userMessageIds = new Set(stored.session.messages.filter(message => message.role === "user").map(message => message.id));
      for (const evidence of stored.session.evidence) if (evidence.grantId === "conversation" && !userMessageIds.has(evidence.path)) evidence.excerpt = "";
      invalidate(stored.session, true);
      stored.session.phase = "idle";
      changed(stored.session);
      event(stored.session, "waiting", "项目原文已更新；历史对话保留，旧确认已失效。");
      await this.save(stored);
      return clone(stored.session);
    });
  }

  async turn(id: string, input: UnderstandingTurnInput, reasoner: UnderstandingReasoner, onSettled?: () => void): Promise<UnderstandingSession> {
    this.assertOpen();
    const parsed = UnderstandingTurnSchema.safeParse(input);
    if (!parsed.success) throw invalid("开始本轮需要明确同意发送、提交标识和当前版本。");
    if (typeof reasoner !== "function") throw invalid("请先选择可用的推理运行时。");
    const data = parsed.data;
    const receiptKey = hash(data.idempotencyKey);
    const fingerprint = hash(canonical(data));
    let launch: Running | undefined;
    const session = await this.lock(id, async () => {
      const stored = await this.load(id);
      const previous = stored.receipts[receiptKey];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new UnderstandingError("idempotency_conflict", "该提交标识已用于不同内容，请重新提交。", 409);
        return clone(stored.session);
      }
      revision(stored.session, data.expectedRevision);
      if (stored.session.phase === "running") throw new UnderstandingError("turn_running", "已有一轮理解正在进行，请等待或取消。", 409);
      const labels = this.protocol.optionLabels(stored.session, data.selectedOptionIds);
      if (stored.session.question && !data.answer.trim() && labels.length === 0) throw invalid("请回答当前问题，或选择其中一个选项。");
      const text = [data.answer.trim(), labels.length ? `已选择（服务端核对选项）：${labels.join("；")}` : ""].filter(Boolean).join("\n");
      if (text) stored.session.messages.push({ id: `msg_${randomUUID()}`, role: "user", text, at: now(), selectedOptionIds: data.selectedOptionIds });
      invalidate(stored.session);
      stored.session.phase = "running";
      stored.session.turnCount++;
      stored.session.checkpoint = { turn: stored.session.turnCount, status: "reading", used: 0, budget: this.maxToolCalls, evidenceIds: [], reusedDirectories: 0 };
      changed(stored.session);
      event(stored.session, "thinking", "正在结合当前项目上下文理解；没有固定访谈轮数限制。");
      stored.receipts[receiptKey] = { fingerprint };
      const controller = new AbortController();
      const token = randomUUID();
      const timer = setTimeout(() => controller.abort(new UnderstandingError("turn_timeout", "本轮推理超时，历史内容已保留，可以继续下一轮。", 408)), this.turnTimeoutMs);
      timer.unref?.();
      launch = { token, controller, timer };
      this.running.set(id, launch);
      active.set(this.filename(id), token);
      try { await this.save(stored); }
      catch (error) { this.abortOwned(id, "storage_error"); throw error; }
      return clone(stored.session);
    });
    if (launch) void this.run(id, launch, reasoner).finally(onSettled);
    else onSettled?.();
    return session;
  }

  async confirm(id: string, input: { expectedRevision: number; summaryHash: string }): Promise<UnderstandingSession> {
    this.assertOpen();
    const parsed = UnderstandingConfirmSchema.safeParse(input);
    if (!parsed.success) throw invalid("确认需要当前版本及完整结构化理解的摘要哈希。");
    return this.lock(id, async () => {
      const stored = await this.load(id);
      const session = stored.session;
      revision(session, parsed.data.expectedRevision);
      if (session.phase !== "awaiting-confirmation" || !session.understanding || session.question || !session.summaryHash || hash(canonical(session.understanding)) !== parsed.data.summaryHash || session.summaryHash !== parsed.data.summaryHash) {
        throw new UnderstandingError("confirmation_conflict", "只能确认当前版本的完整理解，请重新核对。", 409);
      }
      changed(session);
      session.confirmation = { revision: session.revision, summaryHash: session.summaryHash, confirmedAt: now() };
      session.phase = "confirmed";
      event(session, "completed", "已确认这一版本的完整项目理解；这不等于证明个人贡献。");
      await this.save(stored);
      return clone(session);
    });
  }

  async cancel(id: string, expectedTurnCount?: number): Promise<UnderstandingSession> {
    return this.lock(id, async () => {
      const stored = await this.load(id);
      if (expectedTurnCount !== undefined && expectedTurnCount !== stored.session.turnCount) {
        throw new UnderstandingError("turn_changed", "运行轮次已经变化，未停止新的任务。请刷新状态后再决定。", 409);
      }
      if (stored.session.phase !== "running") return clone(stored.session);
      this.abortOwned(id, "turn_cancelled");
      stored.session.phase = "cancelled";
      if (stored.session.checkpoint) stored.session.checkpoint.status = "partial";
      delete stored.session.error;
      changed(stored.session);
      event(stored.session, "cancelled", "已取消推理；对话和已收集证据保留。");
      await this.save(stored);
      return clone(stored.session);
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.running.keys()].map(id => this.cancel(id)));
  }
  async close(): Promise<void> { await this.dispose(); }

  private async run(id: string, running: Running, reasoner: UnderstandingReasoner): Promise<void> {
    const signal = running.controller.signal;
    const results: unknown[] = [];
    let toolCalls = 0;
    let protocolRepairs = 0;
    try {
      // This is an execution budget for one turn, never a limit on future user turns.
      for (let modelCalls = 0; modelCalls <= this.maxToolCalls; modelCalls++) {
        signal.throwIfAborted();
        const synthesisOnly = toolCalls >= this.maxToolCalls || modelCalls === this.maxToolCalls;
        if (synthesisOnly) await this.lock(id, async () => {
          const current = await this.current(id, running);
          if (!current) return;
          current.session.checkpoint!.status = "synthesizing";
          changed(current.session);
          event(current.session, "thinking", "读取阶段结束，正在整理已取得证据、贡献线索和未验证部分；不再遍历目录。");
          await this.save(current);
        });
        const stored = await this.lock(id, () => this.current(id, running));
        if (!stored) return;
        const raw = await this.abortable(reasoner(this.protocol.prompt(stored, results, synthesisOnly), signal), signal);
        if (raw.length > 128000) throw new UnderstandingError("invalid_decision", "推理结果超出本轮结构化输出大小限制，请重试。", 422);
        let decision: UnderstandingDecision;
        try {
          decision = this.protocol.decision(raw);
          if (decision.kind === "reply") this.protocol.validateReply(stored, decision);
        } catch (error) {
          // A provider may obey JSON syntax but miss semantic requirements.
          // Give it bounded, safe feedback; never adopt or persist the invalid
          // answer, and never weaken evidence/confirmation guards to accept it.
          if (!(error instanceof UnderstandingError) || ++protocolRepairs > 2 || modelCalls === this.maxToolCalls) throw error;
          results.push({ protocolError: { code: error.code, message: error.message }, action: "Correct the decision using the actual grants and evidence IDs below. A reply must include all required fields and a question unless readyForConfirmation=true. Never invent references." });
          await this.lock(id, async () => {
            const current = await this.current(id, running);
            if (!current) return;
            changed(current.session);
            event(current.session, "thinking", `正在纠正推理输出格式或证据引用（${protocolRepairs}/2）；尚未采纳理解。`);
            await this.save(current);
          });
          continue;
        }
        if (decision.kind === "reply") {
          await this.lock(id, async () => {
            const current = await this.current(id, running);
            if (!current) return;
            this.protocol.validateReply(current, decision);
            const session = current.session;
            session.understanding = decision.understanding;
            session.summaryHash = hash(canonical(decision.understanding));
            session.question = decision.question;
            session.phase = decision.readyForConfirmation ? "awaiting-confirmation" : "awaiting-answer";
            session.checkpoint!.status = "complete";
            session.messages.push({ id: `msg_${randomUUID()}`, role: "agent", text: decision.message, at: now(), question: decision.question });
            changed(session);
            event(session, "waiting", decision.readyForConfirmation ? "请核对完整结构化理解后再确认。" : "等待你回答当前项目中的具体问题。");
            await this.save(current);
          });
          return;
        }
        if (synthesisOnly) throw new UnderstandingError("turn_budget", "读取预算已结束，但 Agent 未返回有效阶段总结。已读取材料与进度已保留；旧理解未冒充本轮结果，可继续下一轮。", 422);
        for (const request of decision.requests) {
          signal.throwIfAborted();
          if (toolCalls >= this.maxToolCalls) break; // Always reserve the next model call for synthesis.
          toolCalls++;
          const snapshot = await this.lock(id, () => this.current(id, running));
          if (!snapshot) return;
          let result: EvidenceResult | { error: { code: string; message: string } };
          let directory: NonNullable<Stored["directories"]>[number] | undefined;
          let reused = false;
          try {
            if (request.grantId === "conversation") result = this.protocol.history(snapshot, request);
            else {
              const grant = snapshot.session.grants.find(item => item.id === request.grantId && !item.revokedAt);
              if (!grant) throw new EvidenceAccessError("grant_unavailable", "只能使用用户明确授权且未撤销的源码范围。");
              const version = request.operation === "list" ? await this.broker.directoryVersion(grant, request.path) : undefined;
              const cached = version && snapshot.directories?.find(item => item.grantId === grant.id && item.path === request.path && item.version === version && Date.now() - item.at < 300000);
              if (cached) { result = { evidence: [], entries: cached.entries, truncated: cached.truncated }; reused = true; }
              else {
                result = await this.broker.execute(grant, request, signal);
                if (version && result.entries && version === await this.broker.directoryVersion(grant, request.path)) directory = { grantId: grant.id, path: request.path, version, at: Date.now(), entries: result.entries, truncated: result.truncated };
              }
            }
          } catch (error) {
            signal.throwIfAborted();
            const safe = this.safeError(error);
            result = { error: { code: safe.code, message: safe.message } };
          }
          await this.lock(id, async () => {
            const current = await this.current(id, running);
            if (!current) return;
            if (directory) current.directories = [...(current.directories ?? []).filter(item => item.grantId !== directory.grantId || item.path !== directory.path), directory];
            const checkpoint = current.session.checkpoint!;
            checkpoint.used = toolCalls;
            if (reused) checkpoint.reusedDirectories++;
            if ("evidence" in result) {
              for (const item of result.evidence) {
                const existing = current.session.evidence.findIndex(value => value.id === item.id);
                if (existing === -1) current.session.evidence.push(item); else current.session.evidence[existing] = item;
                if (!checkpoint.evidenceIds.includes(item.id)) checkpoint.evidenceIds.push(item.id);
              }
            }
            changed(current.session);
            event(current.session, "reading", reused ? "目录范围未变，复用已保存清单；未再次遍历。" : `${({ list: "列出", search: "检索", read: "读取" })[request.operation]}${request.grantId === "conversation" ? "历史对话" : "授权材料"}${"error" in result ? "被拒绝或暂不可用" : "已完成"}。`);
            await this.save(current);
          });
          results.push({ request, result });
        }
      }
      throw new UnderstandingError("turn_budget", "本轮已达到推理预算，可继续下一轮。", 422);
    } catch (error) {
      try {
        await this.lock(id, async () => {
          const current = await this.current(id, running);
          if (!current) return;
          const failure = signal.aborted ? this.safeError(signal.reason) : this.safeError(error);
          current.session.phase = failure.code === "turn_cancelled" ? "cancelled" : "error";
          current.session.error = { code: failure.code, message: failure.message, recoverable: failure.recoverable };
          if (current.session.checkpoint) current.session.checkpoint.status = "partial";
          changed(current.session);
          event(current.session, current.session.phase === "cancelled" ? "cancelled" : "error", failure.message);
          await this.save(current);
        });
      } catch { /* Persistence errors must not become unhandled background rejections. GET can recover a running record. */ }
    } finally {
      clearTimeout(running.timer);
      if (this.running.get(id)?.token === running.token) this.running.delete(id);
      if (active.get(this.filename(id)) === running.token) active.delete(this.filename(id));
    }
  }

  private async current(id: string, running: Running): Promise<Stored | undefined> {
    if (this.running.get(id)?.token !== running.token || active.get(this.filename(id)) !== running.token) return undefined;
    const stored = await this.load(id);
    return stored.session.phase === "running" ? stored : undefined;
  }
  private abortOwned(id: string, code: string): void {
    const running = this.running.get(id);
    if (!running) return;
    clearTimeout(running.timer);
    running.controller.abort(new UnderstandingError(code, "上下文或服务状态已变化，本轮推理已停止。", 409));
    this.running.delete(id);
    if (active.get(this.filename(id)) === running.token) active.delete(this.filename(id));
  }
  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    });
  }
  private safeError(error: unknown): UnderstandingError {
    if (error instanceof UnderstandingError) return error;
    if (error instanceof ChatGptError) return new UnderstandingError(`chatgpt_${error.issue.code}`, error.message, error.issue.status ?? 502, !["eligibility", "permission"].includes(error.issue.kind));
    if (error instanceof EvidenceAccessError) return new UnderstandingError(error.code, error.message, 400);
    return new UnderstandingError("reasoning_failed", "推理操作失败。未保存运行时错误详情或凭据；历史内容已保留，可以重试。", 502);
  }
  private assertOpen(): void { if (this.closed) throw new UnderstandingError("service_closed", "项目理解服务正在关闭。", 503); }
  private filename(id: string): string {
    if (!idPattern.test(id)) throw new UnderstandingError("session_not_found", "未找到该项目理解会话。", 404);
    return path.join(this.storageDir, `${id}.json`);
  }
  private async lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const key = this.filename(id);
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => next);
    locks.set(key, queued);
    await previous;
    try { return await action(); }
    finally { release(); if (locks.get(key) === queued) locks.delete(key); }
  }
  private async load(id: string): Promise<Stored> {
    let text: string;
    try { text = await fs.readFile(this.filename(id), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new UnderstandingError("storage_unavailable", "无法读取本地私有项目理解存储。", 503);
      const recovered = await this.recovered?.(id);
      if (recovered === undefined) throw new UnderstandingError("session_not_found", "未找到该项目理解会话。", 404);
      text = JSON.stringify(recovered);
    }
    let stored: Stored;
    try {
      const value = JSON.parse(text) as Stored;
      const session = UnderstandingSessionSchema.parse(value.session);
      if (session.id !== id || !value.receipts || typeof value.receipts !== "object" || Array.isArray(value.receipts)) throw new Error("invalid store");
      stored = { session, receipts: value.receipts, agentContextFloor: Number.isSafeInteger(value.agentContextFloor) ? value.agentContextFloor : 0, directories: DirectoryCacheSchema.parse(value.directories ?? []) };
    } catch { throw new UnderstandingError("storage_invalid", "本地理解记录格式异常，原文件未被覆盖。", 503, false); }
    if (stored.session.phase === "running" && !active.has(this.filename(id))) {
      stored.session.phase = "error";
      if (stored.session.checkpoint) stored.session.checkpoint.status = "partial";
      stored.session.error = { code: "host_restarted", message: "主机在上一轮中停止了。历史内容完整保留，请开始新一轮继续。", recoverable: true };
      changed(stored.session);
      event(stored.session, "error", stored.session.error.message);
      await this.save(stored);
    }
    return stored;
  }
  private async save(stored: Stored): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.storageDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UnderstandingError("storage_denied", "本地私有理解存储必须使用实际目录，不能使用符号链接。", 503);
    await fs.chmod(this.storageDir, 0o700);
    const filename = this.filename(stored.session.id);
    const temporary = path.join(this.storageDir, `${stored.session.id}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(stored)); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temporary, filename); }
    catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  }
}
