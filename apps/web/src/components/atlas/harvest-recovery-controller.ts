import type { HarvestCheckpoint, HarvestJournal, HarvestLease, HarvestRunInput } from "./harvest-checkpoint";

export type HarvestRecoveryState = {
  phase: "idle" | "checking" | "ready" | "running" | "recovering" | "elsewhere" | "error";
  message?: string;
  canResume?: boolean;
};
type Connection = { endpoint: string; token: string };
type Dependencies = {
  open: (connection: Connection) => Promise<HarvestJournal>;
  acquire: (scope: string, options: { signal: AbortSignal }) => Promise<HarvestLease | undefined>;
};
type Operation = { abort: AbortController; checkpoint?: HarvestCheckpoint; cancelled: boolean; finished?: Promise<unknown> };
type Resume = (input: HarvestRunInput, checkpoint: HarvestCheckpoint, signal: AbortSignal) => Promise<unknown>;
const defaults: Dependencies = {
  open: async connection => (await import("./harvest-journal")).openHarvestJournal(connection),
  acquire: async (scope, options) => (await import("./harvest-journal")).acquireHarvestLease(scope, options),
};

/** Owns one browser-side capture. Disposal is an interruption, explicit cancel is terminal. */
export class HarvestRecoveryController {
  private journal?: Promise<HarvestJournal>;
  private operation?: Operation;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly connection: Connection,
    private readonly dependencies: Dependencies = defaults,
    private readonly onState: (state: HarvestRecoveryState) => void = () => {},
  ) {}

  private publish(state: HarvestRecoveryState) { if (!this.disposed) this.onState(state); }
  private open() {
    if (!this.journal) {
      const pending = this.dependencies.open(this.connection).catch(error => {
        if (this.journal === pending) this.journal = undefined;
        throw error;
      });
      this.journal = pending;
    }
    return this.journal;
  }

  private run<T>(
    input: HarvestRunInput | undefined,
    execute: (input: HarvestRunInput, checkpoint: HarvestCheckpoint, signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
    explicitContinuation = false,
  ): Promise<T | undefined> {
    if (this.disposed) return Promise.reject(new Error("采集页面已关闭，尚未确认的进度保留供下次恢复。"));
    if (this.operation) return Promise.reject(new Error("本轮采集尚未结束，请先停止或等待本轮收尾。"));
    const operation: Operation = { abort: new AbortController(), cancelled: false };
    this.operation = operation;
    const signal = externalSignal ? AbortSignal.any([externalSignal, operation.abort.signal]) : operation.abort.signal;
    const finished = (async () => {
      let lease: HarvestLease | undefined;
      try {
        this.publish({ phase: "checking", message: "正在检查本机采集断点…" });
        const journal = await this.open();
        if (signal.aborted) return;
        lease = await this.dependencies.acquire(journal.scope, { signal });
        if (signal.aborted) return;
        if (!lease) {
          const message = "另一个标签页正在采集；当前页面继续展示索引，不重复启动采集。";
          this.publish({ phase: "elsewhere", message });
          if (input) throw new Error(message);
          return;
        }
        const checkpoint = input ? await journal.create(input)
          : explicitContinuation ? await journal.findRecoverable() : await journal.findResumable();
        if (!checkpoint) {
          const canResume = Boolean(await journal.findRecoverable());
          this.publish({ phase: "ready", ...(canResume ? { canResume, message: "上次采集保留了未完成断点，可以继续；停止或异常的任务不会自动重启。" } : {}) });
          return;
        }
        operation.checkpoint = checkpoint;
        if (operation.cancelled) { await checkpoint.settle("cancelled"); return; }
        if (signal.aborted) return;
        if (explicitContinuation) await checkpoint.resume();
        const saved = await checkpoint.read();
        if (signal.aborted) return;
        this.publish(input
          ? { phase: "running", message: "采集断点自动保存；刷新后将核对入库回执并继续未完成的平台。" }
          : { phase: "recovering", message: "正在恢复上次采集：先核对入库回执，再继续未完成的平台。" });
        const result = await execute(saved.run.input, checkpoint, signal);
        if (!signal.aborted) {
          const saved = await checkpoint.read();
          const canResume = saved.run.state === "needs-attention" || saved.run.state === "cancelled";
          this.publish({ phase: "ready", canResume, message: canResume
            ? "本轮仍有未完成项，断点已保留；处理登录或错误后，可继续上次采集。"
            : "本轮断点已保存；已入库岗位的后台补全会独立继续。" });
        }
        return result;
      } catch (error) {
        if (signal.aborted) return;
        if (operation.checkpoint) {
          // A pipeline may already have settled its durable outcome. UI errors
          // must not overwrite a terminal receipt or re-enable cancellation.
          try {
            const saved = await operation.checkpoint.read();
            if (saved.run.state === "running") await operation.checkpoint.settle("needs-attention");
          } catch { /* Never report a failed journal write as a confirmed settlement. */ }
        }
        this.publish({ phase: "error", canResume: Boolean(operation.checkpoint), message: error instanceof Error ? error.message : "无法保存或恢复采集断点，请检查浏览器存储空间。" });
        throw error;
      } finally {
        lease?.release();
        if (this.operation === operation) this.operation = undefined;
      }
    })();
    operation.finished = finished;
    return finished;
  }

  /** Recovery never creates another run and does not replay completed/cancelled runs. */
  async resume(execute: Resume): Promise<void> {
    if (this.operation || this.disposed) return;
    await this.run(undefined, execute);
  }

  /** Login/errors/cancellation require this explicit action, never an automatic retry loop. */
  async continue(execute: Resume): Promise<void> { await this.run(undefined, execute, undefined, true); }

  async start<T>(input: HarvestRunInput, execute: (checkpoint: HarvestCheckpoint, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    return this.run(input, (_input, checkpoint, combined) => execute(checkpoint, combined), signal);
  }

  async cancel(): Promise<void> {
    const operation = this.operation;
    if (!operation) return;
    operation.cancelled = true;
    operation.abort.abort();
    try {
      await operation.checkpoint?.settle("cancelled");
      this.publish({ phase: "ready", message: "本轮已停止，正在保留已返回回执；不会在刷新后自动重启。" });
      void operation.finished?.catch(() => {}).then(() => {
        if (!this.operation) this.publish({ phase: "ready", canResume: Boolean(operation.checkpoint), message: "本轮已停止，不会在刷新后自动重启；已确认入库和后台补全保留。" });
      });
    } catch (error) {
      this.publish({ phase: "error", message: "采集已停止，但未能保存停止状态；刷新后可能再次发现本轮断点。请检查浏览器存储空间。" });
      throw error;
    }
  }

  /** Keep the lock and database alive until every already-accepted write drains. */
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    const operation = this.operation;
    operation?.abort.abort();
    this.closing = (async () => {
      await operation?.finished?.catch(() => {});
      const journal = await this.journal?.catch(() => undefined);
      journal?.close();
      this.journal = undefined;
    })();
    return this.closing;
  }
}
