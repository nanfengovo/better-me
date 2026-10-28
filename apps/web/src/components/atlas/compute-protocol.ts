import type { AtlasDataset, JobQueryInput, QueryOptions } from "@better-me/opportunities";
import type { AtlasPageOptions, AtlasPageResult } from "./client";
import type { AtlasCoverageOptions, AtlasDataCoverage } from "./coverage";
import type { DatasetDelta } from "../../../../job-service/src/dataset-sync-contract";

export const ATLAS_TABLES = ["sources", "companies", "jobs", "locations", "compensations", "listings", "observations", "snapshots"] as const;
export type AtlasTable = typeof ATLAS_TABLES[number];
export const ATLAS_CHUNK_SIZE = 128;
export type AtlasMetadata = { coverage: AtlasDataCoverage; penetratedIds: string[] };
export type ComputeOperation =
  | { kind: "snapshot"; endpoint: string; token: string; maxBytes?: number; knownSnapshots?: string[] }
  | { kind: "page"; snapshot: string; query: JobQueryInput; options: QueryOptions; page: Omit<AtlasPageOptions, "signal"> }
  | { kind: "metadata"; snapshot: string; options: AtlasCoverageOptions; text: string };
export type ComputeRequest =
  | { type: "run"; id: number; operation: ComputeOperation }
  | { type: "cancel"; id: number }
  | { type: "ack"; id: number; sequence: number }
  | { type: "install"; id: number; snapshot: string; header: Pick<AtlasDataset, "schemaVersion" | "revision"> }
  | { type: "install-chunk"; snapshot: string; table: AtlasTable; values: unknown[] }
  | { type: "installed"; id: number; snapshot: string };
export type ComputeResponse =
  | { type: "evicted"; snapshot: string }
  | { type: "begin-snapshot"; id: number; snapshot: string; header: Pick<AtlasDataset, "schemaVersion" | "revision"> }
  | { type: "begin-delta"; id: number; snapshot: string; base: string; delta: Omit<DatasetDelta, "upserts"> }
  | { type: "use-snapshot"; id: number; snapshot: string }
  | { type: "begin-page"; id: number; value: AtlasPageResult }
  | { type: "chunk"; id: number; sequence: number; target: AtlasTable | "summaryBuckets" | "pageBuckets" | "mapFeatures" | "officeBucketIds" | "coordinateStacks"; values: unknown[] }
  | { type: "result"; id: number; value?: AtlasMetadata }
  | { type: "error"; id: number; name: string; message: string; code?: string };

export function emptyComputeSnapshot(header: Pick<AtlasDataset, "schemaVersion" | "revision">): AtlasDataset {
  return { ...header, sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
}
