import { z } from "zod";

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

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  actions: z.array(AgentActionCardSchema).optional(),
  createdAt: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestBodySchema = z.object({
  messages: z.array(ChatMessageSchema),
  modelSettings: z.object({
    baseUrl: z.string().url().optional(),
    model: z.string().min(1),
    apiKey: z.string().optional().default("ollama-key"),
    temperature: z.number().min(0).max(2).optional(),
  }),
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
  }).optional(),
});

export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;

export interface ChatResponseBody {
  reply: ChatMessage;
}
