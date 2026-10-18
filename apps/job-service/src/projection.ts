import { createHash } from "node:crypto";
import {
  AtlasDatasetObjectSchema, deriveEntityId, normalizeSourceUrl, ToolError, type AtlasDataset,
  type CanonicalJob, type EvidenceRef, type SourceDefinition,
} from "@better-me/opportunities";
import { SourceJobRecordSchema, type SourceJobRecord, type SourcePage } from "@better-me/source-adapters";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stableValue(item)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
const unique = <T>(values: readonly T[]) => [...new Set(values)];
export function emptyDelta(revision = 0): AtlasDataset {
  return { schemaVersion: 1, revision, sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
}
export type ProjectedLead = { id: string; sourceId: string; observedAt: string; record: SourceJobRecord };
export type SourceProjection = { delta: AtlasDataset; leads: ProjectedLead[]; unchangedJobs: number };

/** Pure projection. External claims never become personal facts or inferred company ownership. */
export async function projectSourcePage(snapshot: AtlasDataset, source: SourceDefinition, page: SourcePage, runId: string): Promise<SourceProjection> {
  const delta = emptyDelta(snapshot.revision);
  delta.sources.push(source);
  const leads: ProjectedLead[] = [];
  const seen = new Map<string, string>();
  let unchangedJobs = 0;
  for (const input of page.records) {
    const record = SourceJobRecordSchema.parse(input);
    const identity = record.sourceRecordId ?? normalizeSourceUrl(record.url!);
    const listingId = await deriveEntityId("listing", [source.sourceId, identity]);
    const signature = digest(record);
    if (seen.has(listingId)) {
      if (seen.get(listingId) !== signature) throw new Error("conflicting-source-record");
      continue;
    }
    seen.set(listingId, signature);
    // Campaigns, directories and incomplete employer identities remain discoverable leads.
    if (record.entityType !== "job-posting" || !record.companyName) {
      leads.push({ id: await deriveEntityId("lead", [source.sourceId, identity]), sourceId: source.sourceId, observedAt: page.observedAt,
        record: { ...record, entityType: record.entityType === "recruitment-campaign" ? "recruitment-campaign" : "discovery-lead", completeness: "lead" } });
      continue;
    }
    const oldListing = snapshot.listings.find((listing) => listing.id === listingId);
    const jobId = oldListing?.canonicalJobId ?? await deriveEntityId("job", [source.sourceId, identity]);
    const oldJob = snapshot.jobs.find((job) => job.id === jobId);
    const companyId = oldJob?.companyId ?? await deriveEntityId("company", [source.sourceId, record.companyName.normalize("NFKC").trim().toLowerCase()]);
    const oldCompany = snapshot.companies.find((company) => company.id === companyId);
    const normalizeName = (name: string) => name.normalize("NFKC").trim().toLowerCase();
    if (oldCompany && !oldCompany.names.some((name) => normalizeName(name) === normalizeName(record.companyName!))) throw new ToolError("source-changed");
    // Cursor overlap is common. Replaying an identical record in one run must not conflict
    // with its immutable observation, while changed content gets a separate observation.
    const observationId = await deriveEntityId("observation", [listingId, runId, signature]);
    if (snapshot.observations.some((observation) => observation.id === observationId)) { unchangedJobs++; continue; }
    const evidence = (field: string, quote?: string): EvidenceRef[] => {
      const entries = record.evidence.filter((entry) => entry.field === field || entry.field.startsWith(`${field}.`));
      if (entries.length) return entries.slice(0, 200).map(({ sourceUrl, selector, quote }) => ({ observationId, sourceUrl, observedAt: page.observedAt, ...(selector ? { selector } : {}), ...(quote ? { quote } : {}) }));
      return record.url && quote ? [{ observationId, sourceUrl: record.url, observedAt: page.observedAt, quote: quote.slice(0, 20_000) }] : [];
    };
    if (!snapshot.companies.some((company) => company.id === companyId) && !delta.companies.some((company) => company.id === companyId)) {
      delta.companies.push({ id: companyId, names: [record.companyName], domains: [], parentCompanyIds: [], manualOverrides: [], ultimateControllers: { value: [], evidence: [], method: "source-structured", verification: "unknown", revision: 0 } });
    }
    const locationIds: string[] = [];
    for (const location of record.locations) {
      const kind = (record.workMode === "unknown" ? oldJob?.workMode : record.workMode) === "remote" ? "remote-region" : "office";
      const id = await deriveEntityId("location", [listingId, kind, digest(location)]);
      locationIds.push(id);
      if (!snapshot.locations.some((item) => item.id === id) && !delta.locations.some((item) => item.id === id)) delta.locations.push({ id, ...location, kind, precision: location.city ? "city" : location.region ? "region" : location.countryCode ? "country" : "unknown", evidence: evidence("locations", location.raw), verification: "unverified" });
    }
    // No disclosed value is not evidence that a former address or salary was removed.
    if (!record.locations.length) locationIds.push(...(oldListing?.locationIds ?? []).filter((id) => record.workMode !== "remote" || snapshot.locations.find((location) => location.id === id)?.kind === "remote-region"));
    const compensationIds: string[] = [];
    for (const compensation of record.compensations) {
      const id = await deriveEntityId("compensation", [listingId, digest(compensation)]);
      compensationIds.push(id);
      if (!snapshot.compensations.some((item) => item.id === id) && !delta.compensations.some((item) => item.id === id)) delta.compensations.push({ id, ...compensation, evidence: evidence("compensations", compensation.raw), verification: "unverified" });
    }
    if (!record.compensations.length) compensationIds.push(...(oldListing?.compensationIds ?? []));
    const description = record.description ?? "";
    const contentHash = createHash("sha256").update(description).digest("hex");
    const oldSnapshot = snapshot.snapshots.find((item) => item.listingId === listingId && item.contentHash === contentHash && item.text === description);
    const snapshotId = description ? oldSnapshot?.id ?? await deriveEntityId("snapshot", [listingId, contentHash]) : undefined;
    if (snapshotId && !oldSnapshot && !delta.snapshots.some((item) => item.id === snapshotId)) delta.snapshots.push({ id: snapshotId, listingId, observationId, text: description, contentHash, createdAt: page.observedAt, ...(record.url ? { sourceUrl: record.url } : {}), extractionMethod: "source-structured", completeness: record.completeness });
    const keepOther = (current: string[], oldContribution: string[] | undefined) => oldJob && oldJob.listingIds.length > 1 ? current.filter((id) => !oldContribution?.includes(id)) : [];
    const title = oldJob?.title.value === record.title || oldJob?.title.method === "manual" ? oldJob.title : { value: record.title, evidence: evidence("title", record.title), method: "source-structured" as const, verification: "unverified" as const, revision: (oldJob?.title.revision ?? -1) + 1 };
    const next: CanonicalJob = {
      ...oldJob, id: jobId, companyId, title, description: record.description ?? oldJob?.description ?? "",
      locationIds: unique([...keepOther(oldJob?.locationIds ?? [], oldListing?.locationIds), ...locationIds]),
      compensationIds: unique([...keepOther(oldJob?.compensationIds ?? [], oldListing?.compensationIds), ...compensationIds]),
      listingIds: unique([...(oldJob?.listingIds ?? []), listingId]),
      ...(snapshotId ? { selectedSnapshotId: snapshotId } : {}), workMode: record.workMode === "unknown" ? oldJob?.workMode ?? "unknown" : record.workMode, employmentType: record.employmentType === "unknown" ? oldJob?.employmentType ?? "unknown" : record.employmentType,
      remoteEligibleRegions: unique(record.remoteEligibleRegions.length ? record.remoteEligibleRegions : oldJob?.remoteEligibleRegions ?? []), status: record.availability === "unknown" ? oldJob?.status ?? "unknown" : record.availability,
      revision: oldJob?.revision ?? 0, updatedAt: oldJob?.updatedAt ?? page.observedAt,
    };
    const changed = !oldJob || digest(next) !== digest(oldJob);
    if (changed && oldJob) { next.revision++; next.updatedAt = page.observedAt; }
    if (!changed) unchangedJobs++;
    delta.jobs.push(next);
    delta.listings.push({
      ...oldListing, id: listingId, sourceId: source.sourceId, ...(record.sourceRecordId ? { sourceRecordId: record.sourceRecordId } : {}),
      ...(record.url ? { canonicalUrl: normalizeSourceUrl(record.url) } : {}), ...(record.applicationUrl ? { applicationUrl: record.applicationUrl } : {}),
      canonicalJobId: jobId, locationIds: unique(locationIds), compensationIds: unique(compensationIds), observationIds: unique([...(oldListing?.observationIds ?? []), observationId]),
      firstDiscoveredAt: oldListing?.firstDiscoveredAt ?? page.observedAt, recordLastSeenAt: page.observedAt,
    });
    delta.observations.push({ id: observationId, listingId, fetchedAt: page.observedAt, feedFetchedAt: page.observedAt,
      result: record.completeness === "detail" ? "read" : "partial", availability: record.availability,
      ...(record.availability !== "unknown" && record.availabilityBasis ? { availabilityMethod: record.availabilityBasis, availabilityVerifiedAt: page.observedAt } : {}),
      ...(snapshotId ? { snapshotId, contentHash } : {}), completeness: record.completeness,
      ...(record.sourcePublishedRaw ? { sourcePublishedRaw: record.sourcePublishedRaw } : {}), ...(record.sourcePublishedAt ? { sourcePublishedAt: record.sourcePublishedAt } : {}),
      ...(record.sourceUpdatedRaw ? { sourceUpdatedRaw: record.sourceUpdatedRaw } : {}), ...(record.sourceUpdatedAt ? { sourceUpdatedAt: record.sourceUpdatedAt } : {}), warnings: record.warnings,
    });
  }
  return { delta: AtlasDatasetObjectSchema.parse(delta), leads, unchangedJobs };
}
