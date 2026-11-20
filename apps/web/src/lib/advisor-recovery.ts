import { z } from "zod";
import { careerJobSnapshotVersion, inventoryDigest, ResumeProposalTargetSchema } from "@better-me/agent-contracts";
import { LlmConfigSchema, type ProjectedResume } from "@better-me/core";
import type { ChatMessage, MatchProposal, ProposalDecision, StructuredJd } from "../services/agent-client";
import { jdMatchResumeMaterial } from "../services/jd-match-task-client";

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
const AdvisorMatchSchema = z.object({
  threadId: z.string(), structuredJd: StructuredSchema.nullable(), proposals: z.array(ProposalSchema),
  decisions: z.record(z.string(), DecisionSchema), editedText: z.string(), editingProposalId: z.string().nullable(),
}).strict();
export const emptyAdvisorMatch: z.infer<typeof AdvisorMatchSchema> = {
  threadId: "", structuredJd: null, proposals: [], decisions: {}, editedText: "", editingProposalId: null,
};
export type AdvisorMatch = z.infer<typeof AdvisorMatchSchema>;
const JobDraftFieldsSchema = z.object({
  inputTitle: z.string(), inputCompany: z.string(), inputSalary: z.string(), inputLocation: z.string(), inputDescription: z.string(),
  sourceUrl: z.string().optional(), sourcePlatform: z.string().optional(), isEditingJob: z.boolean(), linkInputValue: z.string(),
}).strict();
const JobDraftSchema = JobDraftFieldsSchema.extend({ beforeBrowserImport: JobDraftFieldsSchema.optional() });
const AdvisorConversationSchema = z.object({
  messages: z.array(RecoveryMessageSchema), inputMessage: z.string(), pendingReferences: z.array(RecoveryReferenceSchema),
  pendingAttachments: z.array(RecoveryImageSchema), pendingChatId: z.string().optional(),
}).strict();
const emptyConversation: z.infer<typeof AdvisorConversationSchema> = {
  messages: [], inputMessage: "", pendingReferences: [], pendingAttachments: [], pendingChatId: undefined,
};
export const BrowserJobSchema = RecoveryJobSchema.extend({ syncedAt: z.number().finite() });
export const AdvisorRecoverySchema = z.object({
  jobSeed: RecoveryJobSchema.nullable(), currentJob: RecoveryJobSchema.nullable(), ...JobDraftSchema.shape,
  jobDrafts: z.record(z.string(), JobDraftSchema).default({}),
  browserJob: BrowserJobSchema.optional(),
  lastBrowserSyncAt: z.number().finite().optional(),
  ...AdvisorConversationSchema.shape,
  conversations: z.record(z.string(), AdvisorConversationSchema).default({}),
  // Keep pre-scope records recoverable in the journal. Their JD and résumé provenance cannot be proven.
  ...AdvisorMatchSchema.shape,
  matches: z.record(z.string(), AdvisorMatchSchema).default({}),
  taskView: z.enum(["job", "resume", "career", "learning", "practice", "handoff"]), showCareerCoach: z.boolean(),
}).strict();

type RecoveryJob = z.infer<typeof RecoveryJobSchema>;
export function advisorJobKey(job: RecoveryJob | null) {
  return job ? inventoryDigest([careerJobSnapshotVersion(job), job.salary ?? null, job.location ?? null]) : "unassigned";
}

export function advisorMatchKey(job: RecoveryJob | null, resume: ProjectedResume | null, documentKey?: string) {
  if (!job?.description) return undefined;
  const basis = [advisorJobKey(job), documentKey ?? null, Boolean(resume)];
  try {
    return inventoryDigest([...basis, jdMatchResumeMaterial(resume)]);
  } catch {
    // Invalid résumé sources have a UI scope for the validation error, but cannot start a match.
    return inventoryDigest([...basis, "invalid-resume"]);
  }
}

export function advisorJobDraft(job: RecoveryJob | null) {
  return { inputTitle: job?.title ?? "", inputCompany: job?.company ?? "", inputSalary: job?.salary ?? "", inputLocation: job?.location ?? "", inputDescription: job?.description ?? "",
    sourceUrl: job?.sourceUrl, sourcePlatform: job?.sourcePlatform, isEditingJob: false, linkInputValue: "", beforeBrowserImport: undefined };
}

export function switchAdvisorJob(state: z.infer<typeof AdvisorRecoverySchema>, job: RecoveryJob | null) {
  const outgoing = advisorJobKey(state.currentJob), incoming = advisorJobKey(job);
  if (outgoing === incoming) return { ...state, jobSeed: job, currentJob: job };
  const jobDrafts = { ...state.jobDrafts };
  const draft = JobDraftSchema.strip().parse(state);
  if (JSON.stringify(draft) !== JSON.stringify(advisorJobDraft(state.currentJob))) jobDrafts[outgoing] = draft;
  const next = jobDrafts[incoming] ?? advisorJobDraft(job);
  delete jobDrafts[incoming];
  return {
    ...switchAdvisorConversation(state, job), ...next, beforeBrowserImport: next.beforeBrowserImport,
    jobSeed: job, currentJob: job, jobDrafts,
  };
}

export function switchAdvisorConversation(state: z.infer<typeof AdvisorRecoverySchema>, job: RecoveryJob | null) {
  const outgoing = advisorJobKey(state.currentJob), incoming = advisorJobKey(job);
  if (outgoing === incoming) return state;
  const conversations = { ...state.conversations };
  const conversation = AdvisorConversationSchema.strip().parse(state);
  if (conversation.messages.length || conversation.inputMessage || conversation.pendingReferences.length || conversation.pendingAttachments.length || conversation.pendingChatId) {
    conversations[outgoing] = conversation;
  }
  const next = conversations[incoming] ?? emptyConversation;
  delete conversations[incoming];
  return { ...state, ...next, pendingChatId: next.pendingChatId, conversations };
}

export function initialAdvisorRecovery(job: RecoveryJob | null): z.infer<typeof AdvisorRecoverySchema> {
  return { jobSeed: job, currentJob: job, ...advisorJobDraft(job), jobDrafts: {}, ...emptyConversation, conversations: {},
    ...emptyAdvisorMatch, matches: {}, taskView: "job", showCareerCoach: false };
}

export function captureAdvisorJobDraft(state: z.infer<typeof AdvisorRecoverySchema>) {
  return JobDraftFieldsSchema.strip().parse(state);
}
export const CompanionRecoverySchema = z.object({ messages: z.array(RecoveryMessageSchema), draft: z.string(),
  references: z.array(RecoveryReferenceSchema), attachments: z.array(RecoveryImageSchema), prompt: z.string(), pending: z.boolean() }).strict();
