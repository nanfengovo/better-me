import { z } from "zod";

const identifier = z.string().trim().min(1).max(240);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = (max: number) => z.string().min(1).max(max);
export const CommitteeRoleSchema = z.enum(["recruiter", "red_team", "advocate", "adjudicator"]);
export type CommitteeRole = z.infer<typeof CommitteeRoleSchema>;
export const COMMITTEE_ROLES: readonly CommitteeRole[] = ["recruiter", "red_team", "advocate", "adjudicator"];
export const EvidenceSupportSchema = z.enum(["supported", "partial", "contradicted", "unknown"]);
export type EvidenceSupport = z.infer<typeof EvidenceSupportSchema>;
export const EvidenceProvenanceSchema = z.enum(["user_statement", "source", "documentation", "design", "assessment", "inference", "job"]);
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;
export const PersonalContributionSchema = z.enum(["implementation", "design", "not_mine", "unknown"]);
export type PersonalContribution = z.infer<typeof PersonalContributionSchema>;

/** Identity, grants and checks are supplied by the trusted Host, never inferred by a role. */
export const CommitteeBindingSchema = z.object({
  ownerId: identifier, workspaceId: identifier, sessionGeneration: identifier,
  resumeId: identifier, resumeRevision: identifier, factRevision: identifier,
  jdSnapshotIds: z.array(identifier).max(200), rulesVersion: identifier,
}).strict();
export type CommitteeBinding = z.infer<typeof CommitteeBindingSchema>;

/** sourceHash identifies the Broker's source version. excerptHash checks only the included excerpt. */
export const CommitteeEvidenceSchema = z.object({
  id: identifier, sourceId: identifier, sourceHash: digest, excerptHash: digest,
  label: boundedText(500), provenance: EvidenceProvenanceSchema,
  excerpt: boundedText(48_000), startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  measurement: z.object({ receiptId: identifier, claimIds: z.array(identifier).min(1).max(200),
    result: z.enum(["passed", "partial", "failed"]), conditions: boundedText(2000) }).strict().optional(),
}).strict().superRefine((evidence, context) => {
  if (evidence.endLine < evidence.startLine || evidence.excerpt.split(/\r?\n/).length !== evidence.endLine - evidence.startLine + 1)
    context.addIssue({ code: "custom", message: "Evidence excerpt must match its exact line range." });
  if (evidence.measurement && evidence.provenance !== "assessment")
    context.addIssue({ code: "custom", message: "Only an assessment may carry a measurement receipt." });
});
export type CommitteeEvidence = z.infer<typeof CommitteeEvidenceSchema>;
export const CommitteeClaimSchema = z.object({
  id: identifier, text: boundedText(8000), hash: digest,
  contribution: PersonalContributionSchema,
  /** User-confirmed numeric tokens are explicit self-report, not independent certification. */
  confirmedNumericTokens: z.array(z.string().min(1).max(80)).max(100).default([]),
}).strict();
export type CommitteeClaim = z.infer<typeof CommitteeClaimSchema>;
export const CommitteeSnapshotSchema = z.object({
  schemaVersion: z.literal(1), binding: CommitteeBindingSchema,
  authorization: z.object({ grantId: identifier, evidenceIds: z.array(identifier).max(500),
    expiresAt: z.string().datetime(), purpose: z.literal("resume_stress_test") }).strict(),
  claims: z.array(CommitteeClaimSchema).min(1).max(200), evidence: z.array(CommitteeEvidenceSchema).max(500),
  jobText: z.string().max(64_000).default(""), fingerprint: digest,
}).strict();
export type CommitteeSnapshot = z.infer<typeof CommitteeSnapshotSchema>;

export const CommitteeCitationSchema = z.object({
  evidenceId: identifier, sourceHash: digest, excerptHash: digest,
  startLine: z.number().int().positive(), endLine: z.number().int().positive(), quote: boundedText(6000),
}).strict();
export type CommitteeCitation = z.infer<typeof CommitteeCitationSchema>;
export const RoleClaimAssessmentSchema = z.object({
  claimId: identifier, support: EvidenceSupportSchema,
  citations: z.array(CommitteeCitationSchema).max(20),
  counterCitations: z.array(CommitteeCitationSchema).max(20).default([]),
  risks: z.array(boundedText(1000)).max(20).default([]), missing: z.array(boundedText(1000)).max(20).default([]),
  questions: z.array(boundedText(1000)).max(12).default([]), defense: z.array(boundedText(1500)).max(12).default([]),
  rewrite: boundedText(8000).optional(),
}).strict();
export type RoleClaimAssessment = z.infer<typeof RoleClaimAssessmentSchema>;
export const CommitteeDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request_evidence"), requests: z.array(z.object({
    evidenceId: identifier, startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  }).strict()).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("assessment"), role: CommitteeRoleSchema,
    summary: boundedText(3000), claims: z.array(RoleClaimAssessmentSchema).max(200),
  }).strict(),
]);
export type CommitteeDecision = z.infer<typeof CommitteeDecisionSchema>;
/** Provider structured-output schema. Runtime Zod, grants, hashes and semantics still independently validate the reply. */
export function committeeDecisionJsonSchema(roleInput: CommitteeRole, allowedEvidenceIds: readonly string[],
  mode: "request_evidence" | "assessment" | "either" = "either"): Record<string, unknown> {
  const role = CommitteeRoleSchema.parse(roleInput);
  const evidenceIds = [...new Set(allowedEvidenceIds.map(id => identifier.parse(id)))];
  if (!["request_evidence", "assessment", "either"].includes(mode)) throw new Error("Invalid committee schema mode.");
  const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
  const id = { ...text(240), pattern: "\\S" };
  const line = { type: "integer", minimum: 1 };
  const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: "array", items, minItems, maxItems });
  const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
  const citation = object({ evidenceId: { ...id, enum: evidenceIds }, sourceHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    excerptHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, startLine: line, endLine: line, quote: text(6000),
  }, ["evidenceId", "sourceHash", "excerptHash", "startLine", "endLine", "quote"]);
  const opinion = object({ claimId: id, support: { type: "string", enum: EvidenceSupportSchema.options }, citations: array(citation, 20),
    counterCitations: array(citation, 20), risks: array(text(1000), 20), missing: array(text(1000), 20),
    questions: array(text(1000), 12), defense: array(text(1500), 12), rewrite: text(8000),
  }, ["claimId", "support", "citations"]);
  const request = object({ kind: { const: "request_evidence", type: "string" }, requests: array(object({
    evidenceId: { ...id, enum: evidenceIds }, startLine: line, endLine: line,
  }, ["evidenceId", "startLine", "endLine"]), 8, 1) }, ["kind", "requests"]);
  const assessment = object({ kind: { const: "assessment", type: "string" }, role: { const: role, type: "string" },
    summary: text(3000), claims: array(opinion, 200),
  }, ["kind", "role", "summary", "claims"]);
  return mode === "request_evidence" ? request : mode === "assessment" ? assessment : { anyOf: [request, assessment] };
}
export type CommitteeAssessmentDecision = Extract<CommitteeDecision, { kind: "assessment" }>;
export type CommitteeStage = "independent" | "cross_review" | "final";
export type RoleReasonerRequest = {
  role: CommitteeRole; stage: CommitteeStage; round: number; turn: number; prompt: string;
};
/** This is a real model seam: adapters receive prompts and return the documented JSON protocol. */
export type CommitteeRoleReasoner = (request: RoleReasonerRequest, signal: AbortSignal) => Promise<string | CommitteeDecision>;

export type CommitteeIssueCode = "invalid_citation" | "unread_evidence" | "evidence_not_granted" | "unknown_claim"
  | "duplicate_claim" | "missing_claim_assessment" | "no_supporting_evidence" | "inference_is_not_proof"
  | "personal_contribution_unknown" | "personal_contribution_denied" | "design_is_not_implementation"
  | "unsupported_number" | "unsupported_rewrite" | "invalid_protocol" | "wrong_role";
export type CommitteeIssue = { code: CommitteeIssueCode; claimId?: string; evidenceId?: string; detail: string };
export type ClaimEvidenceSidecar = {
  schemaVersion: 1; claimId: string; claimHash: string; snapshotFingerprint: string;
  support: EvidenceSupport; contribution: PersonalContribution; provenance: EvidenceProvenance[];
  citations: CommitteeCitation[]; counterCitations: CommitteeCitation[];
  riskLevel: "high" | "medium" | "low"; risks: string[]; missing: string[];
  questions: string[]; defense: string[];
  rewriteProposal?: { originalText: string; proposedText: string; evidenceIds: string[]; status: "pending_review" };
  limitations: string[];
};
export type CommitteeRoleResult = { role: CommitteeRole; stage: CommitteeStage; round: number;
  decision?: CommitteeAssessmentDecision; issues: CommitteeIssue[]; error?: string };
export type CommitteeStatus = "completed" | "partial" | "cancelled" | "budget_exhausted" | "stale" | "failed";
export type CommitteeReport = {
  schemaVersion: 1; binding: CommitteeBinding; snapshotFingerprint: string;
  status: CommitteeStatus; claims: ClaimEvidenceSidecar[]; roles: CommitteeRoleResult[];
  issues: CommitteeIssue[]; usage: { modelCalls: number; toolCalls: number; elapsedMs: number; outputCharacters: number };
  stopReason?: string; limitations: string[];
};
const CommitteeIssueSchema = z.object({ code: z.enum(["invalid_citation", "unread_evidence", "evidence_not_granted", "unknown_claim",
  "duplicate_claim", "missing_claim_assessment", "no_supporting_evidence", "inference_is_not_proof", "personal_contribution_unknown",
  "personal_contribution_denied", "design_is_not_implementation", "unsupported_number", "unsupported_rewrite", "invalid_protocol", "wrong_role"]),
  claimId: identifier.optional(), evidenceId: identifier.optional(), detail: z.string() }).strict();
export const CommitteeReportSchema: z.ZodType<CommitteeReport, z.ZodTypeDef, unknown> = z.object({
  schemaVersion: z.literal(1), binding: CommitteeBindingSchema, snapshotFingerprint: digest,
  status: z.enum(["completed", "partial", "cancelled", "budget_exhausted", "stale", "failed"]),
  claims: z.array(z.object({ schemaVersion: z.literal(1), claimId: identifier, claimHash: digest, snapshotFingerprint: digest,
    support: EvidenceSupportSchema, contribution: PersonalContributionSchema, provenance: z.array(EvidenceProvenanceSchema),
    citations: z.array(CommitteeCitationSchema), counterCitations: z.array(CommitteeCitationSchema), riskLevel: z.enum(["high", "medium", "low"]),
    risks: z.array(z.string()), missing: z.array(z.string()), questions: z.array(z.string()), defense: z.array(z.string()), limitations: z.array(z.string()),
    rewriteProposal: z.object({ originalText: z.string(), proposedText: z.string(), evidenceIds: z.array(identifier), status: z.literal("pending_review") }).strict().optional(),
  }).strict()),
  roles: z.array(z.object({ role: CommitteeRoleSchema, stage: z.enum(["independent", "cross_review", "final"]), round: z.number().int().nonnegative(),
    decision: CommitteeDecisionSchema.options[1].optional(), issues: z.array(CommitteeIssueSchema), error: z.string().optional() }).strict()),
  issues: z.array(CommitteeIssueSchema), usage: z.object({ modelCalls: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(), outputCharacters: z.number().int().nonnegative() }).strict(), stopReason: z.string().optional(), limitations: z.array(z.string()),
}).strict();
export const CommitteeBudgetSchema = z.object({
  maxModelCalls: z.number().int().min(1).max(100).default(24), maxToolCalls: z.number().int().min(0).max(500).default(80),
  maxDurationMs: z.number().int().min(1).max(3_600_000).default(120_000),
  maxOutputCharacters: z.number().int().min(1).max(2_000_000).default(240_000),
  maxTurnsPerRole: z.number().int().min(1).max(20).default(5), maxCrossRounds: z.number().int().min(0).max(2).default(1),
}).strict();
export type CommitteeBudget = z.infer<typeof CommitteeBudgetSchema>;
export type CommitteeRunOptions = {
  reasoner: CommitteeRoleReasoner; signal?: AbortSignal; budget?: Partial<CommitteeBudget>;
  /** Must recheck owner/session/grants/source revisions. false rejects any late result. */
  isCurrent: (snapshot: CommitteeSnapshot) => boolean | Promise<boolean>;
  /** Host must reserve its authoritative root ledger BEFORE every frozen read,
   * including denied/invalid requests. Throwing stops the entire committee. */
  beforeEvidenceRead?: (request: Extract<CommitteeDecision, { kind: "request_evidence" }>["requests"][number]) => Promise<void>;
  now?: () => number;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
export async function hashCommitteeText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function committeeFingerprint(snapshot: Omit<CommitteeSnapshot, "fingerprint">): Promise<string> {
  return hashCommitteeText(canonicalJson(snapshot));
}
export async function createCommitteeSnapshot(input: Omit<CommitteeSnapshot, "schemaVersion" | "fingerprint" | "claims" | "evidence"> & {
  claims: Array<Omit<CommitteeClaim, "hash" | "confirmedNumericTokens"> & { confirmedNumericTokens?: string[] }>;
  evidence: Array<Omit<CommitteeEvidence, "excerptHash">>;
}): Promise<CommitteeSnapshot> {
  const claims = await Promise.all(input.claims.map(async claim => ({ ...claim, hash: await hashCommitteeText(claim.text), confirmedNumericTokens: claim.confirmedNumericTokens ?? [] })));
  const evidence = await Promise.all(input.evidence.map(async item => ({ ...item, excerptHash: await hashCommitteeText(item.excerpt) })));
  const unsigned = { ...input, schemaVersion: 1 as const, claims, evidence };
  return CommitteeSnapshotSchema.parse({ ...unsigned, fingerprint: await committeeFingerprint(unsigned) });
}
