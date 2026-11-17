import { randomBytes } from "node:crypto";
import { ToolError, queryJobPage, analyzeAiJobRelevance, type AtlasDataset, type ToolHandlerContext, type JobQueryResult } from "@better-me/opportunities";
import type { z } from "zod";
import { BROWSE_PROTOCOL, projectBrowseRows, type BrowseDataset, type BrowseResponse, type BrowseQuerySchema, type BrowsePenetrationSchema } from "./browse-contract.js";
import { DATASET_TABLES, datasetEntityId, emptyDatasetUpserts, emptyDatasetDeletes, MAX_DELTA_ENTITIES, MAX_DELTA_BYTES, sameDatasetCursor, type DatasetCursor, type DatasetSyncResponse } from "./dataset-sync-contract.js";

type Entry = { id: string; cursor: DatasetCursor; source: AtlasDataset; view: BrowseDataset; rows: Map<string, string> };
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** One bounded, read-only browse module. Snapshot IDs bind page/metadata reads to the
 * exact captured object, not just a revision shared by independent stores. */
export function createAtlasBrowse(repository: { readSnapshot(): Promise<AtlasDataset>; syncSnapshot(input: object, paged: boolean): Promise<DatasetSyncResponse> }) {
  const entries = new Map<string, Entry>();
  function get(id: string) {
    const entry = entries.get(id);
    if (!entry) throw new ToolError("stale-version");
    return entry;
  }
  async function current() {
    let source: AtlasDataset | undefined, cursor: DatasetCursor | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await repository.syncSnapshot({}, true);
      if (before.kind !== "baseline-required") throw new ToolError("internal-error");
      for (const entry of entries.values()) if (sameDatasetCursor(entry.cursor, before.cursor)) return entry;
      const candidate = await repository.readSnapshot();
      const after = await repository.syncSnapshot({}, true);
      if (after.kind === "baseline-required" && sameDatasetCursor(before.cursor, after.cursor) && candidate.revision === after.cursor.revision) { source = candidate; cursor = after.cursor; break; }
    }
    if (!source || !cursor) throw new ToolError("stale-version");
    // Concurrent first readers may finish the same capture together. Reuse its
    // identity so one observer cannot evict another observer's identical view.
    for (const entry of entries.values()) if (sameDatasetCursor(entry.cursor, cursor)) return entry;
    const id = randomBytes(16).toString("hex");
    const view: BrowseDataset = { ...projectBrowseRows(source), schemaVersion: 1, revision: source.revision, view: "browse" };
    const rows = new Map<string, string>();
    for (const table of DATASET_TABLES) for (const row of view[table]) rows.set(`${table}:${datasetEntityId(table, row)}`, JSON.stringify(row));
    const entry = { id, cursor, source, view, rows }; entries.set(id, entry);
    while (entries.size > 2) entries.delete(entries.keys().next().value!);
    return entry;
  }
  return {
    async read(input: { snapshot?: string }): Promise<BrowseResponse> {
      const next = await current();
      if (input.snapshot === next.id) return { protocol: BROWSE_PROTOCOL, kind: "unchanged", snapshot: next.id };
      const previous = input.snapshot ? entries.get(input.snapshot) : undefined;
      if (previous && previous.cursor.epoch === next.cursor.epoch && previous.source.revision < next.source.revision) {
        const upserts = emptyDatasetUpserts(), deletes = emptyDatasetDeletes(); let count = 0;
        for (const table of DATASET_TABLES) {
          for (const row of next.view[table]) {
            const id = datasetEntityId(table, row), key = `${table}:${id}`;
            if (next.rows.get(key) !== previous.rows.get(key)) { (upserts[table] as unknown[]).push(row); count++; }
          }
          for (const row of previous.view[table]) {
            const id = datasetEntityId(table, row);
            if (!next.rows.has(`${table}:${id}`)) { deletes[table].push(id); count++; }
          }
        }
        const delta: BrowseResponse = { protocol: BROWSE_PROTOCOL, kind: "delta", snapshot: next.id, base: previous.id, revision: next.source.revision, upserts, deletes };
        if (count <= MAX_DELTA_ENTITIES && Buffer.byteLength(JSON.stringify(delta)) <= MAX_DELTA_BYTES) return delta;
      }
      return { protocol: BROWSE_PROTOCOL, kind: "view", snapshot: next.id, dataset: next.view };
    },
    async query(input: z.infer<typeof BrowseQuerySchema>, context: ToolHandlerContext): Promise<{ summary: JobQueryResult; page: JobQueryResult; pageIndex?: number }> {
      context.throwIfCancelled();
      const result = await queryJobPage(get(input.snapshot).source, input.query, input.options, { ...input.page, signal: context.signal });
      context.throwIfCancelled(); return wire(result);
    },
    async penetration(input: z.infer<typeof BrowsePenetrationSchema>, context: ToolHandlerContext) {
      const data = get(input.snapshot).source, companies = new Map(data.companies.map(row => [row.id, row]));
      const penetratedIds: string[] = [];
      if (input.text.trim()) for (let index = 0; index < data.jobs.length; index++) {
        const job = data.jobs[index]!;
        if (analyzeAiJobRelevance(job, input.text, companies.get(job.companyId)?.names[0]).isPenetrated) penetratedIds.push(job.id);
        if (index % 256 === 255) { await new Promise<void>(resolve => setTimeout(resolve, 0)); context.throwIfCancelled(); }
      }
      context.throwIfCancelled(); return { snapshot: input.snapshot, penetratedIds };
    },
    async detail(input: { snapshot: string; jobId: string }, context: ToolHandlerContext) {
      context.throwIfCancelled();
      const data = get(input.snapshot).source, job = data.jobs.find(row => row.id === input.jobId);
      if (!job) throw new ToolError("invalid-input");
      const listings = data.listings.filter(row => job.listingIds.includes(row.id));
      return wire({ snapshotRevision: data.revision, job, company: data.companies.find(row => row.id === job.companyId)!,
        locations: data.locations.filter(row => job.locationIds.includes(row.id)), compensations: data.compensations.filter(row => job.compensationIds.includes(row.id)), listings,
        observations: data.observations.filter(row => job.listingIds.includes(row.listingId)), snapshots: data.snapshots.filter(row => job.listingIds.includes(row.listingId)),
        sources: data.sources.filter(row => listings.some(listing => listing.sourceId === row.sourceId)) });
    },
  };
}
