import { z } from "zod";
import type { LlmConfig } from "@better-me/core";
import { ResumeProposalTargetSchema, type ResumeEditContext } from "@better-me/agent-contracts";

const text = z.string().trim().min(1).max(4000);
const short = z.string().trim().min(1).max(400);
const points = z.array(text).max(12);
export const COACH_MODES = ["analysis", "resume", "plan", "review", "interview", "drill"] as const;
export type CoachMode = typeof COACH_MODES[number];

export const CoachAnalysisSchema = z.object({
  kind: z.literal("analysis"), summary: text,
  directions: z.array(z.object({ title: short, reason: text, evidence: points, tradeoffs: points }).strict()).min(1).max(4),
  strengths: points,
  gaps: z.array(z.object({ skill: short, status: z.enum(["unknown", "needs_practice"]), reason: text }).strict()).max(12),
  questions: z.array(z.object({ question: text, why: text, options: z.array(short).max(5) }).strict()).max(3),
  nextActions: points,
}).strict();

export const CoachTaskSchema = z.object({
  id: z.string().min(1).max(80), title: short, week: z.number().int().min(1).max(52),
  minutes: z.number().int().min(15).max(1200), deliverable: text,
  acceptanceCriteria: z.array(text).min(1).max(6), resourceQueries: z.array(short).max(5),
}).strict();
export const CoachPlanSchema = z.object({
  kind: z.literal("plan"), title: short, goal: text,
  durationWeeks: z.number().int().min(1).max(52), weeklyHours: z.number().min(1).max(40),
  phases: z.array(z.object({ title: short, startWeek: z.number().int().min(1).max(52), endWeek: z.number().int().min(1).max(52),
    objective: text, tasks: z.array(CoachTaskSchema).min(1).max(12) }).strict()).min(1).max(8),
  risks: points, reviewCadence: text,
}).strict();
export const CoachReviewSchema = z.object({
  kind: z.literal("review"), summary: text,
  evidenceAssessment: z.enum(["insufficient", "needs_revision", "ready_for_self_check"]),
  strengths: points, improvements: points, nextActions: points, checkQuestions: points,
}).strict();
export const CoachInterviewFeedbackSchema = z.object({
  summary: text, strengths: points, improvements: points,
  rubric: z.array(z.object({ criterion: short, score: z.number().int().min(0).max(4), comment: text }).strict()).min(1).max(5),
}).strict();
export const CoachInterviewSchema = z.object({
  kind: z.literal("interview"), complete: z.boolean(),
  question: z.object({ text, focus: short, evaluationCriteria: z.array(text).min(1).max(5) }).strict().optional(),
  feedback: CoachInterviewFeedbackSchema.optional(), summary: text.optional(), nextActions: points,
}).strict();
export const CoachResumeSchema = z.object({
  kind: z.literal("resume"), summary: text,
  proposals: z.array(z.object({ targetRef: ResumeProposalTargetSchema, originalText: z.string().min(1).max(12000), proposedText: z.string().trim().min(1).max(12000), rationale: text }).strict()).max(12),
}).strict();
export const DrillQuestionSchema = z.object({ text, skill: short, why: text, criteria: z.array(text).min(1).max(5) }).strict();
export const DrillFeedbackSchema = z.object({
  verdict: z.enum(["supported", "needs_practice", "uncertain"]), quote: text,
  explanation: text, nextAction: text,
}).strict();
export const CoachDrillSchema = z.object({ kind: z.literal("drill"), question: DrillQuestionSchema.optional(), feedback: DrillFeedbackSchema.optional() }).strict();
export const CoachPayloadSchema = z.discriminatedUnion("kind", [CoachAnalysisSchema, CoachResumeSchema, CoachPlanSchema, CoachReviewSchema, CoachInterviewSchema, CoachDrillSchema]);
export type CoachPayload = z.infer<typeof CoachPayloadSchema>;
export type CoachPlan = z.infer<typeof CoachPlanSchema>;
export type CoachTask = z.infer<typeof CoachTaskSchema>;
export type CoachAnalysis = z.infer<typeof CoachAnalysisSchema>;
export type CoachReview = z.infer<typeof CoachReviewSchema>;
export type CoachResume = z.infer<typeof CoachResumeSchema>;
export type CoachInterview = z.infer<typeof CoachInterviewSchema>;
export type CoachInterviewFeedback = z.infer<typeof CoachInterviewFeedbackSchema>;

export const CoachSettingsSchema = z.object({
  goal: z.string().max(4000), background: z.string().max(6000),
  durationWeeks: z.number().int().min(1).max(52), weeklyHours: z.number().min(1).max(40),
  interviewRounds: z.number().int().min(2).max(8),
}).strict();
export type CoachSettings = z.infer<typeof CoachSettingsSchema>;
export const DEFAULT_COACH_SETTINGS: CoachSettings = { goal: "", background: "", durationWeeks: 8, weeklyHours: 5, interviewRounds: 3 };

export interface CoachContext {
  resume?: ResumeEditContext;
  job?: { title?: string; company?: string; description?: string; location?: string };
}
export const CoachInterviewTurnSchema = z.object({
  question: short.or(text), answer: z.string().max(12000), feedback: CoachInterviewFeedbackSchema.optional(),
}).strict();
export type CoachInterviewTurn = z.infer<typeof CoachInterviewTurnSchema>;
export const GoalConfirmationSchema = z.object({
  id: short, recordId: short, confirmedAt: z.string().datetime(), goal: text, summary: text,
  fingerprint: short, contextFingerprint: short, agentMemoryIds: z.array(z.string()).optional(),
}).strict();
export const PracticeReceiptSchema = z.object({
  id: short, exerciseId: short, version: short, sourceHash: short, source: z.string().max(20000),
  at: z.string().datetime(), runner: z.literal("opaque-browser-worker"),
  checks: z.array(z.object({ name: short, passed: z.boolean(), expected: short, actual: short }).strict()).min(1).max(30),
}).strict();
export type PracticeReceipt = z.infer<typeof PracticeReceiptSchema>;
export interface CoachRequest {
  mode: CoachMode;
  settings: CoachSettings;
  input: string;
  sharedProjectContext?: string;
  agentMemoryIds?: string[];
  sourceRecordIds?: string[];
  context?: CoachContext;
  plan?: CoachPlan;
  task?: CoachTask;
  submission?: { evidence: string; minutes: number };
  confirmedGoal?: z.infer<typeof GoalConfirmationSchema>;
  drill?: { topic: string; question?: z.infer<typeof DrillQuestionSchema>; answer?: string };
  interview?: { turns: CoachInterviewTurn[]; totalRounds: number; adaptive?: boolean };
}
export interface CoachGeneration {
  payload: CoachPayload;
  model: { provider: string; name: string; generatedAt: string };
}
export type CoachGenerate = (request: CoachRequest, config: LlmConfig, signal?: AbortSignal) => Promise<CoachGeneration>;

export const CoachRecordSchema = z.object({
  id: z.string().min(1).max(100), createdAt: z.string().datetime(), mode: z.enum(COACH_MODES), input: z.string().max(12000),
  payload: CoachPayloadSchema,
  model: z.object({ provider: short, name: short, generatedAt: z.string().datetime() }).strict(),
  basis: z.object({ resumeShared: z.boolean(), jobShared: z.boolean(), contextFingerprint: z.string().max(100), agentMemoryIds: z.array(z.string()).optional(), goalFingerprint: short.optional(), goalId: short.optional(), parentPlanId: short.optional() }).strict(),
}).strict();
export type CoachRecord = z.infer<typeof CoachRecordSchema>;
export const CoachTaskProgressSchema = z.object({
  status: z.enum(["todo", "in_progress", "submitted", "self_completed"]), updatedAt: z.string().datetime(),
}).strict();
export type CoachTaskStatus = z.infer<typeof CoachTaskProgressSchema>["status"];
export const CoachSubmissionSchema = z.object({
  id: z.string().min(1).max(100), planId: z.string().min(1).max(100), taskId: z.string().min(1).max(80),
  evidence: z.string().trim().min(1).max(12000), minutes: z.number().int().min(0).max(1440),
  createdAt: z.string().datetime(), feedbackRecordId: z.string().max(100).optional(),
  practice: PracticeReceiptSchema.optional(),
}).strict();
export type CoachSubmission = z.infer<typeof CoachSubmissionSchema>;
const ActivePlanSchema = z.object({ id: z.string().min(1).max(100), plan: CoachPlanSchema, startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), progress: z.record(CoachTaskProgressSchema) }).strict();
const InterviewSessionSchema = z.object({ id: z.string().min(1).max(100), totalRounds: z.number().int().min(2).max(8),
  contextFingerprint: z.string().max(100), status: z.enum(["active", "completed", "stopped"]),
  turns: z.array(CoachInterviewTurnSchema).max(8), question: CoachInterviewSchema.shape.question,
  adaptive: z.boolean().optional(), goalFingerprint: short.optional(), summaryRecordId: short.optional(), draft: z.string().max(12000).optional(), sourceRecordIds: z.array(short).optional(),
}).strict();
export const DrillAttemptSchema = z.object({
  id: short, at: z.string().datetime(), topic: short, question: DrillQuestionSchema,
  questionRecordId: short, contextFingerprint: short, goalFingerprint: short,
  answer: z.string().max(12000), draft: z.string().max(12000).optional(), feedbackRecordId: short.optional(),
  reviewAt: z.string().datetime().optional(), disputed: z.boolean().optional(),
}).strict();
export type DrillAttempt = z.infer<typeof DrillAttemptSchema>;
export const CoachStateSchema = z.object({
  schemaVersion: z.literal(1), workspaceKey: z.string().min(1).max(400), revision: z.number().int().nonnegative(), updatedAt: z.string().datetime(),
  settings: CoachSettingsSchema, records: z.array(CoachRecordSchema),
  activePlan: ActivePlanSchema.optional(),
  planHistory: z.array(ActivePlanSchema).optional(), goalConfirmations: z.array(GoalConfirmationSchema).optional(),
  submissions: z.array(CoachSubmissionSchema),
  interview: InterviewSessionSchema.optional(), interviewHistory: z.array(InterviewSessionSchema).optional(),
  drills: z.array(DrillAttemptSchema).optional(),
  practiceDrafts: z.record(z.string().max(20000)).optional(),
}).strict();
export type CoachState = z.infer<typeof CoachStateSchema>;
