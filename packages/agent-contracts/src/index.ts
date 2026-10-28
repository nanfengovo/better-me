import { z } from "zod";

/** JSON values accepted at process and persistence boundaries. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const RuntimeTransportSchema = z.enum(["stdio", "stream-json", "jsonl", "acp", "json-rpc"]);
export type RuntimeTransport = z.infer<typeof RuntimeTransportSchema>;

export const RuntimeCapabilitySchema = z.enum([
  "text",
  "structured-output",
  "streaming",
  "resume",
  "sandbox",
  "tools",
  "multi-agent",
]);
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>;

export const RuntimeAgentDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(120),
  command: z.string().min(1).max(300),
  fallbackCommands: z.array(z.string().min(1).max(300)).max(12).default([]),
  versionArgs: z.array(z.string().max(200)).max(12).default(["--version"]),
  transport: RuntimeTransportSchema,
  capabilities: z.array(RuntimeCapabilitySchema).max(20).default([]),
  description: z.string().max(500).optional(),
  authProbeArgs: z.array(z.string().max(200)).max(12).optional(),
  /** Arguments that are safe to append to a prompt for the default runner. */
  promptArgs: z.array(z.string().max(200)).max(24).default([]),
  /** A no-cost CLI invocation used to verify the advertised transport. */
  probeArgs: z.array(z.string().max(200)).max(24).optional(),
  /** Flags that must appear in the probe output for the adapter to be compatible. */
  requiredFlags: z.array(z.string().max(200)).max(24).default([]),
  /** Environment variables that can provide non-interactive authentication. */
  authEnvVars: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(24).default([]),
  /** Home-relative files that indicate a persisted local login without reading secrets. */
  authFiles: z.array(z.string().min(1).max(300)).max(24).default([]),
});
export type RuntimeAgentDef = z.infer<typeof RuntimeAgentDefSchema>;

export const RuntimeStatusSchema = z.enum(["available", "not-installed", "needs-config", "error"]);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const RuntimeAgentInfoSchema = RuntimeAgentDefSchema.extend({
  status: RuntimeStatusSchema,
  resolvedCommand: z.string().optional(),
  version: z.string().optional(),
  checkedAt: z.string().datetime(),
  detail: z.string().max(1000).optional(),
  readiness: z.enum(["unknown", "ready", "needs-auth", "unsupported", "error"]).default("unknown"),
  canRun: z.boolean().default(false),
  checks: z.object({
    version: z.enum(["passed", "failed", "skipped"]).default("skipped"),
    protocol: z.enum(["passed", "failed", "skipped"]).default("skipped"),
    auth: z.enum(["configured", "missing", "unsupported", "unknown"]).default("unknown"),
  }).default({}),
});
export type RuntimeAgentInfo = z.infer<typeof RuntimeAgentInfoSchema>;

export const AgentEventTypeSchema = z.enum([
  "run.started",
  "run.paused",
  "run.resumed",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "agent.started",
  "agent.thinking",
  "agent.output",
  "tool.called",
  "tool.result",
  "artifact.created",
  "approval.required",
  "text.delta",
]);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const AgentEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: AgentEventTypeSchema,
  timestamp: z.string().datetime(),
  agentId: z.string().min(1).optional(),
  payload: z.record(z.string(), JsonValueSchema).default({}),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const ArtifactTypeSchema = z.enum([
  "SearchPlan",
  "JobCandidate",
  "CompanyEvidence",
  "LocationCandidate",
  "MatchProposal",
  "CoverageReceipt",
  "generic",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: ArtifactTypeSchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  runId: z.string().min(1),
  sourceRefs: z.array(z.string().min(1)).max(100).default([]),
  payload: z.record(z.string(), JsonValueSchema),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expiresAt: z.string().datetime().optional(),
});
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;

export const ContextPackSchema = z.object({
  role: z.string().min(1).max(120),
  task: z.string().min(1).max(20_000),
  artifactRefs: z.array(z.string().min(1)).max(500).default([]),
  toolAllowlist: z.array(z.string().min(1).max(160)).max(100).default([]),
  redactedFields: z.array(z.string().min(1).max(160)).max(100).default([]),
  content: z.record(z.string(), JsonValueSchema).default({}),
  characterBudget: z.number().int().positive().max(1_000_000).default(40_000),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;

/** Stable, allow-listed resume fields an Agent proposal may target. */
export const ResumeProposalTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile_headline"), locale: z.enum(["zh", "en"]) }),
  z.object({
    kind: z.literal("claim_text"),
    experienceId: z.string().min(1).max(160),
    claimId: z.string().min(1).max(160),
    locale: z.enum(["zh", "en"]),
  }),
]);
export type ResumeProposalTarget = z.infer<typeof ResumeProposalTargetSchema>;

const ResumeEditFieldSchema = z.object({
  targetRef: ResumeProposalTargetSchema,
  text: z.string().min(1).max(12_000),
});

/** Whitelisted, non-contact resume context shared only after an explicit user action. */
export const ResumeEditContextSchema = z.object({
  locale: z.enum(["zh", "en"]),
  profile: z.object({ headline: ResumeEditFieldSchema.optional(), skills: z.array(z.string().max(300)).max(200) }),
  experiences: z.array(z.object({
    id: z.string().min(1).max(160),
    type: z.enum(["work", "opensource", "education", "other"]),
    organization: z.string().max(500),
    title: z.string().max(500),
    claims: z.array(z.object({
      targetRef: ResumeProposalTargetSchema,
      kind: z.string().max(100),
      text: z.string().min(1).max(12_000),
      tags: z.array(z.string().max(120)).max(40),
    })).max(120),
  })).max(80),
}).superRefine((value, context) => {
  if (JSON.stringify(value).length > 80_000) {
    context.addIssue({ code: "custom", message: "resume edit context exceeds 80KB" });
  }
});
export type ResumeEditContext = z.infer<typeof ResumeEditContextSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * Isolation is reported separately from runtime availability. `process` only
 * means shell-free execution in a dedicated run directory; it is not an OS
 * permission boundary. `os-sandbox` is reserved for a provider that enforces
 * read/write policy outside the Node process.
 */
export const RunIsolationSchema = z.enum(["process", "os-sandbox", "none"]);
export type RunIsolation = z.infer<typeof RunIsolationSchema>;

export const RunRecordSchema = z.object({
  id: z.string().min(1),
  workflow: z.string().min(1).max(120),
  runtimeId: z.string().min(1).max(120),
  status: RunStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  runDirectory: z.string().min(1),
  outputDirectory: z.string().min(1),
  isolation: RunIsolationSchema.default("process"),
  allowedReadPaths: z.array(z.string().min(1)).max(20).default([]),
  error: z.string().max(4000).optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const ApprovalStatusSchema = z.enum(["preview", "pending_approval", "approved", "rejected", "expired", "revoked", "committed"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalBatchSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  status: ApprovalStatusSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().min(8).max(200),
  actorScope: z.string().min(1).max(200),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  artifactRefs: z.array(z.string().min(1)).max(500).default([]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type ApprovalBatch = z.infer<typeof ApprovalBatchSchema>;

export function parseAgentEvent(value: unknown): AgentEvent {
  return AgentEventSchema.parse(value);
}

export function parseRuntimeAgentInfo(value: unknown): RuntimeAgentInfo {
  return RuntimeAgentInfoSchema.parse(value);
}
