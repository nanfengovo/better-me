import { z } from "zod";

// IDs refer to registered adapters, never commands, paths or browser-supplied owners.
export const AgentBaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
export const AgentRoutingPolicySchema = z.object({
  revision: z.number().int().nonnegative(),
  mode: z.enum(["legacy", "manual", "auto"]),
  preferred: AgentBaseIdSchema,
  backups: z.array(AgentBaseIdSchema).max(12),
  allowApiBackups: z.boolean(),
}).strict().refine(value => new Set([value.preferred, ...value.backups]).size === value.backups.length + 1, "duplicate runtime");
export type AgentRoutingPolicy = z.infer<typeof AgentRoutingPolicySchema>;
export const defaultAgentRoutingPolicy: AgentRoutingPolicy = {
  revision: 0, mode: "legacy", preferred: "claude-code", backups: ["opencode", "gemini-cli", "codex"], allowApiBackups: false,
};
export const AgentRoutingUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  mode: z.enum(["legacy", "manual", "auto"]), preferred: AgentBaseIdSchema,
  backups: z.array(AgentBaseIdSchema).max(12), allowApiBackups: z.boolean(), consent: z.literal(true),
}).strict();
export const AgentRoutingAttemptSchema = z.object({
  runtimeId: AgentBaseIdSchema, status: z.enum(["skipped", "selected", "completed", "stopped"]),
  code: z.string().regex(/^[a-z0-9_]+$/).max(100), reason: z.string().max(500),
}).strict();
export const AgentRoutingTraceSchema = z.object({
  id: z.string().uuid(), policyRevision: z.number().int().nonnegative(),
  state: z.enum(["running", "completed", "failed", "cancelled"]),
  at: z.string().datetime(), runtimeId: AgentBaseIdSchema.optional(),
  attempts: z.array(AgentRoutingAttemptSchema).max(40),
}).strict();
export type AgentRoutingTrace = z.infer<typeof AgentRoutingTraceSchema>;
export const AgentRoutingRequestSchema = z.object({
  id: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), consentToSend: z.literal(true),
  instructions: z.string().max(60_000),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(200_000) }).strict()).min(1).max(80),
}).strict();
export const AgentRoutingResultSchema = z.object({ text: z.string().min(1).max(1_000_000), trace: AgentRoutingTraceSchema }).strict();
