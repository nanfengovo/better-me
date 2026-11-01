import { z } from "zod";

/** A project consensus is context, never proof of the user's personal contribution. */
export const UnderstandingQuestionSchema = z.object({
  id: z.string().min(1).max(120),
  text: z.string().min(1).max(2000),
  why: z.string().max(1000),
  options: z.array(z.object({ id: z.string().min(1).max(120), label: z.string().min(1).max(500) })).max(8),
  allowMultiple: z.boolean().default(false),
});
export type UnderstandingQuestion = z.infer<typeof UnderstandingQuestionSchema>;

/** Suggestions are questions, never claims of authorship or permission to disclose clients. */
export const ContributionLeadSchema = z.object({
  id: z.string().min(1).max(120), title: z.string().min(1).max(200),
  hypothesis: z.string().min(1).max(1500),
  category: z.enum(["responsibility", "customer", "deployment", "challenge", "outcome"]),
  evidenceIds: z.array(z.string()).min(1).max(12),
  question: z.string().min(1).max(1500), options: z.array(z.string().min(1).max(500)).max(6),
});
export type ContributionLead = z.infer<typeof ContributionLeadSchema>;
export const UnderstandingCheckpointSchema = z.object({
  turn: z.number().int().nonnegative(), status: z.enum(["reading", "synthesizing", "partial", "complete"]),
  used: z.number().int().nonnegative(), budget: z.number().int().positive(),
  evidenceIds: z.array(z.string()).max(2000), reusedDirectories: z.number().int().nonnegative(),
});
/** File type is only a provenance boundary; code is not proof of deployment or authorship. */
export function isImplementationEvidencePath(file: string): boolean {
  return /\.(?:tsx?|jsx?|mjs|cjs|cs|fs|vb|py|go|rs|java|kt|swift|c|h|cpp|hpp|vue|svelte|html|css|scss)$/i.test(file);
}

export const ProjectUnderstandingSchema = z.object({
  summary: z.string().min(1).max(8000),
  terms: z.array(z.object({ term: z.string().min(1).max(200), meaning: z.string().min(1).max(2000), evidenceIds: z.array(z.string()).max(30) })).max(80),
  boundaries: z.array(z.string().max(2000)).max(40),
  claims: z.array(z.object({ id: z.string().min(1).max(120), text: z.string().min(1).max(3000), kind: z.enum(["source", "documentation", "design", "user", "inference", "unknown"]), evidenceIds: z.array(z.string()).max(30) })).max(100),
  unknowns: z.array(z.string().max(2000)).max(40),
  // Optional (not defaulted) so loading legacy confirmed records never changes their hash.
  contributionLeads: z.array(ContributionLeadSchema).max(6).optional(),
});
export type ProjectUnderstanding = z.infer<typeof ProjectUnderstandingSchema>;

export type UnderstandingGrant = { id: string; path: string; label: string; createdAt: string; revokedAt?: string };
export type UnderstandingEvidence = { id: string; grantId: string; path: string; hash: string; startLine: number; endLine: number; excerpt: string; collectedAt: string };
export type UnderstandingEvent = { sequence: number; at: string; label: string; kind: "reading" | "thinking" | "waiting" | "completed" | "error" | "cancelled" };
export type UnderstandingMessage = { id: string; role: "user" | "agent" | "system"; text: string; at: string; question?: UnderstandingQuestion; selectedOptionIds?: string[] };
export type UnderstandingSession = {
  version: 1;
  id: string;
  workspaceKey: string;
  projectKey: string;
  label: string;
  sourceText: string;
  revision: number;
  phase: "idle" | "running" | "awaiting-answer" | "awaiting-confirmation" | "confirmed" | "error" | "cancelled";
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  grants: UnderstandingGrant[];
  evidence: UnderstandingEvidence[];
  messages: UnderstandingMessage[];
  events: UnderstandingEvent[];
  understanding?: ProjectUnderstanding;
  checkpoint?: z.infer<typeof UnderstandingCheckpointSchema>;
  summaryHash?: string;
  question?: UnderstandingQuestion;
  confirmation?: { revision: number; summaryHash: string; confirmedAt: string };
  error?: { code: string; message: string; recoverable: boolean };
};
export type UnderstandingCapability = { id: string; name: string; available: boolean; supported: boolean; reason?: string };

/** Validate persisted / HTTP state before rendering it or reusing its consensus. */
export const UnderstandingSessionSchema = z.object({
  version: z.literal(1), id: z.string().min(1), workspaceKey: z.string(), projectKey: z.string(),
  label: z.string(), sourceText: z.string(), revision: z.number().int().nonnegative(),
  phase: z.enum(["idle", "running", "awaiting-answer", "awaiting-confirmation", "confirmed", "error", "cancelled"]),
  turnCount: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  grants: z.array(z.object({ id: z.string(), path: z.string(), label: z.string(), createdAt: z.string(), revokedAt: z.string().optional() })),
  evidence: z.array(z.object({ id: z.string(), grantId: z.string(), path: z.string(), hash: z.string(), startLine: z.number().int(), endLine: z.number().int(), excerpt: z.string(), collectedAt: z.string() })),
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "agent", "system"]), text: z.string(), at: z.string(), question: UnderstandingQuestionSchema.optional(), selectedOptionIds: z.array(z.string()).optional() })),
  events: z.array(z.object({ sequence: z.number().int(), at: z.string(), label: z.string(), kind: z.enum(["reading", "thinking", "waiting", "completed", "error", "cancelled"]) })),
  understanding: ProjectUnderstandingSchema.optional(), summaryHash: z.string().optional(), question: UnderstandingQuestionSchema.optional(),
  checkpoint: UnderstandingCheckpointSchema.optional(),
  confirmation: z.object({ revision: z.number().int(), summaryHash: z.string(), confirmedAt: z.string() }).optional(),
  error: z.object({ code: z.string(), message: z.string(), recoverable: z.boolean() }).optional(),
});

export const UnderstandingCreateSchema = z.object({
  workspaceKey: z.string().min(1).max(200),
  projectKey: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
  sourceText: z.string().min(1).max(16000),
});
export const UnderstandingTurnSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(200),
  answer: z.string().max(16000).default(""),
  selectedOptionIds: z.array(z.string().min(1).max(120)).max(8).default([]),
  consentToSend: z.literal(true),
});
export type UnderstandingTurnInput = z.infer<typeof UnderstandingTurnSchema>;
export const UnderstandingConfirmSchema = z.object({ expectedRevision: z.number().int().nonnegative(), summaryHash: z.string().min(1).max(128) });

/** Model output may request only these broker operations, never a shell command. */
export const UnderstandingDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), requests: z.array(z.object({
    grantId: z.string().min(1).max(120), operation: z.enum(["list", "search", "read"]),
    path: z.string().max(2000).default(""), query: z.string().max(200).optional(),
    startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional(),
  })).min(1).max(8) }),
  z.object({ kind: z.literal("reply"), message: z.string().min(1).max(8000), understanding: ProjectUnderstandingSchema,
    question: UnderstandingQuestionSchema.optional(), readyForConfirmation: z.boolean(),
  }),
]);
export type UnderstandingDecision = z.infer<typeof UnderstandingDecisionSchema>;
export type UnderstandingReasoner = (prompt: string, signal: AbortSignal) => Promise<string>;
