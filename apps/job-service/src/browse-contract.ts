import { z } from "zod";
import { AtlasDatasetObjectSchema, validateAtlasDatasetReferences, JobQuerySchema, QueryOptionsSchema, JobQueryResultSchema, EntityIdSchema, RevisionSchema, CanonicalJobSchema, CompanySchema, JobLocationSchema, CompensationSchema, SourceListingSchema, SourceObservationSchema, JdSnapshotSchema, SourceDefinitionSchema } from "@better-me/opportunities";
import { DatasetUpsertsSchema, DatasetDeletesSchema, DATASET_TABLES, datasetEntityId, MAX_DELTA_ENTITIES, type DatasetUpserts } from "./dataset-sync-contract.js";

export const BROWSE_PROTOCOL = "better-me/atlas-browse-v1" as const;
export const BrowseIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
/** Deliberately not a complete AtlasDataset: import/export schemas reject the view marker. */
export const BrowseDatasetSchema = AtlasDatasetObjectSchema.extend({ view: z.literal("browse") }).superRefine((data, context) => {
  if (data.snapshots.length || data.jobs.some(job => job.description || job.selectedSnapshotId)
      || data.observations.some(row => row.rawText !== undefined || row.snapshotId !== undefined)) context.addIssue({ code: "custom", message: "Browse views cannot contain full text." });
  for (const issue of validateAtlasDatasetReferences(data)) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
});
export type BrowseDataset = z.infer<typeof BrowseDatasetSchema>;
export const BrowseRequestSchema = z.object({ snapshot: BrowseIdSchema.optional() }).strict();
export const BrowseResponseSchema = z.discriminatedUnion("kind", [
  z.object({ protocol: z.literal(BROWSE_PROTOCOL), kind: z.literal("view"), snapshot: BrowseIdSchema, dataset: BrowseDatasetSchema }).strict(),
  z.object({ protocol: z.literal(BROWSE_PROTOCOL), kind: z.literal("unchanged"), snapshot: BrowseIdSchema }).strict(),
  z.object({ protocol: z.literal(BROWSE_PROTOCOL), kind: z.literal("delta"), snapshot: BrowseIdSchema, base: BrowseIdSchema,
    revision: z.number().int().nonnegative(), upserts: DatasetUpsertsSchema, deletes: DatasetDeletesSchema }).strict(),
]).superRefine((value, context) => {
  if (value.kind !== "delta") return;
  let count = 0;
  for (const table of DATASET_TABLES) {
    const ids = [...value.upserts[table].map(row => datasetEntityId(table, row)), ...value.deletes[table]];
    count += ids.length;
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: [table], message: "Duplicate browse delta entity." });
  }
  if (count > MAX_DELTA_ENTITIES) context.addIssue({ code: "custom", message: "Browse delta entity budget exceeded." });
});
export type BrowseResponse = z.infer<typeof BrowseResponseSchema>;
export const BrowsePageSchema = z.object({ cursor: z.string().max(500).optional(), pageIndex: z.number().int().nonnegative().optional(), selectedJobIds: z.array(EntityIdSchema).max(100_000).optional() }).strict();
export const BrowseQuerySchema = z.object({ snapshot: BrowseIdSchema, query: JobQuerySchema, options: QueryOptionsSchema.optional(), page: BrowsePageSchema.optional() }).strict();
export const BrowseQueryResultSchema = z.object({ summary: JobQueryResultSchema, page: JobQueryResultSchema, pageIndex: z.number().int().nonnegative().optional() }).strict();
export const BrowsePenetrationSchema = z.object({ snapshot: BrowseIdSchema, text: z.string().max(300) }).strict();
export const BrowsePenetrationResultSchema = z.object({ snapshot: BrowseIdSchema, penetratedIds: z.array(EntityIdSchema).max(100_000) }).strict();
export const BrowseDetailInputSchema = z.object({ snapshot: BrowseIdSchema, jobId: EntityIdSchema }).strict();
export const AtlasJobEvidenceSchema = z.object({ snapshotRevision: RevisionSchema, job: CanonicalJobSchema, company: CompanySchema,
  locations: z.array(JobLocationSchema), compensations: z.array(CompensationSchema), listings: z.array(SourceListingSchema), observations: z.array(SourceObservationSchema), snapshots: z.array(JdSnapshotSchema), sources: z.array(SourceDefinitionSchema) }).strict();
export type AtlasJobEvidence = z.infer<typeof AtlasJobEvidenceSchema>;

/** Keep structured facts, source provenance and publication/conflict metadata.
 * Diagnostic history, evidence excerpts/selectors and full text are detail-only.
 * No durable entity or history record is changed by this projection. */
export function projectBrowseRows(rows: DatasetUpserts): DatasetUpserts {
  const referenced = new Set<string>();
  function compact<T>(value: T): T {
    if (Array.isArray(value)) return value.map(item => compact(item)) as T;
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.observationId === "string" && typeof record.sourceUrl === "string" && typeof record.observedAt === "string") {
      referenced.add(record.observationId);
      const { quote: _quote, selector: _selector, ...reference } = record;
      return reference as T;
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, compact(item)])) as T;
  }
  const structured = compact({ ...rows, jobs: rows.jobs.map(({ selectedSnapshotId: _snapshot, ...job }) => ({ ...job, description: "" })), observations: [], snapshots: [] });
  // Keep every publication disclosure (including simultaneous conflicts), plus
  // every observation still referenced by a structured fact. History is fetched
  // for one selected job, never represented as a complete backup by this view.
  const observations = rows.observations.filter(row => referenced.has(row.id)
    || (row.result === "read" || row.result === "partial") && Boolean(row.sourcePublishedAt || row.sourcePublishedRaw?.trim()))
    .map(({ rawText: _text, snapshotId: _snapshot, contentHash: _hash, warnings: _warnings, ...row }) => ({ ...row, warnings: [] }));
  const kept = new Set(observations.map(row => row.id));
  return { ...structured, observations, listings: structured.listings.map(row => ({ ...row, observationIds: row.observationIds.filter(id => kept.has(id)) })) };
}
