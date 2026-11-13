import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { GrowthJourneyCreateSchema, GrowthJourneyCommandSchema, GrowthJourneySchema, GROWTH_PRACTICE_RUNTIME, GROWTH_PRACTICE_BUDGET, growthPracticeVerificationHash, type GrowthJourney, type GrowthJourneyCreate, type GrowthJourneyCommand, type GrowthSource, type GrowthPracticeTask } from "@better-me/agent-contracts";
import type { AgentTaskKernel, CareerTaskAccess } from "../kernel/service.js";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../identity/private-json.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textHash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const sourceText = "工具结果与已完成步骤应一起保存为检查点。界面关闭后先读取原记录；只有本人明确继续，才从已保存结果构造答案，不再调用同一步工具。没有持久回执的外部动作仍是结果未知，不能自动重试。";
const catalog: GrowthSource[] = [
  { id: "checkpoint-note-v1", version: "checkpoint.v1", title: "保存断点与只读恢复", text: sourceText, hash: textHash(sourceText), locator: "合成教材 · 第 1 节 · 保存断点", provenance: "authored_synthetic" },
  { id: "checkpoint-note-v1", version: "reconciliation.v1", title: "未知结果与对账", text: sourceText + "\n只读恢复不产生新的执行授权，学习项目也不等于生产经验。", hash: textHash(sourceText + "\n只读恢复不产生新的执行授权，学习项目也不等于生产经验。"), locator: "合成教材 · 第 2 节 · 未知结果", provenance: "authored_synthetic" },
];
type StoredJourney = Omit<GrowthJourney, "task" | "reportHash" | "attempts" | "attemptAttributions" | "pendingCommand">;
type Store = { schema: 1; ownerId: string; inputHash: string; journey: StoredJourney;
  attributions: Record<string, "guided_example" | "self_reported">;
  requests: Record<string, { hash: string; status: "done" | "pending"; command: GrowthJourneyCommand }> };
const storedSchema = GrowthJourneySchema.omit({ task: true, reportHash: true, attempts: true, attemptAttributions: true, pendingCommand: true });
export class GrowthJourneyError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = "GrowthJourneyError"; }
}
function fail(code: string, status = 409): never { throw new GrowthJourneyError(code, status); }

/** Durable goal/source records only. Execution belongs to the existing task Kernel;
 * no Career/FactBase/jobs adapter, model, filesystem grant or user path is accepted. */
export class GrowthJourneys {
  private writer?: DatabaseSync;
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly revoked = new Set<string>();
  constructor(private readonly options: { ownerId: string; directory: string; kernel: AgentTaskKernel }) {
    if (!options.ownerId || !path.isAbsolute(options.directory) || path.dirname(options.directory) === options.directory) fail("growth_invalid_store", 503);
  }
  private async access(lease: CareerTaskAccess) {
    if (this.closed) fail("growth_closed", 503);
    if (!lease || this.revoked.has(lease.session) || !await lease.valid() || this.revoked.has(lease.session)) fail("growth_access_invalid", 403);
  }
  private async storage() {
    if (this.writer) return;
    await privateDirectory(this.options.directory);
    const file = path.join(this.options.directory, "growth-writer.sqlite");
    try { const h = await fs.open(file, "wx", 0o600); await h.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== "win32" && (stat.mode & 0o077) !== 0) fail("growth_unsafe_store", 503);
    const db = new DatabaseSync(file, { allowExtension: false });
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
      db.prepare("INSERT OR IGNORE INTO owner(id,value) VALUES(1,?)").run(this.options.ownerId);
      if (db.prepare("SELECT value FROM owner WHERE id=1").get()?.value !== this.options.ownerId) fail("growth_owner_mismatch", 403);
      db.exec("COMMIT; BEGIN EXCLUSIVE");
      // Keep the exclusive writer for the module lifetime, just like the task Kernel.
      this.writer = db;
    } catch (error) { db.close(); if (error instanceof GrowthJourneyError) throw error; fail("growth_single_writer_required", 503); }
  }
  private atomic<T>(lease: CareerTaskAccess, fn: () => Promise<T>): Promise<T> {
    const run = async () => { await this.access(lease); await this.storage(); const result = await fn(); await this.access(lease); return result; };
    const result = this.writes.then(run, run); this.writes = result.catch(() => undefined); return result;
  }
  private file(id: string) {
    if (!/^gj_[a-f0-9]{32}$/.test(id)) fail("growth_not_found", 404);
    return path.join(this.options.directory, `${id}.json`);
  }
  private async load(id: string): Promise<Store> {
    const raw = await readPrivateJson(this.file(id)) as Store | undefined;
    if (!raw) fail("growth_not_found", 404);
    if (raw.schema !== 1 || raw.ownerId !== this.options.ownerId || raw.journey?.id !== id || raw.journey.ownerId !== this.options.ownerId || !raw.requests || !raw.attributions || !storedSchema.safeParse(raw.journey).success
      || Object.keys(raw.requests).length > 100 || Object.values(raw.requests).some(item => !item || !["done", "pending"].includes(item.status) || !GrowthJourneyCommandSchema.safeParse(item.command).success || hash(item.command) !== item.hash)) fail("growth_invalid_record", 503);
    return raw;
  }
  private async save(record: Store, lease: CareerTaskAccess) {
    await this.access(lease); await writePrivateJson(this.file(record.journey.id), record);
  }
  private event(record: Store, kind: GrowthJourney["events"][number]["kind"], detail: string) {
    record.journey.events.push({ sequence: record.journey.events.length + 1, kind, at: now(), detail });
  }
  private async view(record: Store, lease: CareerTaskAccess): Promise<GrowthJourney> {
    const attempts: GrowthPracticeTask[] = [];
    const pending = Object.values(record.requests).find(item => item.status === "pending");
    for (const taskId of record.journey.taskIds) {
      try {
        const task = await this.options.kernel.readTask(taskId);
        if (task.kind !== "growth_practice" || task.ownerId !== this.options.ownerId || task.workspaceKey !== record.journey.id || task.rootScopeKey !== `growth:${record.journey.id}`
          || task.request.sourceHash !== record.journey.source?.hash || task.request.sourceText !== record.journey.source?.text) fail("growth_task_binding_changed", 503);
        attempts.push(task);
      } catch (error) {
        if (!(pending?.command.kind === "submit_practice" && taskId === record.journey.taskIds.at(-1) && (error as { code?: string }).code === "task_not_found")) throw error;
      }
    }
    await this.access(lease);
    const task = attempts.at(-1);
    const project = record.journey.project;
    if (project && (!task || project.taskId !== task.id || task.practice.phase !== "verified"
      || project.sourceCodeHash !== textHash(task.request.sourceCode) || project.reportHash !== task.practice.verificationHash
      || project.attribution !== record.attributions[task.id]
      || project.id !== `project_${hash([record.journey.id, task.id, project.reportHash]).slice(0, 32)}`)) fail("growth_project_binding_changed", 503);
    const stage: GrowthJourney["stage"] = record.journey.project ? "completed"
      : pending?.command.kind === "submit_practice" && !task ? "outcome_unknown"
      : task?.practice.phase === "lookup_saved" ? "checkpoint_saved"
      : task?.practice.phase === "verified" ? "ready_for_acceptance"
      : task?.practice.phase === "failed" ? "verification_failed"
      : task?.practice.phase === "outcome_unknown" ? "outcome_unknown"
      : record.journey.source ? "practice" : "choose_source";
    return GrowthJourneySchema.parse({ ...structuredClone(record.journey), stage,
      ...(attempts.length ? { attempts, task, attemptAttributions: Object.fromEntries(attempts.map(attempt => [attempt.id, record.attributions[attempt.id]])) } : {}),
      ...(task?.practice.verificationHash ? { reportHash: task.practice.verificationHash } : {}),
      ...(pending ? { pendingCommand: pending.command } : {}),
    });
  }
  async sources(lease: CareerTaskAccess) { await this.access(lease); return structuredClone(catalog); }
  create(raw: GrowthJourneyCreate, lease: CareerTaskAccess): Promise<GrowthJourney> {
    const input = GrowthJourneyCreateSchema.parse(raw);
    return this.atomic(lease, async () => {
      const id = `gj_${hash([this.options.ownerId, input.idempotencyKey]).slice(0, 32)}`, inputHash = hash(input);
      const previous = await readPrivateJson(this.file(id));
      if (previous) { const record = await this.load(id); if (record.inputHash !== inputHash) fail("growth_idempotency_conflict"); return this.view(record, lease); }
      if ((await fs.readdir(this.options.directory)).filter(name => /^gj_[a-f0-9]{32}\.json$/.test(name)).length >= 64) fail("growth_capacity", 413);
      const at = now();
      const record: Store = { schema: 1, ownerId: this.options.ownerId, inputHash, requests: {}, attributions: {}, journey: {
        id, ownerId: this.options.ownerId, revision: 1, mode: "synthetic", createdAt: at, updatedAt: at,
        goal: { ...input.goal, id: `goal_${id.slice(3)}`, revision: 1, successCriteria: "完成只读工具练习、保存断点、恢复后通过固定验收；本人确认保留为合成实践项目。能力仍待独立复测。" },
        stage: "choose_source", taskIds: [], events: [],
      } };
      this.event(record, "goal_created", "本人设立合成目标；尚未选资料、执行练习或更改职业记录。");
      await this.save(record, lease); return structuredClone(record.journey);
    });
  }
  get(id: string, lease: CareerTaskAccess): Promise<GrowthJourney> { return this.atomic(lease, async () => this.view(await this.load(id), lease)); }
  list(lease: CareerTaskAccess) { return this.atomic(lease, async () => {
    const records: GrowthJourney[] = [];
    for (const name of await fs.readdir(this.options.directory)) if (/^gj_[a-f0-9]{32}\.json$/.test(name)) records.push(await this.view(await this.load(name.slice(0, -5)), lease));
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, ownerId, revision, goal, stage, updatedAt }) => ({ id, ownerId, revision, goal, stage, updatedAt }));
  }); }
  command(id: string, raw: GrowthJourneyCommand, lease: CareerTaskAccess): Promise<GrowthJourney> {
    const command = GrowthJourneyCommandSchema.parse(raw);
    return this.atomic(lease, async () => {
      const record = await this.load(id), fingerprint = hash(command), previous = Object.hasOwn(record.requests, command.requestId) ? record.requests[command.requestId] : undefined;
      if (previous?.hash !== undefined && previous.hash !== fingerprint) fail("growth_idempotency_conflict");
      if (previous?.status === "done") return this.view(record, lease);
      if (!previous && Object.values(record.requests).some(item => item.status === "pending")) fail("growth_pending_command");
      if (!previous && command.expectedRevision !== record.journey.revision) fail("growth_revision_conflict");
      if (!previous && Object.keys(record.requests).length >= 90) fail("growth_command_capacity", 413);
      if (command.kind === "select_source") {
        if (record.journey.taskIds.length || record.journey.project) fail("growth_source_frozen");
        const source = catalog.find(item => item.version === command.sourceVersion);
        if (!source) fail("growth_source_not_found", 404);
        record.journey.source = structuredClone(source); record.journey.stage = "practice";
        this.event(record, "source_selected", "选择合成教材版本；引用与原文保留，未执行工具。");
      } else if (command.kind === "submit_practice") {
        if (!record.journey.source) fail("growth_source_required", 422);
        if (record.journey.project) fail("growth_project_already_accepted");
        if (!previous) {
          const current = await this.view(record, lease);
          if (current.task?.status === "budget_exhausted") fail("growth_budget_exhausted");
          if (current.task && current.task.practice.phase !== "failed") fail("growth_finish_current_attempt");
          if (record.journey.taskIds.length >= 8) fail("growth_attempt_capacity", 413);
          const key = `growth-${hash([id, command.requestId])}`;
          record.journey.taskIds.push(`ct_${hash([this.options.ownerId, key]).slice(0, 32)}`);
          record.attributions[record.journey.taskIds.at(-1)!] = command.attribution;
          record.requests[command.requestId] = { hash: fingerprint, status: "pending", command };
          record.journey.revision++; record.journey.updatedAt = now(); await this.save(record, lease);
        }
        const source = record.journey.source;
        const task = await this.options.kernel.createTask({ kind: "growth_practice", workspaceKey: id, rootScopeKey: `growth:${id}`,
          objective: "合成练习：只读工具执行、持久化检查点与明确恢复", runtimeBinding: GROWTH_PRACTICE_RUNTIME, budget: GROWTH_PRACTICE_BUDGET,
          request: { sourceId: source.id, sourceText: source.text, sourceHash: source.hash, sourceCode: command.sourceCode, answer: command.answer, explanation: command.explanation },
          consent: true, idempotencyKey: `growth-${hash([id, command.requestId])}`,
        }, lease);
        if (task.id !== record.journey.taskIds.at(-1)) fail("growth_task_binding_changed", 503);
        this.event(record, "practice_submitted", "原代码、原答与说明已冻结在同一任务内核；尚未运行工具。");
      } else if (command.kind === "step_practice") {
        if (record.journey.project) fail("growth_project_already_accepted");
        const current = await this.view(record, lease), task = current.task;
        if (!task || task.id !== command.taskId) fail("growth_task_not_current", 404);
        if (!previous) {
          if (task.revision !== command.expectedTaskRevision) fail("growth_task_revision_conflict");
          if (!["ready", "lookup_saved"].includes(task.practice.phase)) fail("growth_task_not_runnable");
          record.requests[command.requestId] = { hash: fingerprint, status: "pending", command };
          record.journey.revision++; record.journey.updatedAt = now(); await this.save(record, lease);
        }
        // A lost response can be reconciled against the original task revision.
        // Never repeat a dispatch whose checkpoint/result is already committed.
        if (task.revision === command.expectedTaskRevision) await this.options.kernel.stepGrowthPractice(task.id, {
          expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, consent: true,
        }, lease);
        else if (task.revision < command.expectedTaskRevision) fail("growth_task_revision_conflict");
        this.event(record, "practice_advanced", "按明确操作推进或核对原任务；已保存的工具步骤没有重新派送。");
      } else if (command.kind === "accept_project") {
        if (record.journey.project) fail("growth_project_already_accepted");
        const task = (await this.view(record, lease)).task, verification = task?.practice.verification;
        if (!task || task.id !== command.taskId || task.status !== "completed" || task.practice.phase !== "verified" || !verification
          || verification.passed !== 4 || verification.total !== 4 || !verification.checks.every(check => check.passed)
          || command.reportHash !== task.practice.verificationHash || growthPracticeVerificationHash(verification) !== command.reportHash
          || verification.sourceCodeHash !== textHash(task.request.sourceCode) || verification.sourceHash !== record.journey.source?.hash) fail("growth_verified_project_required", 422);
        const attribution = record.attributions[task.id];
        if (!attribution) fail("growth_attribution_missing", 503);
        record.journey.project = { id: `project_${hash([id, task.id, command.reportHash]).slice(0, 32)}`, revision: 1, taskId: task.id,
          sourceCodeHash: verification.sourceCodeHash, reportHash: command.reportHash, acceptedAt: now(), attribution,
          scope: "synthetic_practice", mastery: "pending_retest" };
        record.journey.stage = "completed";
        this.event(record, "project_accepted", "本人验收并保留此版本合成实践；原答与说明待独立复测，没有写入履历或工作资历。");
      }
      record.journey.revision++; record.journey.updatedAt = now();
      record.requests[command.requestId] = { hash: fingerprint, status: "done", command };
      await this.save(record, lease); return this.view(record, lease);
    });
  }
  invalidateSession(session: string) { this.revoked.add(session); }
  async close() { this.closed = true; await this.writes; this.writer?.close(); this.writer = undefined; }
}
