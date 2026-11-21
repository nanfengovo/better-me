import {
  DiscoverOfficialJobsInputSchema,
  OfficialJobDiscoveryResultSchema,
  type DiscoverOfficialJobsInput,
} from "@better-me/source-adapters/browser-contracts";
import { AtlasImportReceiptSchema, createAtlasToolRequest } from "./service-client";

export function createOfficialJobDiscoveryClient(endpoint: string, token: string) {
  const request = createAtlasToolRequest(endpoint, token);
  return {
    discover(input: DiscoverOfficialJobsInput, signal: AbortSignal) {
      return request("jobs/discover-official", OfficialJobDiscoveryResultSchema,
        { signal, maxBytes: 8 * 1024 * 1024 }, DiscoverOfficialJobsInputSchema.parse(input));
    },
    collect(candidateId: string, idempotencyKey: string, signal: AbortSignal) {
      return request("jobs/discover-official/import", AtlasImportReceiptSchema,
        { signal }, { candidateId }, idempotencyKey);
    },
  };
}
