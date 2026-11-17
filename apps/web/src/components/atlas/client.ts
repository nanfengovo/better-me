import {
  queryJobPage,
  type AtlasDataset, type JobQueryInput, type JobQueryResult, type JobSearchItem, type QueryOptions,
} from "@better-me/opportunities";
import { atlasComputeAvailable, atlasCompute } from "./compute-client";
import { readAtlasSnapshotLegacy, type SnapshotOptions } from "./snapshot-transport";
import type { AtlasMapGeometry } from "./prototypes/map-performance";
import { createAtlasBrowseReader } from "./browse-reader";
import { getAtlasDataCoverage, type AtlasCoverageOptions } from "./coverage";
import { analyzeAiJobRelevance } from "./ai-job-relevance";
import { AtlasClientError } from "./client-error";
export { AtlasClientError } from "./client-error";

export type { SnapshotOptions } from "./snapshot-transport";
const directBrowse = createAtlasBrowseReader();
export const isAtlasBrowseDataset = (data: AtlasDataset | null | undefined): data is AtlasDataset & { view: "browse" } => Boolean(data && "view" in data && data.view === "browse");
/** Display-only projection. Complete export/ingestion callers keep readAtlasSnapshot. */
export async function readAtlasBrowseSnapshot(endpoint: string, token: string, options: SnapshotOptions = {}): Promise<AtlasDataset> {
  if (atlasComputeAvailable()) return atlasCompute.readSnapshot(endpoint, token, { ...options, view: "browse" });
  return (await directBrowse.read(endpoint, token, options))?.dataset ?? readAtlasSnapshotDirect(endpoint, token, options);
}
export async function readAtlasMetadata(data: AtlasDataset, options: AtlasCoverageOptions, text: string, signal?: AbortSignal) {
  if (atlasComputeAvailable()) return atlasCompute.metadata(data, options, text, signal);
  if (isAtlasBrowseDataset(data) && !directBrowse.has(data)) throw new AtlasClientError("invalid-response", "岗位浏览会话已释放，请重新读取索引。");
  const companies = new Map(data.companies.map(row => [row.id, row]));
  return { coverage: getAtlasDataCoverage(data, options), penetratedIds: directBrowse.has(data)
    ? text.trim() ? await directBrowse.penetration(data, text, signal ?? AbortSignal.timeout(30_000)) : []
    : text.trim() ? data.jobs.filter(job => analyzeAiJobRelevance(job, text, companies.get(job.companyId)?.names[0]).isPenetrated).map(job => job.id) : [] };
}
export async function readAtlasJobEvidence(data: AtlasDataset, jobId: string, signal?: AbortSignal) {
  return atlasComputeAvailable() ? atlasCompute.detail(data, jobId, signal) : directBrowse.detail(data, jobId, signal);
}

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

/** Keep map/statistics on the base query; the list has its own genuine shared-query cursor. */
export function queryAtlasPage(data: AtlasDataset, query: JobQueryInput, options: QueryOptions = {}, page: AtlasPageOptions = {}): Promise<AtlasPageResult> {
  return atlasComputeAvailable() ? atlasCompute.queryPage(data, query, options, page) : queryAtlasPageDirect(data, query, options, page);
}

export async function queryAtlasPageDirect(data: AtlasDataset, query: JobQueryInput, options: QueryOptions = {}, { cursor, pageIndex, selectedJobIds, signal }: AtlasPageOptions = {}): Promise<AtlasPageResult> {
  signal?.throwIfAborted();
  if (directBrowse.has(data)) return directBrowse.query(data, query, options, { cursor, pageIndex, selectedJobIds, signal });
  if (isAtlasBrowseDataset(data)) throw new AtlasClientError("invalid-response", "岗位浏览会话已释放，请重新读取索引。");
  return queryJobPage(data, query, options, { cursor, pageIndex, selectedJobIds, signal });
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
