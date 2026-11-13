import type { ResumeProposalTarget } from "@better-me/agent-contracts";

/** UI handoff only, not a data grant, model request or an approved fact. */
export type CareerWritingFocus = {
  id: string;
  sourceResumeId: string;
  sourceFingerprint: string;
  targetRef: ResumeProposalTarget;
  originalText: string;
  label: string;
  userStatement?: string;
};
