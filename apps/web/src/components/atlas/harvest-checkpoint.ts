import type { ImportReviewedCardsInput } from "@better-me/source-adapters/browser-contracts";
import type { LiveBatchProviderResultClient } from "../../lib/platform-search-client";
import type { ChinaRegionSelection } from "./china-regions";
import type { createAtlasSourceClient } from "./service-client";

export type HarvestProvider = LiveBatchProviderResultClient["provider"];
export const HARVEST_PROVIDERS: readonly HarvestProvider[] = ["liepin", "51job", "boss", "linkedin"];
export type HarvestImportReceipt = Awaited<ReturnType<ReturnType<typeof createAtlasSourceClient>["importReviewedCards"]>>;
export type HarvestRunState = "running" | "completed" | "needs-attention" | "cancelled" | "superseded";

/** Search intent only. Connection credentials and browser cookies never enter the journal. */
export type HarvestRunInput = {
  keyword: string;
  region?: string;
  chinaSelection?: ChinaRegionSelection;
  depth: "quick" | "standard" | "deep";
  maxPages?: number;
  view: { mode: "global" | "domestic"; country: string; region: string; regionText: string };
};

export type HarvestRunRecord = {
  schemaVersion: 1;
  id: string;
  scope: string;
  input: HarvestRunInput;
  state: HarvestRunState;
  createdAt: string;
  updatedAt: string;
  queryTerms?: string[];
  providers?: HarvestProvider[];
};

export type HarvestCapturedBatch = {
  id: string;
  provider: HarvestProvider;
  platform: LiveBatchProviderResultClient["platform"];
  pageUrl: string;
  capturedAt: string;
  cards: LiveBatchProviderResultClient["cards"];
};

/** Persist the exact command before sending it; replay uses the same key and body. */
export type HarvestPreparedImport = { input: ImportReviewedCardsInput; idempotencyKey: string };
export type HarvestBatchCheckpoint = HarvestCapturedBatch & {
  command?: HarvestPreparedImport;
  receipt?: HarvestImportReceipt;
};
export type HarvestProviderCheckpoint = { term: string; capturedAt: string; result: LiveBatchProviderResultClient };
export type HarvestCheckpointSnapshot = {
  run: HarvestRunRecord;
  batches: HarvestBatchCheckpoint[];
  providers: HarvestProviderCheckpoint[];
};

/** Durable run-local inbox. Every mutation resolves only after its transaction commits. */
export interface HarvestCheckpoint {
  readonly id: string;
  read(): Promise<HarvestCheckpointSnapshot>;
  /** Explicit user continuation only; never reopens completed or superseded work. */
  resume(): Promise<void>;
  initialize(queryTerms: readonly string[], providers: readonly HarvestProvider[]): Promise<void>;
  capture(batch: HarvestCapturedBatch): Promise<void>;
  prepare(batchId: string, command: HarvestPreparedImport): Promise<void>;
  confirm(batchId: string, receipt: HarvestImportReceipt): Promise<void>;
  recordProvider(checkpoint: HarvestProviderCheckpoint): Promise<void>;
  settle(state: Exclude<HarvestRunState, "running">): Promise<void>;
}

/** Store ownership and lifecycle are independent of React and of the collection pipeline. */
export interface HarvestJournal {
  readonly scope: string;
  findResumable(): Promise<HarvestCheckpoint | undefined>;
  /** Latest run only. Paused/failed work is offered, not automatically restarted. */
  findRecoverable(): Promise<HarvestCheckpoint | undefined>;
  create(input: HarvestRunInput): Promise<HarvestCheckpoint>;
  close(): void;
}

/** Cross-tab lock; a release never stops the already-committed server enrichment work. */
export type HarvestLease = { release(): void };
