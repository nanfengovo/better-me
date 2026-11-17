import { validateAtlasDatasetReferences, type AtlasDataset, type JobQueryInput, type QueryOptions } from "@better-me/opportunities";
import { BrowseResponseSchema, BrowseQueryResultSchema, BrowsePenetrationResultSchema, AtlasJobEvidenceSchema } from "../../../../job-service/src/browse-contract";
import { DATASET_TABLES, applyDatasetTableDelta, DATASET_SYNC_PROTOCOL, type DatasetDelta } from "../../../../job-service/src/dataset-sync-contract";
import { readAtlasEnvelope, type SnapshotOptions } from "./snapshot-transport";
import { AtlasClientError } from "./client-error";
import type { AtlasPageOptions } from "./client";
import type { SyncedSnapshot } from "./snapshot-sync";

const invalid = () => new AtlasClientError("invalid-response", "岗位浏览投影或版本不一致，请重新读取索引；已入库数据不受影响。");
type Binding = { endpoint: string; token: string; id: string };
type State = { data?: AtlasDataset; binding?: Binding; epoch?: string; tail: Promise<unknown> };
/** Runs in the page-owned worker. Heavy baseline JSON never passes through the renderer.
 * Browse projections are never used by local query/index or full export/import. */
export function createAtlasBrowseReader() {
  const states = new Map<string, State>(), bindings = new WeakMap<AtlasDataset, Binding>();
  async function request(binding: Binding, path: string, body: unknown, signal?: AbortSignal) {
    const result = await readAtlasEnvelope(binding.endpoint, binding.token, { signal }, { path, body });
    if (!result.supported) throw invalid(); return result.value;
  }
  return {
    has: (data: AtlasDataset) => bindings.has(data),
    async read(endpoint: string, token: string, options: SnapshotOptions): Promise<SyncedSnapshot | undefined> {
      const key = JSON.stringify([endpoint, token, options.maxBytes]);
      const state = states.get(key) ?? { tail: Promise.resolve() };
      states.delete(key); states.set(key, state);
      while (states.size > 3) states.delete(states.keys().next().value!);
      const work = state.tail.then(async (): Promise<SyncedSnapshot | undefined> => {
        options.signal?.throwIfAborted();
        const response = await readAtlasEnvelope(endpoint, token, options, { path: "/api/v1/atlas/browse", body: state.binding ? { snapshot: state.binding.id } : {}, allowUnsupported: true });
        if (!response.supported) return undefined;
        const parsed = BrowseResponseSchema.safeParse(response.value);
        if (!parsed.success) throw invalid();
        const value = parsed.data, base = state.data;
        let data: AtlasDataset, delta: DatasetDelta | undefined;
        if (value.kind === "view") data = value.dataset;
        else if (value.kind === "unchanged") {
          if (!base || value.snapshot !== state.binding?.id) throw invalid();
          return { dataset: base, base };
        } else {
          if (!base || value.base !== state.binding?.id || value.revision <= base.revision || value.snapshot === value.base
            || value.upserts.snapshots.length || value.upserts.jobs.some(job => job.description || job.selectedSnapshotId)
            || value.upserts.observations.some(row => row.rawText !== undefined || row.snapshotId !== undefined)) throw invalid();
          data = { ...base, revision: value.revision };
          for (const table of DATASET_TABLES) {
            if (!value.upserts[table].length && !value.deletes[table].length) continue;
            (data as unknown as Record<string, unknown>)[table] = applyDatasetTableDelta<unknown>(table, base[table], value.upserts[table], value.deletes[table]);
          }
          if (validateAtlasDatasetReferences(data).length) throw invalid();
          delta = { protocol: DATASET_SYNC_PROTOCOL, kind: "delta", schemaVersion: 1,
            from: { epoch: state.epoch!, revision: base.revision }, to: { epoch: state.epoch!, revision: data.revision }, upserts: value.upserts, deletes: value.deletes };
        }
        options.signal?.throwIfAborted();
        const binding = { endpoint, token, id: value.snapshot };
        bindings.set(data, binding); state.binding = binding; state.data = data; state.epoch ??= value.snapshot;
        return { dataset: data, ...(base ? { base } : {}), ...(delta ? { delta } : {}) };
      });
      state.tail = work.then(() => {}, () => {}); return work;
    },
    async query(data: AtlasDataset, query: JobQueryInput, options: QueryOptions, { signal, ...page }: AtlasPageOptions) {
      const binding = bindings.get(data); if (!binding) throw invalid();
      const parsed = BrowseQueryResultSchema.safeParse(await request(binding, "/api/v1/atlas/query", { snapshot: binding.id, query, options, page }, signal));
      if (!parsed.success || parsed.data.summary.snapshotVersion !== data.revision || parsed.data.page.snapshotVersion !== data.revision) throw invalid();
      return parsed.data;
    },
    async penetration(data: AtlasDataset, text: string, signal: AbortSignal): Promise<string[]> {
      const binding = bindings.get(data); if (!binding) throw invalid();
      const parsed = BrowsePenetrationResultSchema.safeParse(await request(binding, "/api/v1/atlas/penetration", { snapshot: binding.id, text }, signal));
      const ids = new Set(data.jobs.map(job => job.id));
      if (!parsed.success || parsed.data.snapshot !== binding.id || new Set(parsed.data.penetratedIds).size !== parsed.data.penetratedIds.length || parsed.data.penetratedIds.some(id => !ids.has(id))) throw invalid();
      return parsed.data.penetratedIds;
    },
    async detail(data: AtlasDataset, jobId: string, signal?: AbortSignal) {
      const binding = bindings.get(data); if (!binding) throw invalid();
      const parsed = AtlasJobEvidenceSchema.safeParse(await request(binding, "/api/v1/atlas/detail", { snapshot: binding.id, jobId }, signal));
      if (!parsed.success || parsed.data.snapshotRevision !== data.revision || parsed.data.job.id !== jobId || parsed.data.company.id !== parsed.data.job.companyId) throw invalid();
      return parsed.data;
    },
  };
}
