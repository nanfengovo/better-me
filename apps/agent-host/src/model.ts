/**
 * model.ts — Build a ChatOpenAI-compatible model from the AI settings
 * that the browser passes in per-request.
 *
 * Supports any OpenAI-compatible endpoint (OpenAI, DeepSeek, local Ollama,
 * Gemini OpenAI-compat shim) without importing Vercel AI SDK or any second
 * model runtime.  Only @langchain/openai is needed.
 */

import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface ModelSettings {
  /** OpenAI-compatible base URL. Omit for official OpenAI. */
  baseUrl?: string;
  /** Model name, e.g. "gpt-4o", "deepseek-chat", "gemini-1.5-pro" */
  model: string;
  /** API key – never persisted, passed in per-request from browser. */
  apiKey: string;
  /** Temperature for generation (default: 0). */
  temperature?: number;
}

export function buildModel(settings: ModelSettings): BaseChatModel {
  let baseURL = settings.baseUrl?.trim();
  if (baseURL) {
    baseURL = baseURL.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
  }

  return new ChatOpenAI({
    model: settings.model,
    apiKey: settings.apiKey || "mock-key",
    configuration: baseURL
      ? { baseURL }
      : undefined,
    temperature: settings.temperature ?? 0,
    // Do not stream inside graph nodes — the HTTP layer handles SSE framing.
    streaming: false,
  });
}
