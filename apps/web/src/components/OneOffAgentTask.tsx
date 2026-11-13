import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {z} from "zod";
import type {FreeChatTask} from "@better-me/agent-contracts";
import type {LlmConfig} from "@better-me/core";
import {Check,Copy,Play,RefreshCw,Square} from "lucide-react";
import {defaultFreeChatTaskClient,type createFreeChatTaskClient} from "../services/free-chat-task-client";
import {assertTaskScope} from "../services/agent-task-scope";
import {useAgentTaskRuntime} from "../lib/agent-task-runtime";
import {useWorkspaceRecovery} from "../lib/use-workspace-recovery";
import {useUiPreferences} from "../lib/ui-preferences";
import {AgentMarkdownRenderer} from "./AgentMarkdownRenderer";
import {AgentExecutionLog} from "./AgentExecutionLog";
import {WorkspaceRecoveryNotice} from "./WorkspaceRecoveryNotice";
import {TaskOutputArtifacts} from "./TaskOutputArtifacts";
import {understandingModelRuntime} from "../services/understanding-client";

export const MODEL_CONFIGURATION_PROBE = "This is a model configuration check, not a career request. Reply with BETTERME_OK inside the required free_chat reply envelope. No resume, job description, personal evidence or prior conversation is supplied.";

const savedRequest=z.object({
  message:z.object({id:z.string().min(1),role:z.literal("user"),content:z.string().min(1)}).strict().optional(),
  taskId:z.string().regex(/^ct_[a-f0-9]{32}$/).optional(),
}).strict();
type Client=ReturnType<typeof createFreeChatTaskClient>;

/** A separate text request, not a second CLI executor. Host owns history,
 * runtime and root accounting. The journal stores no credentials or grants. */
export function OneOffAgentTask({workspaceKey,rootScopeKey,config,prompt,onPromptChange,configurationProbe=false,client=defaultFreeChatTaskClient}:{
  workspaceKey:string;rootScopeKey:string;config:LlmConfig;prompt:string;onPromptChange:(value:string)=>void;configurationProbe?:boolean;client?:Client;
}){
  const recovery=useWorkspaceRecovery(`one-off:${workspaceKey}`,savedRequest,()=>({}));
  const {message,taskId}=recovery.value,setSaved=recovery.set;
  const workspaceRuntime=useAgentTaskRuntime(config),{t,theme}=useUiPreferences();
  // A configuration check tests this explicit form, never the unrelated selected
  // native/account transport. The Host still enforces the existing root pin.
  const probeRuntime=useMemo(()=>understandingModelRuntime(config),[config]);
  const probeKey=JSON.stringify(probeRuntime),currentProbe=useRef(probeKey);currentProbe.current=probeKey;
  const selected=configurationProbe?{runtime:probeRuntime,preferredRuntimeId:undefined,label:config.model,error:undefined,key:probeKey,assertSelected:()=>{
    if(currentProbe.current!==probeKey)throw new Error("测试配置已变化，未采用旧结果；请读取原任务核对。");
  }}:workspaceRuntime;
  const [task,setTask]=useState<FreeChatTask>(),[busy,setBusy]=useState(false),[checked,setChecked]=useState(false);
  const [consent,setConsent]=useState(false),[error,setError]=useState(""),[copied,setCopied]=useState(false);
  const observer=useRef<AbortController|null>(null);
  const accept=useCallback((next:FreeChatTask)=>{
    assertTaskScope(next,rootScopeKey);
    if(!message||next.workspaceKey!==`one-off:${workspaceKey}`||next.conversation.messages[0]?.id!==message.id||next.conversation.messages[0]?.content!==message.content)
      throw new Error("任务与本页原文不一致，未覆盖历史或重新发送。");
    setTask(current=>current?.id===next.id&&current.revision>next.revision?current:next);setSaved(current=>({...current,taskId:next.id}));
  },[rootScopeKey,workspaceKey,message,setSaved]);
  const read=useCallback(async(signal?:AbortSignal)=>{
    if(!message){setChecked(true);return;}
    const next=taskId?await client.get(taskId,signal):await client.find(`one-off:${workspaceKey}`,message.id,signal);
    signal?.throwIfAborted();if(next)accept(next);setChecked(true);
  },[message,taskId,client,workspaceKey,accept]);
  useEffect(()=>{
    const controller=new AbortController();
    void read(controller.signal).catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:"任务尚未核对，未重发。");});
    return()=>controller.abort();
  },[read]);
  useEffect(()=>{setConsent(false);},[selected.key,prompt]);
  useEffect(()=>()=>observer.current?.abort(),[]);
  const onRead=async()=>{
    if(observer.current)return;setBusy(true);setError("");
    const controller=new AbortController();observer.current=controller;
    try{await read(controller.signal);}
    catch(failure){if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:"任务尚未核对。");}
    finally{if(observer.current===controller){observer.current=null;setBusy(false);}}
  };
  const run=async()=>{
    if(observer.current||!consent||!checked||recovery.error||!prompt.trim())return;
    const controller=new AbortController();observer.current=controller;setBusy(true);setError("");setCopied(false);
    // Freeze the complete message before any POST, including an unknown create.
    const input=message??{id:`one-off-${crypto.randomUUID()}`,role:"user" as const,content:prompt};
    const onTask=(next:FreeChatTask)=>{
      selected.assertSelected();assertTaskScope(next,rootScopeKey);
      if(next.workspaceKey!==`one-off:${workspaceKey}`||next.conversation.messages[0]?.id!==input.id||next.conversation.messages[0]?.content!==input.content)throw new Error("任务原文不一致，未采用。");
      setTask(current=>current?.id===next.id&&current.revision>next.revision?current:next);setSaved({message:input,taskId:next.id});
    };
    try{
      selected.assertSelected();
      if(input.content!==prompt)throw new Error("本次任务已冻结原文，请先核对原任务；新内容须显式新建任务，仍使用原根账。");
      setSaved(current=>({...current,message:input}));
      if(task&&["paused","interrupted","failed","budget_exhausted"].includes(task.status)){
        await client.resume({task,rootScopeKey,runtime:selected.runtime,preferredRuntimeId:selected.preferredRuntimeId,signal:controller.signal,onTask});
      }else{
        await client.send({workspaceKey:`one-off:${workspaceKey}`,rootScopeKey,messages:[input],runtime:selected.runtime,preferredRuntimeId:selected.preferredRuntimeId,signal:controller.signal,onTask});
      }
      selected.assertSelected();
    }catch(failure){
      if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:"结果尚未确认，请读取原任务；未自动重试。");
    }finally{if(observer.current===controller){observer.current=null;setBusy(false);setConsent(false);}}
  };
  const stop=async()=>{
    if(!task)return;
    try{accept(await client.pause(task.id));observer.current?.abort();observer.current=null;setBusy(false);setConsent(false);}
    catch(failure){setError(failure instanceof Error?failure.message:"停止结果尚未确认，请读取任务。");}
  };
  const active=busy||task?.status==="running",done=task?.status==="awaiting_answer";
  const output=task?.reply?.content;
  return <section className="agent-companion-run" aria-label={configurationProbe?t("模型配置生成测试","Model configuration check"):t("单次文本任务","One-off text task")}>
    <div className="agent-companion-run-heading"><div><span>{configurationProbe?t("模型配置生成测试","Model configuration check"):t("单次文本任务","One-off text task")}</span><small>{configurationProbe?t("使用上方配置和工作区原总额度；底座冲突时拒绝，不另开预算。只发送固定测试句及任务协议，不附加简历或历史。关闭面板不停止任务，可重开读取或明确停止。","Uses the form configuration and the existing workspace budget. A conflicting root runtime is refused, never replaced. Sends only the fixed check and task protocol, without resume or history. Closing does not stop the task; reopen to read or explicitly stop it."):t("与当前对话共用底座和工作区总额度；只发送下方完整原文，不自动附加对话、简历或文件。","Uses the selected runtime and shared workspace budget. Sends only the complete text below, without chat, resume or files.")}</small></div></div>
    <p className="agent-model-summary">{selected.label}</p>
    <WorkspaceRecoveryNotice error={recovery.error} restored={recovery.restored} download={recovery.download}/>
    {configurationProbe?<details className="model-probe-prompt"><summary>{t("查看完整固定测试句","View the complete fixed check")}</summary><pre>{prompt}</pre></details>:<label className="agent-companion-field"><span>{t("任务提示","Task prompt")}</span><textarea value={prompt} onChange={event=>onPromptChange(event.target.value)} placeholder={t("先粘贴岗位描述或其他文本，再写明任务","Paste the job description or other text, then describe the task")} rows={3} disabled={Boolean(message)||active}/></label>}
    <label className="betterme-agent-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={active||Boolean(done)}/>{configurationProbe?t("允许用上方配置执行本测试并计入工作区总额度；可能产生费用，不验证图片能力。","Run this check with the form configuration, charged to the workspace budget. Charges may apply; image capability is not tested."):t("允许将这段原文发送给当前底座；结果只供核对。","Send this text to the selected runtime for review only.")}</label>
    <div className="agent-companion-run-actions">
      <button type="button" className="agent-companion-run-button" onClick={()=>void run()} disabled={active||!consent||!checked||Boolean(done)||Boolean(selected.error)||Boolean(recovery.error)||!prompt.trim()}><Play size={13}/>{task&&task.status!=="ready"?t("继续原任务","Resume original task"):t("开始运行","Run now")}</button>
      {message&&<button type="button" onClick={()=>void onRead()} disabled={busy}><RefreshCw size={13}/>{t("读取现有任务","Read existing task")}</button>}
      {task?.status==="running"&&<button type="button" onClick={()=>void stop()} aria-label={t("停止单次任务","Stop one-off task")}><Square size={13}/></button>}
      {message&&task&&!["ready","running"].includes(task.status)&&<button type="button" disabled={busy} onClick={()=>{setSaved({});setTask(undefined);setConsent(false);setError("");onPromptChange("");}}>{t("新任务 · 沿用总额度","New task · same budget")}</button>}
    </div>
    {selected.error&&<p role="alert">{selected.error}</p>}
    {error&&<p className="agent-companion-run-error" role="alert">{error}</p>}
    {task&&<>
      <div className="agent-companion-run-status"><span>{done?t("完整回复 · 待核对","Full reply · review required"):task.status}</span><small>{t(`工作区模型用量 ${task.rootLedger?.usage.modelCalls??task.usage.modelCalls} / ${task.rootLedger?.budget.maxModelCalls??task.budget.maxModelCalls}`,`Workspace model calls ${task.rootLedger?.usage.modelCalls??task.usage.modelCalls} / ${task.rootLedger?.budget.maxModelCalls??task.budget.maxModelCalls}`)}</small></div>
      {task.error&&<p className="agent-companion-run-error" role="status">{task.error}</p>}
      {output!==undefined&&<section className="agent-companion-output" aria-label={t("本次运行结果","Run output")}>
        <div className="agent-companion-section-heading"><span>{t("运行结果","Run output")}</span><button type="button" aria-label={t("复制完整运行结果","Copy complete run output")} onClick={()=>void navigator.clipboard.writeText(output).then(()=>setCopied(true)).catch(()=>setCopied(false))}>{copied?<Check size={12}/>:<Copy size={12}/>}</button></div>
        <div className="agent-output-text"><AgentMarkdownRenderer content={output} isDark={theme==="dark"}/></div>
      </section>}
      {task.partialOutput&&<details><summary>{t("未完成的原始输出 · 不作为完整结果","Incomplete raw output · not a final result")}</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{task.partialOutput.text}</pre></details>}
      <TaskOutputArtifacts task={task}/>
      <AgentExecutionLog entries={task.events.map(event=>({id:`${task.id}:${event.sequence}`,at:event.at,kind:event.kind,label:event.kind,detail:event.detail,important:["stopped","budget","receipt"].includes(event.kind)}))}/>
    </>}
  </section>;
}
