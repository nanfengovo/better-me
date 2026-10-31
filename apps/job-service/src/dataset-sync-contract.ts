import { z } from "zod";
import { AtlasDatasetObjectSchema, AtlasDatasetSchema, EntityIdSchema, validateAtlasDatasetReferences, type AtlasDataset } from "@better-me/opportunities";
import { DATASET_TABLES, type DatasetTable } from "./dataset-tables.js";
export { DATASET_TABLES, type DatasetTable } from "./dataset-tables.js";

/** Pure transport contract. No SQLite, query engine, UI or service credentials. */
export const DATASET_SYNC_PROTOCOL = "better-me/atlas-sync-v1" as const;
export const MAX_DELTA_ENTITIES = 4096;
export const MAX_DELTA_BYTES = 4 * 1024 * 1024;
export const SYNC_REVISION_WINDOW = 512;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DatasetCursorSchema = z.object({ epoch: z.string().regex(/^[a-f0-9]{32}$/), revision }).strict();
export type DatasetCursor = z.infer<typeof DatasetCursorSchema>;
export const DatasetSyncRequestSchema = z.object({ cursor: DatasetCursorSchema.optional() }).strict();
export type DatasetSyncRequest = z.infer<typeof DatasetSyncRequestSchema>;
export const DatasetUpsertsSchema = AtlasDatasetObjectSchema.omit({ schemaVersion: true, revision: true });
export type DatasetUpserts = z.infer<typeof DatasetUpsertsSchema>;
const deletedIds = z.array(EntityIdSchema).max(MAX_DELTA_ENTITIES);
export const DatasetDeletesSchema = z.object({
  sources: deletedIds, companies: deletedIds, jobs: deletedIds, locations: deletedIds,
  compensations: deletedIds, listings: deletedIds, observations: deletedIds, snapshots: deletedIds,
}).strict();
export type DatasetDeletes = z.infer<typeof DatasetDeletesSchema>;
export const DatasetDeltaSchema = z.object({
  protocol: z.literal(DATASET_SYNC_PROTOCOL), kind: z.literal("delta"), schemaVersion: z.literal(1),
  from: DatasetCursorSchema, to: DatasetCursorSchema, upserts: DatasetUpsertsSchema, deletes: DatasetDeletesSchema,
}).strict();
export type DatasetDelta = z.infer<typeof DatasetDeltaSchema>;
export const DatasetSyncResponseSchema = z.discriminatedUnion("kind", [
  z.object({ protocol: z.literal(DATASET_SYNC_PROTOCOL), kind: z.literal("baseline-required"), cursor: DatasetCursorSchema,
    reason: z.enum(["initial", "cursor-expired", "store-changed", "cursor-ahead", "delta-too-large"]) }).strict(),
  z.object({ protocol: z.literal(DATASET_SYNC_PROTOCOL), kind: z.literal("snapshot"), cursor: DatasetCursorSchema,
    reason: z.enum(["initial", "cursor-expired", "store-changed", "cursor-ahead", "delta-too-large"]), dataset: AtlasDatasetSchema }).strict(),
  DatasetDeltaSchema,
  z.object({ protocol: z.literal(DATASET_SYNC_PROTOCOL), kind: z.literal("unchanged"), cursor: DatasetCursorSchema }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "snapshot" && value.cursor.revision !== value.dataset.revision) context.addIssue({ code: "custom", message: "Snapshot cursor mismatch." });
  if (value.kind !== "delta") return;
  if (value.from.epoch !== value.to.epoch || value.to.revision <= value.from.revision) context.addIssue({ code: "custom", message: "Invalid delta revision." });
  let entities = 0;
  for (const table of DATASET_TABLES) {
    const ids = value.upserts[table].map(row => datasetEntityId(table, row));
    const removals = value.deletes[table];
    entities += ids.length + removals.length;
    if (new Set([...ids, ...removals]).size !== ids.length + removals.length) context.addIssue({ code: "custom", message: "Duplicate delta entity.", path: [table] });
  }
  if (entities > MAX_DELTA_ENTITIES) context.addIssue({ code: "custom", message: "Delta entity budget exceeded." });
});
export type DatasetSyncResponse = z.infer<typeof DatasetSyncResponseSchema>;

export function datasetEntityId(table: DatasetTable, row: unknown): string {
  return (row as Record<string, string>)[table === "sources" ? "sourceId" : "id"]!;
}
export function emptyDatasetUpserts(): DatasetUpserts {
  return { sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
}
export function emptyDatasetDeletes(): DatasetDeletes {
  return { sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
}
export function sameDatasetCursor(left: DatasetCursor, right: DatasetCursor): boolean {
  return left.epoch === right.epoch && left.revision === right.revision;
}

export function applyDatasetTableDelta<T>(table: DatasetTable, baseline: readonly T[], upserts: readonly T[], deletes: readonly string[]): T[] {
  const changed = new Map<string, T>(upserts.map(row => [datasetEntityId(table, row), row]));
  const removed = new Set(deletes);
  const rows: T[] = [];
  for (const row of baseline) {
    const id = datasetEntityId(table, row);
    if (removed.has(id)) continue;
    rows.push(changed.has(id) ? changed.get(id)! : row);
    changed.delete(id);
  }
  rows.push(...changed.values());
  // Stable codepoint order, matching SQLite's public snapshot rather than locale order.
  rows.sort((a, b) => { const left = datasetEntityId(table, a), right = datasetEntityId(table, b); return left < right ? -1 : left > right ? 1 : 0; });
  return rows;
}

/** Atomic, structurally shared application. Only changed rows have been reparsed. */
export function applyDatasetDelta(baseline: AtlasDataset, cursor: DatasetCursor, delta: DatasetDelta, validateReferences = true): AtlasDataset {
  if (!sameDatasetCursor(cursor, delta.from) || baseline.revision !== cursor.revision || delta.to.epoch !== cursor.epoch || delta.to.revision <= cursor.revision) throw new Error("dataset-sync-base-mismatch");
  const next: AtlasDataset = { ...baseline, revision: delta.to.revision };
  for (const table of DATASET_TABLES) {
    if (!delta.upserts[table].length && !delta.deletes[table].length) continue;
    (next as unknown as Record<string, unknown>)[table] = applyDatasetTableDelta<unknown>(table, baseline[table], delta.upserts[table], delta.deletes[table]);
  }
  if (validateReferences && validateAtlasDatasetReferences(next).length) throw new Error("dataset-sync-reference-mismatch");
  return next;
}
