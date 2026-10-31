import { z } from "zod";
import { ModelSettingsSchema } from "../model.js";
import { ResumeEditContextSchema, ResumeProposalTargetSchema } from "@better-me/agent-contracts";

export const AgentActionCardSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("company_card"),
    companyName: z.string(),
    ownership: z.string().optional(),
    jurisdiction: z.string().optional(),
    summary: z.string(),
    verified: z.boolean().default(false),
    officialUrl: z.string().url().optional(),
  }),
  z.object({
    type: z.literal("resume_proposal"),
    targetSection: z.string(),
    originalText: z.string().optional(),
    proposedText: z.string(),
    rationale: z.string(),
    targetRef: ResumeProposalTargetSchema.optional(),
  }),
  z.object({
    type: z.literal("job_match"),
    jobId: z.string().optional(),
    title: z.string(),
    company: z.string(),
    salary: z.string().optional(),
    location: z.string().optional(),
    highlight: z.string(),
  }),
  z.object({
    type: z.literal("interview_defense"),
    gapItem: z.string(),
    strategy: z.string(),
    sampleAnswer: z.string(),
  }),
]);

export type AgentActionCard = z.infer<typeof AgentActionCardSchema>;

export const AgentMessageMetaSchema = z.object({
  provider: z.enum(["openai-compatible", "gemini", "ollama", "custom"]),
  providerLabel: z.string().optional(),
  model: z.string().min(1),
  source: z.enum(["agent-host", "browser-direct"]),
  status: z.enum(["ready", "fallback", "error", "truncated"]),
  completeness: z.enum(["complete", "truncated", "empty"]).optional(),
  observedAt: z.string().datetime().optional(),
  finishReason: z.string().optional(),
  warning: z.string().optional(),
});

export type AgentMessageMeta = z.infer<typeof AgentMessageMetaSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  attachments: z.array(z.object({
    name: z.string().min(1).max(160),
    mimeType: z.string().regex(/^image\/(png|jpeg|webp)$/i).max(120),
    dataUrl: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i).max(8_000_000),
  })).max(3).optional(),
  references: z.array(z.object({
    type: z.literal("resume_text"),
    text: z.string().min(1).max(12_000),
    sourceLabel: z.string().min(1).max(200),
  })).max(5).optional(),
  actions: z.array(AgentActionCardSchema).optional(),
  meta: AgentMessageMetaSchema.optional(),
  createdAt: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestBodySchema = z.object({
  messages: z.array(ChatMessageSchema),
  modelSettings: ModelSettingsSchema,
  context: z.object({
    currentJob: z.object({
      title: z.string().optional(),
      company: z.string().optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    }).optional(),
    resumeSummary: z.object({
      displayName: z.string().optional(),
      headline: z.string().optional(),
      skills: z.array(z.string()).optional(),
      recentExperience: z.string().optional(),
    }).optional(),
    selectedText: z.string().max(12_000).optional(),
    resumeEditContext: ResumeEditContextSchema.optional(),
  }).optional(),
});

export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;

export interface ChatResponseBody {
  reply: ChatMessage;
}
