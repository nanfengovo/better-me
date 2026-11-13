import { z } from "zod";
import { ResumeCandidateResponseContractSchema, ResumeCandidateSourceBindingSchema, validateResumeCandidateBinding } from "./resume-candidate.js";
export * from "./resume-candidate.js";
import { WritingReplySchema, type WritingReply } from "@better-me/core/experience-writing";
import { ResumeProposalTargetSchema } from "./index.js";
import { ProjectUnderstandingSchema, UnderstandingCreateSchema, UnderstandingSessionSchema, UnderstandingTurnSchema, UnderstandingDecisionSchema, type UnderstandingSession } from "./project-understanding.js";
import { AgentActionCardSchema, AgentChatContextSchema, ChatMessageSchema, validChatMaterial } from "./agent-chat.js";
import { JdMatchMaterialSchema, JdMatchResultSchema, JdMatchReviewSchema, JdMatchStructuredSchema } from "./jd-match.js";
import { MockInterviewFocusSchema,MockInterviewReceiptSchema } from "./mock-interview.js";
import { CoachPayloadSchema, type CoachGeneration, type CoachRequest } from "./career-coach.js";
import { CoachRequestSchema } from "./career-coach-protocol.js";
import { JdIntakeRequestSchema, JdIntakeResultSchema, type JdIntakeRequest, type JdIntakeResult } from "./jd-intake.js";
import { JdOcrRequestSchema, JdOcrResultSchema, type JdOcrRequest, type JdOcrResult } from "./jd-ocr.js";
import { StudioAnalysisRequestSchema, type StudioAnalysisRequest } from "./studio-analysis.js";
import { StudioCommitteeRequestSchema } from "./career-studio.js";
import { CommitteeReportSchema, type CommitteeReport } from "@better-me/core/career-intelligence";
export * from "./studio-analysis.js";
import { CAREER_TASK_DEFAULT_BUDGET, CareerTaskBudgetSchema, CareerTaskCreateSchema, CareerTaskRunSchema, CareerTaskSchema, CareerTaskEvidenceSchema, CareerTaskStatusSchema, CareerRuntimeBindingSchema, TaskRootLedgerSchema, type TaskLineage, type CareerTask } from "./career-task.js";

const id=z.string().trim().min(1).max(300);
/** Free conversation has no job/resume placeholders and grants no tools or record writes. */
export const FreeChatTaskCreateSchema=z.object({
  kind:z.literal("free_chat"),workspaceKey:id,objective:z.string().min(1).max(12000),
  parentTaskId:id.optional(),rootScopeKey:id.optional(),
  responseContract:ResumeCandidateResponseContractSchema.optional(),
  candidateSource:ResumeCandidateSourceBindingSchema.optional(),
  conversation:z.object({messages:z.array(ChatMessageSchema).min(1),context:AgentChatContextSchema.optional()}).strict(),
  runtimeBinding:CareerRuntimeBindingSchema,budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),consent:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict().superRefine((value,ctx)=>{
  if(!value.conversation.messages.some(message=>message.role==="user"))ctx.addIssue({code:"custom",message:"user message required"});
  if(new Set(value.conversation.messages.map(message=>message.id)).size!==value.conversation.messages.length)ctx.addIssue({code:"custom",message:"duplicate message identity"});
  if(!validChatMaterial(value.conversation))ctx.addIssue({code:"custom",message:"conversation task material budget or image contract exceeded; no bytes are discarded"});
  validateResumeCandidateBinding(value,ctx);
});
export type FreeChatTaskCreate=z.input<typeof FreeChatTaskCreateSchema>;
export type FreeChatTaskInput=z.infer<typeof FreeChatTaskCreateSchema>;
export const FreeChatReplyDecisionSchema=z.object({kind:z.literal("reply"),content:z.string().min(1),actions:z.array(AgentActionCardSchema).optional()}).strict();
export const TaskOutputArtifactSchema=z.object({id:z.string().regex(/^out_[a-f0-9]{32}$/),bytes:z.number().int().nonnegative(),hash:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.string()}).strict();
export type TaskOutputArtifact=z.infer<typeof TaskOutputArtifactSchema>;
export type FreeChatTask=TaskLineage & Pick<CareerTask,"id"|"ownerId"|"workspaceKey"|"objective"|"revision"|"status"|"createdAt"|"updatedAt"|"runtimeBinding"|"budget"|"usage"|"events"|"error"> & {
  kind:"free_chat";responseContract?:z.infer<typeof ResumeCandidateResponseContractSchema>;candidateSource?:z.infer<typeof ResumeCandidateSourceBindingSchema>;sourceFingerprint:string;conversation:FreeChatTaskInput["conversation"];turn:number;reply?:z.infer<typeof ChatMessageSchema>;partialOutput?:{text:string;finishReason?:string};outputArtifacts?:TaskOutputArtifact[];
};
const conversationTaskRecord=z.object({
  id,ownerId:id,workspaceKey:id,objective:z.string().min(1).max(12000),revision:z.number().int().positive(),status:CareerTaskStatusSchema,
  rootScopeKey:id.optional(),rootTaskId:id.optional(),parentTaskId:id.optional(),rootLedger:TaskRootLedgerSchema.optional(),
  createdAt:z.string(),updatedAt:z.string(),runtimeBinding:CareerRuntimeBindingSchema,budget:CareerTaskBudgetSchema,
  usage:z.object({modelCalls:z.number().int().nonnegative(),toolCalls:z.number().int().nonnegative(),activeMs:z.number().int().nonnegative()}),
  events:z.array(z.object({sequence:z.number().int(),at:z.string(),kind:z.enum(["created","started","model","tool_call","tool_result","decision","question","answer","draft","stopped","budget","receipt","fact"]),detail:z.string()})),error:z.string().optional(),
  kind:z.literal("free_chat"),sourceFingerprint:id,conversation:z.object({messages:z.array(ChatMessageSchema),context:AgentChatContextSchema.optional()}).strict(),turn:z.number().int().positive(),reply:ChatMessageSchema.optional(),
  partialOutput:z.object({text:z.string(),finishReason:z.string().optional()}).optional(),
  outputArtifacts:z.array(TaskOutputArtifactSchema).optional(),
});
export const FreeChatTaskSchema:z.ZodType<FreeChatTask,z.ZodTypeDef,unknown>=conversationTaskRecord.extend({responseContract:ResumeCandidateResponseContractSchema.optional(),candidateSource:ResumeCandidateSourceBindingSchema.optional()}).superRefine(validateResumeCandidateBinding);
export const ExperienceRefinementSchema=z.object({
  source:z.object({targetRef:z.lazy(()=>ResumeProposalTargetSchema),text:z.string(),label:z.string().max(2000),
    quote:z.object({exact:z.string().min(1),prefix:z.string().max(32),suffix:z.string().max(32),start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict().optional(),
  }).strict().superRefine(({text,quote},ctx)=>{if(quote&&(text.slice(quote.start,quote.end)!==quote.exact||quote.end>text.length||quote.end<=quote.start||text.slice(Math.max(0,quote.start-32),quote.start)!==quote.prefix||text.slice(quote.end,quote.end+32)!==quote.suffix))ctx.addIssue({code:"custom",message:"selected source anchor changed"});}),
  projectContext:z.object({sessionId:id,revision:z.number().int().positive(),summaryHash:z.string().min(1),understanding:ProjectUnderstandingSchema}).strict().optional(),
  sharedProjectBackgroundOnly:z.string().optional(),
}).strict();
const refinementConversation=z.object({messages:z.array(ChatMessageSchema).min(1)}).strict();
export const ExperienceRefineTaskCreateSchema=z.object({
  kind:z.literal("experience_refine"),workspaceKey:id,objective:z.string().min(1).max(12000),refinement:ExperienceRefinementSchema,
  parentTaskId:id.optional(),rootScopeKey:id.optional(),
  conversation:refinementConversation,runtimeBinding:CareerRuntimeBindingSchema,budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),consent:z.literal(true),
  supplementConfirmed:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict().superRefine((value,ctx)=>{
  if(value.conversation.messages.length!==1||value.conversation.messages[0]?.role!=="user"||value.conversation.messages[0]?.attachments?.length||value.conversation.messages[0]?.references?.length)ctx.addIssue({code:"custom",message:"one exact confirmed supplement required; no implicit attachment grant"});
  if(!validChatMaterial(value.conversation)||JSON.stringify(value.refinement).length>1_000_000)ctx.addIssue({code:"custom",message:"refinement material budget exceeded; no bytes discarded"});
});
export type ExperienceRefineTaskCreate=z.input<typeof ExperienceRefineTaskCreateSchema>;
export type ExperienceRefineTask=Omit<FreeChatTask,"kind"> & {kind:"experience_refine";refinement:z.infer<typeof ExperienceRefinementSchema>;refinementReply?:WritingReply};
export const ExperienceRefineTaskSchema:z.ZodType<ExperienceRefineTask,z.ZodTypeDef,unknown>=conversationTaskRecord.extend({kind:z.literal("experience_refine"),refinement:ExperienceRefinementSchema,refinementReply:WritingReplySchema.optional()});
export type ConversationTask=FreeChatTask|ExperienceRefineTask;
export const ProjectUnderstandingTaskCreateSchema=z.object({
  kind:z.literal("project_understanding"),workspaceKey:id,objective:z.string().min(1).max(12000),parentTaskId:id.optional(),rootScopeKey:id.optional(),
  project:UnderstandingCreateSchema.omit({workspaceKey:true}).strict(),runtimeBinding:CareerRuntimeBindingSchema,
  budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),consent:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict();
export type ProjectUnderstandingTaskCreate=z.input<typeof ProjectUnderstandingTaskCreateSchema>;
export type ProjectUnderstandingTask=Omit<FreeChatTask,"kind"|"conversation"|"turn"|"reply"> & {kind:"project_understanding";project:UnderstandingSession};
export const ProjectUnderstandingTaskSchema:z.ZodType<ProjectUnderstandingTask,z.ZodTypeDef,unknown>=conversationTaskRecord.omit({conversation:true,turn:true,reply:true}).extend({kind:z.literal("project_understanding"),project:UnderstandingSessionSchema});
/** Paging is explicit. A manifest handle grants no path and is not itself citable evidence. */
export const ProjectUnderstandingTaskDecisionSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("read"),requests:z.array(z.object({
    grantId:id,operation:z.enum(["list","search","read","read_evidence"]),path:z.string().max(2000).default(""),query:z.string().max(200).optional(),
    startLine:z.number().int().positive().optional(),endLine:z.number().int().positive().optional(),offset:z.number().int().nonnegative().optional(),length:z.number().int().positive().max(4000).optional(),
  }).strict()).min(1).max(8)}).strict(),UnderstandingDecisionSchema.options[1],
]);
export type ProjectUnderstandingTaskDecision=z.infer<typeof ProjectUnderstandingTaskDecisionSchema>;
export const JdMatchTaskCreateSchema=z.object({
  kind:z.literal("jd_match"),workspaceKey:id,objective:z.string().min(1).max(12000),parentTaskId:id.optional(),rootScopeKey:id.optional(),
  matching:JdMatchMaterialSchema,runtimeBinding:CareerRuntimeBindingSchema,budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),
  consent:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict();
export type JdMatchTaskCreate=z.input<typeof JdMatchTaskCreateSchema>;
export type JdMatchTask=Omit<FreeChatTask,"kind"|"conversation"|"turn"|"reply"> & {
  kind:"jd_match";matching:z.infer<typeof JdMatchMaterialSchema>;structuredJd:z.infer<typeof JdMatchStructuredSchema>;
  evidence:CareerTask["evidence"];result?:z.infer<typeof JdMatchResultSchema>;review?:z.infer<typeof JdMatchReviewSchema>;
};
export const JdMatchTaskSchema:z.ZodType<JdMatchTask,z.ZodTypeDef,unknown>=conversationTaskRecord.omit({conversation:true,turn:true,reply:true}).extend({
  kind:z.literal("jd_match"),matching:JdMatchMaterialSchema,structuredJd:JdMatchStructuredSchema,
  evidence:z.array(CareerTaskEvidenceSchema),result:JdMatchResultSchema.optional(),review:JdMatchReviewSchema.optional(),
});
export const MockInterviewTaskCreateSchema=z.object({
  kind:z.literal("mock_interview"),workspaceKey:id,objective:z.string().min(1).max(12000),parentTaskId:id,rootScopeKey:id.optional(),
  parentSourceFingerprint:id,focus:MockInterviewFocusSchema,runtimeBinding:CareerRuntimeBindingSchema,
  budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),consent:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict();
export type MockInterviewTaskCreate=z.input<typeof MockInterviewTaskCreateSchema>;
export type MockInterviewTask=Omit<FreeChatTask,"kind"> & {
  kind:"mock_interview";matching:z.infer<typeof JdMatchMaterialSchema>;evidence:CareerTask["evidence"];
  interview:{focus:z.infer<typeof MockInterviewFocusSchema>;parentSourceFingerprint:string;phase:"interview"|"evaluation";receipt?:z.infer<typeof MockInterviewReceiptSchema>};
};
export const MockInterviewTaskSchema:z.ZodType<MockInterviewTask,z.ZodTypeDef,unknown>=conversationTaskRecord.extend({
  kind:z.literal("mock_interview"),matching:JdMatchMaterialSchema,evidence:z.array(CareerTaskEvidenceSchema),
  interview:z.object({focus:MockInterviewFocusSchema,parentSourceFingerprint:id,phase:z.enum(["interview","evaluation"]),receipt:MockInterviewReceiptSchema.optional()}).strict(),
});
/** A frozen explicitly authorized coaching operation; no browser inference or writes. */
export const CoachGuidanceTaskCreateSchema=z.object({
  kind:z.literal("career_coach"),workspaceKey:id,objective:z.string().min(1).max(12000),parentTaskId:id.optional(),rootScopeKey:id.optional(),
  request:CoachRequestSchema,runtimeBinding:CareerRuntimeBindingSchema,budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),
  consent:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict().superRefine((value,ctx)=>{if(JSON.stringify(value.request).length>1_000_000)ctx.addIssue({code:"custom",message:"coaching material budget exceeded; no bytes discarded"});});
export type CoachGuidanceTaskCreate=z.input<typeof CoachGuidanceTaskCreateSchema>;
export type CoachGuidanceTask=Omit<FreeChatTask,"kind"|"conversation"|"reply"> & {kind:"career_coach";request:CoachRequest;result?:CoachGeneration};
export const CoachGuidanceTaskSchema:z.ZodType<CoachGuidanceTask,z.ZodTypeDef,unknown>=conversationTaskRecord.omit({conversation:true,reply:true}).extend({
  kind:z.literal("career_coach"),request:CoachRequestSchema,
  result:z.object({payload:CoachPayloadSchema,model:z.object({provider:z.string(),name:z.string(),generatedAt:z.string()}).strict()}).strict().optional(),
});
export const JdIntakeTaskCreateSchema=z.object({
  kind:z.literal("jd_intake"),workspaceKey:id,objective:z.string().min(1).max(12000),parentTaskId:id.optional(),rootScopeKey:id.optional(),
  request:JdIntakeRequestSchema,runtimeBinding:CareerRuntimeBindingSchema,budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),
  consent:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict();
export type JdIntakeTaskCreate=z.input<typeof JdIntakeTaskCreateSchema>;
export type JdIntakeTask=Omit<FreeChatTask,"kind"|"conversation"|"reply"> & {kind:"jd_intake";request:JdIntakeRequest;result?:JdIntakeResult};
export const JdIntakeTaskSchema:z.ZodType<JdIntakeTask,z.ZodTypeDef,unknown>=conversationTaskRecord.omit({conversation:true,reply:true}).extend({kind:z.literal("jd_intake"),request:JdIntakeRequestSchema,result:JdIntakeResultSchema.optional()});
export const JdOcrTaskCreateSchema=z.object({
  kind:z.literal("jd_ocr"),workspaceKey:id,objective:z.string().min(1).max(12000),parentTaskId:id.optional(),rootScopeKey:id.optional(),
  request:JdOcrRequestSchema,runtimeBinding:CareerRuntimeBindingSchema,budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),
  consent:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict();
export type JdOcrTaskCreate=z.input<typeof JdOcrTaskCreateSchema>;
export type JdOcrTask=Omit<FreeChatTask,"kind"|"conversation"|"reply"> & {kind:"jd_ocr";request:JdOcrRequest;uploadedImageIds:string[];result?:JdOcrResult};
export const JdOcrTaskSchema:z.ZodType<JdOcrTask,z.ZodTypeDef,unknown>=conversationTaskRecord.omit({conversation:true,reply:true}).extend({kind:z.literal("jd_ocr"),request:JdOcrRequestSchema,uploadedImageIds:z.array(z.string().regex(/^img_[a-f0-9]{32}$/)).max(6),result:JdOcrResultSchema.optional()});
export const StudioAnalysisTaskCreateSchema=z.object({
  kind:z.literal("studio_analysis"),workspaceKey:id,objective:z.string().min(1).max(12000),parentTaskId:id.optional(),rootScopeKey:id,
  request:StudioAnalysisRequestSchema,runtimeBinding:CareerRuntimeBindingSchema,budget:CareerTaskBudgetSchema.default(CAREER_TASK_DEFAULT_BUDGET),
  consent:z.literal(true),idempotencyKey:z.string().min(8).max(160),
}).strict();
export type StudioAnalysisTaskCreate=z.input<typeof StudioAnalysisTaskCreateSchema>;
export type StudioAnalysisTask=Omit<FreeChatTask,"kind"|"conversation"|"reply"> & {kind:"studio_analysis";request:StudioAnalysisRequest;result?:{output:Record<string,unknown>;contextId:string;inputHash:string;runtime:StudioAnalysisRequest["runtime"];adopted:false}};
export const StudioAnalysisTaskSchema:z.ZodType<StudioAnalysisTask,z.ZodTypeDef,unknown>=conversationTaskRecord.omit({conversation:true,reply:true}).extend({kind:z.literal("studio_analysis"),request:StudioAnalysisRequestSchema,
  result:z.object({output:z.record(z.unknown()),contextId:z.string(),inputHash:z.string(),runtime:StudioAnalysisRequestSchema.shape.runtime,adopted:z.literal(false)}).strict().optional()});
export const StudioCommitteeTaskCreateSchema=StudioAnalysisTaskCreateSchema.extend({kind:z.literal("studio_committee"),request:StudioCommitteeRequestSchema});
export type StudioCommitteeTaskCreate=z.input<typeof StudioCommitteeTaskCreateSchema>;
export type StudioCommitteeTask=Omit<StudioAnalysisTask,"kind"|"request"|"result"> & {kind:"studio_committee";request:z.infer<typeof StudioCommitteeRequestSchema>;result?:CommitteeReport};
export const StudioCommitteeTaskSchema:z.ZodType<StudioCommitteeTask,z.ZodTypeDef,unknown>=conversationTaskRecord.omit({conversation:true,reply:true}).extend({
  kind:z.literal("studio_committee"),request:StudioCommitteeRequestSchema,result:CommitteeReportSchema.optional(),
});
export type AgentTask=CareerTask|ConversationTask|ProjectUnderstandingTask|JdMatchTask|MockInterviewTask|CoachGuidanceTask|JdIntakeTask|JdOcrTask|StudioAnalysisTask|StudioCommitteeTask;
export type AgentTaskCreate=import("./career-task.js").CareerTaskCreate|FreeChatTaskCreate|ExperienceRefineTaskCreate|ProjectUnderstandingTaskCreate|JdMatchTaskCreate|MockInterviewTaskCreate|CoachGuidanceTaskCreate|JdIntakeTaskCreate|JdOcrTaskCreate|StudioAnalysisTaskCreate|StudioCommitteeTaskCreate;
export const AgentTaskSchema=z.union([CareerTaskSchema,FreeChatTaskSchema,ExperienceRefineTaskSchema,ProjectUnderstandingTaskSchema,JdMatchTaskSchema,MockInterviewTaskSchema,CoachGuidanceTaskSchema,JdIntakeTaskSchema,JdOcrTaskSchema,StudioAnalysisTaskSchema,StudioCommitteeTaskSchema]);
export const AgentTaskCreateSchema=z.union([CareerTaskCreateSchema,FreeChatTaskCreateSchema,ExperienceRefineTaskCreateSchema,ProjectUnderstandingTaskCreateSchema,JdMatchTaskCreateSchema,MockInterviewTaskCreateSchema,CoachGuidanceTaskCreateSchema,JdIntakeTaskCreateSchema,JdOcrTaskCreateSchema,StudioAnalysisTaskCreateSchema,StudioCommitteeTaskCreateSchema]);
export const AgentTaskRunSchema=CareerTaskRunSchema.extend({message:ChatMessageSchema.optional(),supplementConfirmed:z.literal(true).optional(),projectTurn:UnderstandingTurnSchema.optional(),interviewAction:z.enum(["answer","finish"]).optional()}).strict();
export function isCareerTask(task:AgentTask):task is CareerTask{return !("kind" in task&&["free_chat","experience_refine","project_understanding","jd_match","mock_interview","career_coach","jd_intake","jd_ocr","studio_analysis","studio_committee"].includes(task.kind??""));}
export function isConversationTask(task:AgentTask):task is ConversationTask{return task.kind==="free_chat"||task.kind==="experience_refine";}
export function agentTaskSourceFingerprint(task:AgentTask){return isCareerTask(task)?task.resume.sourceFingerprint:task.sourceFingerprint;}
