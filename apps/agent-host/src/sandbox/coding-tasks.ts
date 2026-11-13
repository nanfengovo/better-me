import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { privateDirectory } from "../identity/private-json.js";
import type { CodingCase, CodingCheck, CodingGenerator } from "./coding-engine.js";

export class CodingTaskError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = "CodingTaskError"; }
}
export type CodingTaskLease = (() => boolean | Promise<boolean>) & { signal?: AbortSignal };
export type CreateCodingTask = { goal: string; model: string; cases: CodingCase[]; consent: true;
  maxAttempts?: number; maxActiveMs?: number; idempotencyKey?: string };
export type CodingProgress = { number: number; targetCaseId: string; outcome: "accepted" | "regression" | "failed" | "interrupted";
  passedIds: string[]; failedIds: string[]; sourceHash?: string; error?: string; activeMs: number };
export type CodingTask = {
  id: string; revision: number; goal: string; model: string; modelDigest: string; cases: CodingCase[];
  maxAttempts: number; maxActiveMs: number; attemptsUsed: number; activeMs: number;
  status: "ready" | "running" | "paused" | "interrupted" | "budget_exhausted" | "review_ready";
  best?: { source: string; sourceHash: string; checks: CodingCheck[] };
  lastAttempt?: { number: number; targetCaseId: string; outcome: "running" | "accepted" | "regression" | "failed" | "interrupted";
    checks: CodingCheck[]; sourceHash?: string; error?: string };
  history: CodingProgress[]; createdAt: string; updatedAt: string;
};
type TaskStore = { task: CodingTask; reservation?: { started: number; ms: number; preflight?: true }; repairSource?: string };
type Options = { ownerId: string; directory: string; generate?: CodingGenerator;
  resolveModel?: (model: string, signal: AbortSignal) => Promise<string>;
  verify?: (source: string, cases: CodingCase[], signal: AbortSignal) => Promise<CodingCheck[]> };
const fail = (code: string, status = 409): never => { throw new CodingTaskError(code, status); };
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const iso = () => new Date().toISOString();
const maxSource = 32 * 1024, maxCases = 12, maxTasks = 64, maxStored = 512 * 1024;
const idPattern = /^code_[a-f0-9]{32}$/;
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/);
const manifest = z.object({ goal: z.string().trim().min(1).max(4000),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/).refine(v => !v.includes("//") && !v.includes("..") && !/(?:^|[-.:/_])cloud(?:$|[-.:/_])/i.test(v)),
  cases: z.array(z.object({ id: key, input: z.unknown(), expected: z.unknown() }).strict()).min(1).max(maxCases),
  maxAttempts: z.number().int().min(1).max(8).default(3),
  maxActiveMs: z.number().int().min(1).max(300_000).default(180_000),
  consent: z.literal(true), idempotencyKey: key.optional() }).strict();

/** Both the admitted bytes and nesting are bounded. Do not let non-JSON values silently
 * become different acceptance cases (NaN -> null, undefined property -> missing). */
function canonical(value: unknown, depth = 0, counter = { n: 0, bytes: 0 }): string {
  if (depth > 20 || ++counter.n > 8192) return fail("coding_cases_too_complex", 413);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (typeof value === "string") {
    if ((counter.bytes += Buffer.byteLength(value)) > maxSource) return fail("coding_case_too_large", 413);
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === null) return fail("coding_invalid_case", 400);
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== null && proto !== Object.prototype) return fail("coding_invalid_case", 400);
  const properties = Reflect.ownKeys(value);
  if (properties.length > 8192) return fail("coding_cases_too_complex", 413);
  if (properties.some(k => typeof k !== "string")) return fail("coding_invalid_case", 400);
  function element(k: string) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d || !d.enumerable || !Object.hasOwn(d, "value")) return fail("coding_invalid_case", 400);
    return canonical(d.value, depth + 1, counter);
  }
  if (array) {
    if (properties.length !== value.length + 1) return fail("coding_invalid_case", 400);
    return "[" + Array.from({ length: value.length }, (_, i) => element(String(i))).join(",") + "]";
  }
  return "{" + (properties as string[]).sort().map(k => {
    if (k.length > 256 || (counter.bytes += Buffer.byteLength(k)) > maxSource) return fail("coding_case_too_large", 413);
    return JSON.stringify(k) + ":" + element(k);
  }).join(",") + "}";
}
function admit(raw: CreateCodingTask) {
  const parsed = manifest.safeParse(raw);
  if (!parsed.success) return fail("coding_invalid_manifest", 400);
  const input = parsed.data;
  if (new Set(input.cases.map(c => c.id)).size !== input.cases.length) return fail("coding_duplicate_case", 400);
  const cases = input.cases.map(c => {
    if (!Object.hasOwn(c, "input") || !Object.hasOwn(c, "expected")) return fail("coding_invalid_case", 400);
    const actual = canonical(c.input), expected = canonical(c.expected);
    if (Math.max(Buffer.byteLength(actual), Buffer.byteLength(expected)) > maxSource) return fail("coding_case_too_large", 413);
    return { id: c.id, input: JSON.parse(actual) as unknown, expected: JSON.parse(expected) as unknown };
  });
  if (Buffer.byteLength(JSON.stringify(cases)) > 64 * 1024) return fail("coding_cases_too_large", 413);
  return { ...input, cases };
}
function aborted<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}
function combined(...signals: (AbortSignal | undefined)[]) { return AbortSignal.any(signals.filter(s => s !== undefined)); }
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("coding_invalid_revision", 400);
}
const taskCopy = (s: TaskStore) => structuredClone(s.task);
const limited = (t: CodingTask) => t.attemptsUsed >= t.maxAttempts || t.activeMs >= t.maxActiveMs;
const externalCodes = new Set(["coding_model_not_local", "coding_model_metadata_invalid", "coding_local_transport_unavailable",
  "coding_local_response_limit", "coding_invalid_model_output", "coding_request_limit"]);
function safeEngineCode(err: unknown, fallback: string) {
  if (!(err instanceof Error)) return fallback;
  if (err.message === "coding_model_changed") return "coding_model_digest_changed";
  return externalCodes.has(err.message) ? err.message : fallback;
}
const bindingProblem = (code?: string) => ["coding_model_digest_changed", "coding_model_not_local", "coding_model_metadata_invalid",
  "coding_model_unavailable", "coding_local_transport_unavailable"].includes(code ?? "");
const immutableHash = ({ goal, model, cases, maxActiveMs, maxAttempts }: Pick<CodingTask, "goal" | "model" | "cases" | "maxActiveMs" | "maxAttempts">) =>
  hash(JSON.stringify({ goal, model, cases, maxActiveMs, maxAttempts }));
function checkRunnable(t: CodingTask, expected: number) {
  if (expected !== t.revision) fail("coding_revision_conflict");
  if (t.status === "running" || t.status === "review_ready") fail("coding_not_runnable");
  if (limited(t) || t.status === "budget_exhausted") fail("coding_budget_exhausted");
}
function checkedResults(raw: CodingCheck[], cases: CodingCase[]): CodingCheck[] {
  if (!Array.isArray(raw) || raw.length !== cases.length) return fail("coding_incomplete_verification", 502);
  const byId = new Map(raw.map(c => [c?.id, c]));
  return cases.map(({ id }) => {
    const check = byId.get(id);
    if (!check || typeof check.passed !== "boolean") return fail("coding_incomplete_verification", 502);
    // Never send arbitrary guest exceptions, dumps or stack traces back to the model.
    const error = !check.passed && typeof check.error === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(check.error) ? check.error : undefined;
    return { id, passed: check.passed, ...(error ? { error } : {}) };
  });
}

/** An owner-private, manually advanced task. No workspace, command shell, package
 * installer, publisher or arbitrary network endpoint is a dependency of this service. */
export class CodingTaskService {
  private db?: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly life = new AbortController();
  private readonly active = new Map<string, AbortController>();
  private closing?: Promise<void>;
  constructor(private readonly options: Options) {
    if (!options.ownerId || options.ownerId.length > 240 || !path.isAbsolute(options.directory)
        || path.resolve(options.directory) === path.parse(options.directory).root) fail("coding_invalid_store", 503);
  }
  private async granted(lease: CodingTaskLease, extra?: AbortSignal) {
    if (this.life.signal.aborted) return fail("coding_service_closed", 503);
    if (typeof lease !== "function" || lease.signal?.aborted) return fail("coding_lease_invalid", 403);
    let valid = false;
    const signal = combined(this.life.signal, lease.signal, extra, AbortSignal.timeout(5_000));
    try { valid = await aborted(signal, async () => lease()); } catch { /* absence of authority is not consent */ }
    if (this.life.signal.aborted) return fail("coding_service_closed", 503);
    if (extra?.aborted && !lease.signal?.aborted) return fail("coding_step_interrupted");
    if (!valid || signal.aborted) return fail("coding_lease_invalid", 403);
  }
  private async storage() {
    if (this.db) return this.db;
    const file = path.join(this.options.directory, "coding-tasks.sqlite");
    let db: DatabaseSync | undefined;
    try {
      await privateDirectory(this.options.directory);
      try { const h = await fs.open(file, "wx", 0o600); await h.close(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        let stat;
        try { stat = await fs.lstat(file + suffix); }
        catch (e) { if (suffix && (e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== "win32" && (stat.mode & 0o077) !== 0) fail("coding_unsafe_store", 503);
      }
      db = new DatabaseSync(file, { allowExtension: false });
      db.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, inputHash TEXT NOT NULL, payload TEXT NOT NULL);");
      db.prepare("INSERT OR IGNORE INTO owner(id,value) VALUES(1,?)").run(this.options.ownerId);
      if (db.prepare("SELECT value FROM owner WHERE id=1").get()?.value !== this.options.ownerId) fail("coding_owner_mismatch", 403);
      db.exec("COMMIT");
      this.db = db; return db;
    } catch (err) {
      try { db?.close(); } catch { /* original error is authoritative */ }
      if (err instanceof CodingTaskError) throw err;
      if ((err as { errcode?: number }).errcode === 5) fail("coding_single_writer_required", 503);
      return fail("coding_store_unavailable", 503);
    }
  }
  private atomic<T>(fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    const run = async () => {
      if (this.life.signal.aborted) return fail("coding_service_closed", 503);
      try { return await fn(await this.storage()); }
      catch (err) { if (err instanceof CodingTaskError) throw err; return fail("coding_store_unavailable", 503); }
    };
    const done = this.queue.then(run, run); this.queue = done.catch(() => undefined); return done;
  }
  private load(db: DatabaseSync, id: string): TaskStore {
    if (!idPattern.test(id)) return fail("coding_task_not_found", 404);
    const row = db.prepare("SELECT revision,payload,inputHash FROM tasks WHERE id=?").get(id);
    if (!row) return fail("coding_task_not_found", 404);
    if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > maxStored) return fail("coding_invalid_store", 503);
    const s = JSON.parse(row.payload) as TaskStore;
    const t = s.task;
    if (t?.id !== id || t.revision !== row.revision || !Array.isArray(t.cases) || immutableHash(t) !== row.inputHash
      || !/^[a-f0-9]{64}$/.test(t.modelDigest) || !Number.isInteger(t.attemptsUsed) || t.attemptsUsed < 0 || t.attemptsUsed > t.maxAttempts
      || !Number.isSafeInteger(t.activeMs) || t.activeMs < 0 || t.activeMs > t.maxActiveMs || !Array.isArray(t.history)
      || t.history.length !== t.attemptsUsed - (t.status === "running" ? 1 : 0) || t.history.some((a, i) => a.number !== i + 1)
      || (t.status === "running") !== Boolean(s.reservation && !s.reservation.preflight)
      || s.reservation && (!Number.isSafeInteger(s.reservation.started) || !Number.isSafeInteger(s.reservation.ms) || s.reservation.ms < 1
        || s.reservation.ms > t.maxActiveMs - t.activeMs || (s.reservation.preflight !== undefined && s.reservation.preflight !== true))
      || t.best && (hash(t.best.source) !== t.best.sourceHash
        || t.best.checks.length !== t.cases.length || t.best.checks.some((c, i) => c.id !== t.cases[i]?.id || typeof c.passed !== "boolean"))
      || t.status === "review_ready" && !t.best?.checks.every(c => c.passed)) return fail("coding_invalid_store", 503);
    if (s.reservation && !this.active.has(id)) {
      this.interrupt(s, "interrupted", "coding_host_restarted"); this.save(db, s);
    }
    return s;
  }
  private save(db: DatabaseSync, s: TaskStore, privateOnly = false) {
    const r = s.task.revision;
    if (!privateOnly) { s.task.revision++; s.task.updatedAt = iso(); }
    const payload = JSON.stringify(s); if (Buffer.byteLength(payload) > maxStored) fail("coding_task_capacity", 413);
    if (db.prepare("UPDATE tasks SET revision=?,payload=? WHERE id=? AND revision=?").run(s.task.revision, payload, s.task.id, r).changes !== 1)
      fail("coding_revision_conflict");
  }
  private async pin(model: string, lease: CodingTaskLease, extra?: AbortSignal) {
    await this.granted(lease, extra);
    const signal = combined(lease.signal, this.life.signal, extra, AbortSignal.timeout(10_000));
    try {
      const resolve = this.options.resolveModel ?? (async (m, sig) => (await import("./coding-engine.js")).resolveLocalCodingModel(m, sig));
      const digest = await aborted(signal, () => resolve(model, signal)); await this.granted(lease, extra);
      if (!/^[a-f0-9]{64}$/.test(digest)) return fail("coding_model_unavailable", 503);
      return digest;
    } catch (err) {
      if (this.life.signal.aborted) return fail("coding_service_closed", 503);
      if (lease.signal?.aborted) return fail("coding_lease_invalid", 403);
      if (extra?.aborted) return fail("coding_step_interrupted");
      await this.granted(lease, extra);
      if (err instanceof CodingTaskError) throw err;
      const code = safeEngineCode(err, "coding_model_unavailable");
      return fail(code, code === "coding_model_not_local" ? 422 : 503);
    }
  }
  async create(raw: CreateCodingTask, lease: CodingTaskLease): Promise<CodingTask> {
    await this.granted(lease);
    const { idempotencyKey, goal, model, cases, maxActiveMs, maxAttempts } = admit(raw);
    const fingerprint = immutableHash({ goal, model, cases, maxActiveMs, maxAttempts });
    const id = "code_" + (idempotencyKey ? hash(JSON.stringify([this.options.ownerId, idempotencyKey])).slice(0, 32) : randomUUID().replaceAll("-", ""));
    const existing = (db: DatabaseSync) => {
      const row = db.prepare("SELECT inputHash FROM tasks WHERE id=?").get(id);
      if (!row) return undefined;
      if (row.inputHash !== fingerprint) return fail("coding_idempotency_conflict");
      return taskCopy(this.load(db, id));
    };
    const found = await this.atomic(async db => { await this.granted(lease); return existing(db); }); if (found) return found;
    const modelDigest = await this.pin(model, lease);
    return this.atomic(async db => {
      await this.granted(lease);
      const prior = existing(db); if (prior) return prior;
      if (Number(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n) >= maxTasks) return fail("coding_store_capacity", 429);
      const now = iso(), s: TaskStore = { task: { id, revision: 1, goal, model, modelDigest, cases, maxAttempts, maxActiveMs,
        attemptsUsed: 0, activeMs: 0, status: "ready", history: [], createdAt: now, updatedAt: now } };
      db.prepare("INSERT INTO tasks(id,revision,inputHash,payload) VALUES(?,?,?,?)").run(id, 1, fingerprint, JSON.stringify(s));
      return taskCopy(s);
    });
  }
  async get(id: string, lease: CodingTaskLease): Promise<CodingTask> {
    await this.granted(lease); return this.atomic(async db => { await this.granted(lease); return taskCopy(this.load(db, id)); });
  }
  async list(lease: CodingTaskLease): Promise<CodingTask[]> {
    await this.granted(lease); return this.atomic(async db => {
      await this.granted(lease);
      return db.prepare("SELECT id FROM tasks ORDER BY rowid DESC LIMIT ?").all(maxTasks).map(r => taskCopy(this.load(db, String(r.id))));
    });
  }
  async step(id: string, expectedRevision: number, lease: CodingTaskLease): Promise<CodingTask> {
    await this.granted(lease); revision(expectedRevision);
    const controller = new AbortController();
    const run = await this.atomic(async db => {
      await this.granted(lease);
      if (this.life.signal.aborted) return fail("coding_service_closed", 503);
      const s = this.load(db, id), t = s.task; checkRunnable(t, expectedRevision);
      if (this.active.size) return fail("coding_owner_busy");
      const bestPassed = new Set(t.best?.checks.filter(c => c.passed).map(c => c.id));
      const previousSource = s.repairSource ?? t.best?.source;
      const previousChecks = s.repairSource
        ? s.task.lastAttempt?.checks.length ? s.task.lastAttempt.checks
          : t.cases.map(c => ({ id: c.id, passed: false, error: "candidate_not_verified" }))
        : t.best?.checks ?? [];
      const regressed = s.task.lastAttempt?.outcome === "regression" && previousChecks.find(c => !c.passed && bestPassed.has(c.id));
      const target = regressed ? regressed.id : t.cases.find(c => !bestPassed.has(c.id))?.id;
      if (!target) return fail("coding_not_runnable");
      const request: Parameters<CodingGenerator>[0] = { goal: t.goal, cases: structuredClone(t.cases), targetCaseId: target,
        ...(previousSource !== undefined ? { previousSource } : {}), previousChecks: structuredClone(previousChecks),
        model: t.model, modelDigest: t.modelDigest };
      const ms = Math.min(120_000, t.maxActiveMs - t.activeMs);
      const started = Date.now();
      // Durable before the first model metadata request. A lost Host can recover
      // up to the pin's own 10s cap, but has no evidence of a generation attempt.
      s.reservation = { started, ms: Math.min(10_000, ms), preflight: true };
      this.save(db, s, true); this.active.set(id, controller);
      return { number: t.attemptsUsed + 1, ms, started, request, cases: structuredClone(t.cases) };
    });
    const clock = new AbortController(), timer = setTimeout(() => clock.abort(), Math.max(0, run.started + run.ms - Date.now())), deadline = clock.signal;
    const signal = combined(this.life.signal, controller.signal, lease.signal, deadline);
    try {
      if (Date.now() - run.started >= run.ms) fail("coding_step_timeout");
      if (await aborted(signal, () => this.pin(run.request.model, lease, signal)) !== run.request.modelDigest)
        fail("coding_model_digest_changed");
      await this.atomic(async db => {
        await this.granted(lease, signal);
        if (this.active.get(id) !== controller) return fail("coding_step_superseded");
        const s = this.load(db, id);
        if (s.task.revision !== expectedRevision || !s.reservation?.preflight) return fail("coding_step_superseded");
        if (deadline.aborted || Date.now() - run.started >= s.reservation.ms) return fail("coding_step_timeout");
        // Promote the SAME clock; never add preflight time a second time.
        delete s.reservation.preflight; s.reservation.ms = run.ms;
        s.task.attemptsUsed = run.number; s.task.status = "running";
        s.task.lastAttempt = { number: run.number, targetCaseId: run.request.targetCaseId, outcome: "running", checks: [] };
        delete s.repairSource;
        this.save(db, s); // generation intent is durable before calling the provider
      });
    } catch (error) {
      clearTimeout(timer);
      return this.atomic(db => {
        const denied = lease.signal?.aborted || error instanceof CodingTaskError && error.code === "coding_lease_invalid";
        if (this.active.get(id) !== controller) return fail(denied ? "coding_lease_invalid" : "coding_step_superseded", denied ? 403 : 409);
        try {
          const s = this.load(db, id);
          if (!s.reservation?.preflight || s.task.revision !== expectedRevision) return fail("coding_step_superseded");
          const spent = deadline.aborted || Date.now() - run.started >= s.reservation.ms;
          const code = error instanceof CodingTaskError ? error.code : "coding_model_unavailable";
          this.interrupt(s, "paused", code, spent); this.save(db, s);
          if (denied) return fail("coding_lease_invalid", 403);
          if (limited(s.task)) return fail("coding_budget_exhausted");
          if (error instanceof CodingTaskError) throw error;
          return fail(code, 503);
        } finally { this.active.delete(id); }
      });
    }
    let source: string | undefined, checks: CodingCheck[] | undefined, issue: string | undefined, verifying = false;
    const generate = this.options.generate ?? (async (data, sig) => (await import("./coding-engine.js")).generateLocalCodingCandidate(data, sig));
    const verify = this.options.verify ?? (async (code, cases, sig) => (await import("./coding-engine.js")).verifyCodingCandidate(code, cases, sig));
    try {
      const candidate = await aborted(signal, () => generate(run.request, signal)); await this.granted(lease, signal);
      if (typeof candidate !== "string" || !candidate.trim() || Buffer.byteLength(candidate) > maxSource) fail("coding_invalid_candidate", 422);
      if (await this.pin(run.request.model, lease, signal) !== run.request.modelDigest) fail("coding_model_digest_changed");
      source = candidate;
      verifying = true;
      const report = await aborted(signal, () => verify(candidate, structuredClone(run.cases), signal));
      checks = checkedResults(report, run.cases);
    } catch (err) { issue = err instanceof CodingTaskError ? err.code : safeEngineCode(err, verifying ? "coding_verification_failed" : "coding_generation_failed"); }
    finally { clearTimeout(timer); }
    return this.atomic(async db => {
      let allowed = true;
      try { await this.granted(lease); } catch { allowed = false; }
      if (this.life.signal.aborted) return fail("coding_service_closed", 503);
      if (this.active.get(id) !== controller) return fail(allowed ? "coding_step_superseded" : "coding_lease_invalid", allowed ? 409 : 403);
      const s = this.load(db, id), t = s.task, attempt = t.lastAttempt;
      if (t.status !== "running" || attempt?.number !== run.number || !s.reservation) return fail("coding_step_superseded");
      try {
        const timeout = deadline.aborted || Date.now() - s.reservation.started >= s.reservation.ms;
        const denied = !allowed || lease.signal?.aborted || issue === "coding_lease_invalid";
        if (denied || controller.signal.aborted || timeout || bindingProblem(issue)) {
          const code = denied ? "coding_lease_invalid" : timeout ? "coding_step_timeout" : issue ?? "coding_step_interrupted";
          this.interrupt(s, "paused", code, timeout);
          this.save(db, s);
          if (denied) return fail("coding_lease_invalid", 403);
          return taskCopy(s);
        }
        const elapsed = this.charge(s);
        if (checks && source !== undefined && !issue) {
          const sourceHash = hash(source);
          const passed = new Set(checks.filter(c => c.passed).map(c => c.id));
          const regression = t.best?.checks.some(c => c.passed && !passed.has(c.id)) ?? false;
          Object.assign(attempt, { outcome: regression ? "regression" : "accepted", checks, sourceHash });
          if (regression) s.repairSource = source;
          else t.best = { source, sourceHash, checks };
        } else {
          Object.assign(attempt, { outcome: "failed", error: issue ?? "coding_verification_failed" });
          if (source !== undefined) { s.repairSource = source; attempt.sourceHash = hash(source); }
        }
        t.status = t.best?.checks.every(c => c.passed) ? "review_ready" : limited(t) ? "budget_exhausted" : "ready";
        this.log(s, elapsed);
        this.save(db, s); return taskCopy(s);
      } finally { this.active.delete(id); }
    });
  }
  async pause(id: string, expectedRevision: number, lease: CodingTaskLease): Promise<CodingTask> {
    await this.granted(lease); revision(expectedRevision);
    return this.atomic(async db => {
      await this.granted(lease); const s = this.load(db, id), t = s.task;
      if (t.revision !== expectedRevision) return fail("coding_revision_conflict");
      if (t.status === "paused" && !s.reservation) return taskCopy(s);
      if (["budget_exhausted", "review_ready"].includes(t.status)) return fail("coding_not_runnable");
      const controller = this.active.get(id);
      this.interrupt(s, "paused", "coding_manually_paused");
      this.save(db, s); this.active.delete(id); controller?.abort();
      return taskCopy(s);
    });
  }
  private charge(s: TaskStore, full = false) {
    if (!s.reservation) return 0;
    const elapsed = full ? s.reservation.ms : Math.min(s.reservation.ms, Math.max(0, Date.now() - s.reservation.started));
    s.task.activeMs += elapsed; delete s.reservation; return elapsed;
  }
  private log(s: TaskStore, activeMs: number) {
    const a = s.task.lastAttempt;
    if (!a || a.outcome === "running") return;
    if (s.task.history.length >= 8 || (s.task.history.at(-1)?.number ?? 0) >= a.number) return fail("coding_invalid_progress", 503);
    s.task.history.push({ number: a.number, targetCaseId: a.targetCaseId, outcome: a.outcome, activeMs,
      passedIds: a.checks.filter(c => c.passed).map(c => c.id), failedIds: a.checks.filter(c => !c.passed).map(c => c.id),
      ...(a.error ? { error: a.error } : {}), ...(a.sourceHash ? { sourceHash: a.sourceHash } : {}) });
  }
  private interrupt(s: TaskStore, status: "paused" | "interrupted", error: string, full = false) {
    const elapsed = this.charge(s, full);
    s.task.status = limited(s.task) ? "budget_exhausted" : status;
    if (s.task.lastAttempt?.outcome === "running") {
      Object.assign(s.task.lastAttempt, { outcome: "interrupted", error }); this.log(s, elapsed);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.life.abort();
    this.closing = this.queue.then(() => {
      const db = this.db;
      try {
        if (db) for (const id of this.active.keys()) {
          const s = this.load(db, id);
          if (s.reservation) { this.interrupt(s, "interrupted", "coding_host_stopped"); this.save(db, s); }
        }
      } finally { this.active.clear(); db?.close(); this.db = undefined; }
    });
    return this.closing;
  }
}
