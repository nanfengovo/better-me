import {
  DEFAULT_TECHNICAL_ALIASES, JobQueryError, JobQuerySchema, queryJobs,
  type AtlasDataset, type JobQueryInput, type JobQueryResult, type JobSearchItem, type QueryOptions,
} from "@better-me/opportunities";
import * as opportunityQueries from "@better-me/opportunities";
import { atlasComputeAvailable, atlasCompute } from "./compute-client";
import { readAtlasSnapshotLegacy, type SnapshotOptions } from "./snapshot-transport";
import type { AtlasMapGeometry } from "./prototypes/map-performance";
export { AtlasClientError } from "./client-error";

export type { SnapshotOptions } from "./snapshot-transport";

/** Read only the public loopback export. The byte limit applies before decoding or parsing. */
export function readAtlasSnapshot(endpoint: string, token: string, options: SnapshotOptions = {}): Promise<AtlasDataset> {
  return atlasComputeAvailable() ? atlasCompute.readSnapshot(endpoint, token, options) : readAtlasSnapshotDirect(endpoint, token, options);
}

/** Also used inside the isolated worker and non-browser tests. */
export async function readAtlasSnapshotDirect(endpoint: string, token: string, options: SnapshotOptions = {}): Promise<AtlasDataset> {
  return readAtlasSnapshotLegacy(endpoint, token, options);
}

export type AtlasPageOptions = { cursor?: string; pageIndex?: number; selectedJobIds?: readonly string[]; signal?: AbortSignal };
export type AtlasPageResult = { summary: JobQueryResult; page: JobQueryResult; pageIndex?: number; geometry?: AtlasMapGeometry };

// Snapshots are replaced atomically by the synchronizer. Never key by revision
// alone: separate repositories may legitimately have the same revision number.
type SnapshotQueryIndex = { search(input: JobQueryInput, options?: QueryOptions): Promise<JobQueryResult> };
const queryIndexes = new WeakMap<AtlasDataset, SnapshotQueryIndex>();
function createSnapshotQueryIndex(data: AtlasDataset): SnapshotQueryIndex {
  // A running dev session may still have the previous workspace-package build.
  // It stays usable until the next deliberate build; do not force a restart or
  // reference a missing static export just to activate this optimization.
  const createIndex = Reflect.get(opportunityQueries, "createJobQueryIndex") as ((data: AtlasDataset) => SnapshotQueryIndex) | undefined;
  return typeof createIndex === "function" ? createIndex(data) : { search: (query, options) => queryJobs(data, query, options) };
}

/** Keep map/statistics on the base query; the list has its own genuine shared-query cursor. */
export function queryAtlasPage(data: AtlasDataset, query: JobQueryInput, options: QueryOptions = {}, page: AtlasPageOptions = {}): Promise<AtlasPageResult> {
  return atlasComputeAvailable() ? atlasCompute.queryPage(data, query, options, page) : queryAtlasPageDirect(data, query, options, page);
}

export async function queryAtlasPageDirect(data: AtlasDataset, query: JobQueryInput, options: QueryOptions = {}, { cursor, pageIndex, selectedJobIds, signal }: AtlasPageOptions = {}): Promise<AtlasPageResult> {
  signal?.throwIfAborted();
  if (pageIndex !== undefined && (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || cursor)) {
    throw new JobQueryError("invalid-query", "页码必须是非负整数，且不能与旧版本游标混用。");
  }
  let index = queryIndexes.get(data);
  if (!index) { index = createSnapshotQueryIndex(data); queryIndexes.set(data, index); }
  const search = index.search;
  const effectiveOptions: QueryOptions = {
    ...options,
    aliases: options.aliases ?? DEFAULT_TECHNICAL_ALIASES,
  };
  const baseQuery: JobQueryInput = { ...query, page: { limit: query.page?.limit } };
  // A refreshed snapshot has a new cursor identity. Resolve it once, then resume
  // the visible page instead of treating every background commit as a new search.
  async function resumePage(first: JobQueryResult, selectedQuery: JobQueryInput): Promise<{ page: JobQueryResult; pageIndex?: number }> {
    if (pageIndex === undefined) return { page: first };
    const limit = first.normalizedQuery.page.limit;
    const index = Math.min(pageIndex, Math.max(0, Math.ceil(first.totalJobs / limit) - 1));
    if (index === 0) return { page: first, pageIndex: 0 };
    signal?.throwIfAborted();
    const page = await search({ ...selectedQuery, page: { limit, cursor: `${first.queryId}:${index * limit}` } }, effectiveOptions);
    signal?.throwIfAborted();
    return { page, pageIndex: index };
  }
  if (selectedJobIds === undefined) {
    const result = await search({ ...baseQuery, page: { ...baseQuery.page, ...(cursor ? { cursor } : {}) } }, effectiveOptions);
    signal?.throwIfAborted();
    const resumed = await resumePage(result, baseQuery);
    return { ...resumed, summary: resumed.page };
  }
  const selection = JobQuerySchema.shape.jobIds.safeParse(selectedJobIds);
  if (!selection.success) throw new JobQueryError("invalid-query", "所选岗位 ID 不符合岗位查询契约。");
  const summary = await search(baseQuery, effectiveOptions);
  signal?.throwIfAborted();
  const baseIds = query.jobIds === undefined ? undefined : new Set(query.jobIds);
  const jobIds = [...new Set(selection.data)].filter((id) => !baseIds || baseIds.has(id)).sort();
  const selectedQuery = { ...baseQuery, jobIds, page: { ...baseQuery.page, ...(cursor ? { cursor } : {}) } };
  const page = await search(selectedQuery, effectiveOptions);
  signal?.throwIfAborted();
  return { summary, ...await resumePage(page, selectedQuery) };
}

export type AtlasJobAction = { title: string; text: string; url?: string; platform: string; observedAt?: string; sourcePublishedAt?: string; sourcePublishedText?: string };

/** A record update or a failed read never becomes a source capture timestamp. */
export function buildAtlasJobAction(data: AtlasDataset, item: JobSearchItem): AtlasJobAction {
  const candidates = item.sources.map((source) => ({ source, listing: data.listings.find((listing) =>
    listing.id === source.listingId && listing.sourceId === source.sourceId && item.job.listingIds.includes(listing.id)
      && (!listing.canonicalJobId || listing.canonicalJobId === item.job.id)) })).filter((entry) => entry.listing);
  const snapshot = item.job.selectedSnapshotId ? data.snapshots.find((entry) => entry.id === item.job.selectedSnapshotId
    && item.job.listingIds.includes(entry.listingId)) : undefined;
  const primary = snapshot ? candidates.find((entry) => entry.listing!.id === snapshot.listingId) : candidates[0];
  const observationIds = new Set(primary?.listing?.observationIds ?? []);
  const observation = primary ? data.observations.filter((entry) => observationIds.has(entry.id)
    && entry.listingId === primary.listing!.id && (entry.result === "read" || entry.result === "partial")
    && (!item.job.selectedSnapshotId || (snapshot?.text === item.job.description && entry.id === snapshot.observationId
      && (!entry.snapshotId || entry.snapshotId === snapshot.id))))
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) || a.id.localeCompare(b.id))[0] : undefined;
  const url = primary ? snapshot?.sourceUrl ?? primary.listing?.canonicalUrl : undefined;
  return {
    title: `${item.company.names[0]} · ${item.job.title.value}`, text: item.job.description,
    ...(url ? { url } : {}), platform: primary?.source.label ?? "来源待核实",
    ...(observation ? { observedAt: observation.fetchedAt } : {}),
    ...(observation?.sourcePublishedAt ? { sourcePublishedAt: observation.sourcePublishedAt } : {}),
    ...(observation?.sourcePublishedRaw ? { sourcePublishedText: observation.sourcePublishedRaw } : {}),
  };
}
