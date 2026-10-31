import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentEventSchema,
  ContextPackSchema,
  RunRecordSchema,
  type ContextPack,
  type AgentEvent,
  type RunRecord,
  type RunStatus,
  type RuntimeAgentInfo,
} from "@better-me/agent-contracts";
import { AgentEventBus } from "../events/event-bus.js";
import type { RuntimeRegistry } from "../runtime/registry.js";
import { WorkerAdapterRegistry, type WorkerAdapter } from "../runtime/worker-adapter.js";
import { createSandboxPlan, type SandboxMode, type SandboxPlan } from "./sandbox.js";

export interface StartRunInput {
  runtime: RuntimeAgentInfo;
  workflow: string;
  prompt: string;
  contextPack?: ContextPack;
  allowedReadPaths?: string[];
  timeoutMs?: number;
  sandboxMode?: SandboxMode;
}

interface ManagedRun {
  record: RunRecord;
  adapter: WorkerAdapter;
  sandbox: SandboxPlan;
  process?: ChildProcess;
  cancelRequested: boolean;
  output: string;
  /** User-facing answer assembled from structured text.delta events. */
  answer: string;
  streamBuffers: { stdout: string; stderr: string };
  timeout?: NodeJS.Timeout;
  protocolFailure?: string;
}

function defaultRunsRoot(): string {
  const configured = process.env["AGENT_RUNS_DIR"];
  if (configured) return configured;
  const home = process.env["HOME"] ?? os.homedir();
  return process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "BetterMe", "agent", "runs")
    : path.join(home, ".local", "share", "better-me", "agent", "runs");
}

function safeRunId(): string {
  return `run_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function capText(value: string, max = 80_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

export class AgentRunManager {
  readonly events: AgentEventBus;
  private readonly root: string;
  private readonly runs = new Map<string, ManagedRun>();
  private readonly records = new Map<string, RunRecord>();
  private readonly eventWriteChains = new Map<string, Promise<void>>();
  private readonly registry: RuntimeRegistry;
  private readonly adapters: WorkerAdapterRegistry;
  private readonly sandboxMode: SandboxMode;
  private readonly readyPromise: Promise<void>;

  constructor(options: { rootDirectory?: string; events?: AgentEventBus; registry: RuntimeRegistry; adapters?: WorkerAdapterRegistry; sandboxMode?: SandboxMode }) {
    this.root = path.resolve(options.rootDirectory ?? defaultRunsRoot());
    this.events = options.events ?? new AgentEventBus();
    this.registry = options.registry;
    this.adapters = options.adapters ?? new WorkerAdapterRegistry();
    this.sandboxMode = options.sandboxMode ?? "auto";
    this.readyPromise = this.loadPersistedRuns();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  /** Drain writes already scheduled for a settled run before restart or cleanup. */
  async flush(runId: string): Promise<void> {
    await this.ready();
    await this.eventWriteChains.get(runId);
  }

  async start(input: StartRunInput): Promise<RunRecord> {
    await this.ready();
    const runtime = input.runtime;
    if (runtime.status !== "available" || !runtime.resolvedCommand || runtime.canRun === false) {
      throw new Error(`runtime_not_available:${runtime.id}`);
    }
    const definition = this.registry.getDefinition(runtime.id);
    if (!definition) throw new Error(`runtime_unknown:${runtime.id}`);
    const adapter = this.adapters.get(runtime);
    const contextPack = ContextPackSchema.parse(input.contextPack ?? {
      role: "career-orchestrator",
      task: input.prompt,
      artifactRefs: [],
      toolAllowlist: [],
      redactedFields: [],
      content: {},
      characterBudget: 40_000,
    });
    const runId = safeRunId();
    const runDirectory = path.join(this.root, runId);
    const inputDirectory = path.join(runDirectory, "input");
    const outputDirectory = path.join(runDirectory, "output");
    await fs.mkdir(inputDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(inputDirectory, "task.json"), JSON.stringify({ workflow: input.workflow, prompt: input.prompt }, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(inputDirectory, "context-pack.json"), JSON.stringify(contextPack, null, 2), { mode: 0o600 });
    const allowedReadPaths = await this.validateReadPaths(input.allowedReadPaths ?? []);
    const launch = adapter.buildLaunch({ runtime, prompt: input.prompt, contextPack });
    const sandbox = await createSandboxPlan({
      command: launch.command,
      args: launch.args,
      cwd: runDirectory,
      runDirectory,
      allowedReadPaths,
      mode: input.sandboxMode ?? this.sandboxMode,
    });
    await fs.writeFile(path.join(inputDirectory, "access.json"), JSON.stringify({
      allowedReadPaths,
      isolation: sandbox.isolation,
      provider: sandbox.provider,
      detail: sandbox.detail,
      profilePath: sandbox.profilePath,
    }, null, 2), { mode: 0o600 });

    const now = new Date().toISOString();
    const record = RunRecordSchema.parse({
      id: runId,
      workflow: input.workflow,
      runtimeId: runtime.id,
      status: "running",
      createdAt: now,
      startedAt: now,
      runDirectory,
      outputDirectory,
      isolation: sandbox.isolation,
      allowedReadPaths,
    });
    const managed: ManagedRun = { record, adapter, sandbox, cancelRequested: false, output: "", answer: "", streamBuffers: { stdout: "", stderr: "" } };
    this.runs.set(runId, managed);
    this.records.set(runId, record);
    void this.persistRecord(record);
    this.publish(runId, "run.started", { workflow: input.workflow, runtimeId: runtime.id, adapter: adapter.id, isolation: sandbox.isolation, sandboxProvider: sandbox.provider });

    this.publish(runId, "agent.started", { runtimeId: runtime.id, adapter: adapter.id }, runtime.id);
    const processHandle = spawn(sandbox.command, sandbox.args, {
      cwd: runDirectory,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...launch.env, NO_COLOR: "1", BETTER_ME_RUN_ID: runId },
    });
    managed.process = processHandle;

    processHandle.stdout?.setEncoding("utf8");
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stdout?.on("data", (chunk: string) => this.handleOutput(managed, chunk, "stdout"));
    processHandle.stderr?.on("data", (chunk: string) => this.handleOutput(managed, chunk, "stderr"));
    processHandle.once("error", (error) => this.finish(runId, "failed", error.message));
    processHandle.once("close", (code, signal) => {
      if (managed.cancelRequested) this.finish(runId, "cancelled", signal ? `terminated:${signal}` : undefined);
      else if (code === 0) this.finish(runId, "completed");
      else this.finish(runId, "failed", `exit_code:${code ?? "unknown"}${signal ? ` signal:${signal}` : ""}`);
    });
    const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? 15 * 60_000, 60 * 60_000));
    managed.timeout = setTimeout(() => {
      managed.cancelRequested = true;
      processHandle.kill("SIGTERM");
      this.finish(runId, "failed", `timeout_ms:${timeoutMs}`);
    }, timeoutMs);
    processHandle.unref();
    return { ...record };
  }

  get(runId: string): RunRecord | undefined {
    const run = this.runs.get(runId);
    const record = run?.record ?? this.records.get(runId);
    return record ? { ...record, allowedReadPaths: [...(record.allowedReadPaths ?? [])] } : undefined;
  }

  /**
   * Return the complete user-facing answer separately from the raw process
   * capture. Native CLIs often emit lifecycle JSON alongside answer chunks;
   * callers should not have to reconstruct or display that transport log.
   */
  async getOutput(runId: string): Promise<{ output?: string; rawOutput?: string }> {
    const managed = this.runs.get(runId);
    if (managed) {
      return {
        ...(managed.answer ? { output: managed.answer } : {}),
        ...(managed.output ? { rawOutput: managed.output } : {}),
      };
    }
    const record = this.records.get(runId);
    if (!record) return {};
    const result = await fs.readFile(path.join(record.outputDirectory, "result.json"), "utf8")
      .then((value) => JSON.parse(value) as { answer?: unknown; output?: unknown })
      .catch(() => undefined);
    if (!result) return {};
    const answer = typeof result.answer === "string" ? result.answer : undefined;
    const rawOutput = typeof result.output === "string" ? result.output : undefined;
    return {
      ...(answer ? { output: answer } : {}),
      ...(rawOutput ? { rawOutput } : {}),
    };
  }

  list(limit = 50): RunRecord[] {
    return [...this.records.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((record) => ({ ...record, allowedReadPaths: [...(record.allowedReadPaths ?? [])] }));
  }

  cancel(runId: string): RunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) return this.get(runId);
    if (run.record.status === "running") {
      run.cancelRequested = true;
      this.publish(runId, "run.cancelled", { requested: true });
      run.process?.kill("SIGTERM");
      if (!run.process) this.finish(runId, "cancelled");
    }
    return { ...run.record };
  }

  private async validateReadPaths(paths: string[]): Promise<string[]> {
    const normalized: string[] = [];
    for (const candidate of paths.slice(0, 20)) {
      const resolved = path.resolve(candidate);
      if (normalized.includes(resolved)) continue;
      const stat = await fs.stat(resolved).catch(() => undefined);
      if (!stat?.isDirectory()) throw new Error(`invalid_read_path:${candidate}`);
      normalized.push(resolved);
    }
    return normalized;
  }

  private handleOutput(run: ManagedRun, chunk: string, stream: "stdout" | "stderr"): void {
    const runId = run.record.id;
    run.output = capText(`${run.output}${chunk}`, 80_000);
    const pending = `${run.streamBuffers[stream]}${chunk}`;
    const lines = pending.split(/\r?\n/);
    run.streamBuffers[stream] = lines.pop() ?? "";
    // Do not truncate by line count here: a single stdout chunk can contain
    // hundreds of legitimate answer lines, and the authoritative final answer
    // may appear after the first 500. The raw output and assembled answer are
    // independently character-bounded above/below, so parsing every complete
    // line in this chunk does not make retained run output unbounded.
    for (const line of lines.map((item) => item.trim()).filter(Boolean)) {
      for (const event of run.adapter.parseLine(line, stream)) {
        if (event.failure) run.protocolFailure = event.failure;
        if (event.type === "text.delta" && typeof event.payload.text === "string") {
          run.answer = capText(event.payload.replace === true
            ? event.payload.text
            : `${run.answer}${event.payload.text}`, 80_000);
        }
        this.publish(runId, event.type, event.payload, run.record.runtimeId);
      }
    }
  }

  private finish(runId: string, status: Extract<RunStatus, "completed" | "failed" | "cancelled">, error?: string): void {
    const run = this.runs.get(runId);
    if (!run || ["completed", "failed", "cancelled"].includes(run.record.status)) return;
    if (run.timeout) clearTimeout(run.timeout);
    for (const stream of ["stdout", "stderr"] as const) {
      if (run.streamBuffers[stream].trim()) this.handleOutput(run, "\n", stream);
    }
    if (status === "completed" && run.protocolFailure) {
      status = "failed";
      error = run.protocolFailure;
    }
    const diagnostic = error ?? (status === "failed" ? run.output.trim().slice(-4_000) : undefined);
    if (status === "failed" && diagnostic) this.registry.reportFailure(run.record.runtimeId, diagnostic);
    run.record = RunRecordSchema.parse({
      ...run.record,
      status,
      finishedAt: new Date().toISOString(),
      ...(diagnostic ? { error: diagnostic.slice(0, 4000) } : {}),
    });
    this.records.set(runId, run.record);
    void this.persistRecord(run.record);
    const resultText = JSON.stringify({ status, error: diagnostic, answer: run.answer, output: run.output }, null, 2);
    void this.queueWrite(runId, () => fs.writeFile(path.join(run.record.outputDirectory, "result.json"), resultText, { mode: 0o600 }));
    this.publish(runId, status === "completed" ? "run.completed" : status === "cancelled" ? "run.cancelled" : "run.failed", {
      status,
      ...(diagnostic ? { error: diagnostic.slice(0, 4000) } : {}),
    });
  }

  private publish(runId: string, type: Parameters<AgentEventBus["publish"]>[1], payload: Parameters<AgentEventBus["publish"]>[2] = {}, agentId?: string): void {
    const event = this.events.publish(runId, type, payload, agentId);
    void this.queueWrite(runId, async () => {
      const run = this.get(runId);
      if (run) await fs.appendFile(path.join(run.runDirectory, "events.ndjson"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    });
  }

  private queueWrite(runId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.eventWriteChains.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(write)
      .catch(() => undefined);
    this.eventWriteChains.set(runId, next);
    return next;
  }

  private async persistRecord(record: RunRecord): Promise<void> {
    const text = `${JSON.stringify(record, null, 2)}\n`;
    await this.queueWrite(record.id, async () => {
      await fs.mkdir(record.runDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(record.runDirectory, "run.json"), text, { mode: 0o600 });
    });
  }

  private async loadPersistedRuns(): Promise<void> {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDirectory = path.join(this.root, entry.name);
      const parsed = await fs.readFile(path.join(runDirectory, "run.json"), "utf8")
        .then((value) => RunRecordSchema.safeParse(JSON.parse(value)))
        .catch(() => undefined);
      if (!parsed?.success) continue;
      let record = parsed.data;
      if (record.status === "running" || record.status === "queued" || record.status === "paused") {
        record = RunRecordSchema.parse({
          ...record,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: "host_restarted: active process was not resumed",
        });
        void this.persistRecord(record);
      }
      this.records.set(record.id, record);
      const restored: AgentEvent[] = [];
      const eventText = await fs.readFile(path.join(runDirectory, "events.ndjson"), "utf8").catch(() => "");
      for (const line of eventText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        try {
          const event = AgentEventSchema.safeParse(JSON.parse(line));
          if (event.success) restored.push(event.data);
        } catch {
          // Ignore a torn final line; the next event remains recoverable.
        }
      }
      this.events.restore(record.id, restored);
    }
  }
}

export { defaultRunsRoot };
