import type { FactBase, ResumeView } from "@better-me/core";

export type BetterMeDocument = {
  /** Stable across edits, views and history. Optional for legacy backups. */
  documentId?: string;
  factBase: FactBase;
  resumeViews: ResumeView[];
  activeResumeId: string;
};

export interface DocumentStore {
  load(): Promise<BetterMeDocument | null>;
  save(doc: BetterMeDocument): Promise<void>;
  clear(): Promise<void>;
}
