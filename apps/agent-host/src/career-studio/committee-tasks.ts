import type { StudioCommitteeTask } from "@better-me/agent-contracts";
import type { StudioAccess } from "./contracts.js";
import type { CommitteeReview } from "../kernel/studio-committee.js";

/** Execution remains in the kernel. History is a view; review rechecks current
 * authority and charges exact source rereads to that task's original root. */
export type CommitteeTasks = {
  get(id: string, access: StudioAccess): Promise<StudioCommitteeTask>;
  list(contextId: string, access: StudioAccess): Promise<StudioCommitteeTask[]>;
  /** Frozen metadata only; no source freshness claim or free source read. */
  describe(id: string, access: StudioAccess): Promise<Pick<CommitteeReview, "task" | "snapshot">>;
  review(id: string, access: StudioAccess): Promise<CommitteeReview>;
};
