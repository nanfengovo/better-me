import type { SourceAdapter } from "../contracts.js";
import { SourceRegistryError } from "../contracts.js";

/** Installed access-policy identity for bounded discovery tools, never a job collector. */
export const discoveryPolicyAdapter: SourceAdapter = {
  adapterId: "discovery-policy", version: "1", capabilities: ["discover-sources"], remoteFilters: [], entityTypes: ["discovery-lead"],
  async list() { throw new SourceRegistryError("unsupported-capability"); },
};
