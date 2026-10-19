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
/** Host-selected provenance; source records and tool arguments cannot elevate their own trust. */
export type SourceProjectionOptions = { mode?: "source" | "user-reviewed-browser" };
const completenessRank = { lead: 0, excerpt: 1, detail: 2 } as const;

/** Pure projection. External claims never become personal facts or inferred company ownership. */
export async function projectSourcePage(snapshot: AtlasDataset, source: SourceDefinition, page: SourcePage, runId: string, options: SourceProjectionOptions = {}): Promise<SourceProjection> {
  const reviewedBrowser = options.mode === "user-reviewed-browser";
  // Confirming adoption of a parsed card is not a manual title override.
  const titleMethod = reviewedBrowser ? "parser" : "source-structured";
  const extractionMethod = reviewedBrowser ? "browser" : "source-structured";
  const delta = emptyDelta(snapshot.revision);
  delta.sources.push(source);
  const leads: ProjectedLead[] = [];
  const seen = new Map<string, string>();
  let unchangedJobs = 0;
  for (const input of page.records) {
    const record = SourceJobRecordSchema.parse(input);
    const identity = record.sourceRecordId ?? normalizeSourceUrl(record.url!);
    const listingId = await deriveEntityId("listing", [source.sourceId, identity]);
    const signature = reviewedBrowser ? digest({ record, mode: "user-reviewed-browser" }) : digest(record);
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
      // The pre-address identity stays compatible. Explicit address changes instead
      // identify a new source place; omitted fields cannot be spliced from the old office.
      const identityFields = { raw: location.raw, countryCode: location.countryCode, region: location.region, city: location.city };
      const identityDigest = digest(identityFields);
      const legacyId = await deriveEntityId("location", [listingId, kind, identityDigest]);
      const findLocation = (id: string) => delta.locations.find(item => item.id === id) ?? snapshot.locations.find(item => item.id === id);
      const samePlace = (item: NonNullable<ReturnType<typeof findLocation>>) => item.kind === kind
        && digest({ raw: item.raw, countryCode: item.countryCode, region: item.region, city: item.city }) === identityDigest;
      const conflicts = (item: NonNullable<ReturnType<typeof findLocation>>) => (["streetAddress", "postalCode"] as const)
        .some(field => location[field] && item[field] && location[field] !== item[field]);
      // Prefer this listing's current contribution over historical locations with
      // the same label, so a sparse refresh after a move cannot restore its old street.
      const current = unique([...(oldListing?.locationIds ?? []), ...locationIds]).map(findLocation)
        .filter((item): item is NonNullable<typeof item> => Boolean(item && samePlace(item)));
      if (current.some(item => item.userResolution || item.officeResolution)) throw new ToolError("source-changed");
      const compatible = current.filter(item => !conflicts(item));
      if (compatible.length > 1 && !location.streetAddress && !location.postalCode) {
        locationIds.push(...compatible.map(item => item.id));
        continue;
      }
      let existing = compatible.length === 1 ? compatible[0] : undefined;
      let id = existing?.id ?? legacyId, supplied = location, locationEvidence = evidence("locations", location.raw);
      const legacy = findLocation(legacyId);
      const previous = existing;
      const additions = previous && (["streetAddress", "postalCode"] as const).some(field => location[field] && !previous[field]);
      const replacement = !existing && (current.length > 0 || !!legacy?.streetAddress || !!legacy?.postalCode);
      if (replacement || additions && id !== legacyId) {
        // An address-specific ID is immutable. Compatible additive disclosures can
        // retain the explicitly known counterpart, but an actual move starts only
        // from this response's fields, even when a previous postcode was present.
        if (existing) {
          supplied = { ...(existing.streetAddress ? { streetAddress: existing.streetAddress } : {}),
            ...(existing.postalCode ? { postalCode: existing.postalCode } : {}), ...location };
          locationEvidence = [...new Map([...existing.evidence, ...locationEvidence].map(ref => [digest(ref), ref])).values()].slice(0, 200);
        }
        id = await deriveEntityId("location", [listingId, kind, digest({ ...identityFields,
          streetAddress: supplied.streetAddress, postalCode: supplied.postalCode, addressIdentityVersion: 1 })]);
        existing = findLocation(id);
      } else if (!existing) existing = legacy;
      if (existing?.userResolution || existing?.officeResolution) throw new ToolError("source-changed");
      locationIds.push(id);
      const queued = delta.locations.findIndex((item) => item.id === id);
      if (!existing) {
        delta.locations.push({ id, ...supplied, kind, precision: location.city ? "city" : location.region ? "region" : location.countryCode ? "country" : "unknown", evidence: locationEvidence, verification: "unverified" });
      } else {
        const additions: { streetAddress?: string; postalCode?: string } = {};
        for (const field of ["streetAddress", "postalCode"] as const) {
          const supplied = location[field], prior = existing[field];
          // A changed address is not a compatible enrichment of the legacy identity.
          if (supplied && prior && supplied !== prior) throw new ToolError("source-changed");
          if (supplied && !prior) additions[field] = supplied;
        }
        if (Object.keys(additions).length) {
          // Source projection is fed the repository's base snapshot. Do not import
          // a user overlay if a caller accidentally supplies the visible snapshot.
          if (existing.userResolution || existing.officeResolution) throw new ToolError("source-changed");
          const refs = [...new Map([...existing.evidence, ...evidence("locations", location.raw)].map(ref => [digest(ref), ref])).values()].slice(0, 200);
          const enhanced = { ...existing, ...additions, evidence: refs };
          if (queued >= 0) delta.locations[queued] = enhanced; else delta.locations.push(enhanced);
        }
      }
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
    // Reuse legacy IDs when their content and provenance match, while keeping a card
    // excerpt distinct from a later complete JD or another extraction method.
    const oldSnapshot = snapshot.snapshots.find((item) => item.listingId === listingId && item.contentHash === contentHash && item.text === description
      && item.completeness === record.completeness && item.extractionMethod === extractionMethod);
    const snapshotId = description ? oldSnapshot?.id ?? await deriveEntityId("snapshot", [listingId, contentHash, record.completeness, extractionMethod]) : undefined;
    if (snapshotId && !oldSnapshot && !delta.snapshots.some((item) => item.id === snapshotId)) delta.snapshots.push({ id: snapshotId, listingId, observationId, text: description, contentHash, createdAt: page.observedAt, ...(record.url ? { sourceUrl: record.url } : {}), extractionMethod, completeness: record.completeness });
    const selectedSnapshot = snapshot.snapshots.find((item) => item.id === oldJob?.selectedSnapshotId);
    const retainDescription = Boolean(selectedSnapshot && completenessRank[selectedSnapshot.completeness] > completenessRank[record.completeness]);
    const keepOther = (current: string[], oldContribution: string[] | undefined) => oldJob && oldJob.listingIds.length > 1 ? current.filter((id) => !oldContribution?.includes(id)) : [];
    const title: CanonicalJob["title"] = oldJob?.title.value === record.title || oldJob?.title.method === "manual" ? oldJob.title : { value: record.title, evidence: evidence("title", record.title), method: titleMethod, verification: "unverified", revision: (oldJob?.title.revision ?? -1) + 1 };
    const next: CanonicalJob = {
      ...oldJob, id: jobId, companyId, title, description: retainDescription ? oldJob!.description : record.description ?? oldJob?.description ?? "",
      locationIds: unique([...keepOther(oldJob?.locationIds ?? [], oldListing?.locationIds), ...locationIds]),
      compensationIds: unique([...keepOther(oldJob?.compensationIds ?? [], oldListing?.compensationIds), ...compensationIds]),
      listingIds: unique([...(oldJob?.listingIds ?? []), listingId]),
      ...(snapshotId && !retainDescription ? { selectedSnapshotId: snapshotId } : {}), workMode: record.workMode === "unknown" ? oldJob?.workMode ?? "unknown" : record.workMode, employmentType: record.employmentType === "unknown" ? oldJob?.employmentType ?? "unknown" : record.employmentType,
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
