import { useEffect, useRef, useState } from "react";
import type { LlmConfig } from "@better-me/core";
import {
  CAREER_TASK_DEFAULT_BUDGET, CareerTaskBudgetSchema, CareerTaskCreateSchema, careerRuntimeBinding,
  type CareerTask, type CareerTaskBudget, type CareerTaskInput, type CareerToolArtifact, type ResumeEditContext,
} from "@better-me/agent-contracts";
import { BookOpen, ShieldCheck } from "lucide-react";
import { z } from "zod";
import { captureIdentityLease, capturePrivateStorage, currentPrincipal } from "../lib/identity";
import { useUiPreferences, type UiLocale, type UiTranslator } from "../lib/ui-preferences";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { useAgentRouting } from "../lib/agent-routing";
import { writingSources, writingTargetKey } from "../lib/resume-copilot";
import type { CareerWritingFocus } from "../lib/career-task-focus";
import type { WorkspaceReceiptRequest, WorkspaceReceiptInspection } from "../lib/career-task-reconciliation";
import { understandingModelRuntime, type UnderstandingRuntime } from "../services/understanding-client";
import { defaultCareerTaskClient, type CareerTaskClient, type CareerReceiptInput } from "../services/career-task-client";
import { assertTaskScope, taskCreatePayload } from "../services/agent-task-scope";
import "./career-task-panel.css";

export interface CareerTaskPanelProps {
  workspaceKey:string; job?:{ id?:string; title:string; company?:string; description:string } | null; resumeFields?:ResumeEditContext;
  sourceResumeId?:string; sourceResumeName?:string; sourceFingerprint?:string; llmConfig?:LlmConfig;
  onSave?:(task:CareerTask, approvedPatchIds:string[])=>Promise<{versionId:string;receiptId?:string}>;
  onCommitFact?:(task:CareerTask, fact:CareerTask["facts"][number])=>Promise<void>;
  onReconcile?:(task:CareerTask, request:WorkspaceReceiptRequest)=>Promise<WorkspaceReceiptInspection>;
  initialObjective?:string; client?:CareerTaskClient; pollIntervalMs?:number;
  initialFocus?:CareerWritingFocus;
  onTaskChange?:(task:CareerTask|undefined)=>void;
}
const phaseText=(t:UiTranslator):Record<CareerTask["status"],string>=>({ready:t("等待启动","Ready to start"),running:t("正在执行","Running"),awaiting_answer:t("等你补充","Waiting for your answer"),awaiting_review:t("等待逐条审阅","Awaiting item-by-item review"),
  paused:t("已暂停","Paused"),interrupted:t("已中断，等待核对","Interrupted; awaiting verification"),budget_exhausted:t("已达预算","Budget reached"),failed:t("本次执行失败","Run failed"),revoked:t("授权已撤销","Authorization revoked"),completed:t("已收到版本回执","Version receipt received")});
const kindLabels=(t:UiTranslator)=>({job:t("岗位原文","Job source"),resume:t("简历原句","Resume source"),user_statement:t("本人陈述","User statement"),source:t("项目资料","Project source"),design:t("设计材料（非交付证明）","Design material (not delivery evidence)")}) as const;
const eventLabels=(t:UiTranslator):Record<CareerTask["events"][number]["kind"],string>=>({created:t("建立约定","Agreement created"),started:t("开始执行","Started"),model:t("模型调用","Model call"),tool_call:t("调用工具","Tool call"),tool_result:t("工具结果","Tool result"),
  decision:t("下一步","Next step"),question:t("请求补充","Question asked"),answer:t("收到补充","Answer received"),draft:t("草稿","Draft"),stopped:t("停止","Stopped"),budget:t("预算","Budget"),receipt:t("保存回执","Save receipt"),fact:t("事实确认","Fact confirmation")});
const pendingReceiptSchema=z.object({draftHash:z.string().min(1),versionId:z.string().min(1),receiptId:z.string().min(1).optional(),approvedPatchIds:z.array(z.string()).min(1)});
type PendingReceipt=z.infer<typeof pendingReceiptSchema>;
function receiptMatches(saved:CareerTask["receipt"],pending:PendingReceipt){
  return !!saved && saved.versionId===pending.versionId && (!pending.receiptId || saved.receiptId===pending.receiptId)
    && saved.draftHash===pending.draftHash && JSON.stringify(saved.approvedPatchIds)===JSON.stringify(pending.approvedPatchIds);
}
function unresolved(t:UiTranslator,state:"missing"|"edited"|"conflict",subject:string){
  if(state==="missing")return t(`当前工作区未找到${subject}；若曾保存，可能已移除或恢复到旧版。未创建或补写回执。`,`The current workspace cannot find ${subject}. If it was saved, it may have been removed or restored to an older version. No receipt was created or backfilled.`);
  if(state==="edited")return t(`曾保存的${subject}后来已编辑或替代；不能把现稿当作原审批内容。未覆盖或补写回执。`,`The saved ${subject} was later edited or replaced. The current content cannot be treated as the approved content. Nothing was overwritten and no receipt was backfilled.`);
  return t(`工作区的${subject}与任务、批准清单或历史指针不一致。未覆盖或补写回执。`,`The workspace ${subject} does not match the task, approval list, or history pointer. Nothing was overwritten and no receipt was backfilled.`);
}
const fmt=(ms:number,t:UiTranslator)=>t(`${Math.floor(ms/60_000)}分${Math.floor(ms/1000)%60}秒`,`${Math.floor(ms/60_000)}m ${Math.floor(ms/1000)%60}s`);
const errorEnglish:Record<string,string>={
  "记录不属于当前账号与工作区，未载入。":"This record does not belong to the current account and workspace, so it was not loaded.",
  "请先登录当前账号；不会读取匿名任务或预算。":"Sign in to the current account. Anonymous tasks and budgets will not be read.",
  "当前任务未在本账号列表中找到；未覆盖现有状态。":"The current task was not found in this account’s list. Existing state was not overwritten.",
  "请先核对本次资料与模型并授权。":"Review this task’s sources and model, then authorize it.",
  "任务约定缺少岗位、源简历或选中的字段。":"The task agreement is missing a job, source resume, or selected fields.",
  "任务约定格式超限或存在重复资料；请检查字段、材料、目录和预算。":"The task agreement exceeds limits or contains duplicate sources. Check fields, materials, directories, and budget.",
  "资料或底座在创建期间已更新，本机仅保存约定；未启动模型。":"Sources or runtime changed during creation. Only the agreement was saved; the model was not started.",
  "当前原稿、岗位或模型与授权不符，未继续。":"The current source, job, or model does not match the authorization. Nothing continued.",
  "请先填写对这一个问题的回答。":"Answer this question before continuing.",
  "任务或草稿已变化，请刷新并重新逐条核对；未写入新版本。":"The task or draft changed. Refresh and review each item again; no new version was written.",
  "请核对原稿、来源与逐条批准状态；未保存。":"Review the source, citations, and item approvals. Nothing was saved.",
  "来源在保存前已变化，未保存。":"Sources changed before saving. Nothing was saved.",
  "所选改写的引用不完整，未保存。":"Selected rewrites have incomplete citations. Nothing was saved.",
  "未收到业务版本编号；不会标记完成。":"No business version ID was received, so the task will not be marked complete.",
  "业务版本已落盘，但宿主回执未对上。请刷新，勿重复保存。":"The business version was saved, but the Host receipt does not match. Refresh and do not save again.",
  "工作区未提供只读核对能力，未补写回执。":"The workspace does not provide read-only reconciliation. No receipt was backfilled.",
  "未核对到同一份草稿的真实版本回执。":"No real version receipt was found for the same draft.",
  "宿主历史回执与工作区不一致，未采用。":"The Host history receipt does not match the workspace and was not accepted.",
  "任务状态已变化，不能补写回执。":"Task state changed, so the receipt cannot be backfilled.",
  "回执仍未核对成功，未重复写入版本。":"The receipt is still unverified. The version was not written again.",
  "只能从勾选的本人陈述中摘录原句。":"Only exact text from selected user statements can be extracted.",
  "该长期事实提案已变化，未更改。":"This long-term fact proposal changed. Nothing was modified.",
  "工作区已经保存此陈述，请只补写回执。":"The workspace already saved this statement. Only backfill the receipt.",
  "工作区没有确认写入本账号事实记录，未批准。":"The workspace did not confirm writing this account’s fact record, so it was not approved.",
  "工作区未提供只读核对能力，未补写事实回执。":"The workspace does not provide read-only reconciliation. No fact receipt was backfilled.",
  "当前工作区有此本人陈述，但宿主提案不同或已撤销；请人工核对。":"The workspace contains this statement, but the Host proposal differs or was revoked. Review it manually.",
  "事实回执尚未确认。":"The fact receipt has not been confirmed.",
};
const reason=(error:unknown,t:UiTranslator)=>error instanceof Error ? t(error.message,errorEnglish[error.message]??error.message) : t("操作没有获得确认。请刷新当前状态。","The operation was not confirmed. Refresh the current state.");
const keyOf=(workspaceKey:string)=>`career-task.v1:${encodeURIComponent(workspaceKey)}`;
type Material=CareerTaskInput["materials"][number];
const locationLabels=(t:UiTranslator)=>({local:t("本机 Ollama 端点（后端部署未独立验证）","Local Ollama endpoint (backend deployment not independently verified)"),cloud:t("云端推理","Cloud inference"),unknown:t("推理位置未证实，可能发送云端","Inference location unverified; data may be sent to the cloud")}) as const;
function observedTime(iso:string,locale:UiLocale,t:UiTranslator){const d=new Date(iso);return Number.isNaN(d.valueOf())?t("时间未知","Time unknown"):new Intl.DateTimeFormat(locale==="en"?"en":"zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(d);}
function readJson(storage:Storage,key:string):unknown { try { return JSON.parse(storage.getItem(key)??"null"); } catch { return null; } }
function BudgetFields({value,onChange}:{value:CareerTaskBudget;onChange:(value:CareerTaskBudget)=>void}) {
  const {t}=useUiPreferences();
  const fields=[["maxModelCalls",t("模型调用（次）","Model calls"),500,1],["maxToolCalls",t("资料读取（次）","Source reads"),2000,1],["maxActiveMs",t("主动运行（分钟）","Active runtime (minutes)"),1440,60_000]] as const;
  return <div className="ct-budget">{fields.map(([key,label,max,scale])=><label key={key}>{label}<input type="number" min={1} max={max} step={1}
    value={Number.isFinite(value[key])?value[key]/scale:""} onChange={event=>onChange({...value,[key]:event.target.valueAsNumber*scale})}/></label>)}</div>;
}
function Sources({task,ids}:{task:CareerTask;ids:string[]}) {
  const {t}=useUiPreferences(),kindText=kindLabels(t);
  return <ul className="ct-sources">{ids.map(id=>{const item=task.evidence.find(source=>source.id===id);
    return <li key={id}>{item ? <><strong>{kindText[item.kind]} · {item.label}</strong>{item.path && <small>{item.path}{item.startLine ? t(` · ${item.startLine}–${item.endLine??item.startLine} 行`,` · lines ${item.startLine}–${item.endLine??item.startLine}`):""}</small>}
      <blockquote>{item.excerpt}</blockquote></> : <span>{t("未取得引用：","Citation unavailable: ")}{id}</span>}</li>;})}</ul>;
}
function Events({items}:{items:CareerTask["events"]}){
  const {t,locale}=useUiPreferences(),eventText=eventLabels(t);
  return <ol className="ct-events">{items.map(e=><li key={e.sequence}><strong>{eventText[e.kind]}</strong> {e.detail} <time dateTime={e.at}>{observedTime(e.at,locale,t)}</time></li>)}</ol>;
}
function useSelectedRuntime(config: LlmConfig|undefined) {
  const {t}=useUiPreferences(),routing=useAgentRouting(), {agent,snapshot}=useBetterMeAgent();
  let runtime:UnderstandingRuntime|undefined, endpoint:string|undefined, preferred:string|undefined;
  if(routing?.blocked || routing?.error || routing?.busy || (agent && (!snapshot?.ready || snapshot.error))) return {error:t("当前底座尚未核实，请在模型与工具中检查。","The current runtime has not been verified. Check Models & Tools.")};
  if(routing?.enabled && routing.policy){
    if(routing.policy.mode!=="manual") return {error:t("这项任务不接受自动切换模型。请在模型与工具中手动选定一个底座。","This task does not allow automatic model switching. Select a runtime manually in Models & Tools.")};
    // A generic routing ID is not necessarily an owner-isolated task adapter.
    // The host independently checks installation, isolation and the live authorization before dispatch.
    if(!["codex","claude-code","opencode","gemini-cli"].includes(routing.policy.preferred))return {error:t("所选底座没有已识别的职业任务适配，不能发送资料，也不会改用其他通道。","The selected runtime has no recognized career-task adapter. Sources cannot be sent, and no alternate channel will be used.")};
    runtime={kind:"unified",expectedRevision:routing.policy.revision}; preferred=routing.policy.preferred;
  } else if(snapshot?.data.selection.kind==="chatgpt"){
    return {error:t("此任务支持已配置的模型或手动选定的账号隔离 CLI。ChatGPT 套餐独立通道尚未接入；不会自动改用 API。","This task supports configured models or a manually selected account-isolated CLI. The separate ChatGPT subscription channel is not connected; it will not fall back to an API.")};
  } else if(config?.model.trim()&&config.baseUrl.trim()){
    try {
      const url=new URL(config.baseUrl);
      const loopback=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
      if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:" || (url.protocol==="http:" && loopback))) throw Error();
      if(!loopback && config.provider!=="ollama" && !config.apiKey?.trim()) return {error:t("所选云端模型尚未配置凭据；未尝试其他通道。","Credentials are missing for the selected cloud model; no other channel was attempted.")};
      endpoint=url.origin+url.pathname; runtime=understandingModelRuntime(config);
    } catch { return {error:t("模型端点无法安全辨认，未启用任务。","The model endpoint could not be identified safely, so the task was not enabled.")}; }
  } else return {error:t("没有明确选择可用的模型；不会自动改用付费服务。","No available model was explicitly selected; BetterMe will not switch to a paid service automatically.")};
  return {runtime,binding:careerRuntimeBinding(runtime,preferred),endpoint,error:undefined};
}
export default function CareerTaskPanel(props:CareerTaskPanelProps) {
  return <TaskSession key={JSON.stringify([currentPrincipal()?.id,props.workspaceKey])} {...props}/>;
}
export { CareerTaskPanel };
function TaskSession({workspaceKey,job,resumeFields,sourceResumeId,sourceResumeName,sourceFingerprint,llmConfig,onSave,onCommitFact,onReconcile,initialObjective,initialFocus,
  client=defaultCareerTaskClient,pollIntervalMs=1500,onTaskChange}:CareerTaskPanelProps) {
  const {t,locale}=useUiPreferences(),phase=phaseText(t),kindText=kindLabels(t),locText=locationLabels(t);
  const {agent}=useBetterMeAgent();
  const rootScopeKey=agent?.workspaceKey??workspaceKey;
  const [sharedRoot,setSharedRoot]=useState<Awaited<ReturnType<NonNullable<CareerTaskClient["root"]>>>>();
  const [scope]=useState(()=>({lease:captureIdentityLease(),storage:capturePrivateStorage(),key:keyOf(workspaceKey)}));
  const model=useSelectedRuntime(llmConfig);
  const [list,setList]=useState<CareerTask[]>([]),[task,setTask]=useState<CareerTask>(),[loading,setLoading]=useState(true);
  const [working,setWorking]=useState(""),[error,setError]=useState(""),[uncertain,setUncertain]=useState(false),[notice,setNotice]=useState("");
  const [objective,setObjective]=useState(initialObjective?.trim()||t("核对岗位要求与我的经历，生成逐条有依据的定制简历草稿，列出仍缺少的事实。","Review the job requirements against my experience, draft an evidence-backed tailored resume item by item, and list the facts still missing."));
  const fields=(resumeFields?writingSources(resumeFields):[]).filter(field=>field.text.trim()).map((field,i)=>({...field,id:`field-${i+1}`}));
  const [selected,setSelected]=useState<string[]>([]),[materials,setMaterials]=useState<Material[]>([]);
  const [directoryLines,setDirectoryLines]=useState(""),[answer,setAnswer]=useState("");
  const [ignoredFocus,setIgnoredFocus]=useState("");
  const focus=initialFocus?.id===ignoredFocus?undefined:initialFocus;
  const focusField=focus&&focus.sourceResumeId===sourceResumeId&&focus.sourceFingerprint===sourceFingerprint
    ?fields.find(field=>writingTargetKey(field.targetRef)===writingTargetKey(focus.targetRef)&&field.text===focus.originalText):undefined;
  const focusInvalid=!!focus&&!focusField, preparedFocus=useRef("");
  const focusInTask=!!(task&&focus&&task.resume.id===focus.sourceResumeId&&task.resume.sourceFingerprint===focus.sourceFingerprint&&task.resume.fields.some(f=>writingTargetKey(f.targetRef)===writingTargetKey(focus.targetRef)&&f.originalText===focus.originalText));
  const historicalFocus=task?.status==="completed"&&focusInTask;
  const statementInTask=!!(task&&focus?.userStatement&&(task.materials.some(m=>m.kind==="user_statement"&&m.text===focus.userStatement)||task.evidence.some(e=>e.kind==="user_statement"&&e.excerpt===focus.userStatement)));
  const [allowBuild,setAllowBuild]=useState(false),[installed,setInstalled]=useState<CareerToolArtifact[]>([]),[toolVersions,setToolVersions]=useState<string[]>([]),[installApproval,setInstallApproval]=useState("");
  const [consent,setConsent]=useState(""),[budgetConsent,setBudgetConsent]=useState(""),[checked,setChecked]=useState<string[]>([]);
  const [budget,setBudget]=useState<CareerTaskBudget>(()=>{
    const parsed=scope.lease.ownerId && CareerTaskBudgetSchema.safeParse(readJson(scope.storage,"career-task.v1:budget"));
    return parsed && parsed.success?parsed.data:{...CAREER_TASK_DEFAULT_BUDGET};
  });
  const [factText,setFactText]=useState(""),[factEvidence,setFactEvidence]=useState<string[]>([]);
  const busy=!!working || loading, alive=useRef(true), lock=useRef(false), taskRef=useRef(task);
  taskRef.current=task;
  useEffect(()=>{onTaskChange?.(task);},[task,onTaskChange]);
  useEffect(()=>{if(initialObjective?.trim()&&!taskRef.current&&!lock.current){setObjective(initialObjective.trim());setConsent("");}},[initialObjective]);
  const sourceSignature=JSON.stringify([sourceResumeId,sourceFingerprint,job?.id,job?.title,job?.company,job?.description]);
  const credentials=useRef({key:llmConfig?.apiKey,generation:0});
  if(credentials.current.key!==llmConfig?.apiKey)credentials.current={key:llmConfig?.apiKey,generation:credentials.current.generation+1};
  const selectedRuntime=JSON.stringify([model.binding,model.endpoint,credentials.current.generation,llmConfig?.temperature,llmConfig?.thinkingMode,llmConfig?.reasoningEffort,llmConfig?.maxTokens]), scopeToken=JSON.stringify([sourceSignature,selectedRuntime,task?.id,task?.revision,
    task?undefined:[objective,selected,materials,directoryLines,budget,allowBuild,toolVersions],task?.status==="awaiting_answer"?answer:undefined]);
  const latestToken=useRef(scopeToken);latestToken.current=scopeToken;
  const candidate=useRef<{token:string;key:string} | undefined>(undefined);
  const observing=useRef(0);
  const pendingKey=(id:string)=>`${scope.key}:receipt:${id}`;
  const [pending,setPending]=useState<PendingReceipt>();
  const pendingMemory=useRef(new Map<string,PendingReceipt>());
  function readPending(id:string){const saved=pendingReceiptSchema.safeParse(readJson(scope.storage,pendingKey(id)));return saved.success?saved.data:pendingMemory.current.get(id);}
  const [pendingFacts,setPendingFacts]=useState<string[]>([]),factMemory=useRef(new Map<string,string[]>());
  const factKey=(id:string)=>`${scope.key}:facts:${id}`;
  function readFacts(id:string){const parsed=z.array(z.string()).safeParse(readJson(scope.storage,factKey(id)));return parsed.success?parsed.data:factMemory.current.get(id)??[];}
  function writeFacts(id:string,ids:string[]){factMemory.current.set(id,ids);persist(factKey(id),ids.length?JSON.stringify(ids):undefined);if(alive.current)setPendingFacts(ids);}
  function persist(key:string,value:string|undefined){scope.lease.assert();if(!scope.lease.ownerId)return false;
    try { if(value===undefined)scope.storage.removeItem(key);else scope.storage.setItem(key,value);return true; } catch {if(alive.current)setNotice(t("浏览器记录未保存；可在本账号的宿主任务列表中找回。","Browser state was not saved. You can recover the task from this account’s Host task list."));return false;}}
  function checkOwned(next:CareerTask){scope.lease.assert();if(!scope.lease.ownerId||next.ownerId!==scope.lease.ownerId||next.workspaceKey!==workspaceKey) throw Error("记录不属于当前账号与工作区，未载入。");}
  function adopt(next:CareerTask){
    checkOwned(next);if(!alive.current)return;
    const before=taskRef.current;if(before?.id===next.id && before.revision>next.revision)return;
    if(before?.id!==next.id || before.revision!==next.revision) {setConsent("");setBudgetConsent("");setChecked([]);setFactEvidence([]);}
    if(before?.id!==next.id || before.question!==next.question)setAnswer("");
    if(before?.id!==next.id || before.budget.maxActiveMs!==next.budget.maxActiveMs || before.budget.maxModelCalls!==next.budget.maxModelCalls || before.budget.maxToolCalls!==next.budget.maxToolCalls)setBudget(next.budget);
    if(before?.id!==next.id)setFactText("");
    taskRef.current=next;setTask(next);setList(old=>[next,...old.filter(t=>t.id!==next.id)]);persist(scope.key,next.id);
    const local=readPending(next.id);
    if(local && receiptMatches(next.receipt,local)){pendingMemory.current.delete(next.id);persist(pendingKey(next.id),undefined);setPending(undefined);}
    else setPending(local);
    const facts=readFacts(next.id),openFacts=facts.filter(id=>!next.facts.some(f=>f.id===id&&f.status==="approved"));
    if(openFacts.length!==facts.length)writeFacts(next.id,openFacts);else setPendingFacts(openFacts);
    const disputed=!!(local&&next.receipt&&!receiptMatches(next.receipt,local));
    setUncertain(disputed);
    if(disputed)setError(t("工作区与宿主记录了不同的版本回执。不能标为本次保存成功，请人工核对。","The workspace and Host recorded different version receipts. This save cannot be marked successful; review it manually."));
  }
  const adoptRef=useRef(adopt);adoptRef.current=adopt;
  const load=async(signal?:AbortSignal, pick=true)=>{
    scope.lease.assert();if(!scope.lease.ownerId)throw Error("请先登录当前账号；不会读取匿名任务或预算。");
    const sequence=++observing.current;const [allTasks,root]=await Promise.all([client.list(signal),client.root?.(rootScopeKey,signal)]),tasks=allTasks.filter(t=>t.workspaceKey===workspaceKey);
    scope.lease.assert(); if(signal?.aborted||!alive.current||sequence!==observing.current)return;
    tasks.forEach(checkOwned);setList(tasks);
    setSharedRoot(root);if(root&&!taskRef.current)setBudget(root.budget);
    let stored:string|null=null;try{if(pick)stored=scope.storage.getItem(scope.key);}catch{/* Authorized host history still works without browser storage. */}
    const choice=taskRef.current?.id ?? stored;
    const matching=tasks.find(t=>t.id===choice);
    if(matching)adoptRef.current(matching); else if(choice && taskRef.current)throw Error("当前任务未在本账号列表中找到；未覆盖现有状态。");else setUncertain(false);
  };
  const loadRef=useRef(load);loadRef.current=load;
  useEffect(()=>{alive.current=true;const get=new AbortController();void loadRef.current(get.signal).catch(e=>{if(!get.signal.aborted){setError(reason(e,t));setUncertain(true);}}).finally(()=>{if(!get.signal.aborted)setLoading(false);});
    return ()=>{alive.current=false;get.abort();};},[scope,client,t]);
  useEffect(()=>{setConsent("");setSelected([]);},[sourceSignature]);
  const focusSignature=JSON.stringify(focus);
  const focusFieldId=focusField?.id;
  useEffect(()=>{
    if(!focus||loading||taskRef.current||preparedFocus.current===focusSignature)return;
    preparedFocus.current=focusSignature;setConsent("");
    if(!focusFieldId)return;
    setSelected([focusFieldId]);
    // Preserve other unsent materials. Project understanding, memories and old grants are NOT imported.
    if(focus.userStatement?.trim())setMaterials(old=>[...old.filter(m=>m.id!==`writing-focus-${focus.id}`),{
      id:`writing-focus-${focus.id}`,label:t(`旁写本人补充 · ${focus.label}`,`Writing supplement · ${focus.label}`).slice(0,300),kind:"user_statement",text:focus.userStatement!.trim(),
    }]);
  },[focusSignature,focusFieldId,loading,focus,t]);
  useEffect(()=>{setConsent("");},[llmConfig?.apiKey,selectedRuntime]);
  useEffect(()=>{if(!client.installedTools||!scope.lease.ownerId)return;const ctrl=new AbortController();
    void client.installedTools(ctrl.signal).then(items=>{if(!ctrl.signal.aborted){scope.lease.assert();setInstalled(items);}}).catch(e=>{if(!ctrl.signal.aborted)setNotice(t("工具库未载入，未授权任何已安装工具。","The tool library did not load; no installed tools were authorized. ")+reason(e,t));});
    return ()=>ctrl.abort();},[client,scope,t]);
  const observedId=task?.id, observedStatus=task?.status;
  useEffect(()=>{
    if(!observedId || observedStatus!=="running")return;
    const id=observedId, ctrl=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{try{const next=await client.get(id,ctrl.signal);if(!ctrl.signal.aborted && taskRef.current?.id===id)adoptRef.current(next);}
      catch(e){if(!ctrl.signal.aborted){setError(reason(e,t));setUncertain(true);}}finally{if(!ctrl.signal.aborted)timer=setTimeout(tick,pollIntervalMs);}};
    timer=setTimeout(tick,pollIntervalMs);return ()=>{clearTimeout(timer);ctrl.abort();};
  },[observedId,observedStatus,client,pollIntervalMs,t]); // restarting the view never restarts a task
  async function act(label:string, action:()=>Promise<void>, mutates=true){
    if(lock.current)return;lock.current=true;setWorking(label);setError("");setNotice("");
    try {scope.lease.assert();await action();}
    catch(e){if(alive.current){setError(reason(e,t));if(mutates)setUncertain(true);}}
    finally{lock.current=false;if(alive.current)setWorking("");}
  }
  const viewRead=useRef<AbortController | undefined>(undefined);
  useEffect(()=>()=>viewRead.current?.abort(),[]);
  const refresh=()=>act(t("刷新","refreshing"),async()=>{const ctrl=new AbortController();viewRead.current?.abort();viewRead.current=ctrl;
    if(taskRef.current){const next=await client.get(taskRef.current.id,ctrl.signal);if(!ctrl.signal.aborted)adopt(next);}
    else await load(ctrl.signal);},false);
  const sourceMatches=!!task&&sourceResumeId===task.resume.id&&sourceFingerprint===task.resume.sourceFingerprint
    &&!!job&&task.job.title===job.title&&task.job.company===(job.company??"")&&task.job.description===job.description&&task.job.id===job.id;
  const runtimeMatches=!task||!!model.binding&&(model.binding.id===task.runtimeBinding.id && model.binding.location===task.runtimeBinding.location && model.binding.label===task.runtimeBinding.label);
  const allowed=consent===scopeToken&&!!model.runtime&&!!model.binding&&runtimeMatches&&!uncertain&&!!scope.lease.ownerId;
  const selectedFields=fields.filter(field=>selected.includes(field.id)).map(({id,targetRef,text})=>({id,targetRef,originalText:text}));
  const directories=directoryLines.split(/\r?\n/).map(v=>v.trim()).filter(Boolean).map(path=>({path,label:path.split(/[\\/]/).filter(Boolean).at(-1)??path}));
  const validSetup=!focusInvalid&&!!job?.title.trim()&&!!job.description.trim()&&!!sourceResumeId&&!!sourceFingerprint&&!!sourceResumeName?.trim()&&!!objective.trim()
    &&selectedFields.length>0&&CareerTaskBudgetSchema.safeParse(budget).success&&materials.every(m=>m.text.trim()&&m.label.trim());
  const execute=()=>act(t("提交","submitting"),async()=>{
    if(!allowed || !model.runtime || !model.binding || !sourceFingerprint)throw Error("请先核对本次资料与模型并授权。");
    let current=taskRef.current;
    if(!current){
      if(!validSetup || !job || !sourceResumeId || !sourceResumeName)throw Error("任务约定缺少岗位、源简历或选中的字段。");
      const same=candidate.current?.token===scopeToken;const key=same?candidate.current!.key:crypto.randomUUID();
      candidate.current={token:scopeToken,key};
      const data=CareerTaskCreateSchema.safeParse({workspaceKey,rootScopeKey,objective:objective.trim(),job:{id:job.id,title:job.title,company:job.company??"",description:job.description},
        resume:{id:sourceResumeId,name:sourceResumeName,sourceFingerprint,fields:selectedFields},materials,directories,runtimeBinding:model.binding,budget,toolPolicy:{allowBuild,installedVersionIds:toolVersions},consent:true,idempotencyKey:key});
      if(!data.success)throw Error("任务约定格式超限或存在重复资料；请检查字段、材料、目录和预算。");
      current=await client.create(taskCreatePayload(data.data,sharedRoot?undefined:budget));checkOwned(current);
      if(!alive.current)return;
      if(latestToken.current!==scopeToken){adopt(current);throw Error("资料或底座在创建期间已更新，本机仅保存约定；未启动模型。");}
      adopt(current);
      if(current.status!=="ready")return; // reconcile an idempotent create, never replay an existing run
    } else {assertTaskScope(current,rootScopeKey);if(!sourceMatches || !runtimeMatches)throw Error("当前原稿、岗位或模型与授权不符，未继续。");}
    const action=current.status==="ready"?"start":current.status==="awaiting_answer"?"answer":"resume";
    if(action==="answer"&&!answer.trim())throw Error("请先填写对这一个问题的回答。");
    const next=await client.run(current.id,action,{expectedRevision:current.revision,sourceFingerprint,runtimeBinding:model.binding,runtime:model.runtime,consent:true,
      ...(action==="answer"?{answer:answer.trim()}:{})});if(alive.current)adopt(next);
  });
  const choose=(next:CareerTask)=>{if(lock.current)return;observing.current++;setError("");setNotice("");adopt(next);};
  const reset=()=>{if(lock.current)return;observing.current++;persist(scope.key,undefined);taskRef.current=undefined;setTask(undefined);setPending(undefined);setPendingFacts([]);
    setChecked([]);setConsent("");setSelected([]);setMaterials([]);setDirectoryLines("");setAllowBuild(false);setToolVersions([]);setInstallApproval("");setAnswer("");setFactText("");setFactEvidence([]);setNotice("");setError("");setUncertain(false);candidate.current=undefined;};
  const validBudget=CareerTaskBudgetSchema.safeParse(budget).success;
  const increased=task && validBudget && budget.maxModelCalls>=task.budget.maxModelCalls && budget.maxToolCalls>=task.budget.maxToolCalls && budget.maxActiveMs>=task.budget.maxActiveMs
    && (budget.maxModelCalls>task.budget.maxModelCalls||budget.maxToolCalls>task.budget.maxToolCalls||budget.maxActiveMs>task.budget.maxActiveMs);
  const budgetToken=JSON.stringify([task?.id,task?.revision,budget]);
  async function fresh(current:CareerTask){
    const ctrl=new AbortController();viewRead.current?.abort();viewRead.current=ctrl;
    const next=await client.get(current.id,ctrl.signal);ctrl.signal.throwIfAborted();checkOwned(next);
    if(next.id!==current.id || next.revision!==current.revision || next.status!==current.status || next.draft?.hash!==current.draft?.hash){
      adopt(next);throw Error("任务或草稿已变化，请刷新并重新逐条核对；未写入新版本。");
    } return next;
  }
  const save=()=>act(t("保存","saving"),async()=>{
    if(!task || task.status!=="awaiting_review" || !task.draft || !onSave || !sourceMatches || uncertain || !checked.length || readPending(task.id))throw Error("请核对原稿、来源与逐条批准状态；未保存。");
    const before=await fresh(task);
    if(!before.draft || !alive.current || latestToken.current!==scopeToken)throw Error("来源在保存前已变化，未保存。");
    const ids=before.draft.patches.filter(p=>checked.includes(p.id)).map(p=>p.id);
    if(ids.length!==checked.length || before.draft.patches.filter(p=>ids.includes(p.id)).some(p=>!p.evidenceIds.length || p.evidenceIds.some(id=>!before.evidence.some(e=>e.id===id))))throw Error("所选改写的引用不完整，未保存。");
    const saved=await onSave(before,ids);scope.lease.assert();
    if(!saved?.versionId?.trim())throw Error("未收到业务版本编号；不会标记完成。");
    const record={versionId:saved.versionId,...(saved.receiptId?{receiptId:saved.receiptId}:{}),draftHash:before.draft.hash,approvedPatchIds:ids};
    pendingMemory.current.set(task.id,record);persist(pendingKey(task.id),JSON.stringify(record));if(alive.current)setPending(record);
    const next=await client.receipt(task.id,{...record,expectedRevision:before.revision});
    if(!receiptMatches(next.receipt,record)||next.status!=="completed")throw Error("业务版本已落盘，但宿主回执未对上。请刷新，勿重复保存。");
    if(alive.current)adopt(next);
  });
  const retryReceipt=()=>act(t("核对回执","reconciling the receipt"),async()=>{
    if(!task||!onReconcile)throw Error("工作区未提供只读核对能力，未补写回执。");
    const ctrl=new AbortController();viewRead.current?.abort();viewRead.current=ctrl;
    const next=await client.get(task.id,ctrl.signal);ctrl.signal.throwIfAborted();checkOwned(next);
    const observed=await onReconcile(next,{kind:"resume",hint:pending??next.receipt});scope.lease.assert();if(!alive.current)return;
    if(observed.state!=="current"){setNotice(unresolved(t,observed.state,t("岗位版本","job version")));return;}
    const record=observed.receipt;
    if(!record || next.draft?.hash!==record.draftHash)throw Error("未核对到同一份草稿的真实版本回执。");
    if(next.receipt){
      if(!receiptMatches(next.receipt,record))throw Error("宿主历史回执与工作区不一致，未采用。");
      adopt(next);setNotice(t("已核对：工作区仍有该审批版本。未重复保存或发送回执。","Verified: the workspace still contains this approved version. Nothing was saved again and no receipt was resent."));return;
    }
    if(next.status!=="awaiting_review")throw Error("任务状态已变化，不能补写回执。");
    const body:CareerReceiptInput={...record,expectedRevision:next.revision};
    const res=await client.receipt(task.id,body);if(!receiptMatches(res.receipt,record)||res.status!=="completed")throw Error("回执仍未核对成功，未重复写入版本。");adopt(res);
  });
  const propose=()=>act(t("准备事实提案","preparing a fact proposal"),async()=>{
    if(!task||!factText.trim()||!factEvidence.length)return;
    const before=await fresh(task);
    if(!before.evidence.some(e=>factEvidence.includes(e.id)&&e.kind==="user_statement"&&e.excerpt.includes(factText.trim())))throw Error("只能从勾选的本人陈述中摘录原句。");
    adopt(await client.proposeFact(task.id,{expectedRevision:before.revision,text:factText.trim(),evidenceIds:factEvidence}));setFactText("");setFactEvidence([]);
  });
  const decideFact=(id:string,approve:boolean)=>act(t("核对事实","reviewing the fact"),async()=>{
    if(!task || task.status==="revoked" || uncertain)return;
    const before=await fresh(task), fact=before.facts.find(f=>f.id===id&&f.status==="proposed");
    if(!fact)throw Error("该长期事实提案已变化，未更改。");
    if(readFacts(task.id).includes(fact.id))throw Error("工作区已经保存此陈述，请只补写回执。");
    if(onReconcile){
      const observed=await onReconcile(before,{kind:"fact",factId:id});scope.lease.assert();if(!alive.current)return;
      if(observed.state==="current"){setNotice(t("工作区已有此本人陈述，不重复写入或拒绝；请核对并补写事实回执。","The workspace already contains this statement. It was neither rewritten nor rejected; verify it and backfill the fact receipt."));return;}
      if(observed.state!=="missing"){setNotice(unresolved(t,observed.state,t("本人陈述","user statement")));return;}
    }
    if(approve){if(!onCommitFact || !sourceMatches || !alive.current)throw Error("工作区没有确认写入本账号事实记录，未批准。");
      await onCommitFact(before,fact);scope.lease.assert();writeFacts(task.id,[...readFacts(task.id),fact.id]);}
    adopt(await client.fact(task.id,fact.id,approve?"approve":"reject",{expectedRevision:before.revision}));
  });
  const retryFact=(id:string)=>act(t("补写事实回执","backfilling the fact receipt"),async()=>{
    if(!task||!onReconcile)throw Error("工作区未提供只读核对能力，未补写事实回执。");
    const ctrl=new AbortController();viewRead.current?.abort();viewRead.current=ctrl;
    const next=await client.get(task.id,ctrl.signal);ctrl.signal.throwIfAborted();checkOwned(next);const fact=next.facts.find(f=>f.id===id);
    const observed=await onReconcile(next,{kind:"fact",factId:id});scope.lease.assert();if(!alive.current)return;
    if(observed.state!=="current"){setNotice(unresolved(t,observed.state,t("本人陈述","user statement")));return;}
    if(fact?.status==="approved"){adopt(next);setNotice(t("已核对：长期记录仍有该本人陈述。","Verified: the long-term record still contains this statement."));return;}
    if(fact?.status!=="proposed"||next.status==="revoked")throw Error("当前工作区有此本人陈述，但宿主提案不同或已撤销；请人工核对。");
    const recorded=await client.fact(task.id,id,"approve",{expectedRevision:next.revision});if(!recorded.facts.some(f=>f.id===id&&f.status==="approved"))throw Error("事实回执尚未确认。");adopt(recorded);
  });
  const consentBox=<label className="ct-check"><input type="checkbox" checked={consent===scopeToken} disabled={busy || !model.binding} onChange={e=>setConsent(e.target.checked?scopeToken:"")}/>
    <span>{t("允许本任务将以上资料用于所选模型","Allow this task to use the sources above with the selected model")}{model.binding?.location!=="local"?t("（包括可能的云端处理）"," (including possible cloud processing)"):""}{t("，在所列预算内运行。不授权投递或修改原稿。"," within the listed budget. This does not authorize applications or changes to the source resume.")}</span></label>;
  return <section className="career-task-panel" aria-label={t("职业任务","Career task")} aria-busy={busy}>
    <header className="ct-header"><div><span className="ct-kicker"><ShieldCheck size={15} aria-hidden="true"/>{t("职业任务","Career task")}</span><h2>{task?task.job.title:t("为所选岗位准备简历","Prepare a resume for the selected job")}</h2></div>
      <button type="button" disabled={busy} onClick={()=>void refresh()}>{t("刷新状态","Refresh status")}</button></header>
    {error&&<p role="alert" className="ct-alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {working&&<p role="status">{t(`正在${working}，等待确认…`,`Currently ${working}; waiting for confirmation…`)}</p>}
    {loading&&<p role="status">{t("正在读取本账号的任务记录…","Reading this account’s task records…")}</p>}
    {focus&&<section className="ct-section" aria-label={t("当前经历交接","Current experience handoff")}><h3>{historicalFocus?t("任务原句（历史）","Task source (history)"):t("当前经历","Current experience")} · {focus.label}</h3>
      {focusInvalid&&!historicalFocus?<p role="alert">{t("旁写原稿已变化或不属于当前简历，未替换字段、发送补充或启动任务。请回到原文重新选择。","The writing source changed or does not belong to the current resume. No field was replaced, supplement sent, or task started. Return to the source and select it again.")}</p>:<>
        <blockquote>{focus.originalText}</blockquote>{focus.userStatement&&<p>{statementInTask?t("已收到的本人陈述","Received user statement"):t("待授权的本人陈述","User statement awaiting authorization")}：{focus.userStatement}</p>}
        {historicalFocus&&<p>{t("保留已完成任务当时的原句；当前新版本不继承旧任务的读取或执行许可。","The source text from the completed task is retained. The current version does not inherit the old task’s read or execution permissions.")}</p>}
        {task?<p>{t(`仍是同一任务 ${task.id}；目标、证据、预算和审阅保持不变。`,`This is still task ${task.id}; its objective, evidence, budget, and review remain unchanged. `)}{focusInTask?t("此字段已在任务范围内。","This field is already in scope. "):t("此字段尚不在当前任务授权内，未扩大范围。","This field is not authorized for the current task; scope was not expanded. ")}{focus.userStatement?(statementInTask?t("补充已列入本任务，实际取证请看来源记录；不自动写入事实库。","The supplement is included in this task. Review source records for the evidence; it is not written to the fact base automatically."):t("新补充尚未发送，也未写入事实库。","The new supplement has not been sent or written to the fact base.")):t("此次只定位，不增加资料或调用。","This only locates the field; it adds no sources or calls.")}</p>:<p>{t("只预选这一字段；本人补充作为单独来源列在材料中。核对岗位、模型和资料后授权启动，草稿逐条审阅后另存岗位版，不修改原稿或共享 FactBase。","Only this field is preselected, and the user supplement is listed as a separate source. Review the job, model, and sources before authorizing. Save an independently reviewed job-specific version without modifying the source or shared FactBase.")}</p>}
        {task?.status==="awaiting_answer"&&focusInTask&&!statementInTask&&focus.userStatement&&<button type="button" disabled={busy} onClick={()=>{setAnswer(focus.userStatement!);setConsent("");}}>{t("将这段补充放入本任务回答框（暂不发送）","Place this supplement in the answer field (do not send yet)")}</button>}
      </>}
      <button type="button" onClick={()=>{setIgnoredFocus(focus.id);setConsent("");}}>{t("关闭本次经历定位","Close this experience handoff")}</button>
    </section>}
    {!task && <><div className="ct-section"><h3>{t("任务约定","Task agreement")}</h3><label>{t("交付目标","Delivery objective")}<textarea value={objective} onChange={e=>setObjective(e.target.value)} maxLength={12000}/></label>
      {job?.description?.trim()?<details><summary>{t("岗位快照","Job snapshot")} · {job.title} {job.company}</summary><blockquote>{job.description}</blockquote></details>:<p>{t("请先选择带岗位原文的职位。","Select a job with source text first.")}</p>}
      <fieldset><legend>{t("允许读取的简历字段","Resume fields allowed for reading")} · {sourceResumeName??t("尚未选择简历","No resume selected")}</legend>
        {fields.map(field=><label className="ct-check" key={field.id}><input type="checkbox" checked={selected.includes(field.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,field.id]:old.filter(v=>v!==field.id))}/><span><strong>{field.label}</strong>{field.text}</span></label>)}
        {!fields.length&&<p>{t("没有可选择的非联系资料字段。","No non-contact fields are available.")}</p>}</fieldset>
      <details><summary>{t("可选项目资料与只读目录","Optional project sources and read-only directories")}</summary>
        {materials.map(material=><fieldset key={material.id}><legend>{t("项目材料","Project material")}</legend><label>{t("材料名称","Material name")}<input maxLength={300} value={material.label} onChange={e=>setMaterials(old=>old.map(m=>m.id===material.id?{...m,label:e.target.value}:m))}/></label>
          <label>{t("来源类型","Source type")}<select value={material.kind} onChange={e=>setMaterials(old=>old.map(m=>m.id===material.id?{...m,kind:e.target.value as Material["kind"]}:m))}>{(["source","design","user_statement"] as const).map(kind=><option key={kind} value={kind}>{kindText[kind]}</option>)}</select></label>
          <label>{t("材料内容","Material content")}<textarea maxLength={64000} value={material.text} onChange={e=>setMaterials(old=>old.map(m=>m.id===material.id?{...m,text:e.target.value}:m))}/></label>
          <button type="button" onClick={()=>setMaterials(old=>old.filter(m=>m.id!==material.id))}>{t("移除材料","Remove material")}</button></fieldset>)}
        <button type="button" disabled={materials.length>=40} onClick={()=>setMaterials(old=>[...old,{id:`material-${crypto.randomUUID()}`,label:"",text:"",kind:"source"}])}>{t("添加项目材料","Add project material")}</button>
        <label>{t("授权的项目目录（可不填，每行一个完整路径）","Authorized project directories (optional, one full path per line)")}<textarea value={directoryLines} onChange={e=>setDirectoryLines(e.target.value)}/></label>
        <small>{t("只允许读取这些目录中的受支持资料；相关摘录可能会随任务进入所选模型。","Only supported sources in these directories may be read. Relevant excerpts may be sent to the selected model with this task.")}</small>
      </details></div>
      <div className="ct-section"><h3>{t("执行与预算","Execution and budget")}</h3><p>{model.binding?<><strong>{model.binding.label}</strong> · {locText[model.binding.location]}{model.endpoint&&<> · <code>{model.endpoint}</code></>}</>:model.error}</p>
        {model.binding?.location==="local"&&<small>{t("按你配置的回环地址识别；如果该端点代理到远程服务，资料仍可能离开本机。","Identified from your configured loopback address. If that endpoint proxies a remote service, sources may still leave this device.")}</small>}
        {sharedRoot?<p>{t(`继承工作区根上限：模型 ${sharedRoot.budget.maxModelCalls} 次 · 读取 ${sharedRoot.budget.maxToolCalls} 次 · 主动 ${fmt(sharedRoot.budget.maxActiveMs,t)}。累计用量和调额见“共识与进度 → 工作区共享额度”，不另领预算。`,`Inherited workspace root limits: ${sharedRoot.budget.maxModelCalls} model calls · ${sharedRoot.budget.maxToolCalls} reads · ${fmt(sharedRoot.budget.maxActiveMs,t)} active. Review cumulative usage and adjustments under Consensus & progress → Shared workspace quota; this task receives no separate budget.`)}</p>:<BudgetFields value={budget} onChange={setBudget}/>}<small>{t("额度限制宿主发起的模型与读取次数，以及主动运行时间，等待回答不计时。CLI 内部步骤、重试和 token 用量不一定可见；费用未知，这不是账单上限。","Limits cover Host model calls, reads, and active runtime; waiting for answers does not count. Internal CLI steps, retries, and token usage may be unavailable. Cost is unknown; this is not a billing cap.")}</small>
        <details><summary>{t("沙箱工具 · 默认不构建、不借用已安装版本","Sandbox tools · No builds or installed versions by default")}</summary>
          <label className="ct-check"><input type="checkbox" checked={allowBuild} onChange={e=>setAllowBuild(e.target.checked)}/>{t("允许在本任务内构建纯 JSON 工具","Allow this task to build a JSON-only tool")}</label>
          <small>{t("当前只支持材料逐行整理。使用同一底座和任务预算，最多 3 次构建、8 次调用；宿主固定测试与实际输入校验不可修改。无文件、网络、Shell 或凭据权限。通过仅代表此有限契约，不证明事实真实。","Only line-by-line material processing is supported. It shares this runtime and budget, with at most 3 builds and 8 calls. Host fixtures and real-input validation cannot be changed. No file, network, Shell, or credential access is granted. Passing proves only this limited contract, not factual truth.")}</small>
          {installed.map(tool=><label className="ct-check" key={tool.versionId}><input type="checkbox" checked={toolVersions.includes(tool.versionId)} onChange={e=>setToolVersions(old=>e.target.checked?[...old,tool.versionId]:old.filter(id=>id!==tool.versionId))}/><span>{t("允许本任务调用：","Allow this task to call: ")}{tool.label}<code>{tool.versionId}</code></span></label>)}
          {!installed.length&&<p>{t("当前账号没有可选择的已安装版本。","This account has no installed versions available for selection.")}</p>}
        </details>
        <button type="button" disabled={busy || !validBudget || !scope.lease.ownerId} onClick={()=>{if(persist("career-task.v1:budget",JSON.stringify(budget)))setNotice(t("预算已设为本账号默认值；未授权任何模型请求。","Budget saved as this account’s default; no model request was authorized."));}}>{t("设为本账号默认预算","Set as this account’s default budget")}</button>
        {consentBox}<button className="ct-primary" type="button" disabled={busy || !allowed || !validSetup} onClick={()=>void execute()}>{t("授权并启动任务","Authorize and start task")}</button></div></>}
    {task&&<><div className="ct-section">
      <div className="ct-status" role="status"><strong>{pending&&task.receipt&&!receiptMatches(task.receipt,pending)?t("两端回执冲突","Receipt conflict between workspace and Host"):phase[task.status]}</strong><span>{t(`根账累计 · 模型 ${(task.rootLedger?.usage??task.usage).modelCalls}/${task.budget.maxModelCalls} 次 · 读取 ${(task.rootLedger?.usage??task.usage).toolCalls}/${task.budget.maxToolCalls} 次 · 主动 ${fmt((task.rootLedger?.usage??task.usage).activeMs,t)}/${fmt(task.budget.maxActiveMs,t)}`,`Root ledger · Model ${(task.rootLedger?.usage??task.usage).modelCalls}/${task.budget.maxModelCalls} · Reads ${(task.rootLedger?.usage??task.usage).toolCalls}/${task.budget.maxToolCalls} · Active ${fmt((task.rootLedger?.usage??task.usage).activeMs,t)}/${fmt(task.budget.maxActiveMs,t)}`)}</span></div>
      <p>{task.objective}</p><p>{t("绑定底座：","Bound runtime: ")}<strong>{task.runtimeBinding.label}</strong> · {locText[task.runtimeBinding.location]}{t("。费用未知；宿主调用数不等于 CLI 内部用量或账单。",". Cost is unknown; Host call counts do not equal internal CLI usage or billing.")}</p>
      <small>{t("工具约定：","Tool agreement: ")}{task.toolPolicy?.allowBuild?t("允许受限构建","limited builds allowed"):t("不允许构建","builds not allowed")} · {t(`明确授权已安装版本 ${task.toolPolicy?.installedVersionIds.length??0} 个。生成与修复、测试及实际调用共用上述预算。`,`${task.toolPolicy?.installedVersionIds.length??0} installed versions explicitly authorized. Generation, repair, tests, and real calls share the budget above.`)}</small>
      {task.error&&<p className="ct-alert">{task.error}</p>}
      {task.status==="revoked"&&pendingFacts.length>0&&<p className="ct-alert">{t(`工作区已保存过 ${pendingFacts.length} 条本人陈述，但宿主回执尚未核对。撤销只停止后续运行，不会删除先前保存的内容。`,`The workspace saved ${pendingFacts.length} user statements, but Host receipts are still unverified. Revoking stops future execution; it does not delete previously saved content.`)}</p>}
      <details><summary>{t("已授权资料","Authorized sources")} · {task.resume.name} · {t(`${task.resume.fields.length} 个字段`,`${task.resume.fields.length} fields`)}</summary>
        <p>{task.job.title} · {task.job.company}</p><blockquote>{task.job.description}</blockquote>{task.resume.fields.map(f=><blockquote key={f.id}>{f.originalText}</blockquote>)}
        {task.materials.map(m=><div key={m.id}><strong>{kindText[m.kind]} · {m.label}</strong><blockquote>{m.text}</blockquote></div>)}{task.directories.map(d=><p key={d.id}>{t("只读目录：","Read-only directory: ")}{d.label}</p>)}</details>
      <div className="ct-actions">{task.status==="running"&&<button type="button" disabled={busy} onClick={()=>void act(t("暂停","pausing"),async()=>adopt(await client.control(task.id,"pause",{expectedRevision:task.revision})))}>{t("暂停任务","Pause task")}</button>}
        {!['revoked','completed'].includes(task.status)&&<button type="button" disabled={busy} onClick={()=>void act(t("撤销","revoking"),async()=>adopt(await client.control(task.id,"revoke",{expectedRevision:task.revision})))}>{t("撤销本任务授权","Revoke task authorization")}</button>}
        <button type="button" disabled={busy} onClick={reset}>{t("打开新任务配置","Open new task setup")}</button></div></div>
      {["ready","paused","interrupted","awaiting_answer","failed","budget_exhausted"].includes(task.status)&&<div className="ct-section">
        <h3>{task.status==="awaiting_answer"?t("待回答的问题","Question awaiting answer"):t("核对后继续","Review before continuing")}</h3>
        {task.status==="awaiting_answer"&&<><p>{task.question}</p><Sources task={task} ids={task.questionEvidenceIds??[]}/>
          <label>{t("只用于这项任务的回答","Answer for this task only")}<textarea value={answer} maxLength={12000} onChange={e=>setAnswer(e.target.value)}/></label><small>{t("回答不会自动更新长期事实记录。","This answer does not update long-term fact records automatically.")}</small></>}
        {!sourceMatches&&<p className="ct-alert">{t("当前岗位或简历原稿已变化。请切回相同来源，或新建任务。","The current job or resume source changed. Return to the same source or create a new task.")}</p>}
        {(!runtimeMatches||model.error)&&<p className="ct-alert">{model.error??t("当前选中的模型与任务绑定的底座不同；未自动切换。","The selected model differs from the runtime bound to this task; nothing was switched automatically.")}</p>}
        {model.runtime&&model.binding&&<p>{t("本次接收资料：","Sources will be sent to: ")}{model.binding.label} · {locText[model.binding.location]}{model.endpoint&&<> · <code>{model.endpoint}</code></>}</p>}
        {consentBox}<button className="ct-primary" type="button" disabled={busy||!allowed||!sourceMatches||(task.rootLedger?.usage??task.usage).modelCalls>=task.budget.maxModelCalls||(task.rootLedger?.usage??task.usage).activeMs>=task.budget.maxActiveMs||(task.status==="awaiting_answer"&&!answer.trim())} onClick={()=>void execute()}>
          {task.status==="awaiting_answer"?t("确认回答并继续","Confirm answer and continue"):t("确认资料与底座并继续","Confirm sources and runtime, then continue")}</button></div>}
      {task.parentTaskId?<p>{t("本任务继承根额度；请在“共识与进度 → 工作区共享额度”核对或调整整组上限。","This task inherits the root quota. Review or adjust the group limit under Consensus & progress → Shared workspace quota.")}</p>:["paused","budget_exhausted","interrupted","ready","awaiting_answer","failed"].includes(task.status)&&<details className="ct-section"><summary>{t("调整预算上限","Adjust budget limits")}</summary><BudgetFields value={budget} onChange={setBudget}/>
        <label className="ct-check"><input type="checkbox" checked={budgetConsent===budgetToken} onChange={e=>setBudgetConsent(e.target.checked?budgetToken:"")}/>{t("我确认增加此任务额度；费用未知，此操作不会启动模型。","I confirm the increased quota. Cost is unknown, and this action will not start the model.")}</label>
        <button type="button" disabled={busy||uncertain||!increased||budgetConsent!==budgetToken} onClick={()=>void act(t("增加额度","increasing the quota"),async()=>adopt(await client.budget(task.id,{expectedRevision:task.revision,budget,consent:true})))}>{t("确认增加预算","Confirm budget increase")}</button></details>}
      {task.draft && <div className="ct-section"><h3>{t("定制版本 · 逐条审阅","Tailored version · Item-by-item review")}</h3>
        {task.draft.unknowns.length>0&&<div><strong>{t("仍待核实","Still unverified")}</strong><ul>{task.draft.unknowns.map((v,i)=><li key={i}>{v}</li>)}</ul></div>}
        {!task.draft.patches.length&&<p>{t("没有可批准的改写，未生成简历版本。可以补齐材料后发起新任务。","There are no rewrites to approve, so no resume version was created. Add the missing material and start a new task.")}</p>}
        {task.draft.patches.map((patch,i)=>{
          const supported=patch.evidenceIds.length>0&&patch.evidenceIds.every(id=>task.evidence.some(e=>e.id===id));
          return <div className="ct-diff" key={patch.id}><strong>{t(`第 ${i+1} 条`,`Item ${i+1}`)} · {patch.rationale}</strong><p>{t("原文：","Source: ")}{patch.originalText}</p><p>{t("建议：","Proposal: ")}{patch.proposedText}</p>
            <details><summary>{t(`依据（${patch.evidenceIds.length}）`,`Evidence (${patch.evidenceIds.length})`)}</summary><Sources task={task} ids={patch.evidenceIds}/>
              {patch.sentences?.map((s,n)=><p key={n}>{s.text} · {s.evidenceIds.join("、")}</p>)}</details>
            {task.status==="awaiting_review"&&<label className="ct-check"><input type="checkbox" disabled={busy||!!pending||!supported} checked={checked.includes(patch.id)}
              onChange={e=>setChecked(old=>e.target.checked?[...old,patch.id]:old.filter(v=>v!==patch.id))}/>{t(`批准第 ${i+1} 条`,`Approve item ${i+1}`)}</label>}</div>;})}
        {task.status==="awaiting_review"&&!sourceMatches&&<p className="ct-alert">{t("原稿或岗位已变化；不可用旧草稿保存，请重新比较。","The source resume or job changed. The old draft cannot be saved; compare again.")}</p>}
        {pending?<><p role="status">{t(`工作区曾返回版本 ${pending.versionId}，宿主回执待核对，不代表当前仍存在。不会重复创建。`,`The workspace returned version ${pending.versionId}, but its Host receipt is pending verification and does not prove the version still exists. It will not be created again.`)}</p>
          <button type="button" disabled={busy||!onReconcile} onClick={()=>void retryReceipt()}>{t("仅核对并补写回执","Verify and backfill receipt only")}</button></>:
          task.status==="awaiting_review"&&<button className="ct-primary" type="button" disabled={busy||uncertain||!onSave||!sourceMatches||!checked.length} onClick={()=>void save()}>{t(`保存已批准的 ${checked.length} 条为独立版本`,`Save ${checked.length} approved items as an independent version`)}</button>}
        {!pending&&onReconcile&&task.status==="awaiting_review"&&<button type="button" disabled={busy} onClick={()=>void retryReceipt()}>{t("查找已保存版本并补写回执（不创建）","Find saved version and backfill receipt (do not create)")}</button>}
        {task.receipt&&!pending&&<div role="status"><strong>{t("历史回执 · 已保存独立版本：","Historical receipt · Saved independent version: ")}{task.receipt.versionId}</strong> · {t(`当时批准 ${task.receipt.approvedPatchIds.length} 条；不证明当前版本未被编辑或移除。`,`${task.receipt.approvedPatchIds.length} items were approved then; this does not prove the current version was not edited or removed.`)}
          {onReconcile&&<button type="button" disabled={busy} onClick={()=>void retryReceipt()}>{t("只核对当前工作区版本","Verify current workspace version only")}</button>}
          <details><summary>{t("查看保存回执","View save receipt")}</summary>{task.receipt.receiptId&&<p>{t("工作区回执：","Workspace receipt: ")}<code>{task.receipt.receiptId}</code></p>}
            <p>{t("草稿指纹：","Draft fingerprint: ")}<code>{task.receipt.draftHash}</code></p><p>{t("记录时间：","Recorded: ")}<time dateTime={task.receipt.at}>{observedTime(task.receipt.at,locale,t)}</time></p></details></div>}</div>}
      {!!task.tools?.length&&<div className="ct-section"><h3>{t("本任务构建的工具 · 独立安装审批","Tools built by this task · Separate installation approval")}</h3><small>{t("通过测试后可在本任务临时使用；采纳简历不会顺带安装工具。以后任务仍需勾选具体版本。","A tool that passes tests can be used temporarily by this task. Adopting the resume does not install it, and future tasks must select an exact version again.")}</small>
        {task.tools.map(tool=>{const token=JSON.stringify([task.id,task.revision,tool.versionId,tool.sourceHash]),isInstalled=installed.some(t=>t.versionId===tool.versionId);return <div className="ct-diff" key={tool.versionId}>
          <strong>{tool.label} · {isInstalled?t("本账号已安装","Installed for this account"):t("仅当前任务可用","Available only to this task")}</strong><code>{tool.versionId}</code><p>{tool.profile} · {t(`固定测试 ${tool.testsPassed}/${tool.testsTotal}`,`Fixed tests ${tool.testsPassed}/${tool.testsTotal}`)}</p>
          <details><summary>{t("审阅代码与指纹","Review code and fingerprint")}</summary><code>{tool.sourceHash}</code><pre className="ct-tool-source">{tool.source}</pre></details>
          {!isInstalled&&["awaiting_review","paused","completed"].includes(task.status)&&<><label className="ct-check"><input type="checkbox" checked={installApproval===token} onChange={e=>setInstallApproval(e.target.checked?token:"")}/>{t("我单独批准将此版本安装到当前账号工具库","I separately approve installing this version in the current account’s tool library")}</label>
            <button type="button" disabled={busy||uncertain||!client.installTool||installApproval!==token} onClick={()=>void act(t("安装审阅版本","installing the reviewed version"),async()=>{adopt(await client.installTool!(task.id,tool.versionId,{expectedRevision:task.revision,sourceHash:tool.sourceHash,consent:true}));if(client.installedTools)setInstalled(await client.installedTools());setInstallApproval("");})}>{t("安装已审阅的精确版本","Install exact reviewed version")}</button></>}
        </div>;})}</div>}
      {task.status!=="revoked"&&task.status!=="running"&&(task.facts.length>0||task.evidence.some(e=>e.kind==="user_statement"))&&<div className="ct-section"><h3>{t("长期事实 · 独立确认","Long-term facts · Separate confirmation")}</h3>
        <small>{t("本轮回答只服务当前任务。只有单独批准才写入长期本人陈述，不等于第三方已核验，也不改岗位简历。","This answer serves only the current task. A long-term user statement is written only after separate approval; it is not third-party verification and does not change the job-specific resume.")}</small>
        {task.facts.map(f=><div className="ct-diff" key={f.id}><p>{f.text}</p><Sources task={task} ids={f.evidenceIds}/>
          {pendingFacts.includes(f.id)?<><p>{t("历史指针显示本人陈述曾落盘；宿主回执","A history pointer shows that the user statement was saved; the Host receipt ")}{f.status==="rejected"?t("存在冲突，请人工核对","conflicts and needs manual review"):t("待核对","is awaiting verification")}{t("。",".")}</p>
            {f.status==="proposed"&&<button type="button" disabled={busy||!onReconcile} onClick={()=>void retryFact(f.id)}>{t("仅补写事实回执","Backfill fact receipt only")}</button>}</>:f.status==="proposed"?<div className="ct-actions"><button type="button" disabled={busy||uncertain||!onCommitFact||!sourceMatches} onClick={()=>void decideFact(f.id,true)}>{t("单独确认长期本人陈述","Confirm long-term user statement separately")}</button>
            <button type="button" disabled={busy||uncertain} onClick={()=>void decideFact(f.id,false)}>{t("不记入长期事实","Do not add to long-term facts")}</button>
            {onReconcile&&<button type="button" disabled={busy} onClick={()=>void retryFact(f.id)}>{t("查找已有陈述并补写事实回执","Find existing statement and backfill fact receipt")}</button>}</div>:<small>{f.status==="approved"?t("历史回执：本人已单独确认","Historical receipt: separately confirmed by the user"):t("已拒绝，不记入","Rejected and not recorded")}</small>}</div>)}
        {task.evidence.some(e=>e.kind==="user_statement")&&<details><summary>{t("从本人陈述准备新提案","Prepare a new proposal from user statements")}</summary>
          {task.evidence.filter(e=>e.kind==="user_statement").map(e=><label className="ct-check" key={e.id}><input type="checkbox" checked={factEvidence.includes(e.id)} onChange={v=>setFactEvidence(old=>v.target.checked?[...old,e.id]:old.filter(i=>i!==e.id))}/>{e.excerpt}</label>)}
          <label>{t("摘录本人明确说过的话","Extract the user’s exact words")}<textarea maxLength={4000} value={factText} onChange={e=>setFactText(e.target.value)}/></label>
          <button type="button" disabled={busy||uncertain||!factText.trim()||!task.evidence.some(e=>factEvidence.includes(e.id)&&e.kind==="user_statement"&&e.excerpt.includes(factText.trim()))} onClick={()=>void propose()}>{t("准备独立事实提案","Prepare separate fact proposal")}</button></details>}</div>}
      <div className="ct-section"><h3><BookOpen size={15} aria-hidden="true"/>{t("执行记录","Execution record")}</h3>{task.events.length?<Events items={task.events.slice(-8)}/>:<p>{t("尚无已记录的动作。","No actions have been recorded yet.")}</p>}
        {task.events.length>8&&<details><summary>{t(`更早的 ${task.events.length-8} 项动作`,`${task.events.length-8} earlier actions`)}</summary><Events items={task.events.slice(0,-8)}/></details>}
        {task.evidence.length>0&&<details><summary>{t(`已读取证据（${task.evidence.length}）`,`Evidence read (${task.evidence.length})`)}</summary><Sources task={task} ids={task.evidence.map(e=>e.id)}/></details>}</div>
    </>}
    {list.length>0&&<details className="ct-section"><summary>{t(`本工作区任务记录（${list.length}）`,`Workspace task records (${list.length})`)}</summary><ul className="ct-history">{list.map(item=><li key={item.id}><button type="button" disabled={busy||item.id===task?.id} onClick={()=>choose(item)}>{item.job.title} · {phase[item.status]} · <time dateTime={item.updatedAt}>{observedTime(item.updatedAt,locale,t)}</time></button></li>)}</ul></details>}
    {installed.length>0&&<details className="ct-section"><summary>{t(`当前账号工具库（${installed.length}）`,`Current account tool library (${installed.length})`)}</summary>{installed.map(tool=><div className="ct-diff" key={tool.versionId}><strong>{tool.label}</strong><code>{tool.versionId}</code><small>{t("撤销后，使用此版本的活动任务会暂停，不会暗中换版本。","After revocation, active tasks using this version pause and never switch versions silently.")}</small><button type="button" disabled={busy||!client.revokeTool} onClick={()=>void act(t("撤销工具版本","revoking the tool version"),async()=>{setInstalled(await client.revokeTool!(tool.versionId,{sourceHash:tool.sourceHash,consent:true}));setToolVersions(old=>old.filter(id=>id!==tool.versionId));if(task)adopt(await client.get(task.id));})}>{t("撤销此已安装版本","Revoke installed version")}</button></div>)}</details>}
  </section>;
}
