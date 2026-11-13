import { z } from "zod";
import { CareerRuntimeBindingSchema, TaskRootLedgerSchema } from "./career-task.js";

export const TaskRootScopeKeySchema=z.string().trim().min(1).max(300);
const taskId=z.string().regex(/^ct_[a-f0-9]{32}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const TaskScopeAssociationRequestSchema=z.object({
  rootScopeKey:TaskRootScopeKeySchema,previewToken:hash,
  confirmation:z.literal("associate_records_and_usage_only"),
}).strict();
export type TaskScopeAssociationRequest=z.infer<typeof TaskScopeAssociationRequestSchema>;
export const TaskScopeAssociationSchema=z.object({
  ownerId:z.string().min(1),rootTaskId:taskId,rootScopeKey:TaskRootScopeKeySchema,previewToken:hash,
  associatedAt:z.string().datetime(),memberIds:z.array(taskId).min(1).max(100),
  effect:z.literal("records_and_usage_only"),
}).strict();
export type TaskScopeAssociation=z.infer<typeof TaskScopeAssociationSchema>;
export const LegacyTaskScopeCandidateSchema=z.object({
  rootTaskId:taskId,objective:z.string(),workspaceKey:z.string(),status:z.string(),updatedAt:z.string(),
  runtimeBinding:CareerRuntimeBindingSchema,ledger:TaskRootLedgerSchema,
  blockedBy:z.enum(["root_scope_occupied","pause_before_scope_association","root_task_revoked"]).optional(),
  previewToken:hash.optional(),
}).strict();
export type LegacyTaskScopeCandidate=z.infer<typeof LegacyTaskScopeCandidateSchema>;
export const LegacyTaskScopePreviewSchema=z.object({
  ownerId:z.string().min(1),rootScopeKey:TaskRootScopeKeySchema,existingRootTaskId:taskId.optional(),
  candidates:z.array(LegacyTaskScopeCandidateSchema),
}).strict();
export type LegacyTaskScopePreview=z.infer<typeof LegacyTaskScopePreviewSchema>;
