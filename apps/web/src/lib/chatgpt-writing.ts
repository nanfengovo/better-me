import type { ChatGptChoice, ChatGptClient } from "../services/chatgpt-client";
import { parseWritingReply, writingMessages, type ConfirmedWritingProjectContext, type WritingSource } from "./resume-copilot";

/** Never passes LlmConfig or an API key into this route. A failed request stays failed. */
export async function generateChatGptWritingReply(client: ChatGptClient, choice: ChatGptChoice, source: WritingSource,
  answer: string, signal: AbortSignal, context?: ConfirmedWritingProjectContext, sharedAgentContext?: string) {
  const messages = writingMessages(source, answer, context, sharedAgentContext);
  const result = await client.respond({ ...choice, consentToSend: true,
    instructions: messages.filter(message => message.role === "system").map(message => message.content).join("\n"),
    input: messages.filter(message => message.role === "user").map(message => ({ role: "user" as const, content: message.content })),
  }, signal);
  signal.throwIfAborted();
  if (result.profileId !== choice.profileId || result.model !== choice.model) throw new Error("ChatGPT 回复与所选账号或模型不一致，未采用。");
  return parseWritingReply(result.text, source, answer);
}
