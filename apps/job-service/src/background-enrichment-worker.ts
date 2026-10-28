type BatchResult = {
  processed: number;
  status: { nextRetryAt?: string };
};

type Processor = {
  processEnrichmentBatch(options?: { limit?: number; actorScope?: string; signal?: AbortSignal }): Promise<BatchResult>;
};

export type BackgroundEnrichmentWorkerState = {
  workerState: "idle" | "running" | "stopped" | "error";
  workerError?: string;
};

export type BackgroundEnrichmentWorker = {
  wake(): void;
  status(): BackgroundEnrichmentWorkerState;
  stop(): Promise<void>;
};

type WorkerOptions = {
  actorScope?: string;
  batchSize?: number;
  pollIntervalMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Serialize only the bounded local repository batch, never remote lookups. */
  runLocalBatch?: (operation: () => Promise<BatchResult>) => Promise<BatchResult>;
};

const workers = new WeakMap<Processor, Map<string, BackgroundEnrichmentWorker>>();

/** Service-owned lifetime: neither an HTTP disconnect nor a search owns this signal. */
export function startBackgroundEnrichmentWorker(repository: Processor, options: WorkerOptions = {}): BackgroundEnrichmentWorker {
  const actorScope = options.actorScope ?? "local-owner";
  const existing = workers.get(repository)?.get(actorScope);
  if (existing) return existing;
  const batchSize = options.batchSize ?? 16;
  const interval = options.pollIntervalMs ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32 || !Number.isFinite(interval) || interval < 1) {
    throw new Error("Invalid background enrichment worker limits.");
  }
  const schedule = options.schedule ?? ((callback, delayMs) => {
    // Even a full queue yields to imports, queries and cancellation between batches.
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  });
  const controller = new AbortController();
  let state: BackgroundEnrichmentWorkerState = { workerState: "idle" };
  let cancelScheduled: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let wakeRequested = false;

  function queue(delayMs: number): void {
    if (stopped || cancelScheduled) return;
    cancelScheduled = schedule(() => {
      cancelScheduled = undefined;
      if (!stopped) inFlight = run();
    }, delayMs);
  }

  async function run(): Promise<void> {
    // Keep the inFlight promise installed even if a dependency throws synchronously.
    await Promise.resolve();
    state = { workerState: "running" };
    let delayMs = interval;
    try {
      controller.signal.throwIfAborted();
      const operation = () => {
        controller.signal.throwIfAborted();
        return repository.processEnrichmentBatch({ limit: batchSize, actorScope, signal: controller.signal });
      };
      const result = await (options.runLocalBatch ? options.runLocalBatch(operation) : operation());
      state = { workerState: "idle" };
      if (result.processed > 0) delayMs = 0;
      else if (result.status.nextRetryAt) {
        const retryAt = Date.parse(result.status.nextRetryAt);
        if (Number.isFinite(retryAt)) delayMs = Math.max(1, Math.min(30_000, retryAt - (options.now?.() ?? Date.now())));
      }
    } catch {
      // Do not leak storage paths, source excerpts or credentials in a public status.
      state = { workerState: "error", workerError: "后台补全暂不可用，将自动重试。" };
    } finally {
      inFlight = undefined;
      if (stopped) state = { workerState: "stopped" };
      else {
        queue(wakeRequested ? 0 : delayMs);
        wakeRequested = false;
      }
    }
  }

  const worker: BackgroundEnrichmentWorker = {
    wake() {
      if (stopped) return;
      if (inFlight) { wakeRequested = true; return; }
      cancelScheduled?.();
      cancelScheduled = undefined;
      queue(0);
    },
    status: () => ({ ...state }),
    async stop() {
      stopped = true;
      controller.abort();
      cancelScheduled?.();
      cancelScheduled = undefined;
      await inFlight;
      state = { workerState: "stopped" };
      if (workers.get(repository)?.get(actorScope) === worker) workers.get(repository)?.delete(actorScope);
    },
  };
  const scopedWorkers = workers.get(repository) ?? new Map<string, BackgroundEnrichmentWorker>();
  scopedWorkers.set(actorScope, worker);
  workers.set(repository, scopedWorkers);
  queue(0);
  return worker;
}
