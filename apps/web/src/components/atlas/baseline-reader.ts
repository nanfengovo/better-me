import { validateAtlasDatasetReferences, type AtlasDataset } from "@better-me/opportunities";
import { BaselineResponseSchema, BASELINE_MAX_ENTITIES, BASELINE_MAX_ROW_BYTES, type BaselineProgress, type BaselinePage } from "../../../../job-service/src/dataset-baseline-contract";
import { DATASET_TABLES, datasetEntityId, sameDatasetCursor, type DatasetCursor } from "../../../../job-service/src/dataset-sync-contract";
import { DATASET_ENTITY_LIMITS } from "../../../../job-service/src/dataset-tables";
import { readAtlasEnvelope, atlasConnection, type SnapshotOptions } from "./snapshot-transport";
import { AtlasClientError } from "./client-error";

const invalid = () => new AtlasClientError("invalid-response", "岗位分页基线不完整或版本不一致；已显示结果保留，请重试读取。");
const empty = (revision: number): AtlasDataset => ({ schemaVersion: 1, revision, sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] });

/** Runs inside the compute worker. Partial graph fragments never become a queryable snapshot.
 * Publish at geometrically spaced closed checkpoints, avoiding a full-library
 * query, sort and array copy for every network page.
 */
export async function readAtlasBaseline(endpoint: string, token: string, options: SnapshotOptions, previous?: DatasetCursor): Promise<{ dataset: AtlasDataset; cursor: DatasetCursor }> {
  const maxBytes = atlasConnection(endpoint, token, options.maxBytes).maxBytes;
  let session: string | undefined, cursor: DatasetCursor | undefined, sequence = 0, bytes = 0, pages = 0;
  let totals: number | undefined, advertisedJobs = 0, publishedJobs = 0;
  const draft = empty(0), ids = new Map(DATASET_TABLES.map(table => [table, new Set<string>()]));
  let published: AtlasDataset | undefined, next: BaselinePage["next"];
  try {
    do {
      options.signal?.throwIfAborted();
      const response = await readAtlasEnvelope(endpoint, token, { ...options, maxBytes: Math.min(maxBytes, BASELINE_MAX_ROW_BYTES + 4096) }, { path: "/api/v1/dataset/baseline", body: next ? { page: next } : {} });
      if (!response.supported) throw invalid();
      bytes += response.bytes; pages++;
      if (bytes > maxBytes) throw new AtlasClientError("too-large", "分页基线累计超过读取字节上限；已显示结果保留，请缩小数据范围。");
      const parsed = BaselineResponseSchema.safeParse(response.value);
      if (!parsed.success) throw invalid();
      if (parsed.data.kind === "expired") throw new AtlasClientError("invalid-response", "岗位分页会话已过期；已显示结果保留，请重新读取索引。");
      const page = parsed.data;
      // Remember the session before validation too, so a malformed response cannot
      // leave a known read transaction pinned until TTL expiration.
      session ??= page.session; cursor ??= page.cursor; totals ??= page.totalJobs;
      if (page.session !== session || page.sequence !== sequence || !sameDatasetCursor(page.cursor, cursor)
          || page.totalJobs !== totals || page.loadedJobs < advertisedJobs || page.loadedJobs > totals
          || (page.complete ? Boolean(page.next) || !page.checkpoint : !page.next || page.next.session !== session || page.next.sequence !== sequence + 1)
          || (previous?.epoch === cursor.epoch && cursor.revision < previous.revision)) throw invalid();
      advertisedJobs = page.loadedJobs;
      let entities = 0;
      for (const table of DATASET_TABLES) {
        for (const row of page.rows[table]) {
          const id = datasetEntityId(table, row);
          if (ids.get(table)!.has(id)) throw invalid();
          ids.get(table)!.add(id); (draft[table] as unknown[]).push(row); entities++;
        }
        if (draft[table].length > DATASET_ENTITY_LIMITS[table]) throw invalid();
      }
      if (entities > BASELINE_MAX_ENTITIES || draft.jobs.length !== page.loadedJobs || (page.complete && page.loadedJobs !== totals)) throw invalid();
      // A checkpoint may contain detached history with no new jobs. Always
      // publish the complete terminal view, even when all jobs arrived earlier.
      const shouldPublish = page.checkpoint && (page.complete || !published || page.loadedJobs >= Math.max(publishedJobs * 2, publishedJobs + 256));
      if (shouldPublish) {
        const dataset = { ...draft, revision: cursor.revision };
        for (const table of DATASET_TABLES) (dataset as unknown as Record<string, unknown>)[table] = [...draft[table]].sort((a, b) => {
          const left = datasetEntityId(table, a), right = datasetEntityId(table, b); return left < right ? -1 : left > right ? 1 : 0;
        });
        if (validateAtlasDatasetReferences(dataset).length) throw invalid();
        published = dataset; publishedJobs = page.loadedJobs;
        const progress: BaselineProgress = { loadedJobs: page.loadedJobs, totalJobs: totals, pages, complete: page.complete };
        await options.onProgress?.(dataset, progress);
        options.signal?.throwIfAborted();
      }
      next = page.next; sequence++;
      // HTTP streaming already yields; an additional timer per network page can
      // be heavily coalesced in background workers. UI checkpoints are acked.
    } while (next);
    if (!published || !cursor) throw invalid();
    return { dataset: published, cursor };
  } finally {
    if (session) {
      // Cancellation must release the WAL view too. A separate short signal is
      // deliberate: the caller's aborted signal cannot send the release request.
      await readAtlasEnvelope(endpoint, token, { signal: AbortSignal.timeout(2000), maxBytes: 4096 }, { path: "/api/v1/dataset/baseline/close", body: { session } }).catch(() => {});
    }
  }
}
