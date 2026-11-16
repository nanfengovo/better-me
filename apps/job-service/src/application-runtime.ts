import { Worker } from "node:worker_threads";
import { ToolError, type ToolResult, type TrustedToolContext } from "@better-me/opportunities";
import { READ_LANE_TOOLS, type RuntimeConfig, type RuntimeRequest, type RuntimeResponse, type SerializedToolResult } from "./application-runtime-protocol.js";

function fixedFailure(context: TrustedToolContext, code: "cancelled" | "timeout" | "budget-exceeded" | "internal-error"): SerializedToolResult {
  const error = new ToolError(code);
  return { ok: false, errorCode: code, json: new TextEncoder().encode(JSON.stringify({ ok: false, requestId: context.requestId, error: { code, message: error.message } })) };
}

function createLane(config: RuntimeConfig, onFailure: () => void) {
  // tsx's scoped import is needed only for a source checkout. Built JS uses a
  // normal module worker and never inherits watch/test/inspect process flags.
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(source ? "./application-runtime-worker.ts" : "./application-runtime-worker.js", import.meta.url).href;
  const bootstrap = source
    ? `const {tsImport}=await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}); await tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)});`
    : `await import(${JSON.stringify(entry)});`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { workerData: config, execArgv: [] });
  const pending = new Map<number, { finish: (result: SerializedToolResult) => void; context: TrustedToolContext }>();
  let sequence = 0, failed = false, closing = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let closedResolve!: () => void, closedReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise<void>((resolve, reject) => { closedResolve = resolve; closedReject = reject; });
  void closed.catch(() => {});
  function fail() {
    if (failed) return;
    failed = true; onFailure();
    const error = new Error("Job compute lane unavailable; inspect durable command receipts before retrying.");
    readyReject(error); closedReject(error);
    for (const item of [...pending.values()]) item.finish(fixedFailure(item.context, "internal-error"));
  }
  const startupTimeout = setTimeout(fail, 30_000);
  worker.on("error", fail);
  worker.on("exit", code => { if (code !== 0 || !closing) fail(); });
  worker.on("messageerror", fail);
  worker.on("message", (message: RuntimeResponse) => {
    if (message.type === "ready") { clearTimeout(startupTimeout); readyResolve(); }
    else if (message.type === "closed") closedResolve();
    else pending.get(message.id)?.finish(message.result);
  });
  const post = (message: RuntimeRequest) => worker.postMessage(message);
  return {
    ready,
    async execute(tool: string, input: unknown, context: TrustedToolContext): Promise<SerializedToolResult> {
      if (failed || closing) return fixedFailure(context, "internal-error");
      if (context.signal.aborted) return fixedFailure(context, "cancelled");
      if (pending.size >= 64) return fixedFailure(context, "budget-exceeded");
      const id = ++sequence;
      return new Promise(resolve => {
        const cancel = () => post({ type: "cancel", id });
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
    async close() {
      clearTimeout(startupTimeout);
      if (failed) { await worker.terminate(); return; }
      if (!closing) { closing = true; post({ type: "close" }); }
      await closed;
      await worker.terminate(); // Only after the application and SQLite have drained.
    },
  };
}

/** Single writer + independent WAL read lane; neither runs CPU work on HTTP. */
export async function startJobApplicationRuntime(config: Omit<RuntimeConfig, "readOnly">) {
  let failed = false;
  const writer = createLane({ ...config, readOnly: false }, () => { failed = true; });
  let reader: { execute: ReturnType<typeof createLane>["execute"]; close: () => Promise<void> } | undefined;
  const readPool: Array<ReturnType<typeof createLane>> = [];
  try {
    await writer.ready;
    const { officeGeocoder: _office, careerSearch: _career, ...readConfig } = config.config;
    // Two read-only WAL workers let fast status/cached reads bypass cold searches without duplicating caches under c=1 load.
    const READ_POOL_SIZE = 2;
    for (let i = 0; i < READ_POOL_SIZE; i++) {
      readPool.push(createLane({ ...config, config: readConfig, readOnly: true }, () => { failed = true; }));
    }
    await Promise.all(readPool.map((lane) => lane.ready));
    const inFlight = new Array<number>(readPool.length).fill(0);
    let tieBreaker = 0;
    reader = {
      async execute(tool, input, context) {
        let chosen = 0;
        let minFlight = inFlight[0]!;
        for (let i = 1; i < readPool.length; i++) {
          if (inFlight[i]! < minFlight) {
            minFlight = inFlight[i]!;
            chosen = i;
          }
        }
        // Keep sequential c=1 reads pinned to an idle worker 0; load-balance minimum-flight ties when saturated.
        if (minFlight > 0) {
          const start = tieBreaker++ % readPool.length;
          for (let offset = 0; offset < readPool.length; offset++) {
            const idx = (start + offset) % readPool.length;
            if (inFlight[idx]! === minFlight) {
              chosen = idx;
              break;
            }
          }
        }
        inFlight[chosen]!++;
        try {
          return await readPool[chosen]!.execute(tool, input, context);
        } finally {
          inFlight[chosen]!--;
        }
      },
      async close() {
        await Promise.allSettled(readPool.map((lane) => lane.close()));
      },
    };
  } catch (error) { await Promise.allSettled([writer.close(), ...readPool.map((lane) => lane.close())]); throw error; }
  async function executeSerialized(tool: string, input: unknown, context: TrustedToolContext) {
    if (failed) return fixedFailure(context, "internal-error");
    return (READ_LANE_TOOLS.has(tool) ? reader! : writer).execute(tool, input, context);
  }
  return {
    registry: {
      executeSerialized,
      async execute<O = unknown>(tool: string, input: unknown, context: TrustedToolContext): Promise<ToolResult<O>> {
        return JSON.parse(new TextDecoder().decode((await executeSerialized(tool, input, context)).json)) as ToolResult<O>;
      },
    },
    async shutdown() { await Promise.all([writer.close(), reader!.close()]); },
  };
}
