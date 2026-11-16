import type { LlmConfig } from "@better-me/core";

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKey: "",
  model: "gemini-1.5-flash",
  temperature: 0.3,
};
