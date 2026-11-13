import { setImmediate as nextTurn } from "node:timers/promises";
import { CodingTaskError, type CodingTask, type CodingTaskLease, type CodingTaskService } from "./coding-tasks.js";

export type CodingAutoView = CodingTask & { autoRunning: boolean; autoStopReason?: string };
type Run = {
  id: string; controller: AbortController; lease: CodingTaskLease; done: Promise<void>;
  stop?: string; pauseGate?: Promise<void>; dispatchRevision?: number;
};
const fail = (code: string, status = 409): never => { throw new CodingTaskError(code, status); };
const known = new Set(["coding_budget_exhausted", "coding_lease_invalid", "coding_owner_busy", "coding_revision_conflict",
  "coding_not_runnable", "coding_step_superseded", "coding_model_digest_changed", "coding_model_not_local",
  "coding_model_metadata_invalid", "coding_model_unavailable", "coding_local_transport_unavailable", "coding_local_response_limit",
  "coding_invalid_model_output", "coding_request_limit", "coding_invalid_candidate", "coding_incomplete_verification",
  "coding_generation_failed", "coding_verification_failed", "coding_step_timeout", "coding_step_interrupted", "coding_manually_paused",
  "coding_host_stopped", "coding_host_restarted", "coding_service_closed", "coding_single_writer_required",
  "coding_unsafe_store", "coding_invalid_store", "coding_store_unavailable", "coding_task_capacity", "coding_invalid_progress"]);
const safeReason = (code?: string) => code && known.has(code) ? code : "coding_auto_step_failed";
function fenced(lease: CodingTaskLease, ...signals: AbortSignal[]): CodingTaskLease {
  return Object.assign(() => lease(), { signal: AbortSignal.any(lease.signal ? [...signals, lease.signal] : signals) });
}
const spent = (t: CodingTask) => t.attemptsUsed >= t.maxAttempts || t.activeMs >= t.maxActiveMs;
function assertRevision(t: CodingTask, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 1) fail("coding_invalid_revision", 400);
  if (t.revision !== expected) fail("coding_revision_conflict");
}

/** One explicit background grant per owner service. Only its bounded scheduling lease
 * lives here. The durable manifest, quota, evidence, pause and CAS remain in tasks.step.
 * Losing this object NEVER rehydrates or starts a runner. */
export class CodingAutoRuns {
  private readonly life = new AbortController();
  private current?: Run;
  private readonly stops = new Map<string, string>();
  constructor(private readonly tasks: CodingTaskService) {}

  busy(id: string): boolean { return this.current?.id === id; }
  view(task: CodingTask): CodingAutoView {
    const autoRunning = this.busy(task.id), reason = !autoRunning && this.stops.get(task.id);
    return { ...task, autoRunning, ...(reason ? { autoStopReason: reason } : {}) };
  }

  async start(id: string, expectedRevision: number, lease: CodingTaskLease, releaseLease: () => void): Promise<CodingTask> {
    if (this.life.signal.aborted) return fail("coding_service_closed", 503);
    const controller = new AbortController(), session = fenced(lease, this.life.signal, controller.signal);
    const task = await this.tasks.get(id, session);
    if (this.life.signal.aborted) return fail("coding_service_closed", 503);
    if (session.signal?.aborted) return fail("coding_lease_invalid", 403);
    assertRevision(task, expectedRevision);
    if (this.current) return fail(this.busy(id) ? "coding_auto_active" : "coding_owner_busy");
    if (task.status === "review_ready" || task.status === "running") return fail("coding_not_runnable");
    if (task.status === "budget_exhausted" || spent(task)) return fail("coding_budget_exhausted");
    if (!["ready", "paused", "interrupted"].includes(task.status)) return fail("coding_not_runnable");
    // No await between owner-wide reservation and installing its completion handler.
    const run: Run = { id, controller, lease: session, done: Promise.resolve() };
    this.current = run; this.stops.delete(id);
    run.done = this.drive(run, task).then(async reason => {
      if (run.pauseGate) await run.pauseGate;
      this.stops.set(id, run.stop ?? reason);
      if (this.current === run) this.current = undefined;
      try { releaseLease(); } catch { /* never replay an accepted run to retry a release */ }
    });
    return task;
  }
  private async drive(run: Run, first: CodingTask): Promise<string> {
    let task = first;
    // Independent outer cap guards even a buggy future step implementation.
    const remaining = Math.min(8, first.maxAttempts) - first.attemptsUsed;
    try {
      for (let i = 0; i < remaining; i++) {
        // Yield between durable attempts, allowing control requests to fence the next one.
        await nextTurn(undefined, { signal: run.lease.signal });
        if (run.pauseGate) await run.pauseGate;
        if (run.stop) return run.stop;
        if (this.life.signal.aborted || this.current !== run) return "coding_host_stopped";
        if (run.lease.signal?.aborted) return "coding_lease_invalid";
        run.dispatchRevision = task.revision;
        const result = await this.tasks.step(run.id, task.revision, run.lease);
        if (result.id !== task.id || result.revision <= task.revision || result.attemptsUsed !== task.attemptsUsed + 1
          || result.lastAttempt?.number !== result.attemptsUsed) return "coding_auto_outcome_unknown";
        task = result;
        const outcome = result.lastAttempt.outcome;
        if (result.status === "review_ready") return "coding_review_ready";
        if (result.status === "budget_exhausted" || spent(result)) return "coding_budget_exhausted";
        if (result.status !== "ready" || !["accepted", "regression"].includes(outcome)) return safeReason(result.lastAttempt.error);
        // A complete, independent report with ordinary test failures may be repaired;
        // transport errors, missing evidence and uncertain outcomes must NOT auto-retry.
        if (result.lastAttempt.checks.length !== result.cases.length || result.lastAttempt.checks.some((c, j) => c.id !== result.cases[j]?.id)) return "coding_auto_outcome_unknown";
      }
      return "coding_budget_exhausted";
    } catch (err) {
      return run.stop ?? (this.life.signal.aborted ? "coding_host_stopped" : run.lease.signal?.aborted
        ? "coding_lease_invalid" : safeReason(err instanceof CodingTaskError ? err.code : undefined));
    }
  }
  async pause(id: string, expectedRevision: number, lease: CodingTaskLease): Promise<CodingTask> {
    if (this.life.signal.aborted) return fail("coding_service_closed", 503);
    const access = fenced(lease, this.life.signal), run = this.current;
    if (!run || run.id !== id) return this.tasks.pause(id, expectedRevision, access);
    if (run.pauseGate) return fail("coding_auto_control_busy");
    // While checking this command, do not dispatch the NEXT attempt. An invalid
    // or stale pause merely lifts the fence; it cannot cancel the active grant.
    let lift!: () => void;
    run.pauseGate = new Promise<void>(resolve => { lift = resolve; });
    let accepted = false, result: CodingTask;
    try {
      const seen = await this.tasks.get(id, access);
      assertRevision(seen, expectedRevision);
      if (this.life.signal.aborted) return fail("coding_service_closed", 503);
      if (access.signal?.aborted) return fail("coding_lease_invalid", 403);
      accepted = true; run.stop = "coding_manually_paused";
      const terminal = (t: CodingTask) => {
        if (t.status === "review_ready") { run.stop = "coding_review_ready"; return true; }
        if (t.status === "budget_exhausted") { run.stop = "coding_budget_exhausted"; return true; }
        return false;
      };
      if (terminal(seen)) result = seen;
      else try { result = await this.tasks.pause(id, seen.revision, access); }
      catch (err) {
        if (!(err instanceof CodingTaskError) || err.code !== "coding_revision_conflict") throw err;
        const fresh = await this.tasks.get(id, access);
        // A valid pause may cross THIS attempt's reservation/settlement; no new
        // attempt was dispatched while fenced. Never rebase onto unrelated work.
        if (this.current !== run || run.dispatchRevision === undefined || fresh.revision <= seen.revision
          || fresh.revision > run.dispatchRevision + 2 || fresh.attemptsUsed > seen.attemptsUsed + 1) throw err;
        result = terminal(fresh) ? fresh : await this.tasks.pause(id, fresh.revision, access);
      }
    } finally {
      // Let the core record a human pause before revoking its temporary auto lease.
      if (accepted) run.controller.abort();
      run.pauseGate = undefined; lift();
    }
    await run.done; return result!;
  }
  close(): Promise<void> {
    if (this.current) this.current.stop = "coding_host_stopped";
    this.life.abort();
    return this.current?.done ?? Promise.resolve();
  }
}
