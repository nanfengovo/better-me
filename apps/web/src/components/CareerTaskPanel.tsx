import { useEffect, useRef, useState } from "react";
import type { LlmConfig } from "@better-me/core";
import {
  CAREER_TASK_DEFAULT_BUDGET, CareerTaskBudgetSchema, CareerTaskCreateSchema, careerRuntimeBinding,
  type CareerTask, type CareerTaskBudget, type CareerTaskInput, type CareerToolArtifact, type ResumeEditContext,
} from "@better-me/agent-contracts";
import { BookOpen, ShieldCheck } from "lucide-react";
import { z } from "zod";
import { captureIdentityLease, capturePrivateStorage, currentPrincipal } from "../lib/identity";
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
const phase: Record<CareerTask["status"],string>={ready:"等待启动",running:"正在执行",awaiting_answer:"等你补充",awaiting_review:"等待逐条审阅",
  paused:"已暂停",interrupted:"已中断，等待核对",budget_exhausted:"已达预算",failed:"本次执行失败",revoked:"授权已撤销",completed:"已收到版本回执"};
const kindText={job:"岗位原文",resume:"简历原句",user_statement:"本人陈述",source:"项目资料",design:"设计材料（非交付证明）"} as const;
const eventText:Record<CareerTask["events"][number]["kind"],string>={created:"建立约定",started:"开始执行",model:"模型调用",tool_call:"调用工具",tool_result:"工具结果",
  decision:"下一步",question:"请求补充",answer:"收到补充",draft:"草稿",stopped:"停止",budget:"预算",receipt:"保存回执",fact:"事实确认"};
const pendingReceiptSchema=z.object({draftHash:z.string().min(1),versionId:z.string().min(1),receiptId:z.string().min(1).optional(),approvedPatchIds:z.array(z.string()).min(1)});
type PendingReceipt=z.infer<typeof pendingReceiptSchema>;
function receiptMatches(saved:CareerTask["receipt"],pending:PendingReceipt){
  return !!saved && saved.versionId===pending.versionId && (!pending.receiptId || saved.receiptId===pending.receiptId)
    && saved.draftHash===pending.draftHash && JSON.stringify(saved.approvedPatchIds)===JSON.stringify(pending.approvedPatchIds);
}
function unresolved(state:"missing"|"edited"|"conflict",subject:string){
  if(state==="missing")return `当前工作区未找到${subject}；若曾保存，可能已移除或恢复到旧版。未创建或补写回执。`;
  if(state==="edited")return `曾保存的${subject}后来已编辑或替代；不能把现稿当作原审批内容。未覆盖或补写回执。`;
  return `工作区的${subject}与任务、批准清单或历史指针不一致。未覆盖或补写回执。`;
}
const fmt=(ms:number)=>`${Math.floor(ms/60_000)}分${Math.floor(ms/1000)%60}秒`;
const reason=(error:unknown)=>error instanceof Error ? error.message : "操作没有获得确认。请刷新当前状态。";
const keyOf=(workspaceKey:string)=>`career-task.v1:${encodeURIComponent(workspaceKey)}`;
type Material=CareerTaskInput["materials"][number];
const locText={local:"本机 Ollama 端点（后端部署未独立验证）",cloud:"云端推理",unknown:"推理位置未证实，可能发送云端"} as const;
const clock=new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
function observedTime(iso:string){const d=new Date(iso);return Number.isNaN(d.valueOf())?"时间未知":clock.format(d);}
function readJson(storage:Storage,key:string):unknown { try { return JSON.parse(storage.getItem(key)??"null"); } catch { return null; } }
function BudgetFields({value,onChange}:{value:CareerTaskBudget;onChange:(value:CareerTaskBudget)=>void}) {
  const fields=[["maxModelCalls","模型调用（次）",500,1],["maxToolCalls","资料读取（次）",2000,1],["maxActiveMs","主动运行（分钟）",1440,60_000]] as const;
  return <div className="ct-budget">{fields.map(([key,label,max,scale])=><label key={key}>{label}<input type="number" min={1} max={max} step={1}
    value={Number.isFinite(value[key])?value[key]/scale:""} onChange={event=>onChange({...value,[key]:event.target.valueAsNumber*scale})}/></label>)}</div>;
}
function useSelectedRuntime(config: LlmConfig|undefined) {
  const routing=useAgentRouting(), {agent,snapshot}=useBetterMeAgent();
  let runtime:UnderstandingRuntime|undefined, endpoint:string|undefined, preferred:string|undefined;
  if(routing?.blocked || routing?.error || routing?.busy || (agent && (!snapshot?.ready || snapshot.error))) return {error:"当前底座尚未核实，请在模型与工具中检查。"};
  if(routing?.enabled && routing.policy){
    if(routing.policy.mode!=="manual") return {error:"这项任务不接受自动切换模型。请在模型与工具中手动选定一个底座。"};
    // A generic routing ID is not necessarily an owner-isolated task adapter.
    // The host independently checks installation, isolation and the live authorization before dispatch.
    if(!["codex","claude-code","opencode","gemini-cli"].includes(routing.policy.preferred))return {error:"所选底座没有已识别的职业任务适配，不能发送资料，也不会改用其他通道。"};
    runtime={kind:"unified",expectedRevision:routing.policy.revision}; preferred=routing.policy.preferred;
  } else if(snapshot?.data.selection.kind==="chatgpt"){
    return {error:"此任务支持已配置的模型或手动选定的账号隔离 CLI。ChatGPT 套餐独立通道尚未接入；不会自动改用 API。"};
  } else if(config?.model.trim()&&config.baseUrl.trim()){
    try {
      const url=new URL(config.baseUrl);
      const loopback=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
      if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:" || (url.protocol==="http:" && loopback))) throw Error();
      if(!loopback && config.provider!=="ollama" && !config.apiKey?.trim()) return {error:"所选云端模型尚未配置凭据；未尝试其他通道。"};
      endpoint=url.origin+url.pathname; runtime=understandingModelRuntime(config);
    } catch { return {error:"模型端点无法安全辨认，未启用任务。"}; }
  } else return {error:"没有明确选择可用的模型；不会自动改用付费服务。"};
  return {runtime,binding:careerRuntimeBinding(runtime,preferred),endpoint,error:undefined};
}
function Sources({task,ids}:{task:CareerTask;ids:string[]}) {
  return <ul className="ct-sources">{ids.map(id=>{const item=task.evidence.find(source=>source.id===id);
    return <li key={id}>{item ? <><strong>{kindText[item.kind]} · {item.label}</strong>{item.path && <small>{item.path}{item.startLine ? ` · ${item.startLine}–${item.endLine??item.startLine} 行`:""}</small>}
      <blockquote>{item.excerpt}</blockquote></> : <span>未取得引用：{id}</span>}</li>;})}</ul>;
}
function Events({items}:{items:CareerTask["events"]}){
  return <ol className="ct-events">{items.map(e=><li key={e.sequence}><strong>{eventText[e.kind]}</strong> {e.detail} <time dateTime={e.at}>{observedTime(e.at)}</time></li>)}</ol>;
}
export default function CareerTaskPanel(props:CareerTaskPanelProps) {
  return <TaskSession key={JSON.stringify([currentPrincipal()?.id,props.workspaceKey])} {...props}/>;
}
export { CareerTaskPanel };
function TaskSession({workspaceKey,job,resumeFields,sourceResumeId,sourceResumeName,sourceFingerprint,llmConfig,onSave,onCommitFact,onReconcile,initialObjective,initialFocus,
  client=defaultCareerTaskClient,pollIntervalMs=1500,onTaskChange}:CareerTaskPanelProps) {
  const {agent}=useBetterMeAgent();
  const rootScopeKey=agent?.workspaceKey??workspaceKey;
  const [sharedRoot,setSharedRoot]=useState<Awaited<ReturnType<NonNullable<CareerTaskClient["root"]>>>>();
  const [scope]=useState(()=>({lease:captureIdentityLease(),storage:capturePrivateStorage(),key:keyOf(workspaceKey)}));
  const model=useSelectedRuntime(llmConfig);
  const [list,setList]=useState<CareerTask[]>([]),[task,setTask]=useState<CareerTask>(),[loading,setLoading]=useState(true);
  const [working,setWorking]=useState(""),[error,setError]=useState(""),[uncertain,setUncertain]=useState(false),[notice,setNotice]=useState("");
  const [objective,setObjective]=useState(initialObjective?.trim()||"核对岗位要求与我的经历，生成逐条有依据的定制简历草稿，列出仍缺少的事实。");
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
    try { if(value===undefined)scope.storage.removeItem(key);else scope.storage.setItem(key,value);return true; } catch {if(alive.current)setNotice("浏览器记录未保存；可在本账号的宿主任务列表中找回。");return false;}}
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
    if(disputed)setError("工作区与宿主记录了不同的版本回执。不能标为本次保存成功，请人工核对。");
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
  useEffect(()=>{alive.current=true;const get=new AbortController();void loadRef.current(get.signal).catch(e=>{if(!get.signal.aborted){setError(reason(e));setUncertain(true);}}).finally(()=>{if(!get.signal.aborted)setLoading(false);});
    return ()=>{alive.current=false;get.abort();};},[scope,client]);
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
      id:`writing-focus-${focus.id}`,label:`旁写本人补充 · ${focus.label}`.slice(0,300),kind:"user_statement",text:focus.userStatement!.trim(),
    }]);
  },[focusSignature,focusFieldId,loading,focus]);
  useEffect(()=>{setConsent("");},[llmConfig?.apiKey,selectedRuntime]);
  useEffect(()=>{if(!client.installedTools||!scope.lease.ownerId)return;const ctrl=new AbortController();
    void client.installedTools(ctrl.signal).then(items=>{if(!ctrl.signal.aborted){scope.lease.assert();setInstalled(items);}}).catch(e=>{if(!ctrl.signal.aborted)setNotice(`工具库未载入，未授权任何已安装工具。${reason(e)}`);});
    return ()=>ctrl.abort();},[client,scope]);
  const observedId=task?.id, observedStatus=task?.status;
  useEffect(()=>{
    if(!observedId || observedStatus!=="running")return;
    const id=observedId, ctrl=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{try{const next=await client.get(id,ctrl.signal);if(!ctrl.signal.aborted && taskRef.current?.id===id)adoptRef.current(next);}
      catch(e){if(!ctrl.signal.aborted){setError(reason(e));setUncertain(true);}}finally{if(!ctrl.signal.aborted)timer=setTimeout(tick,pollIntervalMs);}};
    timer=setTimeout(tick,pollIntervalMs);return ()=>{clearTimeout(timer);ctrl.abort();};
  },[observedId,observedStatus,client,pollIntervalMs]); // restarting the view never restarts a task
  async function act(label:string, action:()=>Promise<void>, mutates=true){
    if(lock.current)return;lock.current=true;setWorking(label);setError("");setNotice("");
    try {scope.lease.assert();await action();}
    catch(e){if(alive.current){setError(reason(e));if(mutates)setUncertain(true);}}
    finally{lock.current=false;if(alive.current)setWorking("");}
  }
  const viewRead=useRef<AbortController | undefined>(undefined);
  useEffect(()=>()=>viewRead.current?.abort(),[]);
  const refresh=()=>act("刷新",async()=>{const ctrl=new AbortController();viewRead.current?.abort();viewRead.current=ctrl;
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
  const execute=()=>act("提交",async()=>{
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
  const save=()=>act("保存",async()=>{
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
  const retryReceipt=()=>act("核对回执",async()=>{
    if(!task||!onReconcile)throw Error("工作区未提供只读核对能力，未补写回执。");
    const ctrl=new AbortController();viewRead.current?.abort();viewRead.current=ctrl;
    const next=await client.get(task.id,ctrl.signal);ctrl.signal.throwIfAborted();checkOwned(next);
    const observed=await onReconcile(next,{kind:"resume",hint:pending??next.receipt});scope.lease.assert();if(!alive.current)return;
    if(observed.state!=="current"){setNotice(unresolved(observed.state,"岗位版本"));return;}
    const record=observed.receipt;
    if(!record || next.draft?.hash!==record.draftHash)throw Error("未核对到同一份草稿的真实版本回执。");
    if(next.receipt){
      if(!receiptMatches(next.receipt,record))throw Error("宿主历史回执与工作区不一致，未采用。");
      adopt(next);setNotice("已核对：工作区仍有该审批版本。未重复保存或发送回执。");return;
    }
    if(next.status!=="awaiting_review")throw Error("任务状态已变化，不能补写回执。");
    const body:CareerReceiptInput={...record,expectedRevision:next.revision};
    const res=await client.receipt(task.id,body);if(!receiptMatches(res.receipt,record)||res.status!=="completed")throw Error("回执仍未核对成功，未重复写入版本。");adopt(res);
  });
  const propose=()=>act("准备事实提案",async()=>{
    if(!task||!factText.trim()||!factEvidence.length)return;
    const before=await fresh(task);
    if(!before.evidence.some(e=>factEvidence.includes(e.id)&&e.kind==="user_statement"&&e.excerpt.includes(factText.trim())))throw Error("只能从勾选的本人陈述中摘录原句。");
    adopt(await client.proposeFact(task.id,{expectedRevision:before.revision,text:factText.trim(),evidenceIds:factEvidence}));setFactText("");setFactEvidence([]);
  });
  const decideFact=(id:string,approve:boolean)=>act("核对事实",async()=>{
    if(!task || task.status==="revoked" || uncertain)return;
    const before=await fresh(task), fact=before.facts.find(f=>f.id===id&&f.status==="proposed");
    if(!fact)throw Error("该长期事实提案已变化，未更改。");
    if(readFacts(task.id).includes(fact.id))throw Error("工作区已经保存此陈述，请只补写回执。");
    if(onReconcile){
      const observed=await onReconcile(before,{kind:"fact",factId:id});scope.lease.assert();if(!alive.current)return;
      if(observed.state==="current"){setNotice("工作区已有此本人陈述，不重复写入或拒绝；请核对并补写事实回执。");return;}
      if(observed.state!=="missing"){setNotice(unresolved(observed.state,"本人陈述"));return;}
    }
    if(approve){if(!onCommitFact || !sourceMatches || !alive.current)throw Error("工作区没有确认写入本账号事实记录，未批准。");
      await onCommitFact(before,fact);scope.lease.assert();writeFacts(task.id,[...readFacts(task.id),fact.id]);}
    adopt(await client.fact(task.id,fact.id,approve?"approve":"reject",{expectedRevision:before.revision}));
  });
  const retryFact=(id:string)=>act("补写事实回执",async()=>{
    if(!task||!onReconcile)throw Error("工作区未提供只读核对能力，未补写事实回执。");
    const ctrl=new AbortController();viewRead.current?.abort();viewRead.current=ctrl;
    const next=await client.get(task.id,ctrl.signal);ctrl.signal.throwIfAborted();checkOwned(next);const fact=next.facts.find(f=>f.id===id);
    const observed=await onReconcile(next,{kind:"fact",factId:id});scope.lease.assert();if(!alive.current)return;
    if(observed.state!=="current"){setNotice(unresolved(observed.state,"本人陈述"));return;}
    if(fact?.status==="approved"){adopt(next);setNotice("已核对：长期记录仍有该本人陈述。");return;}
    if(fact?.status!=="proposed"||next.status==="revoked")throw Error("当前工作区有此本人陈述，但宿主提案不同或已撤销；请人工核对。");
    const recorded=await client.fact(task.id,id,"approve",{expectedRevision:next.revision});if(!recorded.facts.some(f=>f.id===id&&f.status==="approved"))throw Error("事实回执尚未确认。");adopt(recorded);
  });
  const consentBox=<label className="ct-check"><input type="checkbox" checked={consent===scopeToken} disabled={busy || !model.binding} onChange={e=>setConsent(e.target.checked?scopeToken:"")}/>
    <span>允许本任务将以上资料用于所选模型{model.binding?.location!=="local"?"（包括可能的云端处理）":""}，在所列预算内运行。不授权投递或修改原稿。</span></label>;
  return <section className="career-task-panel" aria-label="职业任务" aria-busy={busy}>
    <header className="ct-header"><div><span className="ct-kicker"><ShieldCheck size={15} aria-hidden="true"/>职业任务</span><h2>{task?task.job.title:"为所选岗位准备简历"}</h2></div>
      <button type="button" disabled={busy} onClick={()=>void refresh()}>刷新状态</button></header>
    {error&&<p role="alert" className="ct-alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {working&&<p role="status">正在{working}，等待确认…</p>}
    {loading&&<p role="status">正在读取本账号的任务记录…</p>}
    {focus&&<section className="ct-section" aria-label="当前经历交接"><h3>{historicalFocus?"任务原句（历史）":"当前经历"} · {focus.label}</h3>
      {focusInvalid&&!historicalFocus?<p role="alert">旁写原稿已变化或不属于当前简历，未替换字段、发送补充或启动任务。请回到原文重新选择。</p>:<>
        <blockquote>{focus.originalText}</blockquote>{focus.userStatement&&<p>{statementInTask?"已收到的本人陈述":"待授权的本人陈述"}：{focus.userStatement}</p>}
        {historicalFocus&&<p>保留已完成任务当时的原句；当前新版本不继承旧任务的读取或执行许可。</p>}
        {task?<p>仍是同一任务 {task.id}；目标、证据、预算和审阅保持不变。{focusInTask?"此字段已在任务范围内。":"此字段尚不在当前任务授权内，未扩大范围。"}{focus.userStatement?(statementInTask?"补充已列入本任务，实际取证请看来源记录；不自动写入事实库。":"新补充尚未发送，也未写入事实库。"):"此次只定位，不增加资料或调用。"}</p>:<p>只预选这一字段；本人补充作为单独来源列在材料中。核对岗位、模型和资料后授权启动，草稿逐条审阅后另存岗位版，不修改原稿或共享 FactBase。</p>}
        {task?.status==="awaiting_answer"&&focusInTask&&!statementInTask&&focus.userStatement&&<button type="button" disabled={busy} onClick={()=>{setAnswer(focus.userStatement!);setConsent("");}}>将这段补充放入本任务回答框（暂不发送）</button>}
      </>}
      <button type="button" onClick={()=>{setIgnoredFocus(focus.id);setConsent("");}}>关闭本次经历定位</button>
    </section>}
    {!task && <><div className="ct-section"><h3>任务约定</h3><label>交付目标<textarea value={objective} onChange={e=>setObjective(e.target.value)} maxLength={12000}/></label>
      {job?.description?.trim()?<details><summary>岗位快照 · {job.title} {job.company}</summary><blockquote>{job.description}</blockquote></details>:<p>请先选择带岗位原文的职位。</p>}
      <fieldset><legend>允许读取的简历字段 · {sourceResumeName??"尚未选择简历"}</legend>
        {fields.map(field=><label className="ct-check" key={field.id}><input type="checkbox" checked={selected.includes(field.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,field.id]:old.filter(v=>v!==field.id))}/><span><strong>{field.label}</strong>{field.text}</span></label>)}
        {!fields.length&&<p>没有可选择的非联系资料字段。</p>}</fieldset>
      <details><summary>可选项目资料与只读目录</summary>
        {materials.map(material=><fieldset key={material.id}><legend>项目材料</legend><label>材料名称<input maxLength={300} value={material.label} onChange={e=>setMaterials(old=>old.map(m=>m.id===material.id?{...m,label:e.target.value}:m))}/></label>
          <label>来源类型<select value={material.kind} onChange={e=>setMaterials(old=>old.map(m=>m.id===material.id?{...m,kind:e.target.value as Material["kind"]}:m))}>{(["source","design","user_statement"] as const).map(kind=><option key={kind} value={kind}>{kindText[kind]}</option>)}</select></label>
          <label>材料内容<textarea maxLength={64000} value={material.text} onChange={e=>setMaterials(old=>old.map(m=>m.id===material.id?{...m,text:e.target.value}:m))}/></label>
          <button type="button" onClick={()=>setMaterials(old=>old.filter(m=>m.id!==material.id))}>移除材料</button></fieldset>)}
        <button type="button" disabled={materials.length>=40} onClick={()=>setMaterials(old=>[...old,{id:`material-${crypto.randomUUID()}`,label:"",text:"",kind:"source"}])}>添加项目材料</button>
        <label>授权的项目目录（可不填，每行一个完整路径）<textarea value={directoryLines} onChange={e=>setDirectoryLines(e.target.value)}/></label>
        <small>只允许读取这些目录中的受支持资料；相关摘录可能会随任务进入所选模型。</small>
      </details></div>
      <div className="ct-section"><h3>执行与预算</h3><p>{model.binding?<><strong>{model.binding.label}</strong> · {locText[model.binding.location]}{model.endpoint&&<> · <code>{model.endpoint}</code></>}</>:model.error}</p>
        {model.binding?.location==="local"&&<small>按你配置的回环地址识别；如果该端点代理到远程服务，资料仍可能离开本机。</small>}
        {sharedRoot?<p>继承工作区根上限：模型 {sharedRoot.budget.maxModelCalls} 次 · 读取 {sharedRoot.budget.maxToolCalls} 次 · 主动 {fmt(sharedRoot.budget.maxActiveMs)}。累计用量和调额见“共识与进度 → 工作区共享额度”，不另领预算。</p>:<BudgetFields value={budget} onChange={setBudget}/>}<small>额度限制宿主发起的模型与读取次数，以及主动运行时间，等待回答不计时。CLI 内部步骤、重试和 token 用量不一定可见；费用未知，这不是账单上限。</small>
        <details><summary>沙箱工具 · 默认不构建、不借用已安装版本</summary>
          <label className="ct-check"><input type="checkbox" checked={allowBuild} onChange={e=>setAllowBuild(e.target.checked)}/>允许在本任务内构建纯 JSON 工具</label>
          <small>当前只支持材料逐行整理。使用同一底座和任务预算，最多 3 次构建、8 次调用；宿主固定测试与实际输入校验不可修改。无文件、网络、Shell 或凭据权限。通过仅代表此有限契约，不证明事实真实。</small>
          {installed.map(tool=><label className="ct-check" key={tool.versionId}><input type="checkbox" checked={toolVersions.includes(tool.versionId)} onChange={e=>setToolVersions(old=>e.target.checked?[...old,tool.versionId]:old.filter(id=>id!==tool.versionId))}/><span>允许本任务调用：{tool.label}<code>{tool.versionId}</code></span></label>)}
          {!installed.length&&<p>当前账号没有可选择的已安装版本。</p>}
        </details>
        <button type="button" disabled={busy || !validBudget || !scope.lease.ownerId} onClick={()=>{if(persist("career-task.v1:budget",JSON.stringify(budget)))setNotice("预算已设为本账号默认值；未授权任何模型请求。");}}>设为本账号默认预算</button>
        {consentBox}<button className="ct-primary" type="button" disabled={busy || !allowed || !validSetup} onClick={()=>void execute()}>授权并启动任务</button></div></>}
    {task&&<><div className="ct-section">
      <div className="ct-status" role="status"><strong>{pending&&task.receipt&&!receiptMatches(task.receipt,pending)?"两端回执冲突":phase[task.status]}</strong><span>根账累计 · 模型 {(task.rootLedger?.usage??task.usage).modelCalls}/{task.budget.maxModelCalls} 次 · 读取 {(task.rootLedger?.usage??task.usage).toolCalls}/{task.budget.maxToolCalls} 次 · 主动 {fmt((task.rootLedger?.usage??task.usage).activeMs)}/{fmt(task.budget.maxActiveMs)}</span></div>
      <p>{task.objective}</p><p>绑定底座：<strong>{task.runtimeBinding.label}</strong> · {locText[task.runtimeBinding.location]}。费用未知；宿主调用数不等于 CLI 内部用量或账单。</p>
      <small>工具约定：{task.toolPolicy?.allowBuild?"允许受限构建":"不允许构建"} · 明确授权已安装版本 {task.toolPolicy?.installedVersionIds.length??0} 个。生成与修复、测试及实际调用共用上述预算。</small>
      {task.error&&<p className="ct-alert">{task.error}</p>}
      {task.status==="revoked"&&pendingFacts.length>0&&<p className="ct-alert">工作区已保存过 {pendingFacts.length} 条本人陈述，但宿主回执尚未核对。撤销只停止后续运行，不会删除先前保存的内容。</p>}
      <details><summary>已授权资料 · {task.resume.name} · {task.resume.fields.length} 个字段</summary>
        <p>{task.job.title} · {task.job.company}</p><blockquote>{task.job.description}</blockquote>{task.resume.fields.map(f=><blockquote key={f.id}>{f.originalText}</blockquote>)}
        {task.materials.map(m=><div key={m.id}><strong>{kindText[m.kind]} · {m.label}</strong><blockquote>{m.text}</blockquote></div>)}{task.directories.map(d=><p key={d.id}>只读目录：{d.label}</p>)}</details>
      <div className="ct-actions">{task.status==="running"&&<button type="button" disabled={busy} onClick={()=>void act("暂停",async()=>adopt(await client.control(task.id,"pause",{expectedRevision:task.revision})))}>暂停任务</button>}
        {!["revoked","completed"].includes(task.status)&&<button type="button" disabled={busy} onClick={()=>void act("撤销",async()=>adopt(await client.control(task.id,"revoke",{expectedRevision:task.revision})))}>撤销本任务授权</button>}
        <button type="button" disabled={busy} onClick={reset}>打开新任务配置</button></div></div>
      {["ready","paused","interrupted","awaiting_answer","failed","budget_exhausted"].includes(task.status)&&<div className="ct-section">
        <h3>{task.status==="awaiting_answer"?"待回答的问题":"核对后继续"}</h3>
        {task.status==="awaiting_answer"&&<><p>{task.question}</p><Sources task={task} ids={task.questionEvidenceIds??[]}/>
          <label>只用于这项任务的回答<textarea value={answer} maxLength={12000} onChange={e=>setAnswer(e.target.value)}/></label><small>回答不会自动更新长期事实记录。</small></>}
        {!sourceMatches&&<p className="ct-alert">当前岗位或简历原稿已变化。请切回相同来源，或新建任务。</p>}
        {(!runtimeMatches||model.error)&&<p className="ct-alert">{model.error??"当前选中的模型与任务绑定的底座不同；未自动切换。"}</p>}
        {model.runtime&&model.binding&&<p>本次接收资料：{model.binding.label} · {locText[model.binding.location]}{model.endpoint&&<> · <code>{model.endpoint}</code></>}</p>}
        {consentBox}<button className="ct-primary" type="button" disabled={busy||!allowed||!sourceMatches||(task.rootLedger?.usage??task.usage).modelCalls>=task.budget.maxModelCalls||(task.rootLedger?.usage??task.usage).activeMs>=task.budget.maxActiveMs||(task.status==="awaiting_answer"&&!answer.trim())} onClick={()=>void execute()}>
          {task.status==="awaiting_answer"?"确认回答并继续":"确认资料与底座并继续"}</button></div>}
      {task.parentTaskId?<p>本任务继承根额度；请在“共识与进度 → 工作区共享额度”核对或调整整组上限。</p>:["paused","budget_exhausted","interrupted","ready","awaiting_answer","failed"].includes(task.status)&&<details className="ct-section"><summary>调整预算上限</summary><BudgetFields value={budget} onChange={setBudget}/>
        <label className="ct-check"><input type="checkbox" checked={budgetConsent===budgetToken} onChange={e=>setBudgetConsent(e.target.checked?budgetToken:"")}/>我确认增加此任务额度；费用未知，此操作不会启动模型。</label>
        <button type="button" disabled={busy||uncertain||!increased||budgetConsent!==budgetToken} onClick={()=>void act("增加额度",async()=>adopt(await client.budget(task.id,{expectedRevision:task.revision,budget,consent:true})))}>确认增加预算</button></details>}
      {task.draft && <div className="ct-section"><h3>定制版本 · 逐条审阅</h3>
        {task.draft.unknowns.length>0&&<div><strong>仍待核实</strong><ul>{task.draft.unknowns.map((v,i)=><li key={i}>{v}</li>)}</ul></div>}
        {!task.draft.patches.length&&<p>没有可批准的改写，未生成简历版本。可以补齐材料后发起新任务。</p>}
        {task.draft.patches.map((patch,i)=>{
          const supported=patch.evidenceIds.length>0&&patch.evidenceIds.every(id=>task.evidence.some(e=>e.id===id));
          return <div className="ct-diff" key={patch.id}><strong>第 {i+1} 条 · {patch.rationale}</strong><p>原文：{patch.originalText}</p><p>建议：{patch.proposedText}</p>
            <details><summary>依据（{patch.evidenceIds.length}）</summary><Sources task={task} ids={patch.evidenceIds}/>
              {patch.sentences?.map((s,n)=><p key={n}>{s.text} · {s.evidenceIds.join("、")}</p>)}</details>
            {task.status==="awaiting_review"&&<label className="ct-check"><input type="checkbox" disabled={busy||!!pending||!supported} checked={checked.includes(patch.id)}
              onChange={e=>setChecked(old=>e.target.checked?[...old,patch.id]:old.filter(v=>v!==patch.id))}/>批准第 {i+1} 条</label>}</div>;})}
        {task.status==="awaiting_review"&&!sourceMatches&&<p className="ct-alert">原稿或岗位已变化；不可用旧草稿保存，请重新比较。</p>}
        {pending?<><p role="status">工作区曾返回版本 {pending.versionId}，宿主回执待核对，不代表当前仍存在。不会重复创建。</p>
          <button type="button" disabled={busy||!onReconcile} onClick={()=>void retryReceipt()}>仅核对并补写回执</button></>:
          task.status==="awaiting_review"&&<button className="ct-primary" type="button" disabled={busy||uncertain||!onSave||!sourceMatches||!checked.length} onClick={()=>void save()}>保存已批准的 {checked.length} 条为独立版本</button>}
        {!pending&&onReconcile&&task.status==="awaiting_review"&&<button type="button" disabled={busy} onClick={()=>void retryReceipt()}>查找已保存版本并补写回执（不创建）</button>}
        {task.receipt&&!pending&&<div role="status"><strong>历史回执 · 已保存独立版本：{task.receipt.versionId}</strong> · 当时批准 {task.receipt.approvedPatchIds.length} 条；不证明当前版本未被编辑或移除。
          {onReconcile&&<button type="button" disabled={busy} onClick={()=>void retryReceipt()}>只核对当前工作区版本</button>}
          <details><summary>查看保存回执</summary>{task.receipt.receiptId&&<p>工作区回执：<code>{task.receipt.receiptId}</code></p>}
            <p>草稿指纹：<code>{task.receipt.draftHash}</code></p><p>记录时间：<time dateTime={task.receipt.at}>{observedTime(task.receipt.at)}</time></p></details></div>}</div>}
      {!!task.tools?.length&&<div className="ct-section"><h3>本任务构建的工具 · 独立安装审批</h3><small>通过测试后可在本任务临时使用；采纳简历不会顺带安装工具。以后任务仍需勾选具体版本。</small>
        {task.tools.map(tool=>{const token=JSON.stringify([task.id,task.revision,tool.versionId,tool.sourceHash]),isInstalled=installed.some(t=>t.versionId===tool.versionId);return <div className="ct-diff" key={tool.versionId}>
          <strong>{tool.label} · {isInstalled?"本账号已安装":"仅当前任务可用"}</strong><code>{tool.versionId}</code><p>{tool.profile} · 固定测试 {tool.testsPassed}/{tool.testsTotal}</p>
          <details><summary>审阅代码与指纹</summary><code>{tool.sourceHash}</code><pre className="ct-tool-source">{tool.source}</pre></details>
          {!isInstalled&&["awaiting_review","paused","completed"].includes(task.status)&&<><label className="ct-check"><input type="checkbox" checked={installApproval===token} onChange={e=>setInstallApproval(e.target.checked?token:"")}/>我单独批准将此版本安装到当前账号工具库</label>
            <button type="button" disabled={busy||uncertain||!client.installTool||installApproval!==token} onClick={()=>void act("安装审阅版本",async()=>{adopt(await client.installTool!(task.id,tool.versionId,{expectedRevision:task.revision,sourceHash:tool.sourceHash,consent:true}));if(client.installedTools)setInstalled(await client.installedTools());setInstallApproval("");})}>安装已审阅的精确版本</button></>}
        </div>;})}</div>}
      {task.status!=="revoked"&&task.status!=="running"&&(task.facts.length>0||task.evidence.some(e=>e.kind==="user_statement"))&&<div className="ct-section"><h3>长期事实 · 独立确认</h3>
        <small>本轮回答只服务当前任务。只有单独批准才写入长期本人陈述，不等于第三方已核验，也不改岗位简历。</small>
        {task.facts.map(f=><div className="ct-diff" key={f.id}><p>{f.text}</p><Sources task={task} ids={f.evidenceIds}/>
          {pendingFacts.includes(f.id)?<><p>历史指针显示本人陈述曾落盘；宿主回执{f.status==="rejected"?"存在冲突，请人工核对":"待核对"}。</p>
            {f.status==="proposed"&&<button type="button" disabled={busy||!onReconcile} onClick={()=>void retryFact(f.id)}>仅补写事实回执</button>}</>:f.status==="proposed"?<div className="ct-actions"><button type="button" disabled={busy||uncertain||!onCommitFact||!sourceMatches} onClick={()=>void decideFact(f.id,true)}>单独确认长期本人陈述</button>
            <button type="button" disabled={busy||uncertain} onClick={()=>void decideFact(f.id,false)}>不记入长期事实</button>
            {onReconcile&&<button type="button" disabled={busy} onClick={()=>void retryFact(f.id)}>查找已有陈述并补写事实回执</button>}</div>:<small>{f.status==="approved"?"历史回执：本人已单独确认":"已拒绝，不记入"}</small>}</div>)}
        {task.evidence.some(e=>e.kind==="user_statement")&&<details><summary>从本人陈述准备新提案</summary>
          {task.evidence.filter(e=>e.kind==="user_statement").map(e=><label className="ct-check" key={e.id}><input type="checkbox" checked={factEvidence.includes(e.id)} onChange={v=>setFactEvidence(old=>v.target.checked?[...old,e.id]:old.filter(i=>i!==e.id))}/>{e.excerpt}</label>)}
          <label>摘录本人明确说过的话<textarea maxLength={4000} value={factText} onChange={e=>setFactText(e.target.value)}/></label>
          <button type="button" disabled={busy||uncertain||!factText.trim()||!task.evidence.some(e=>factEvidence.includes(e.id)&&e.kind==="user_statement"&&e.excerpt.includes(factText.trim()))} onClick={()=>void propose()}>准备独立事实提案</button></details>}</div>}
      <div className="ct-section"><h3><BookOpen size={15} aria-hidden="true"/>执行记录</h3>{task.events.length?<Events items={task.events.slice(-8)}/>:<p>尚无已记录的动作。</p>}
        {task.events.length>8&&<details><summary>更早的 {task.events.length-8} 项动作</summary><Events items={task.events.slice(0,-8)}/></details>}
        {task.evidence.length>0&&<details><summary>已读取证据（{task.evidence.length}）</summary><Sources task={task} ids={task.evidence.map(e=>e.id)}/></details>}</div>
    </>}
    {list.length>0&&<details className="ct-section"><summary>本工作区任务记录（{list.length}）</summary><ul className="ct-history">{list.map(item=><li key={item.id}><button type="button" disabled={busy||item.id===task?.id} onClick={()=>choose(item)}>{item.job.title} · {phase[item.status]} · <time dateTime={item.updatedAt}>{observedTime(item.updatedAt)}</time></button></li>)}</ul></details>}
    {installed.length>0&&<details className="ct-section"><summary>当前账号工具库（{installed.length}）</summary>{installed.map(tool=><div className="ct-diff" key={tool.versionId}><strong>{tool.label}</strong><code>{tool.versionId}</code><small>撤销后，使用此版本的活动任务会暂停，不会暗中换版本。</small><button type="button" disabled={busy||!client.revokeTool} onClick={()=>void act("撤销工具版本",async()=>{setInstalled(await client.revokeTool!(tool.versionId,{sourceHash:tool.sourceHash,consent:true}));setToolVersions(old=>old.filter(id=>id!==tool.versionId));if(task)adopt(await client.get(task.id));})}>撤销此已安装版本</button></div>)}</details>}
  </section>;
}
