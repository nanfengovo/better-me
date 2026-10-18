import type { SourceDefinition } from "@better-me/opportunities";
import { AtlasSourceServiceError, type AtlasSourceScopeInput, type AtlasSourceSync } from "./service-client";

export type AtlasAggregateSourceStatus = "queued" | AtlasSourceSync["run"]["status"];
export type AtlasAggregateError = { message: string; code?: string; status?: number };
export type AtlasAggregateSource = {
  sourceId: string;
  label: string;
  status: AtlasAggregateSourceStatus;
  /** A request can settle with a receipt whose server-side run is still running. */
  settled: boolean;
  /** No final server receipt was received after dispatch; retry with the same key. */
  outcomeUnknown: boolean;
  receipt?: AtlasSourceSync;
  error?: AtlasAggregateError;
};
export type AtlasAggregateProgress = {
  sources: readonly AtlasAggregateSource[];
  total: number;
  settled: number;
  /** Active client calls, separate from a server receipt reporting running. */
  running: number;
  queued: number;
  cancelled: boolean;
};
export type AtlasAggregateResult = AtlasAggregateProgress & {
  notificationErrors: readonly { sourceId?: string; phase: "progress" | "receipt"; error: AtlasAggregateError }[];
};
export type AtlasAggregateRequest = { request: AtlasSourceScopeInput; idempotencyKey: string };
type Sync = (sourceId: string, request: AtlasSourceScopeInput, options: { signal?: AbortSignal; idempotencyKey: string }) => Promise<AtlasSourceSync>;
export type AtlasAggregateOptions = {
  /** The caller selects eligible, enabled sources. This runner never enables sources. */
  sources: readonly SourceDefinition[];
  buildRequest: (source: SourceDefinition) => AtlasAggregateRequest;
  sync: Sync;
  signal?: AbortSignal;
  /** Limited parallelism; defaults to two and accepts 1–8. */
  concurrency?: number;
  onProgress?: (progress: AtlasAggregateProgress) => void;
  /** Runs as each real receipt arrives. Guard asynchronous UI writes with signal. */
  onReceipt?: (receipt: AtlasSourceSync, source: SourceDefinition, progress: AtlasAggregateProgress, signal: AbortSignal) => void | Promise<void>;
};

function describeError(error: unknown): AtlasAggregateError {
  if (!(error instanceof Error)) return { message: "来源请求失败，未收到可确认回执。" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  // The sync route replays an existing idempotent run before its interval check.
  // An authenticated tool-envelope 429 therefore rejected this attempt before
  // starting a new run. This says nothing about an earlier lost receipt held by
  // the caller, so it must not clear outcomeUnknown or replace its request key.
  if (error instanceof AtlasSourceServiceError && code === "rate-limited" && status === 429) {
    return { code, status, message: "刷新间隔限制：来源尚未到刷新时间，本次请求未开始新的刷新。请稍后再试；此前未确认的请求仍保留原标识核对。" };
  }
  return { message: error.message, ...(code ? { code } : {}), ...(status !== undefined ? { status } : {}) };
}

/** Stop waiting even when an injected transport ignores AbortSignal; handle its late rejection. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error: unknown) => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

/**
 * Bounded, source-independent acquisition. Progress counts settled sources, never estimated
 * records or an upstream market total. Completed receipts survive cancellation; dispatched
 * requests without receipts remain outcomeUnknown because the service may have saved results.
 */
export async function runAtlasSourceSearch(options: AtlasAggregateOptions): Promise<AtlasAggregateResult> {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new RangeError("concurrency must be an integer from 1 to 8.");
  const ids = options.sources.map((source) => source.sourceId);
  if (new Set(ids).size !== ids.length) throw new TypeError("Each aggregate sourceId must be unique.");
  // Copy the source list so callers cannot add new work after the batch starts.
  const sources = [...options.sources];
  const signal = options.signal ?? new AbortController().signal;
  const states: AtlasAggregateSource[] = sources.map((source) => ({
    sourceId: source.sourceId, label: source.attribution.label, status: "queued", settled: false, outcomeUnknown: false,
  }));
  const notifications: AtlasAggregateResult["notificationErrors"][number][] = [];
  const dispatchedSources = new Set<string>();
  let nextIndex = 0;
  function progress(): AtlasAggregateProgress {
    return {
      sources: states.map((state) => ({ ...state })), total: states.length,
      settled: states.filter((state) => state.settled).length,
      running: states.filter((state) => state.status === "running" && !state.settled).length,
      queued: states.filter((state) => state.status === "queued").length,
      cancelled: signal.aborted,
    };
  }
  function publish() {
    try { options.onProgress?.(progress()); } catch (error) {
      notifications.push({ phase: "progress", error: describeError(error) });
    }
  }
  function cancel() {
    for (const state of states) if (!state.settled) {
      state.outcomeUnknown = dispatchedSources.has(state.sourceId);
      state.status = "cancelled"; state.settled = true;
    }
    publish();
  }
  async function worker() {
    while (!signal.aborted && nextIndex < sources.length) {
      const index = nextIndex++;
      const source = sources[index]!;
      const state = states[index]!;
      let dispatched = false;
      try {
        const { request, idempotencyKey } = options.buildRequest(source);
        if (signal.aborted) return;
        state.status = "running"; publish();
        // A progress listener can synchronously cancel before dispatch.
        if (signal.aborted) return;
        dispatched = true;
        dispatchedSources.add(source.sourceId);
        const receipt = await untilAborted(options.sync(source.sourceId, request, { signal, idempotencyKey }), signal);
        if (signal.aborted) return;
        if (receipt.run.sourceId !== source.sourceId) throw new Error("来源回执与请求的来源不一致，请核对服务状态。");
        state.receipt = receipt; state.status = receipt.run.status; state.settled = true;
        publish();
        if (!signal.aborted && options.onReceipt) {
          try { await untilAborted(Promise.resolve(options.onReceipt(receipt, source, progress(), signal)), signal); }
          catch (error) { if (!signal.aborted) notifications.push({ sourceId: source.sourceId, phase: "receipt", error: describeError(error) }); }
        }
      } catch (error) {
        if (signal.aborted) return;
        state.status = "failed"; state.settled = true; state.outcomeUnknown = dispatched;
        state.error = describeError(error); publish();
      }
    }
  }
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel(); else publish();
    await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
    return { ...progress(), notificationErrors: [...notifications] };
  } finally { signal.removeEventListener("abort", cancel); }
}
