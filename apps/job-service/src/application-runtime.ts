import { Worker, type WorkerOptions } from "node:worker_threads";
import { ToolError, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { READ_LANE_TOOLS, type JobRuntimeHealth, type RuntimeConfig, type RuntimeRequest, type RuntimeResponse, type SerializedToolResult } from "./application-runtime-protocol.js";

function fixedFailure(context: TrustedToolContext, code: "cancelled" | "timeout" | "budget-exceeded" | "internal-error", temporarilyUnavailable = false): SerializedToolResult {
  const error = new ToolError(code);
  return {
    ok: false, errorCode: code, ...(temporarilyUnavailable ? { temporarilyUnavailable: true } : {}),
    json: new TextEncoder().encode(JSON.stringify({ ok: false, requestId: context.requestId, error: { code, message: error.message } })),
  };
}

type SpawnWorker = (entry: URL, options: WorkerOptions) => Worker;
const spawnWorker: SpawnWorker = (entry, options) => new Worker(entry, options);

function createLane(config: RuntimeConfig, onFailure: () => void, spawn: SpawnWorker) {
  // tsx's scoped import is needed only for a source checkout. Built JS uses a
  // normal module worker and never inherits watch/test/inspect process flags.
  const source = new URL(import.meta.url).pathname.endsWith(".ts");
  const entry = new URL(source ? "./application-runtime-worker.ts" : "./application-runtime-worker.js", import.meta.url).href;
  const bootstrap = source
    ? `const {tsImport}=await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}); await tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)});`
    : `await import(${JSON.stringify(entry)});`;
  const worker = spawn(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { workerData: config, execArgv: [] });
  const pending = new Map<number, { finish: (result: SerializedToolResult) => void; context: TrustedToolContext }>();
  let sequence = 0, failed = false, initialized = false, drained = false;
  let closing: Promise<void> | undefined;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let closedResolve!: () => void, closedReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise<void>((resolve, reject) => { closedResolve = resolve; closedReject = reject; });
  void ready.catch(() => {});
  void closed.catch(() => {});
  function fail() {
    if (failed || drained) return;
    failed = true;
    clearTimeout(startupTimeout);
    const error = new Error("Job compute lane unavailable; inspect durable command receipts before retrying.");
    readyReject(error); closedReject(error);
    for (const item of pending.values()) item.finish(fixedFailure(item.context, "internal-error", config.readOnly));
    onFailure();
  }
  const startupTimeout = setTimeout(fail, 30_000);
  worker.on("error", fail);
  worker.on("exit", fail);
  worker.on("messageerror", fail);
  worker.on("message", (message: RuntimeResponse) => {
    if (failed) return;
    if (message.type === "ready") { clearTimeout(startupTimeout); initialized = true; readyResolve(); }
    else if (message.type === "closed") { drained = true; closedResolve(); }
    else pending.get(message.id)?.finish(message.result);
  });
  const post = (message: RuntimeRequest) => worker.postMessage(message);
  const available = () => initialized && !failed && !drained && !closing;
  return {
    ready,
    get available() { return available(); },
    get inFlight() { return pending.size; },
    async execute(tool: string, input: unknown, context: TrustedToolContext): Promise<SerializedToolResult> {
      if (!available()) return fixedFailure(context, "internal-error", true);
      if (context.signal.aborted) return fixedFailure(context, "cancelled");
      if (pending.size >= 64) return fixedFailure(context, "budget-exceeded");
      const id = ++sequence;
      return new Promise(resolve => {
        const cancel = () => {
          try { post({ type: "cancel", id }); }
          catch { fail(); }
        };
        const timer = setTimeout(() => { cancel(); pending.get(id)?.finish(fixedFailure(context, "timeout")); }, context.budget.timeoutMs + 1000);
        pending.set(id, { context, finish(result) {
          pending.delete(id); clearTimeout(timer); context.signal.removeEventListener("abort", cancel); resolve(result);
        } });
        context.signal.addEventListener("abort", cancel, { once: true });
        const { signal: _signal, ...wireContext } = context;
        try { post({ type: "execute", id, tool, input, context: wireContext }); }
        catch { pending.get(id)?.finish(fixedFailure(context, "internal-error")); }
      });
    },
    close() {
      if (closing) return closing;
      clearTimeout(startupTimeout);
      closing = (async () => {
        try {
          if (initialized && !failed && !drained) {
            post({ type: "close" });
            await closed;
          }
        } finally {
          // A healthy lane drains its application and SQLite before termination.
          await worker.terminate();
        }
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}

/** Single writer + independent WAL read lane; neither runs CPU work on HTTP. */
export async function startJobApplicationRuntime(config: Omit<RuntimeConfig, "readOnly">, spawn = spawnWorker) {
  const writer = createLane({ ...config, readOnly: false }, () => {}, spawn);
  const { officeGeocoder: _office, careerSearch: _career, ...readConfig } = config.config;
  type Lane = ReturnType<typeof createLane>;
  type ReaderSlot = { lane?: Lane; failures: number; restartTimer?: NodeJS.Timeout };
  // Keep one idle worker warm for sequential requests and a second for overlapping reads.
  const readPool: ReaderSlot[] = [{ failures: 0 }, { failures: 0 }];
  let started = false, stopping = false, tieBreaker = 0;

  function scheduleReaderReplacement(slot: ReaderSlot) {
    if (!started || stopping || !writer.available || slot.restartTimer) return;
    const backoff = Math.min(30_000, 250 * 2 ** Math.min(slot.failures++, 7));
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = undefined;
      void replaceReader(slot);
    }, backoff);
    slot.restartTimer.unref();
  }
  function openReader(slot: ReaderSlot) {
    const lane = createLane({ ...config, config: readConfig, readOnly: true }, () => scheduleReaderReplacement(slot), spawn);
    slot.lane = lane;
    return lane;
  }
  async function replaceReader(slot: ReaderSlot) {
    try {
      await slot.lane?.close();
      if (stopping || !writer.available) return;
      await openReader(slot).ready;
      slot.failures = 0;
    } catch {
      scheduleReaderReplacement(slot);
    }
  }
  async function shutdown() {
    stopping = true;
    for (const slot of readPool) clearTimeout(slot.restartTimer);
    const results = await Promise.allSettled([writer.close(), ...readPool.map(slot => slot.lane?.close())]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  try {
    await writer.ready;
    await Promise.all(readPool.map(slot => openReader(slot).ready));
    if (!writer.available || readPool.some(slot => !slot.lane?.available)) throw new Error("Job compute lanes failed to initialize.");
    started = true;
  } catch (error) { await shutdown().catch(() => {}); throw error; }

  function chooseReader(tool: string) {
    // Keep each cursor-based family on one worker. A replacement owns fresh
    // sessions, so old browse snapshots and baseline pages expire normally.
    if (tool.startsWith("jobs.browse") || tool.startsWith("jobs.baseline-")) return readPool[0]!.lane;
    const ready = readPool.flatMap(slot => slot.lane?.available ? [slot.lane] : []);
    const minFlight = Math.min(...ready.map(lane => lane.inFlight));
    const leastBusy = ready.filter(lane => lane.inFlight === minFlight);
    return leastBusy[minFlight > 0 && leastBusy.length > 1 ? tieBreaker++ % leastBusy.length : 0];
  }
  async function executeSerialized(tool: string, input: unknown, context: TrustedToolContext) {
    if (context.signal.aborted) return fixedFailure(context, "cancelled");
    const lane = READ_LANE_TOOLS.has(tool) ? chooseReader(tool) : writer;
    if (stopping || !lane) return fixedFailure(context, "internal-error", true);
    return lane.execute(tool, input, context);
  }
  return {
    registry: {
      executeSerialized,
      async execute<O = unknown>(tool: string, input: unknown, context: TrustedToolContext): Promise<ToolResult<O>> {
        return JSON.parse(new TextDecoder().decode((await executeSerialized(tool, input, context)).json)) as ToolResult<O>;
      },
    },
    health(): JobRuntimeHealth {
      const writerReady = !stopping && writer.available;
      const ready = stopping ? 0 : readPool.filter(slot => slot.lane?.available).length;
      const total = readPool.length;
      return { status: !writerReady ? "unavailable" : ready < total ? "degraded" : "ok", writerReady, readers: { ready, total } };
    },
    shutdown,
  };
}
