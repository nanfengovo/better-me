import {useEffect,useRef,useState} from "react";
import {CareerTaskBudgetSchema,type CareerTaskBudget} from "@better-me/agent-contracts";
import {defaultTaskLedgerClient} from "../services/agent-task-scope";
import {captureIdentityLease,currentPrincipal} from "../lib/identity";
import {TaskOutputArtifacts} from "./TaskOutputArtifacts";
import {LegacyTaskScopeAssociation} from "./LegacyTaskScopeAssociation";
import {useUiPreferences} from "../lib/ui-preferences";

type Ledger=NonNullable<Awaited<ReturnType<typeof defaultTaskLedgerClient.read>>>;
const fields=[["maxModelCalls",["模型调用","Model calls"],1,500],["maxToolCalls",["工具读取","Tool reads"],1,2000],["maxActiveMs",["主动运行（分钟）","Active runtime (minutes)"],60000,1440]] as const;
export function AgentTaskLedger({rootScopeKey,client=defaultTaskLedgerClient}:{rootScopeKey:string;client?:typeof defaultTaskLedgerClient}){
  const {t}=useUiPreferences();
  const [ledger,setLedger]=useState<Ledger>(),[budget,setBudget]=useState<CareerTaskBudget>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[confirmed,setConfirmed]=useState("");
  const alive=useRef(true),lock=useRef(false),generation=useRef(0);
  const [lease]=useState(captureIdentityLease),[invalid,setInvalid]=useState(false);
  const apply=(next:Ledger|undefined)=>{setLedger(next);setBudget(next?.root.budget);setConfirmed("");};
  useEffect(()=>{alive.current=true;const epoch=++generation.current,ctrl=new AbortController();setLoading(true);setBusy(false);setError("");apply(undefined);
    const invalidate=()=>{alive.current=false;ctrl.abort();apply(undefined);setLoading(false);setBusy(false);setInvalid(true);setError(t("账号状态已变化，请重新核对共享额度。","Session changed. Sign in again or refresh to verify the shared budget."));};
    lease.signal.addEventListener("abort",invalidate,{once:true});if(lease.signal.aborted)invalidate();
    if(!currentPrincipal()||lease.signal.aborted){setLoading(false);return ()=>{alive.current=false;generation.current=epoch+1;ctrl.abort();lease.signal.removeEventListener("abort",invalidate);};}
    void client.read(rootScopeKey,ctrl.signal).then(value=>{if(!ctrl.signal.aborted)apply(value);}).catch(failure=>{if(!ctrl.signal.aborted)setError(failure instanceof Error?failure.message:t("根账尚未核实。","Root ledger has not been verified."))}).finally(()=>{if(!ctrl.signal.aborted)setLoading(false);});
    return ()=>{alive.current=false;generation.current=epoch+1;ctrl.abort();lease.signal.removeEventListener("abort",invalidate);};
  },[client,rootScopeKey,lease,t]);
  async function act(work:()=>Promise<unknown>){if(lock.current)return;const epoch=generation.current,isCurrent=()=>alive.current&&generation.current===epoch;lock.current=true;setBusy(true);setError("");setConfirmed("");
    try{lease.assert();await work();lease.assert();if(!isCurrent())return;const next=await client.read(rootScopeKey);lease.assert();if(isCurrent())apply(next);}catch(failure){if(isCurrent())setError(failure instanceof Error?failure.message:t("根账操作尚未确认，请刷新核对；没有重试模型。","Root-ledger operation is not confirmed. Refresh to verify it; the model was not retried."));}finally{lock.current=false;if(isCurrent())setBusy(false);}}
  const root=ledger?.root,totals=root?.rootLedger,valid=CareerTaskBudgetSchema.safeParse(budget),token=JSON.stringify([root?.id,root?.revision,budget]),running=ledger?.members.some(task=>task.status==="running");
  const changed=!!root&&!!budget&&JSON.stringify(budget)!==JSON.stringify(root.budget);
  const outputTasks=ledger?.members.filter(task=>"outputArtifacts"in task&&task.outputArtifacts?.length)??[];
  return <details className="agent-task-ledger"><summary>{t("工作区共享额度","Shared workspace budget")}{totals?t(` · 模型 ${totals.usage.modelCalls}/${totals.budget.maxModelCalls}`,` · Model ${totals.usage.modelCalls}/${totals.budget.maxModelCalls}`):""}{outputTasks.length?t(` · 原始输出 ${outputTasks.length} 项任务`,` · Raw output from ${outputTasks.length} tasks`):""}</summary>
    {error&&<p role="alert">{error}</p>}
    {loading?<p role="status">{t("正在核对根账…","Verifying root ledger…")}</p>:!root?(error||invalid?null:<p>{t("尚未建立共享根账。首次明确发送时建立，不自动认领旧记录或重发请求。","No shared root ledger exists yet. It is created on the first explicit send; legacy records are not claimed and requests are not resent automatically.")}</p>):<>
      <p role="status">{t(`${totals?.memberCount??ledger!.members.length} 项任务 · 模型 ${totals?.usage.modelCalls??root.usage.modelCalls}/${root.budget.maxModelCalls} 次 · 读取 ${totals?.usage.toolCalls??root.usage.toolCalls}/${root.budget.maxToolCalls} 次 · 主动 ${Math.ceil((totals?.usage.activeMs??root.usage.activeMs)/1000)} 秒`,`${totals?.memberCount??ledger!.members.length} tasks · Model ${totals?.usage.modelCalls??root.usage.modelCalls}/${root.budget.maxModelCalls} · Reads ${totals?.usage.toolCalls??root.usage.toolCalls}/${root.budget.maxToolCalls} · Active ${Math.ceil((totals?.usage.activeMs??root.usage.activeMs)/1000)} seconds`)}</p>
      <p><strong>{t("此工作区已绑定的模型：","Model bound to this workspace: ")}{root.runtimeBinding.label}</strong><br/>{t("保存其他 API 配置或停止任务都不会更换这个模型。资料仍需逐次授权。","Saving other API settings or stopping a task does not change this model. Sharing materials still requires your permission each time.")}</p>
      {outputTasks.map(task=><div key={task.id}><p>{task.objective} · {task.status}</p><TaskOutputArtifacts task={task}/></div>)}
      <div className="agent-task-ledger-fields">{fields.map(([key,label,scale,max])=><label key={key}>{t(label[0],label[1])}<input type="number" min={1} max={max} step={1} disabled={busy||running||root.status==="revoked"} value={(budget?.[key]??root.budget[key])/scale} onChange={event=>{setBudget(previous=>({...previous!,[key]:Number(event.target.value)*scale}));setConfirmed("");}}/></label>)}</div>
      <p>{t("调整只改变整组上限，累计用量保留；不启动或恢复任务。费用未知，这不是账单上限。","Changes affect only the group limits and preserve accumulated usage; no task starts or resumes. Costs are unknown, so this is not a billing cap.")}</p>
      {running&&<p>{t("有任务正在运行，暂时不能改额度。可以等它结束；「停止整组运行」会影响这组里所有正在运行的任务。","Limits cannot change while a task is running. You can wait; stopping the group affects every active task in it.")}</p>}
      <label><input type="checkbox" checked={confirmed===token} disabled={busy||running||!valid.success||!changed||root.status==="revoked"} onChange={event=>setConfirmed(event.target.checked?token:"")}/>{t("我已核对工作区总上限","I verified the workspace limits")}</label>
      <div className="agent-task-ledger-actions"><button type="button" disabled={busy||running||!valid.success||!changed||confirmed!==token||root.status==="revoked"} onClick={()=>void act(()=>client.budget(root,valid.success?valid.data:root.budget))}>{t("确认调整根额度","Confirm root budget changes")}</button>
        {running&&<button type="button" disabled={busy} onClick={()=>void act(()=>client.pause(root))}>{t("停止整组运行","Stop the entire group")}</button>}</div>
    </>}
    <button type="button" disabled={busy||loading||invalid||!currentPrincipal()} onClick={()=>void act(async()=>{})}>{t("刷新根账（不推理）","Refresh root ledger (no inference)")}</button>
    <LegacyTaskScopeAssociation rootScopeKey={rootScopeKey} client={client} onAssociated={()=>act(async()=>{})}/>
  </details>;
}
