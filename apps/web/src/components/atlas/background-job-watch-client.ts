import {
  JobWatchReceiptSchema, JobWatchStatusSchema,
  type JobWatchConfig, type JobWatchHandle,
} from "@better-me/source-adapters/browser-contracts";
import { createAtlasToolRequest } from "./service-client";
import type { AtlasConnectionIdentity } from "./connection-session";

export function createBackgroundJobWatchClient(connection: AtlasConnectionIdentity) {
  const request = createAtlasToolRequest(connection.endpoint, connection.token);
  return {
    start(handle: JobWatchHandle, config: JobWatchConfig, signal: AbortSignal) {
      return request("jobs/watch/start", JobWatchReceiptSchema, { signal }, { ...handle, config }, crypto.randomUUID());
    },
    status(handle: JobWatchHandle, signal: AbortSignal, offset?: number, view?: "matches" | "related") {
      return request("jobs/watch/status", JobWatchStatusSchema, { signal, maxBytes: 4 * 1024 * 1024 },
        { ...handle, ...(offset !== undefined ? { offset } : {}), ...(view ? { view } : {}) });
    },
    enable(handle: JobWatchHandle, enabled: boolean, signal: AbortSignal) {
      return request("jobs/watch/enable", JobWatchReceiptSchema, { signal }, { ...handle, enabled }, crypto.randomUUID());
    },
    acknowledge(handle: JobWatchHandle, hitIds: string[], signal: AbortSignal) {
      return request("jobs/watch/ack", JobWatchReceiptSchema, { signal }, { ...handle, hitIds }, crypto.randomUUID());
    },
  };
}
