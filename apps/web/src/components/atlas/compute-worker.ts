import type { AtlasDataset } from "@better-me/opportunities";
import { queryAtlasPageDirect, type AtlasPageResult } from "./client";
import { createAtlasSnapshotSynchronizer } from "./snapshot-sync";
import { getAtlasDataCoverage } from "./coverage";
import { analyzeAiJobRelevance } from "./ai-job-relevance";
import { prepareAtlasMapGeometry } from "./prototypes/map-performance";
import { ATLAS_CHUNK_SIZE, ATLAS_TABLES, emptyComputeSnapshot, type ComputeRequest, type ComputeResponse, type AtlasTable } from "./compute-protocol";
import { datasetEntityId } from "../../../../job-service/src/dataset-sync-contract";

type WorkerPort = { postMessage(message: ComputeResponse): void; onmessage: ((event: { data: ComputeRequest }) => void) | null };
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Exported for a real worker-thread harness, not a main-thread fallback. */
export function startAtlasComputeWorker(port: WorkerPort) {
  const snapshots = new Map<string, AtlasDataset>();
  const snapshotKeys = new WeakMap<AtlasDataset, string>();
  const synchronizer = createAtlasSnapshotSynchronizer();
  const pages = new WeakMap<AtlasDataset, Map<string, Promise<AtlasPageResult>>>();
  const geometries = new WeakMap<AtlasPageResult["summary"]["mapBuckets"], ReturnType<typeof prepareAtlasMapGeometry>>();
  const coverages = new WeakMap<AtlasDataset, { key: string; value: ReturnType<typeof getAtlasDataCoverage> }>();
  const installing = new Map<string, AtlasDataset>();
  const controllers = new Map<number, AbortController>();
  const acknowledgements = new Map<string, () => void>();
  let snapshotSequence = 0, chunkSequence = 0;
  function put(key: string, value: AtlasDataset) {
    snapshotKeys.set(value, key);
    snapshots.delete(key); snapshots.set(key, value);
    while (snapshots.size > 3) {
      const oldest = snapshots.keys().next().value!;
      snapshots.delete(oldest); port.postMessage({ type: "evicted", snapshot: oldest });
    }
  }
  function get(key: string): AtlasDataset {
    const dataset = snapshots.get(key);
    if (!dataset) throw Object.assign(new Error("岗位快照已释放，正在重新读取。"), { code: "snapshot-missing" });
    put(key, dataset); return dataset;
  }
  async function chunks(id: number, target: AtlasTable | "summaryBuckets" | "pageBuckets" | "mapFeatures" | "officeBucketIds" | "coordinateStacks", values: unknown[], signal: AbortSignal) {
    for (let offset = 0; offset < values.length; offset += ATLAS_CHUNK_SIZE) {
      signal.throwIfAborted();
      const sequence = ++chunkSequence, key = `${id}:${sequence}`;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { acknowledgements.delete(key); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        acknowledgements.set(key, () => { signal.removeEventListener("abort", abort); resolve(); });
        port.postMessage({ type: "chunk", id, sequence, target, values: values.slice(offset, offset + ATLAS_CHUNK_SIZE) });
      });
    }
  }
  port.onmessage = ({ data: message }) => {
    if (message.type === "ack") { const key = `${message.id}:${message.sequence}`; acknowledgements.get(key)?.(); acknowledgements.delete(key); return; }
    if (message.type === "cancel") { controllers.get(message.id)?.abort(); return; }
    if (message.type === "install") { installing.set(message.snapshot, emptyComputeSnapshot(message.header)); return; }
    if (message.type === "install-chunk") { (installing.get(message.snapshot)?.[message.table] as unknown[] | undefined)?.push(...message.values); return; }
    if (message.type === "installed") {
      const dataset = installing.get(message.snapshot);
      if (dataset) { installing.delete(message.snapshot); put(message.snapshot, dataset); port.postMessage({ type: "result", id: message.id }); }
      return;
    }
    const { id, operation } = message;
    const controller = new AbortController(); controllers.set(id, controller);
    // Give already-queued cancellations a turn before starting expensive work.
    void (async () => {
      await yieldTask(); controller.signal.throwIfAborted();
      if (operation.kind === "snapshot") {
        let previewKey: string | undefined;
        const relayed = new Map(ATLAS_TABLES.map(table => [table, new Set<string>()]));
        const { dataset, base, delta } = await synchronizer.read(operation.endpoint, operation.token, { signal: controller.signal, maxBytes: operation.maxBytes,
          onProgress: async (partial, progress) => {
            controller.signal.throwIfAborted();
            const key = `service-${++snapshotSequence}`; put(key, partial); previewKey = key;
            port.postMessage({ type: "begin-baseline", id, snapshot: key, header: { schemaVersion: 1, revision: partial.revision } });
            for (const table of ATLAS_TABLES) {
              const added = partial[table].filter(row => !relayed.get(table)!.has(datasetEntityId(table, row)));
              await chunks(id, table, added, controller.signal);
              for (const row of added) relayed.get(table)!.add(datasetEntityId(table, row));
            }
            // One closed prefix at a time: acknowledge after the UI has assembled
            // it, so a fast loopback cannot flood the render thread with snapshots.
            const sequence = ++chunkSequence, ack = `${id}:${sequence}`;
            await new Promise<void>((resolve, reject) => {
              const abort = () => { acknowledgements.delete(ack); reject(controller.signal.reason); };
              controller.signal.addEventListener("abort", abort, { once: true });
              acknowledgements.set(ack, () => { controller.signal.removeEventListener("abort", abort); resolve(); });
              port.postMessage({ type: "baseline-checkpoint", id, sequence, progress });
            });
          },
        });
        controller.signal.throwIfAborted();
        const key = snapshotKeys.get(dataset) ?? `service-${++snapshotSequence}`;
        const baseKey = base && snapshotKeys.get(base);
        put(key, dataset);
        if (previewKey === key || operation.knownSnapshots?.includes(key)) {
          port.postMessage({ type: "use-snapshot", id, snapshot: key });
        } else if (delta && baseKey && operation.knownSnapshots?.includes(baseKey)) {
          const { upserts, ...header } = delta;
          port.postMessage({ type: "begin-delta", id, snapshot: key, base: baseKey, delta: header });
          for (const table of ATLAS_TABLES) await chunks(id, table, upserts[table], controller.signal);
        } else {
          // A cancelled/evicted UI transfer can be repaired from this worker's
          // validated baseline without forcing another full HTTP download.
          port.postMessage({ type: "begin-snapshot", id, snapshot: key, header: { schemaVersion: dataset.schemaVersion, revision: dataset.revision } });
          for (const table of ATLAS_TABLES) await chunks(id, table, dataset[table], controller.signal);
        }
      } else if (operation.kind === "page") {
        const dataset = get(operation.snapshot);
        const key = JSON.stringify([operation.query, operation.options, operation.page, (operation.options.now ?? new Date().toISOString()).slice(0, 10)]);
        const cache = pages.get(dataset) ?? new Map<string, Promise<AtlasPageResult>>();
        pages.set(dataset, cache);
        let computation = cache.get(key);
        if (!computation) {
          // A caller's cancellation cannot cancel a shared read. Each observer
          // still discards its own late result; no mutation runs in this worker.
          computation = queryAtlasPageDirect(dataset, operation.query, operation.options, operation.page)
            .then(async value => {
              let geometry = geometries.get(value.summary.mapBuckets);
              if (!geometry) { geometry = prepareAtlasMapGeometry(value.summary.mapBuckets); geometries.set(value.summary.mapBuckets, geometry); }
              return { ...value, geometry: await geometry };
            });
          cache.set(key, computation);
          while (cache.size > 4) cache.delete(cache.keys().next().value!);
          void computation.catch(() => { if (cache.get(key) === computation) cache.delete(key); });
        }
        const result = await computation;
        controller.signal.throwIfAborted();
        const summary = { ...result.summary, mapBuckets: [] };
        const page = result.page === result.summary ? summary : { ...result.page, mapBuckets: [] };
        const geometry = result.geometry ? { ...result.geometry, data: { ...result.geometry.data, features: [] }, officeBucketIds: [], coordinateStacks: [] } : undefined;
        port.postMessage({ type: "begin-page", id, value: { ...result, summary, page, geometry } });
        await chunks(id, "summaryBuckets", result.summary.mapBuckets, controller.signal);
        if (page !== summary) await chunks(id, "pageBuckets", result.page.mapBuckets, controller.signal);
        if (result.geometry) {
          await chunks(id, "mapFeatures", result.geometry.data.features, controller.signal);
          await chunks(id, "officeBucketIds", result.geometry.officeBucketIds, controller.signal);
          await chunks(id, "coordinateStacks", result.geometry.coordinateStacks, controller.signal);
        }
      } else {
        const dataset = get(operation.snapshot);
        const key = JSON.stringify(operation.options), previous = coverages.get(dataset);
        const coverage = operation.options.now && previous?.key === key ? previous.value : getAtlasDataCoverage(dataset, operation.options);
        if (operation.options.now) coverages.set(dataset, { key, value: coverage });
        const companies = new Map(dataset.companies.map(company => [company.id, company]));
        const penetratedIds: string[] = [];
        if (operation.text.trim()) for (let index = 0; index < dataset.jobs.length; index++) {
          const job = dataset.jobs[index]!;
          if (analyzeAiJobRelevance(job, operation.text, companies.get(job.companyId)?.names[0]).isPenetrated) penetratedIds.push(job.id);
          if (index % 256 === 255) { await yieldTask(); controller.signal.throwIfAborted(); }
        }
        port.postMessage({ type: "result", id, value: { coverage, penetratedIds } }); return;
      }
      controller.signal.throwIfAborted(); port.postMessage({ type: "result", id });
    })().catch((error: unknown) => {
      const value = error instanceof Error ? error : new Error("岗位计算失败，请重试。");
      port.postMessage({ type: "error", id, name: value.name, message: value.message, ...("code" in value && typeof value.code === "string" ? { code: value.code } : {}) });
    }).finally(() => { controllers.delete(id); });
  };
}

// No DOM or network is touched by importing this module in a Node test.
if (typeof self !== "undefined" && typeof document === "undefined") startAtlasComputeWorker(self as unknown as WorkerPort);
