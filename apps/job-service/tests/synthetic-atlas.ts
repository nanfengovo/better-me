import { createHash } from "node:crypto";
import type { AtlasDataset } from "@better-me/opportunities";

export const SYNTHETIC_AT = "2026-10-28T00:00:00.000Z";
/** Isolated evidence and .test URLs only. Never loads the user's library. */
export function syntheticAtlas(size: number, prefix = "scale"): AtlasDataset {
  const dataset: AtlasDataset = {
    schemaVersion: 1, revision: 0,
    sources: [{ sourceId: "synthetic-source", name: "Synthetic source", adapterId: "synthetic", adapterVersion: "1", capabilities: [], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "disabled", remoteFilters: [], endpointPolicy: { allowedHosts: ["careers.example.test"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 100, maxPages: 10, requestsPerMinute: 30 } }],
    companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [],
  };
  for (let index = 0; index < size; index++) {
    const id = `${prefix}-${index}`, listingId = `listing-${id}`, observationId = `observation-${id}`, snapshotId = `snapshot-${id}`;
    const url = `https://careers.example.test/jobs/${id}`;
    const text = `Synthetic ${index % 2 ? "TypeScript" : "C#"} engineer ${id}\n${"Synthetic description. ".repeat(12)}`;
    const contentHash = createHash("sha256").update(text).digest("hex");
    dataset.companies.push({ id: `company-${id}`, names: [`Synthetic company ${id}`], domains: [], parentCompanyIds: [], ultimateControllers: { value: [], evidence: [], method: "source-structured", verification: "unverified", revision: 0 }, manualOverrides: [] });
    dataset.jobs.push({ id: `job-${id}`, companyId: `company-${id}`, title: { value: index % 2 ? "TypeScript engineer" : "C# engineer", evidence: [], method: "source-structured", verification: "unverified", revision: 0 }, description: text, locationIds: [`location-${id}`], compensationIds: [], listingIds: [listingId], selectedSnapshotId: snapshotId, workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: SYNTHETIC_AT });
    dataset.locations.push({ id: `location-${id}`, raw: "上海", kind: "office", precision: index % 4 === 0 ? "address" : "unknown", verification: "unverified", ...(index % 4 === 0 ? { countryCode: "CN", coordinates: { latitude: 31.2 + index % 50 / 1000, longitude: 121.4 + index % 50 / 1000, coordinateSystem: "WGS84" as const } } : {}), evidence: [{ observationId, sourceUrl: url, observedAt: SYNTHETIC_AT, quote: "上海" }] });
    dataset.listings.push({ id: listingId, sourceId: "synthetic-source", sourceRecordId: id, canonicalUrl: url, canonicalJobId: `job-${id}`, locationIds: [`location-${id}`], observationIds: [observationId], firstDiscoveredAt: SYNTHETIC_AT });
    dataset.observations.push({ id: observationId, listingId, fetchedAt: SYNTHETIC_AT, contentHash, snapshotId, result: "read", availability: "unknown", completeness: "detail", warnings: [] });
    dataset.snapshots.push({ id: snapshotId, listingId, observationId, text, contentHash, createdAt: SYNTHETIC_AT, sourceUrl: url, extractionMethod: "source-structured", completeness: "detail" });
  }
  return dataset;
}
