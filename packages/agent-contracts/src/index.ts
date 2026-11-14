import { z } from "zod";
export * from "./chatgpt-plan.js";
export * from "./social-login.js";
export * from "./agent-routing.js";

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

export * from "./resume-edit-context.js";

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

export const AutopilotJobStatusSchema = z.enum([
  "queued",
  "prefetching",
  "ready_for_approval",
  "hibernated",
  "interview_prep",
  "offer_backcheck",
  "onboarded",
  "declined",
]);
export type AutopilotJobStatus = z.infer<typeof AutopilotJobStatusSchema>;

export const CompanyBackcheckEvidenceTierSchema = z.enum(["tier1_compliance", "tier2_business", "tier3_sentiment"]);
export type CompanyBackcheckEvidenceTier = z.infer<typeof CompanyBackcheckEvidenceTierSchema>;

export const CompanyBackcheckEvidenceSchema = z.object({
  id: z.string().min(1),
  tier: CompanyBackcheckEvidenceTierSchema,
  sourceName: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  observedAt: z.string().datetime(),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string().min(1),
  sanitizedExcerpt: z.string().min(1),
  strippedInjectionFragments: z.number().int().nonnegative().default(0),
});
export type CompanyBackcheckEvidence = z.infer<typeof CompanyBackcheckEvidenceSchema>;

export const CompanyBackcheckReportSchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  legalEntity: z.string().min(1),
  generatedAt: z.string().datetime(),
  tier1ComplianceSummary: z.string().min(1),
  tier2BusinessSummary: z.string().min(1),
  tier3SentimentSummary: z.string().min(1),
  estimatedSchedule: z.string().min(1),
  estimatedWeeklyHours: z.number().positive(),
  bonusRealizationRate: z.number().min(0).max(1.5),
  sentimentSampleCount: z.number().int().nonnegative(),
  overallRecommendation: z.enum(["strongly_recommended", "recommended_with_caution", "high_risk_decline"]),
  evidences: z.array(CompanyBackcheckEvidenceSchema).min(1),
});
export type CompanyBackcheckReport = z.infer<typeof CompanyBackcheckReportSchema>;

export const MicroAppScopeSchema = z.enum(["selected_offers", "backcheck_summary", "job_snapshots"]);
export type MicroAppScope = z.infer<typeof MicroAppScopeSchema>;

export const MicroAppManifestSchema = z.object({
  appId: z.string().regex(/^[a-z0-9][a-z0-9-_]{2,63}$/),
  name: z.string().min(1).max(80),
  nameEn: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  dependencies: z.record(z.string(), z.string()).default({}),
  grantedScopes: z.array(MicroAppScopeSchema).min(1),
  pinnedToDock: z.boolean().default(true),
});
export type MicroAppManifest = z.infer<typeof MicroAppManifestSchema>;

export const MicroAppBuildReceiptSchema = z.object({
  appId: z.string().min(1),
  version: z.string().min(1),
  codeHash: z.string().regex(/^[a-f0-9]{16,64}$/),
  verifierVersion: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  syntheticFixturesPassed: z.number().int().nonnegative(),
  containerIsolationFlags: z.array(z.string().min(1)).min(1),
  verifiedAt: z.string().datetime(),
});
export type MicroAppBuildReceipt = z.infer<typeof MicroAppBuildReceiptSchema>;

export * from "./project-understanding.js";
export * from "./capabilities.js";
export * from "./evidence-handoff.js";
export * from "./resume-adoption.js";
export * from "./career-task.js";
export * from "./agent-chat.js";
export * from "./agent-task.js";
export * from "./growth-practice.js";
export * from "./growth-journey.js";
export * from "./learning-path.js";
export * from "./learning-translation.js";
export * from "./jd-match.js";
export * from "./mock-interview.js";
export * from "./jd-intake.js";
export * from "./jd-ocr.js";
export * from "./task-scope.js";
export * from "./studio-committee.js";
