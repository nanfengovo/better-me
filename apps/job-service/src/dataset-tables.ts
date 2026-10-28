/** Public entity vocabulary shared by storage and transport, without either implementation. */
export const DATASET_TABLES = ["sources", "companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const;
export type DatasetTable = typeof DATASET_TABLES[number];
/** Mirrors AtlasDatasetObjectSchema's global caps; checked even for partial writes. */
export const DATASET_ENTITY_LIMITS: Record<DatasetTable, number> = {
  sources: 10_000, companies: 100_000, jobs: 100_000, locations: 200_000,
  compensations: 200_000, listings: 300_000, observations: 1_000_000, snapshots: 1_000_000,
};
