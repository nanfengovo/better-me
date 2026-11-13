import { z } from "zod";

const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PrivacySourceSchema = z.object({
  id: opaqueId,
  revision: opaqueId,
  classification: z.enum(["local_only", "summary_allowed", "public"]),
  kind: z.enum(["source", "diff", "fact", "design", "note"]),
  text: z.string().min(1).max(256_000),
}).strict();
export type PrivacySource = z.infer<typeof PrivacySourceSchema>;

export const PrivacyBudgetSchema = z.object({
  revision: z.number().int().nonnegative(),
  maxLocalCalls: z.number().int().min(1).max(100),
  maxCloudCalls: z.literal(1),
  maxInputBytes: z.number().int().min(1).max(2_000_000),
  maxOutputBytes: z.number().int().min(1).max(256_000),
  maxActiveMs: z.number().int().min(1).max(600_000),
}).strict();
export type PrivacyBudget = z.infer<typeof PrivacyBudgetSchema>;

export const PrivacyPolicySchema = z.object({
  version: opaqueId,
  allowedFields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(20),
  /** Host-supplied sensitive names/tokens. Never copied to a draft or audit event. */
  privateTerms: z.array(z.string().min(2).max(500)).max(200).default([]),
  maxFieldCharacters: z.number().int().min(1).max(12_000).default(4000),
}).strict().refine(value => new Set(value.allowedFields).size === value.allowedFields.length, "duplicate fields");
export type PrivacyPolicy = z.infer<typeof PrivacyPolicySchema>;

export const LocalRuntimeBindingSchema = z.object({
  id: opaqueId,
  version: opaqueId,
  location: z.literal("local"),
  /** Binds the configured loopback endpoint/transport, not just model name. */
  endpointFingerprint: hash,
  model: z.string().min(1).max(200),
  modelDigest: z.string().min(1).max(200),
  embeddingModel: z.string().min(1).max(200).optional(),
  embeddingDigest: z.string().min(1).max(200).optional(),
}).strict();
export type LocalRuntimeBinding = z.infer<typeof LocalRuntimeBindingSchema>;
export const CloudRuntimeBindingSchema = z.object({
  id: opaqueId,
  version: opaqueId,
  location: z.literal("cloud"),
  recipientOrigin: z.string().url().max(2000),
  endpointFingerprint: hash,
  model: z.string().min(1).max(200),
}).strict();
export type CloudRuntimeBinding = z.infer<typeof CloudRuntimeBindingSchema>;

export type PrivacyAccess = {
  /** Supplied by the authenticated Host, never copied from model/HTTP input. */
  ownerId: string;
  sessionId: string;
  sessionGeneration: number;
  authorizationGeneration: number;
  valid: () => Promise<boolean>;
};

export type PrivacyTaskBinding = {
  ownerId: string;
  sessionId: string;
  sessionGeneration: number;
  authorizationGeneration: number;
  taskRevision: number;
  sourceSnapshotHash: string;
  policyVersion: string;
  localRuntimeFingerprint: string;
  cloudRuntimeFingerprint: string;
  budget: PrivacyBudget;
  status: "active" | "revoked" | "closed";
};

export type PrivacyStage = "local_scan" | "local_summary" | "local_embedding" | "disclosure_prepared" | "disclosure_approved" | "cloud_dispatch" | "cloud_result" | "revoked" | "stopped";
export type PrivacyAuditEvent = {
  taskId: string;
  operationId: string;
  stage: PrivacyStage;
  code: string;
  at: string;
  /** Digests and counters only: no prompt, source excerpt, names, paths or answer. */
  draftHash?: string;
  recipientFingerprint?: string;
  sourceSnapshotHash?: string;
  bytes?: number;
};

/** The owning task lifecycle must implement these as durable atomic gates.
 * This module owns no task queue, business assets, credential store or budget. */
export type PrivacyLifecycle = {
  current(taskId: string): Promise<PrivacyTaskBinding>;
  /** Atomically claims one stage+operation and consumes a local call. Return
   * false for an existing claim; true must never permit an unmetered replay. */
  reserveLocal(input: { taskId: string; operationId: string; stage: "local_scan" | "local_summary" | "local_embedding"; budget: PrivacyBudget }): Promise<boolean>;
  /** Atomically claims the logical dispatch AND consumes the cloud budget.
   * Return false after any previous claim, even when its outcome is unknown. */
  reserveDispatch(input: { taskId: string; operationId: string; draftHash: string; approvalHash: string; recipientFingerprint: string; budget: PrivacyBudget }): Promise<boolean>;
  audit(event: PrivacyAuditEvent): Promise<void>;
};

export type PrivacyFinding = { sourceId: string; categories: string[] };
export type LocalInspection = { findings: PrivacyFinding[]; inspectedSourceIds: string[] };
export type DisclosureField = { name: string; text: string; sourceIds: string[] };
export type LocalPrivacyAdapter = {
  binding(): Promise<LocalRuntimeBinding>;
  inspect(sources: readonly PrivacySource[], signal: AbortSignal): Promise<LocalInspection>;
  /** Never receives local_only sources or the inspection's potentially private output. */
  summarize(input: { sources: readonly PrivacySource[]; requestedFields: readonly string[] }, signal: AbortSignal): Promise<string>;
  /** Local-only embedding interface. Vectors never enter a cloud envelope. */
  embed?(texts: readonly string[], signal: AbortSignal): Promise<number[][]>;
};

export type DisclosureDraft = {
  id: string;
  taskId: string;
  operationId: string;
  version: 1;
  hash: string;
  createdAt: string;
  expiresAt: string;
  policyVersion: string;
  sourceSnapshotHash: string;
  requestedFields: string[];
  fields: DisclosureField[];
  sources: { id: string; revision: string; hash: string }[];
  redactions: { category: string; count: number }[];
  repairs: { kind: string; beforeHash: string; afterHash: string }[];
};
export type DisclosureApproval = {
  id: string;
  hash: string;
  draftId: string;
  draftHash: string;
  recipientFingerprint: string;
  approvedFields: string[];
  budgetHash: string;
  expiresAt: string;
};
export type CloudDisclosureEnvelope = {
  protocol: "betterme.disclosure.v1";
  taskId: string;
  operationId: string;
  model: string;
  summary: Record<string, string>;
  sources: { id: string; revision: string; hash: string }[];
};
export type CloudDisclosureReply = { text: string; sourceIds: string[]; unknowns: string[] };
export type CloudPrivacyAdapter = {
  binding(): Promise<CloudRuntimeBinding>;
  dispatch(input: CloudDisclosureEnvelope, signal: AbortSignal): Promise<unknown>;
};

export class PrivacyError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PrivacyError"; }
}
