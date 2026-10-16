import type { FactBase, ResumeView } from "@better-me/core";

export type BetterMeDocument = {
  factBase: FactBase;
  resumeViews: ResumeView[];
  activeResumeId: string;
};

export interface DocumentStore {
  load(): Promise<BetterMeDocument | null>;
  save(doc: BetterMeDocument): Promise<void>;
  clear(): Promise<void>;
}
