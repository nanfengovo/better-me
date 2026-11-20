import type { FactBase, ResumeView } from "@better-me/core";

import type { RequirementEvidenceLink } from "@better-me/core/document";

export type BetterMeDocument = {
  /** Stable across edits, views and history. Optional for legacy backups. */
  documentId?: string;
  factBase: FactBase;
  requirementEvidence?: RequirementEvidenceLink[];
  resumeViews: ResumeView[];
  activeResumeId: string;
};

export interface DocumentStore {
  load(): Promise<BetterMeDocument | null>;
  save(doc: BetterMeDocument): Promise<void>;
  clear(): Promise<void>;
}
