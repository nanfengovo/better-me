import { z } from "zod";

export const LlmConfigSchema = z.object({
  provider: z
    .enum(["openai-compatible", "gemini", "ollama", "custom"])
    .default("openai-compatible"),
  baseUrl: z.string().url().default("https://api.deepseek.com"),
  apiKey: z.string().optional().default(""),
  model: z.string().min(1).default("deepseek-flash"),
  temperature: z.number().min(0).max(2).default(0.3),
  /** DeepSeek-specific controls; ignored for other providers. Old saved configs remain valid. */
  thinkingMode: z.enum(["enabled", "disabled"]).optional(),
  reasoningEffort: z.enum(["low", "high", "max"]).optional(),
  maxTokens: z.number().int().min(1).max(393216).optional(),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const JdRecommendationSchema = z.object({
  claimId: z.string().optional(),
  currentText: z.string().optional(),
  suggestedText: z.string(),
  reason: z.string(),
});

export type JdRecommendation = z.infer<typeof JdRecommendationSchema>;

export const JdMatchReportSchema = z.object({
  matchScore: z.number().min(0).max(100),
  scoreSummary: z.string(),
  matchingStrengths: z.array(z.string()).default([]),
  missingGaps: z.array(z.string()).default([]),
  tailoredSuggestions: z.array(JdRecommendationSchema).default([]),
  /** Computed locally: suggestions excluded because their source could not be bound. */
  unverifiedSuggestionCount: z.number().int().nonnegative().default(0),
  interviewDefenseTips: z.array(z.string()).default([]),
});

export type JdMatchReport = z.infer<typeof JdMatchReportSchema>;
