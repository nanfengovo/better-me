import { z } from "zod";
import type { AgentTask } from "@better-me/agent-contracts";
import { agentOrigin, captureIdentityLease, IdentityBoundaryError, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";
export class AgentTaskClientError extends Error { constructor(message:string,readonly code:string,readonly taskId?:string){super(message);this.name="AgentTaskClientError";} }
export const taskIssueText:Record<string,string>={
  model_call_budget:"这个工作区的模型调用额度已用尽。打开「共识与进度 → 任务 → 工作区共享额度」查看用量；需要更多次数时，可在那里确认调整。新建对话不会清零。",
  root_runtime_binding_changed:"这个工作区已绑定其他模型，本次请求没有发给新模型。打开「共识与进度 → 任务 → 工作区共享额度」可查看原模型；保存新配置或停止任务都不会更换它。",
  root_scope_changed:"父任务与工作区根账不一致，未继续或迁移旧授权。",
  root_scope_ambiguous:"工作区存在不唯一的根账，已停止派送；历史和用量保留。",
  root_scope_occupied:"当前工作区已有另一根账。未合并历史、免除旧用量或恢复授权，请核对两份记录。",
  scope_association_preview_changed:"旧任务或工作区状态已变化，请重新读取并核对整组记录；没有自动关联。",
  pause_before_scope_association:"旧任务组仍在运行。请先明确停止整组，再读取并核对关联。",
  task_scope_already_associated:"这份旧根账已经关联，不能覆盖到另一工作区；请刷新根账核对。",
  legacy_root_scope_required:"只能关联尚无工作区归属的原根任务，未改动历史。",
  invalid_task_scope_associations:"本机历史关联记录无法安全核对，已停止操作；原记录和用量保留。",
  child_budget_must_inherit_root:"子任务必须继承工作区根额度；请核对根任务预算，未自动扩额。",
  root_task_revoked:"工作区根任务已撤权，不能从其他入口继续发送。",
  pause_before_adjusting_budget:"请先停止整组运行，再核对根上限；没有自动中止或调额。",
  budget_below_usage:"根上限不能小于整组已经发生的用量；没有清零历史或修改额度。",
  task_revision_conflict:"任务状态已变化，请先读取现有结果；没有自动重发。",
  runtime_binding_changed:"本任务的底座已变化，不能用新选择继续原任务。到「共识与进度 → 任务 → 工作区共享额度」查看原模型；原文和用量保留。",
  runtime_authorization_changed_new_task_required:"模型端点或账号授权已变化，本任务未继续。",
  root_runtime_authorization_changed:"此工作区原先使用的模型连接或账号授权已变化，本次没有发送。请在「共识与进度 → 任务 → 工作区共享额度」查看原模型，再到「系统设置 → 工具与授权」核对来源。重新保存 Key 不会改绑旧任务。",
  task_images_not_supported:"所选底座不支持图片；图片完整保留，未丢弃或换用其他通道。",
  model_output_incomplete:"模型报告输出未完成；原始输出已保存，未自动续答或标记为完整。",
  decision_output_budget:"输出超过任务解析额度，完整原文已另存到本任务，没有裁短或自动重试。",
  project_context_changed:"项目共识或来源已变化，本轮已停止；请重新核对完整项目理解，没有自动采用候选或重置额度。",
};


export type TaskClientOptions={fetch?:typeof fetch;baseUrl?:string;pollMs?:number};
/** Authenticated transport only; never dispatches a model or retries an inference. */
export function createTaskTransport<T extends AgentTask>(schema:z.ZodType<T,unknown>,options:TaskClientOptions={}){
  async function request(path:string,body?:unknown,signal?:AbortSignal){
    const lease=captureIdentityLease();lease.assert();
    if(!lease.ownerId)throw new AgentTaskClientError("请先登录 BetterMe 账号；未从浏览器直接调用其他模型。","identity_required");
    let response:Response;
    try{response=await ownedFetch(`${options.baseUrl??agentOrigin()}/api/v1/agent/tasks${path}`,{
      method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${readRuntimeConnection()?.agentToken??"better-me-agent-token"}`},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
    },options.fetch??fetch);}catch(error){
      if(signal?.aborted||error instanceof IdentityBoundaryError)throw error;
      throw new AgentTaskClientError("未收到任务服务回执。结果尚未确认；请读取现有任务，没有自动重发或切换模型。","outcome_unknown");
    }
    const raw:unknown=await response.json().catch((error:unknown)=>{if(error instanceof IdentityBoundaryError)throw error;return undefined;});lease.assert();
    if(!response.ok){const issue=z.object({error:z.string()}).safeParse(raw),code=issue.success?issue.data.error:"task_request_failed";
      throw new AgentTaskClientError(taskIssueText[code]??`任务未接受本次操作（HTTP ${response.status}）；输入保留，没有自动重发。`,code);}
    return {raw,ownerId:lease.ownerId};
  }
  async function read(id:string,signal?:AbortSignal,body?:unknown,suffix=""){
    const result=await request(`/${encodeURIComponent(id)}${suffix}`,body,signal),envelope=z.object({task:z.unknown()}).safeParse(result.raw);
    const parsed=schema.safeParse(envelope.success?envelope.data.task:undefined);
    if(!parsed.success||parsed.data.id!==id)throw new AgentTaskClientError("任务回执不完整或标识不匹配，未采用。","invalid_response",id);
    if(parsed.data.ownerId!==result.ownerId)throw new IdentityBoundaryError();return parsed.data;
  }
  async function pause(id:string){
    const lease=captureIdentityLease();lease.assert();
    for(let attempt=0;attempt<2;attempt++){
      lease.assert();const task=await read(id);lease.assert();if(!["running","ready"].includes(task.status))return task;
      try{return await read(id,undefined,{expectedRevision:task.revision},"/pause");}
      catch(error){if(!(error instanceof AgentTaskClientError)||error.code!=="task_revision_conflict"||attempt===1)throw error;}
    }
    throw new AgentTaskClientError("停止结果尚未确认，请读取任务。","outcome_unknown",id);
  }

  return {request,read,pause};
}
