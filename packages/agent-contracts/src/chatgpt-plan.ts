import { z } from "zod";

/** Public metadata only. OAuth credentials never cross this boundary. */
export const ChatGptIssueSchema = z.object({
  kind: z.enum(["auth", "permission", "eligibility", "limit", "unavailable", "model", "incomplete", "protocol", "cancelled"]),
  code: z.string().max(160), message: z.string().max(1000),
  status: z.number().int().optional(), requestId: z.string().max(160).optional(),
});
export const ChatGptModelSchema = z.object({ slug: z.string().min(1).max(200), displayName: z.string().min(1).max(300) });
export const ChatGptProfileSchema = z.object({
  id: z.string(), label: z.string(), state: z.enum(["signed-out", "connected", "plan-disabled", "reauth-required"]),
  issue: ChatGptIssueSchema.optional(), lastCompletedAt: z.string().datetime().optional(),
});
export const ChatGptStateSchema = z.object({
  profiles: z.array(ChatGptProfileSchema),
  attempt: z.object({ id: z.string(), profileId: z.string(), phase: z.enum(["waiting", "exchanging", "completed", "cancelled", "error", "expired"]),
    expiresAt: z.string().datetime(), issue: ChatGptIssueSchema.optional() }).optional(),
  usageUrl: z.literal("https://chatgpt.com/settings/usage"),
  automaticBillingFallback: z.literal(false),
  authorizationUnavailableReason: z.string().max(1000).optional(),
});
export const ChatGptRuntimeSchema = z.object({ kind: z.literal("chatgpt"), profileId: z.string().min(1).max(100), model: z.string().min(1).max(200) }).strict();
export const ChatGptResponseRequestSchema = z.object({
  profileId: z.string().min(1).max(100), model: z.string().min(1).max(200),
  instructions: z.string().max(20000),
  input: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(100000) }).strict()).min(1).max(50),
  consentToSend: z.literal(true),
}).strict();
export type ChatGptIssue = z.infer<typeof ChatGptIssueSchema>;
export type ChatGptModel = z.infer<typeof ChatGptModelSchema>;
export type ChatGptState = z.infer<typeof ChatGptStateSchema>;
export type ChatGptRuntime = z.infer<typeof ChatGptRuntimeSchema>;
export type ChatGptResponseRequest = z.infer<typeof ChatGptResponseRequestSchema>;
