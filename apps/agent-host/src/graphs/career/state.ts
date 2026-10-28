import { Annotation } from "@langchain/langgraph";
import type { ArtifactEnvelope } from "@better-me/agent-contracts";

export type CareerWorkerId = "discovery" | "company-research" | "match" | "location-evidence" | "fact-check";
export type CareerStep = "intake" | "plan" | "fanout" | "normalize" | "locationEvidence" | "factCheck" | "coverage" | "approval" | "commit" | "response";

export interface WorkerStatus {
  id: CareerWorkerId;
  status: "queued" | "ready" | "running" | "completed" | "skipped" | "failed";
  runtimeId?: string;
  detail?: string;
}

export interface CareerApproval {
  status: "approved" | "rejected";
  approvedArtifactRefs?: string[];
  actorScope?: string;
  expectedRevision?: number;
  idempotencyKey?: string;
}

export const CareerAnnotation = Annotation.Root({
  task: Annotation<string>({ reducer: (_old, next) => next }),
  workspaceId: Annotation<string>({ reducer: (_old, next) => next, default: () => "default" }),
  requestedRuntimeId: Annotation<string | undefined>({ reducer: (_old, next) => next, default: () => undefined }),
  currentStep: Annotation<CareerStep>({ reducer: (_old, next) => next, default: () => "intake" }),
  workers: Annotation<WorkerStatus[]>({ reducer: (_old, next) => next, default: () => [] }),
  artifacts: Annotation<ArtifactEnvelope[]>({ reducer: (old, next) => old.concat(next), default: () => [] }),
  approval: Annotation<CareerApproval | undefined>({ reducer: (_old, next) => next, default: () => undefined }),
  errors: Annotation<string[]>({ reducer: (old, next) => old.concat(next), default: () => [] }),
  coverage: Annotation<{ attempted: number; completed: number; missing: CareerWorkerId[] }>({
    reducer: (_old, next) => next,
    default: () => ({ attempted: 0, completed: 0, missing: [] }),
  }),
  stepLog: Annotation<string[]>({ reducer: (old, next) => old.concat(next), default: () => [] }),
});

export type CareerState = typeof CareerAnnotation.State;
