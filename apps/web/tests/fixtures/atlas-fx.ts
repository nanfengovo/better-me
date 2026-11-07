import { buildFxImportPreview, type AtlasDataset, type FxImportDraft, type FxState } from "@better-me/opportunities";
import { createAtlasDemo } from "../../src/components/atlas/demo.ts";
export const fxAt = "2026-10-21T12:00:00.000Z";
export const fxDraft: FxImportDraft = { schemaVersion: 1, provider: "Synthetic reference rates", sourceUrl: "https://rates.example.invalid/reference",
  retrievedAt: "2026-10-20T10:00:00.000Z", format: "eur-reference-json-v1", raw: '{"date":"2026-10-20","base":"EUR","rates":{"CNY":8,"USD":1}}' };
export const fxPreview = await buildFxImportPreview({ draft: fxDraft, expectedRevision: 1 }, { now: fxAt });
export function fxState(revision = 1, enabled = false): FxState { return { schemaVersion: 1, revision,
  context: { schemaVersion: 1, datasetRevision: revision, asOf: fxAt, ...(enabled ? { activeSnapshot: fxPreview.snapshot } : {}) }, snapshots: [fxPreview.snapshot] }; }
export const fxReceipt = { ok: true as const, revision: 2, snapshotId: fxPreview.snapshot.fx.id, activeSnapshotId: fxPreview.snapshot.fx.id };
export function fxData(revision = 1): AtlasDataset { const data = createAtlasDemo(); data.revision = revision; return data; }
