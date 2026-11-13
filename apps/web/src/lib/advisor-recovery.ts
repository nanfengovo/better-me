import { z } from "zod";
import { ResumeProposalTargetSchema } from "@better-me/agent-contracts";
import { LlmConfigSchema } from "@better-me/core";
import type { ChatMessage, MatchProposal, ProposalDecision, StructuredJd } from "../services/agent-client";

export const RecoveryJobSchema = z.object({ id: z.string().optional(), title: z.string(), company: z.string(), description: z.string(),
  salary: z.string().optional(), location: z.string().optional(), sourceUrl: z.string().optional(), sourcePlatform: z.string().optional() }).strict();
export const RecoveryReferenceSchema = z.object({ type: z.literal("resume_text"), text: z.string(), sourceLabel: z.string() }).strict();
export const RecoveryImageSchema = z.object({ name: z.string(), mimeType: z.string(), dataUrl: z.string() }).strict();
export const RecoveryMessageSchema: z.ZodType<ChatMessage> = z.object({
  id: z.string(), role: z.enum(["user", "assistant", "system"]), content: z.string(), createdAt: z.string().optional(),
  attachments: z.array(RecoveryImageSchema).optional(), references: z.array(RecoveryReferenceSchema).optional(),
  actions: z.array(z.object({ type: z.enum(["company_card", "resume_proposal", "job_match", "interview_defense", "badge_3d"]),
    targetRef: ResumeProposalTargetSchema.optional(), sourceVerified: z.boolean().optional(),
    sourceIssue: z.enum(["missing_target", "not_shared", "original_mismatch"]).optional(),
    style: z.enum(["quantum_prism", "cyber_neon", "sunset_solitude"]).optional(),
    companyName: z.string().optional(), ownership: z.string().optional(), jurisdiction: z.string().optional(), summary: z.string().optional(),
    verified: z.boolean().optional(), officialUrl: z.string().optional(), targetSection: z.string().optional(), originalText: z.string().optional(),
    proposedText: z.string().optional(), rationale: z.string().optional(), jobId: z.string().optional(), title: z.string().optional(),
    company: z.string().optional(), salary: z.string().optional(), location: z.string().optional(), highlight: z.string().optional(),
    gapItem: z.string().optional(), strategy: z.string().optional(), sampleAnswer: z.string().optional(), imageUrl: z.string().optional(), renderDurationMs: z.number().optional(),
  }).strict()).optional(),
  meta: z.object({ provider: LlmConfigSchema.shape.provider.removeDefault(), providerLabel: z.string(), model: z.string(),
    source: z.enum(["agent-host", "browser-direct"]), status: z.enum(["ready", "fallback", "error", "truncated"]),
    completeness: z.enum(["complete", "truncated", "empty"]).optional(), observedAt: z.string(), finishReason: z.string().optional(), warning: z.string().optional(), taskId:z.string().regex(/^ct_[a-f0-9]{32}$/).optional() }).strict().optional(),
}).strict();
const ProposalSchema: z.ZodType<MatchProposal> = z.object({ id: z.string(), jdItem: z.string(), evidenceType: z.enum(["verified", "claimed", "gap"]),
  profileEntryId: z.string().optional(), suggestion: z.string(), rationale: z.string(),evidenceIds:z.array(z.string()).optional() }).strict();
const DecisionSchema: z.ZodType<ProposalDecision> = z.discriminatedUnion("status", [z.object({ status: z.literal("accepted") }).strict(),
  z.object({ status: z.literal("rejected"), reason: z.string().optional() }).strict(), z.object({ status: z.literal("edited"), editedSuggestion: z.string() }).strict()]);
const StructuredSchema: z.ZodType<StructuredJd> = z.object({ title: z.string(), company: z.string(), location: z.string(), requirements: z.array(z.string()),
  responsibilities: z.array(z.string()).optional(), qualifications: z.array(z.string()).optional(), preferences: z.array(z.string()), compensationRaw: z.string().nullable(), techStack: z.array(z.string()) }).strict();
export const AdvisorRecoverySchema = z.object({
  jobSeed: RecoveryJobSchema.nullable(), currentJob: RecoveryJobSchema.nullable(), inputTitle: z.string(), inputCompany: z.string(), inputSalary: z.string(), inputLocation: z.string(), inputDescription: z.string(),
  sourceUrl: z.string().optional(), sourcePlatform: z.string().optional(), isEditingJob: z.boolean(), linkInputValue: z.string(),
  messages: z.array(RecoveryMessageSchema), inputMessage: z.string(), pendingReferences: z.array(RecoveryReferenceSchema), pendingAttachments: z.array(RecoveryImageSchema), pendingChatId: z.string().optional(),
  threadId: z.string(), structuredJd: StructuredSchema.nullable(), proposals: z.array(ProposalSchema), decisions: z.record(DecisionSchema),
  editedText: z.string(), editingProposalId: z.string().nullable(),
  taskView: z.enum(["job", "resume", "career", "learning", "practice", "handoff"]), showCareerCoach: z.boolean(),
}).strict();
export function initialAdvisorRecovery(job: z.infer<typeof RecoveryJobSchema> | null): z.infer<typeof AdvisorRecoverySchema> {
  return { jobSeed: job, currentJob: job, inputTitle: job?.title ?? "", inputCompany: job?.company ?? "", inputSalary: job?.salary ?? "", inputLocation: job?.location ?? "", inputDescription: job?.description ?? "",
    sourceUrl: job?.sourceUrl, sourcePlatform: job?.sourcePlatform, isEditingJob: false, linkInputValue: "", messages: [], inputMessage: "", pendingReferences: [], pendingAttachments: [],
    threadId: "", structuredJd: null, proposals: [], decisions: {}, editedText: "", editingProposalId: null, taskView: "job", showCareerCoach: false };
}
export const CompanionRecoverySchema = z.object({ messages: z.array(RecoveryMessageSchema), draft: z.string(),
  references: z.array(RecoveryReferenceSchema), attachments: z.array(RecoveryImageSchema), prompt: z.string(), pending: z.boolean() }).strict();
