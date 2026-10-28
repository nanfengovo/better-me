import type { ToolErrorCode, TrustedToolContext } from "@better-me/opportunities";
import type { JobServiceConfig } from "./lifecycle.js";

// A small audited set of public reads uses a separate read-only WAL connection.
// All mutation/preview/external-source orchestration stays with the single writer.
export const READ_LANE_TOOLS: ReadonlySet<string> = new Set([
  "jobs.search", "jobs.export-public", "jobs.sync-public", "jobs.read-detail", "enrichment.status", "sources.list", "runs.list", "runs.read", "leads.list",
]);
export type RuntimeConfig = { databasePath: string; config: JobServiceConfig; readOnly: boolean };
export type RuntimeCall = { type: "execute"; id: number; tool: string; input: unknown; context: Omit<TrustedToolContext, "signal"> };
export type RuntimeRequest = RuntimeCall | { type: "cancel"; id: number } | { type: "close" };
export type SerializedToolResult = { ok: boolean; errorCode?: ToolErrorCode; json: Uint8Array };
export type RuntimeResponse = { type: "ready" } | { type: "closed" } | { type: "result"; id: number; result: SerializedToolResult };
