import {useEffect,useRef,useState} from "react";
import {CareerTaskBudgetSchema,type CareerTaskBudget} from "@better-me/agent-contracts";
import {defaultTaskLedgerClient} from "../services/agent-task-scope";
import {captureIdentityLease,currentPrincipal} from "../lib/identity";
import {TaskOutputArtifacts} from "./TaskOutputArtifacts";
import {LegacyTaskScopeAssociation} from "./LegacyTaskScopeAssociation";

type Ledger=NonNullable<Awaited<ReturnType<typeof defaultTaskLedgerClient.read>>>;
const fields=[["maxModelCalls","模型调用",1,500],["maxToolCalls","工具读取",1,2000],["maxActiveMs","主动运行（分钟）",60000,1440]] as const;
export function AgentTaskLedger({rootScopeKey,client=defaultTaskLedgerClient}:{rootScopeKey:string;client?:typeof defaultTaskLedgerClient}){
  const [ledger,setLedger]=useState<Ledger>(),[budget,setBudget]=useState<CareerTaskBudget>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[confirmed,setConfirmed]=useState("");
  const alive=useRef(true),lock=useRef(false),generation=useRef(0);
  const [lease]=useState(captureIdentityLease),[invalid,setInvalid]=useState(false);
  const apply=(next:Ledger|undefined)=>{setLedger(next);setBudget(next?.root.budget);setConfirmed("");};
  useEffect(()=>{alive.current=true;const epoch=++generation.current,ctrl=new AbortController();setLoading(true);setBusy(false);setError("");apply(undefined);
    const invalidate=()=>{alive.current=false;ctrl.abort();apply(undefined);setLoading(false);setBusy(false);setInvalid(true);};
    lease.signal.addEventListener("abort",invalidate,{once:true});if(lease.signal.aborted)invalidate();
    if(!currentPrincipal()||lease.signal.aborted){setLoading(false);return ()=>{alive.current=false;generation.current=epoch+1;ctrl.abort();lease.signal.removeEventListener("abort",invalidate);};}
    void client.read(rootScopeKey,ctrl.signal).then(value=>{if(!ctrl.signal.aborted)apply(value);}).catch(failure=>{if(!ctrl.signal.aborted)setError(failure instanceof Error?failure.message:"根账尚未核实。")}).finally(()=>{if(!ctrl.signal.aborted)setLoading(false);});
    return ()=>{alive.current=false;generation.current=epoch+1;ctrl.abort();lease.signal.removeEventListener("abort",invalidate);};
  },[client,rootScopeKey,lease]);
  async function act(work:()=>Promise<unknown>){if(lock.current)return;const epoch=generation.current,isCurrent=()=>alive.current&&generation.current===epoch;lock.current=true;setBusy(true);setError("");setConfirmed("");
    try{lease.assert();await work();lease.assert();if(!isCurrent())return;const next=await client.read(rootScopeKey);lease.assert();if(isCurrent())apply(next);}catch(failure){if(isCurrent())setError(failure instanceof Error?failure.message:"根账操作尚未确认，请刷新核对；没有重试模型。");}finally{lock.current=false;if(isCurrent())setBusy(false);}}
  const root=ledger?.root,totals=root?.rootLedger,valid=CareerTaskBudgetSchema.safeParse(budget),token=JSON.stringify([root?.id,root?.revision,budget]),running=ledger?.members.some(task=>task.status==="running");
  const changed=!!root&&!!budget&&JSON.stringify(budget)!==JSON.stringify(root.budget);
  const outputTasks=ledger?.members.filter(task=>"outputArtifacts"in task&&task.outputArtifacts?.length)??[];
  return <details className="agent-task-ledger"><summary>工作区共享额度{totals?` · 模型 ${totals.usage.modelCalls}/${totals.budget.maxModelCalls}`:""}{outputTasks.length?` · 原始输出 ${outputTasks.length} 项任务`:""}</summary>
    {error&&<p role="alert">{error}</p>}
    {loading?<p role="status">正在核对根账…</p>:!root?<p>尚未建立共享根账。首次明确发送时建立，不自动认领旧记录或重发请求。</p>:<>
      <p role="status">{totals?.memberCount??ledger!.members.length} 项任务 · 模型 {totals?.usage.modelCalls??root.usage.modelCalls}/{root.budget.maxModelCalls} 次 · 读取 {totals?.usage.toolCalls??root.usage.toolCalls}/{root.budget.maxToolCalls} 次 · 主动 {Math.ceil((totals?.usage.activeMs??root.usage.activeMs)/1000)} 秒</p>
      <p>{root.runtimeBinding.label} · 各入口共用根账，资料仍需逐次授权。</p>
      {outputTasks.map(task=><div key={task.id}><p>{task.objective} · {task.status}</p><TaskOutputArtifacts task={task}/></div>)}
      <div className="agent-task-ledger-fields">{fields.map(([key,label,scale,max])=><label key={key}>{label}<input type="number" min={1} max={max} step={1} disabled={busy||running||root.status==="revoked"} value={(budget?.[key]??root.budget[key])/scale} onChange={event=>{setBudget(previous=>({...previous!,[key]:Number(event.target.value)*scale}));setConfirmed("");}}/></label>)}</div>
      <p>调整只改变整组上限，累计用量保留；不启动或恢复任务。费用未知，这不是账单上限。</p>
      <label><input type="checkbox" checked={confirmed===token} disabled={busy||running||!valid.success||!changed||root.status==="revoked"} onChange={event=>setConfirmed(event.target.checked?token:"")}/>我已核对工作区总上限</label>
      <div className="agent-task-ledger-actions"><button type="button" disabled={busy||running||!valid.success||!changed||confirmed!==token||root.status==="revoked"} onClick={()=>void act(()=>client.budget(root,valid.success?valid.data:root.budget))}>确认调整根额度</button>
        {running&&<button type="button" disabled={busy} onClick={()=>void act(()=>client.pause(root))}>停止整组运行</button>}</div>
    </>}
    <button type="button" disabled={busy||loading||invalid||!currentPrincipal()} onClick={()=>void act(async()=>{})}>刷新根账（不推理）</button>
    <LegacyTaskScopeAssociation rootScopeKey={rootScopeKey} client={client} onAssociated={()=>act(async()=>{})}/>
  </details>;
}
