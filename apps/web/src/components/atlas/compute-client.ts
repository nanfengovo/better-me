import { JobQueryError, type AtlasDataset, type JobQueryInput, type QueryOptions } from "@better-me/opportunities";
import { AtlasClientError } from "./client-error";
import type { AtlasPageOptions, AtlasPageResult, SnapshotOptions } from "./client";
import type { AtlasCoverageOptions } from "./coverage";
import { ATLAS_CHUNK_SIZE, ATLAS_TABLES, emptyComputeSnapshot, type AtlasMetadata, type ComputeOperation, type ComputeRequest, type ComputeResponse } from "./compute-protocol";
import { applyDatasetTableDelta, emptyDatasetUpserts, type DatasetDelta } from "../../../../job-service/src/dataset-sync-contract";
import type { DatasetUpserts } from "../../../../job-service/src/dataset-sync-contract";
import type { BaselineProgress } from "../../../../job-service/src/dataset-baseline-contract";

export type AtlasComputePort = {
  postMessage(message: ComputeRequest): void;
  terminate(): void;
  onmessage: Worker["onmessage"];
  onerror: Worker["onerror"];
  onmessageerror: Worker["onmessageerror"];
};
type Installed = { key: string; valid: boolean; ready: Promise<void>; data: AtlasDataset };
type Pending = {
  resolve(value: unknown): void; reject(reason: unknown): void; cleanup(): void;
  snapshot?: AtlasDataset; snapshotKey?: string; page?: AtlasPageResult;
  knownSnapshots?: Map<string, AtlasDataset>; patch?: { base: AtlasDataset; delta: DatasetDelta };
  preview?: AtlasDataset; fragment?: DatasetUpserts; previewHeader?: Pick<AtlasDataset, "schemaVersion" | "revision">;
  onProgress?: SnapshotOptions["onProgress"];
};
const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
export const atlasComputeAvailable = () => {
  const node = (globalThis as typeof globalThis & { process?: { versions?: { node?: string } } }).process?.versions?.node;
  // Node/happy-dom uses the pure reference implementation. A real browser with
  // Worker disabled must surface an actionable error, not freeze on a large DB.
  return typeof document !== "undefined" && (typeof Worker !== "undefined" || !node);
};

/** One bounded page-owned worker; snapshots are installed once, not once per query. */
export function createAtlasComputeClient(port: AtlasComputePort, options: { yieldTask?: () => Promise<void>; onFailure?: () => void } = {}) {
  let sequence = 0, failed = false;
  const pending = new Map<number, Pending>();
  const byData = new WeakMap<AtlasDataset, Installed>();
  const installed = new Map<string, Installed>();
  const reads = new Map<string, { promise: Promise<AtlasDataset>; controller: AbortController; observers: number; settled: boolean;
    listeners: Set<NonNullable<SnapshotOptions["onProgress"]>>; latest?: { data: AtlasDataset; progress: BaselineProgress } }>();
  const yieldTask = options.yieldTask ?? nextTask;
  const unavailable = () => new AtlasClientError("invalid-response", "岗位计算服务暂不可用，请重试连接；已入库数据不受影响。");
  function remember(record: Installed) {
    installed.delete(record.key); installed.set(record.key, record);
    while (installed.size > 3) { const oldest = installed.keys().next().value!; installed.get(oldest)!.valid = false; installed.delete(oldest); }
  }
  function fail() {
    if (failed) return;
    failed = true; port.terminate();
    for (const item of pending.values()) { item.cleanup(); item.reject(unavailable()); }
    pending.clear();
    for (const item of installed.values()) item.valid = false;
    installed.clear(); options.onFailure?.();
  }
  function finishSnapshot(id: number, item: Pending, data: AtlasDataset) {
    if (pending.get(id) !== item || !item.snapshotKey) return;
    pending.delete(id); item.cleanup();
    const record: Installed = { key: item.snapshotKey, valid: true, ready: Promise.resolve(), data };
    byData.set(data, record); remember(record); item.resolve(data);
  }
  port.onerror = fail; port.onmessageerror = fail;
  port.onmessage = event => {
    const message = event.data as ComputeResponse;
    if (message.type === "evicted") { const item = installed.get(message.snapshot); if (item) item.valid = false; installed.delete(message.snapshot); return; }
    // Always acknowledge a late chunk, even after cancellation, so the worker
    // cannot retain a blocked producer or flood the main-thread message queue.
    if (message.type === "chunk") port.postMessage({ type: "ack", id: message.id, sequence: message.sequence });
    const item = pending.get(message.id);
    if (!item) { if (message.type === "baseline-checkpoint") port.postMessage({ type: "ack", id: message.id, sequence: message.sequence }); return; }
    if (message.type === "begin-baseline") { item.fragment = emptyDatasetUpserts(); item.previewHeader = message.header; item.snapshotKey = message.snapshot; }
    else if (message.type === "baseline-checkpoint") {
      void (async () => {
        if (!item.fragment || !item.previewHeader || !item.snapshotKey) throw unavailable();
        const data = { ...(item.preview ?? emptyComputeSnapshot(item.previewHeader)) };
        for (const table of ATLAS_TABLES) {
          if (pending.get(message.id) !== item) return;
          if (!item.fragment[table].length) continue;
          (data as unknown as Record<string, unknown>)[table] = applyDatasetTableDelta<unknown>(table, data[table], item.fragment[table], []);
          await yieldTask();
        }
        if (pending.get(message.id) !== item) return;
        const record: Installed = { key: item.snapshotKey, data, valid: true, ready: Promise.resolve() };
        byData.set(data, record); remember(record); item.knownSnapshots?.set(record.key, data);
        item.preview = data; item.fragment = undefined;
        await item.onProgress?.(data, message.progress);
      })().catch(fail).finally(() => port.postMessage({ type: "ack", id: message.id, sequence: message.sequence }));
    }
    else if (message.type === "begin-snapshot") { item.snapshot = emptyComputeSnapshot(message.header); item.snapshotKey = message.snapshot; }
    else if (message.type === "use-snapshot") {
      const data = item.knownSnapshots?.get(message.snapshot);
      if (!data) { fail(); return; }
      item.snapshot = data; item.snapshotKey = message.snapshot;
    } else if (message.type === "begin-delta") {
      const base = item.knownSnapshots?.get(message.base);
      if (!base || base.revision !== message.delta.from.revision) { fail(); return; }
      item.snapshotKey = message.snapshot;
      item.patch = { base, delta: { ...message.delta, upserts: emptyDatasetUpserts() } };
    }
    else if (message.type === "begin-page") item.page = message.value;
    else if (message.type === "chunk") {
      const array = message.target === "summaryBuckets" ? item.page?.summary.mapBuckets
        : message.target === "pageBuckets" ? item.page?.page.mapBuckets
          : message.target === "mapFeatures" ? item.page?.geometry?.data.features
            : message.target === "officeBucketIds" ? item.page?.geometry?.officeBucketIds
              : message.target === "coordinateStacks" ? item.page?.geometry?.coordinateStacks : item.fragment?.[message.target] ?? item.patch?.delta.upserts[message.target] ?? item.snapshot?.[message.target];
      if (!array) { fail(); return; }
      (array as unknown[]).push(...message.values);
    } else {
      if (message.type === "error") {
        pending.delete(message.id); item.cleanup();
        const error = message.name === "JobQueryError" ? new JobQueryError(message.code as JobQueryError["code"], message.message)
          : message.name === "AtlasClientError" ? new AtlasClientError(message.code as AtlasClientError["code"], message.message)
          : Object.assign(new Error(message.message), { name: message.name, code: message.code });
        item.reject(error);
      } else if (item.patch) {
        const { base, delta } = item.patch;
        // Immutable array copies are small per-table tasks. Parsing and global
        // reference validation already ran off-thread; do not repeat them here.
        void (async () => {
          const data = { ...base, revision: delta.to.revision };
          for (const table of ATLAS_TABLES) {
            if (pending.get(message.id) !== item) return;
            if (!delta.upserts[table].length && !delta.deletes[table].length) continue;
            (data as unknown as Record<string, unknown>)[table] = applyDatasetTableDelta<unknown>(table, base[table], delta.upserts[table], delta.deletes[table]);
            await yieldTask();
          }
          finishSnapshot(message.id, item, data);
        })().catch(fail);
      } else if (item.snapshot && item.snapshotKey) finishSnapshot(message.id, item, item.snapshot);
      else { pending.delete(message.id); item.cleanup(); item.resolve(item.page ?? message.value); }
    }
  };
  function request<T>(send: (id: number) => void, signal?: AbortSignal): Promise<T> {
    if (failed) return Promise.reject(unavailable());
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (pending.size >= 32) return Promise.reject(new Error("岗位计算队列已满，请稍后重试。"));
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { const item = pending.get(id); if (!item) return; pending.delete(id); item.cleanup(); port.postMessage({ type: "cancel", id }); reject(signal?.reason); };
      const timer = setTimeout(() => { pending.delete(id); cleanup(); port.postMessage({ type: "cancel", id }); reject(new Error("岗位计算超时，请缩小筛选范围后重试。")); }, 120_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      pending.set(id, { resolve: value => resolve(value as T), reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { send(id); } catch { fail(); }
    });
  }
  async function ensureSnapshot(data: AtlasDataset): Promise<Installed> {
    const previous = byData.get(data);
    if (previous?.valid) { await previous.ready; if (previous.valid) { remember(previous); return previous; } }
    const record: Installed = { key: `ui-${++sequence}`, valid: true, ready: Promise.resolve(), data };
    byData.set(data, record); remember(record);
    record.ready = request<void>(id => {
      port.postMessage({ type: "install", id, snapshot: record.key, header: { schemaVersion: data.schemaVersion, revision: data.revision } });
      void (async () => {
        for (const table of ATLAS_TABLES) for (let offset = 0; offset < data[table].length; offset += ATLAS_CHUNK_SIZE) {
          if (failed) throw unavailable();
          port.postMessage({ type: "install-chunk", snapshot: record.key, table, values: data[table].slice(offset, offset + ATLAS_CHUNK_SIZE) });
          await yieldTask();
        }
        port.postMessage({ type: "installed", id, snapshot: record.key });
      })().catch(fail);
    }).catch(error => { record.valid = false; installed.delete(record.key); throw error; });
    await record.ready; return record;
  }
  async function onSnapshot<T>(data: AtlasDataset, operation: (key: string) => ComputeOperation, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const upload = ensureSnapshot(data);
      // An observer can stop waiting immediately without cancelling the shared
      // upload that a newer search/metadata request may still need.
      const record = await (signal ? new Promise<Installed>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        void upload.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
      }) : upload);
      signal?.throwIfAborted();
      try { return await request<T>(id => port.postMessage({ type: "run", id, operation: operation(record.key) }), signal); }
      catch (error) {
        if (attempt || !(error instanceof Error) || !("code" in error) || error.code !== "snapshot-missing") throw error;
        record.valid = false; installed.delete(record.key);
      }
    }
  }
  function readSnapshot(endpoint: string, token: string, { signal, maxBytes, onProgress }: SnapshotOptions = {}): Promise<AtlasDataset> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = JSON.stringify([endpoint, token, maxBytes]);
    let sharedRead = reads.get(key);
    if (!sharedRead) {
      const controller = new AbortController();
      const listeners = new Set<NonNullable<SnapshotOptions["onProgress"]>>();
      const promise = request<AtlasDataset>(id => {
        const known = new Map([...installed].filter(([, record]) => record.valid).map(([name, record]) => [name, record.data]));
        pending.get(id)!.knownSnapshots = known;
        pending.get(id)!.onProgress = async (data, progress) => {
          const current = reads.get(key);
          if (current) current.latest = { data, progress };
          // A presentation callback cannot poison another observer's shared read.
          await Promise.all([...listeners].map(async listener => { try { await listener(data, progress); } catch { /* observer owns presentation failure */ } }));
        };
        port.postMessage({ type: "run", id, operation: { kind: "snapshot", endpoint, token, maxBytes, knownSnapshots: [...known.keys()] } });
      }, controller.signal);
      sharedRead = { promise, controller, observers: 0, settled: false, listeners }; reads.set(key, sharedRead);
      const captured = sharedRead;
      const done = () => { captured.settled = true; if (reads.get(key) === captured) reads.delete(key); };
      void promise.then(done, done);
    }
    const read = sharedRead; read.observers++;
    if (onProgress) {
      read.listeners.add(onProgress);
      if (read.latest) void Promise.resolve().then(() => { if (read.listeners.has(onProgress)) return onProgress(read.latest!.data, read.latest!.progress); }).catch(() => {});
    }
    return new Promise<AtlasDataset>((resolve, reject) => {
      let active = true;
      const cleanup = () => {
        if (!active) return false;
        active = false; signal?.removeEventListener("abort", abort); if (onProgress) read.listeners.delete(onProgress); read.observers--; return true;
      };
      const abort = () => {
        if (!cleanup()) return;
        reject(signal?.reason);
        // A cancelled search does not cancel a simultaneous enrichment/harvest
        // observer. The HTTP read stops only when nobody still needs it.
        if (!read.observers && !read.settled) { if (reads.get(key) === read) reads.delete(key); read.controller.abort(); }
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void read.promise.then(value => { if (cleanup()) resolve(value); }, error => { if (cleanup()) reject(error); });
    });
  }
  return {
    readSnapshot,
    queryPage(data: AtlasDataset, query: JobQueryInput, queryOptions: QueryOptions = {}, { signal, ...page }: AtlasPageOptions = {}) {
      return onSnapshot<AtlasPageResult>(data, snapshot => ({ kind: "page", snapshot, query, options: queryOptions, page }), signal);
    },
    metadata(data: AtlasDataset, coverageOptions: AtlasCoverageOptions, text: string, signal?: AbortSignal) {
      return onSnapshot<AtlasMetadata>(data, snapshot => ({ kind: "metadata", snapshot, options: coverageOptions, text }), signal);
    },
    dispose: fail,
  };
}

let shared: ReturnType<typeof createAtlasComputeClient> | undefined;
function client() {
  if (!shared) {
    try { shared = createAtlasComputeClient(new Worker(new URL("./compute-worker.ts", import.meta.url), { type: "module", name: "atlas-query" }), { onFailure: () => { shared = undefined; } }); }
    catch { throw new AtlasClientError("invalid-response", "浏览器未能启动岗位计算 Worker，请检查浏览器限制后重试连接；已入库数据不受影响。"); }
  }
  return shared;
}
export const atlasCompute = {
  readSnapshot: async (...args: Parameters<ReturnType<typeof createAtlasComputeClient>["readSnapshot"]>) => client().readSnapshot(...args),
  queryPage: async (...args: Parameters<ReturnType<typeof createAtlasComputeClient>["queryPage"]>) => client().queryPage(...args),
  metadata: async (...args: Parameters<ReturnType<typeof createAtlasComputeClient>["metadata"]>) => client().metadata(...args),
};
