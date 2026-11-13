import { z } from "zod";
import { ResumeEditContextSchema, ResumeProposalTargetSchema, type ResumeEditContext, type ResumeProposalTarget } from "./index.js";
const target:z.ZodType<ResumeProposalTarget>=z.lazy(()=>ResumeProposalTargetSchema);
const editContext:z.ZodType<ResumeEditContext>=z.lazy(()=>ResumeEditContextSchema);

/** Shared data contract. Cards are proposals, never permission to execute an effect. */
export const AgentActionCardSchema = z.discriminatedUnion("type", [
  z.object({ type:z.literal("company_card"), companyName:z.string(), ownership:z.string().optional(), jurisdiction:z.string().optional(), summary:z.string(), verified:z.boolean().default(false), officialUrl:z.string().url().optional() }),
  z.object({ type:z.literal("resume_proposal"), targetSection:z.string(), originalText:z.string().optional(), proposedText:z.string(), rationale:z.string(), targetRef:target.optional() }),
  z.object({ type:z.literal("job_match"), jobId:z.string().optional(), title:z.string(), company:z.string(), salary:z.string().optional(), location:z.string().optional(), highlight:z.string() }),
  z.object({ type:z.literal("interview_defense"), gapItem:z.string(), strategy:z.string(), sampleAnswer:z.string() }),
  z.object({ type:z.literal("badge_3d"), title:z.string(), highlight:z.string(), style:z.enum(["quantum_prism","cyber_neon","sunset_solitude"]).default("quantum_prism"), imageUrl:z.string().optional(), renderDurationMs:z.number().optional(), rationale:z.string().optional() }),
]);
export type AgentActionCard = z.infer<typeof AgentActionCardSchema>;
export const AgentMessageMetaSchema = z.object({
  provider:z.enum(["openai-compatible","gemini","ollama","custom"]), providerLabel:z.string().optional(), model:z.string().min(1),
  source:z.enum(["agent-host","browser-direct"]), status:z.enum(["ready","fallback","error","truncated"]),
  completeness:z.enum(["complete","truncated","empty"]).optional(), observedAt:z.string().datetime().optional(), finishReason:z.string().optional(), warning:z.string().optional(),
  taskId:z.string().regex(/^ct_[a-f0-9]{32}$/).optional(),
});
export type AgentMessageMeta = z.infer<typeof AgentMessageMetaSchema>;
export const ChatMessageSchema = z.object({
  id:z.string(), role:z.enum(["user","assistant","system"]), content:z.string(),
  attachments:z.array(z.object({ name:z.string().min(1).max(160), mimeType:z.string().regex(/^image\/(png|jpeg|webp)$/i).max(120), dataUrl:z.string().regex(/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i).max(8_000_000) })).max(3).optional(),
  references:z.array(z.object({ type:z.literal("resume_text"), text:z.string().min(1), sourceLabel:z.string().min(1).max(200) })).max(5).optional(),
  actions:z.array(AgentActionCardSchema).optional(), meta:AgentMessageMetaSchema.optional(), createdAt:z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export const AgentChatContextSchema = z.object({
  currentJob:z.object({ title:z.string().optional(), company:z.string().optional(), location:z.string().optional(), description:z.string().optional() }).optional(),
  resumeSummary:z.object({ displayName:z.string().optional(), headline:z.string().optional(), skills:z.array(z.string()).optional(), recentExperience:z.string().optional() }).optional(),
  selectedText:z.string().optional(), resumeEditContext:editContext.optional(),
  sharedMemory:z.string().optional(),
});
export type AgentChatContext = z.infer<typeof AgentChatContextSchema>;

/** Keep the exact image payloads out of the text JSON only when transported as image parts. */
export function chatTextMaterial(value:{messages:ChatMessage[];context?:AgentChatContext}){
  return {...value,messages:value.messages.map(message=>({...message,attachments:message.attachments?.map(({name,mimeType})=>({name,mimeType}))}))};
}
export function validChatMaterial(value:{messages:ChatMessage[];context?:AgentChatContext}){
  const images=value.messages.flatMap(message=>message.attachments??[]);
  return JSON.stringify(chatTextMaterial(value)).length<=1_000_000
    && images.reduce((sum,image)=>sum+image.dataUrl.length,0)<=6_000_000
    && new TextEncoder().encode(JSON.stringify(value)).byteLength<=7*1024*1024
    && value.messages.every(message=>!message.attachments?.length||message.role==="user")
    && images.every(image=>image.dataUrl.toLowerCase().startsWith(`data:${image.mimeType.toLowerCase()};base64,`));
}
