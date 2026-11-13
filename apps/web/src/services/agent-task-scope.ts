import { AgentTaskSchema, LegacyTaskScopePreviewSchema, TaskRootScopeKeySchema, TaskScopeAssociationSchema, type AgentTask, type CareerTaskBudget, type TaskLineage, type LegacyTaskScopeCandidate } from "@better-me/agent-contracts";
import { z } from "zod";
import { captureIdentityLease, IdentityBoundaryError } from "../lib/identity";
import { AgentTaskClientError } from "./agent-task-transport";
import { createTaskTransport, type TaskClientOptions } from "./agent-task-transport";

/** Linking a ledger never grants materials, changes the runtime, or replays input. */
export function assertTaskScope(task:TaskLineage & {id:string},rootScopeKey?:string){
  if(rootScopeKey!==undefined&&task.rootScopeKey!==rootScopeKey)throw new AgentTaskClientError(
    task.rootScopeKey?"任务属于另一工作区账本，未继续或新建清账。":"这份旧记录尚未关联统一工作区账本；请保留历史后核对关联，未自动重发或清零旧用量。",
    task.rootScopeKey?"root_scope_changed":"legacy_root_scope_unassigned",task.id);
}

/** Validation defaults are not an explicit request to expand a shared root ceiling. */
export function taskCreatePayload<T extends {budget?:unknown}>(parsed:T,requestedBudget?:unknown):T{
  const body={...parsed};if(requestedBudget===undefined)delete body.budget;return body;
}

export function selectTaskRoot(tasks:AgentTask[],rootScopeKey:string){
  const members=tasks.filter(task=>task.rootScopeKey===rootScopeKey);
  if(!members.length)return undefined;
  const roots=members.filter(task=>!task.parentTaskId&&(task.rootTaskId??task.id)===task.id);
  if(roots.length!==1||members.some(task=>task.rootTaskId!==roots[0]!.id))throw new AgentTaskClientError("工作区根账无法唯一核对，未派送或修改预算。","root_scope_ambiguous");
  return {root:roots[0]!,members};
}

export function createTaskLedgerClient(options:TaskClientOptions={}){
  const transport=createTaskTransport(AgentTaskSchema,options);
  return {
    async legacy(rootScopeKey:string,signal?:AbortSignal){
      const scope=TaskRootScopeKeySchema.parse(rootScopeKey),result=await transport.request(`/legacy-scopes?rootScopeKey=${encodeURIComponent(scope)}`,undefined,signal);
      const preview=LegacyTaskScopePreviewSchema.parse(result.raw);
      if(preview.ownerId!==result.ownerId)throw new IdentityBoundaryError();
      if(preview.rootScopeKey!==scope||new Set(preview.candidates.map(item=>item.rootTaskId)).size!==preview.candidates.length||preview.candidates.some(item=>item.ledger.rootTaskId!==item.rootTaskId||!!item.previewToken===!!item.blockedBy))throw new AgentTaskClientError("旧账预览标识不一致，未关联或重发。","invalid_response");
      return preview;
    },
    async associate(rootScopeKey:string,candidate:LegacyTaskScopeCandidate,signal?:AbortSignal){
      const scope=TaskRootScopeKeySchema.parse(rootScopeKey);
      if(candidate.blockedBy||!candidate.previewToken)throw new AgentTaskClientError("请先重新读取可关联的旧根账，未改动记录。","scope_association_preview_changed");
      const result=await transport.request(`/${encodeURIComponent(candidate.rootTaskId)}/associate-scope`,{rootScopeKey:scope,previewToken:candidate.previewToken,confirmation:"associate_records_and_usage_only"},signal);
      const receipt=z.object({task:AgentTaskSchema,association:TaskScopeAssociationSchema}).parse(result.raw);
      if(receipt.task.ownerId!==result.ownerId||receipt.association.ownerId!==result.ownerId)throw new IdentityBoundaryError();
      if(receipt.task.id!==candidate.rootTaskId||receipt.association.rootTaskId!==candidate.rootTaskId||receipt.association.rootScopeKey!==scope||receipt.association.previewToken!==candidate.previewToken||!receipt.association.memberIds.includes(candidate.rootTaskId))throw new AgentTaskClientError("关联回执标识不一致，请读取根账核对；没有自动重发。","invalid_response");
      assertTaskScope(receipt.task,scope);return receipt;
    },
    async read(rootScopeKey:string,signal?:AbortSignal){
      const lease=captureIdentityLease();lease.assert();
      const rows=z.object({tasks:z.array(AgentTaskSchema)}).parse((await transport.request("",undefined,signal)).raw);lease.assert();
      if(rows.tasks.some(task=>task.ownerId!==lease.ownerId))throw new IdentityBoundaryError();
      return selectTaskRoot(rows.tasks,rootScopeKey);
    },
    async budget(root:AgentTask,budget:CareerTaskBudget,signal?:AbortSignal){
      if(root.parentTaskId||!root.rootScopeKey)throw new AgentTaskClientError("只能调整已核对的工作区根账。","adjust_root_budget_only");
      const updated=await transport.read(root.id,signal,{expectedRevision:root.revision,budget,consent:true},"/budget");assertTaskScope(updated,root.rootScopeKey);return updated;
    },
    async pause(root:AgentTask,signal?:AbortSignal){
      if(root.parentTaskId||!root.rootScopeKey)throw new AgentTaskClientError("只能从已核对的根任务停止整组。","invalid_task_lineage");
      const updated=await transport.read(root.id,signal,{expectedRevision:root.revision},"/pause-group");assertTaskScope(updated,root.rootScopeKey);return updated;
    },
  };
}
export const defaultTaskLedgerClient=createTaskLedgerClient();
