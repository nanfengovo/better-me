import type { AtlasDataset } from "@better-me/opportunities";
import {
  DatasetSyncResponseSchema, applyDatasetDelta, sameDatasetCursor,
  type DatasetCursor, type DatasetDelta,
} from "../../../../job-service/src/dataset-sync-contract";
import { AtlasClientError } from "./client-error";
import { atlasConnection, readAtlasEnvelope, readAtlasSnapshotLegacy, type SnapshotOptions } from "./snapshot-transport";

export type SyncedSnapshot = { dataset: AtlasDataset; base?: AtlasDataset; delta?: DatasetDelta };
type State = { dataset?: AtlasDataset; cursor?: DatasetCursor; legacyUntil?: number; tail: Promise<unknown> };
const invalid = () => new AtlasClientError("invalid-response", "岗位增量版本或引用不一致；保留上一份可用结果，请重试同步。");

/** One serialized revision stream per authenticated connection. Never exposes a partial dataset. */
export function createAtlasSnapshotSynchronizer() {
  const connections = new Map<string, State>();
  return {
    async read(endpoint: string, token: string, options: SnapshotOptions = {}): Promise<SyncedSnapshot> {
      options.signal?.throwIfAborted();
      const connection = atlasConnection(endpoint, token, options.maxBytes);
      const key = JSON.stringify([connection.url.origin, connection.token, connection.maxBytes]);
      const state = connections.get(key) ?? { tail: Promise.resolve() };
      connections.delete(key); connections.set(key, state);
      while (connections.size > 3) connections.delete(connections.keys().next().value!);
      const work = state.tail.then(async (): Promise<SyncedSnapshot> => {
        options.signal?.throwIfAborted();
        const base = state.dataset;
        if ((state.legacyUntil ?? 0) > Date.now()) {
          const dataset = await readAtlasSnapshotLegacy(endpoint, token, options);
          options.signal?.throwIfAborted(); state.dataset = dataset;
          return { dataset, ...(base ? { base } : {}) };
        }
        const result = await readAtlasEnvelope(endpoint, token, options, { path: "/api/v1/dataset/sync", body: state.cursor ? { cursor: state.cursor } : {}, allowUnsupported: true });
        if (!result.supported) {
          const dataset = await readAtlasSnapshotLegacy(endpoint, token, options);
          options.signal?.throwIfAborted();
          state.dataset = dataset; state.cursor = undefined; state.legacyUntil = Date.now() + 30_000;
          return { dataset, ...(base ? { base } : {}) };
        }
        const parsed = DatasetSyncResponseSchema.safeParse(result.value);
        if (!parsed.success) throw invalid();
        const response = parsed.data;
        let dataset: AtlasDataset;
        if (response.kind === "unchanged") {
          if (!base || !state.cursor || !sameDatasetCursor(state.cursor, response.cursor)) throw invalid();
          dataset = base;
        } else if (response.kind === "snapshot") {
          if (state.cursor?.epoch === response.cursor.epoch && response.cursor.revision < state.cursor.revision) throw invalid();
          dataset = response.dataset;
        } else {
          if (!base || !state.cursor) throw invalid();
          try { dataset = applyDatasetDelta(base, state.cursor, response); } catch { throw invalid(); }
        }
        options.signal?.throwIfAborted();
        state.dataset = dataset;
        state.cursor = response.kind === "delta" ? response.to : response.cursor;
        return { dataset, ...(base ? { base } : {}), ...(response.kind === "delta" ? { delta: response } : {}) };
      });
      // A failed/cancelled poll does not poison the next one or advance its cursor.
      state.tail = work.then(() => {}, () => {});
      return work;
    },
  };
}
