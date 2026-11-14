import {useEffect,useRef,useState} from "react";
import type {LegacyTaskScopePreview} from "@better-me/agent-contracts";
import {defaultTaskLedgerClient} from "../services/agent-task-scope";
import {captureIdentityLease,currentPrincipal} from "../lib/identity";
import {useUiPreferences} from "../lib/ui-preferences";
/** Metadata-only, explicitly requested preview. No model, resume or grant operation. */
export function LegacyTaskScopeAssociation({rootScopeKey,client=defaultTaskLedgerClient,onAssociated}:{rootScopeKey:string;client?:typeof defaultTaskLedgerClient;onAssociated:()=>Promise<void>}){
  const {t}=useUiPreferences();
  const blockedText={root_scope_occupied:t("当前工作区已有另一根账，未合并或清账。","This workspace already has another root ledger; nothing was merged or cleared."),pause_before_scope_association:t("旧组仍在运行，请先明确停止。","The legacy group is still running. Stop it explicitly first."),root_task_revoked:t("旧组含撤权记录，不能关联后继续。","The legacy group contains a revoked grant and cannot continue after association.")};
  const [lease]=useState(captureIdentityLease),[invalid,setInvalid]=useState(false),[preview,setPreview]=useState<LegacyTaskScopePreview>(),[selected,setSelected]=useState(""),[confirmed,setConfirmed]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[receipt,setReceipt]=useState("");
  const generation=useRef(0),operation=useRef<AbortController|undefined>(undefined);
  useEffect(()=>{const clear=()=>{generation.current++;operation.current?.abort();operation.current=undefined;setBusy(false);setPreview(undefined);setSelected("");setConfirmed("");setError("");setReceipt("");};
    clear();const epoch=generation.current,invalidate=()=>{clear();setInvalid(true);};lease.signal.addEventListener("abort",invalidate,{once:true});if(lease.signal.aborted)invalidate();
    return ()=>{generation.current=epoch+1;operation.current?.abort();operation.current=undefined;lease.signal.removeEventListener("abort",invalidate);};
  },[rootScopeKey,client,lease]);
  const candidate=preview?.candidates.find(item=>item.rootTaskId===selected),token=JSON.stringify([rootScopeKey,candidate?.rootTaskId,candidate?.previewToken]);
  async function perform(associate:boolean){
    if(operation.current||invalid)return;const epoch=generation.current,controller=new AbortController();operation.current=controller;setBusy(true);setError("");setConfirmed("");
    const valid=()=>{lease.assert();return generation.current===epoch;};
    try{
      if(associate&&candidate){
        const result=await client.associate(rootScopeKey,candidate,controller.signal);if(!valid())return;
        setReceipt(result.association.rootTaskId);setPreview(undefined);setSelected("");await onAssociated();
      }else{const next=await client.legacy(rootScopeKey,controller.signal);if(valid()){setPreview(next);setSelected("");setReceipt("");}}
    }catch(failure){try{if(valid())setError(failure instanceof Error?failure.message:t("关联结果尚未确认，请刷新根账核对；没有自动重发。","Association is not confirmed. Refresh the root ledger to verify it; nothing was resent automatically."));}catch{/* Identity changed: never publish the former owner's record. */}}
    finally{if(operation.current===controller){operation.current=undefined;if(generation.current===epoch)setBusy(false);}}
  }
  return <details className="agent-legacy-scope"><summary>{t("关联旧任务记录","Associate legacy task records")}</summary>
    <p>{t("只关联旧根及整组累计用量。不恢复运行、资料授权或简历采用；原始记录保持不变。","Only the legacy root and accumulated group usage are associated. Runs, material grants and resume adoption are not restored; original records remain unchanged.")}</p>
    {error&&<p role="alert">{error}</p>}{receipt&&<p role="status">{t(`已关联原根 ${receipt}，没有启动模型。后续发送仍需重新核对资料和授权。`,`Associated original root ${receipt} without starting a model. Materials and grants must be verified again before any later send.`)}</p>}
    {invalid&&<p role="status">{t("账号授权已变化，旧账预览已清除；请重新打开当前账号的工作区。","Account authorization changed. The legacy-ledger preview was cleared; reopen the current account workspace.")}</p>}
    <button type="button" disabled={busy||invalid||!currentPrincipal()} onClick={()=>void perform(false)}>{busy?t("正在核对…","Verifying…"):t("读取可关联旧根账（不推理）","Read eligible legacy roots (no inference)")}</button>
    {preview&&<>
      {preview.existingRootTaskId&&<p role="status">{t(`当前根：${preview.existingRootTaskId}。不自动合并其他旧账。`,`Current root: ${preview.existingRootTaskId}. Other legacy ledgers are not merged automatically.`)}</p>}
      {!preview.candidates.length?<p>{t("没有尚未关联的旧根账。","No unassociated legacy roots were found.")}</p>:<fieldset disabled={busy}><legend>{t("选择需要核对的原根任务","Select an original root task to verify")}</legend>{preview.candidates.map(item=><label className="agent-legacy-scope-candidate" key={item.rootTaskId}>
        <input type="radio" name={`legacy-scope-${rootScopeKey}`} checked={selected===item.rootTaskId} disabled={!!item.blockedBy} onChange={()=>{setSelected(item.rootTaskId);setConfirmed("");}}/>
        <span><strong>{item.objective}</strong><span>{item.rootTaskId} · {item.workspaceKey} · {item.status}</span><span>{t(`${item.runtimeBinding.label} · ${item.ledger.memberCount} 项任务 · 模型 ${item.ledger.usage.modelCalls}/${item.ledger.budget.maxModelCalls} · 读取 ${item.ledger.usage.toolCalls}/${item.ledger.budget.maxToolCalls} · 主动 ${Math.ceil(item.ledger.usage.activeMs/1000)} 秒`,`${item.runtimeBinding.label} · ${item.ledger.memberCount} tasks · Model ${item.ledger.usage.modelCalls}/${item.ledger.budget.maxModelCalls} · Reads ${item.ledger.usage.toolCalls}/${item.ledger.budget.maxToolCalls} · Active ${Math.ceil(item.ledger.usage.activeMs/1000)} seconds`)}</span>{item.blockedBy&&<span>{blockedText[item.blockedBy]}</span>}</span>
      </label>)}</fieldset>}
      <label><input type="checkbox" checked={confirmed===token} disabled={busy||!candidate?.previewToken||!!candidate.blockedBy} onChange={event=>setConfirmed(event.target.checked?token:"")}/>{t("仅关联记录与用量，不恢复运行或资料授权","Associate records and usage only; do not restore runs or material grants")}</label>
      <div className="agent-task-ledger-actions"><button type="button" disabled={busy||!candidate?.previewToken||!!candidate.blockedBy||confirmed!==token} onClick={()=>void perform(true)}>{t("确认关联原根账","Confirm original root association")}</button></div>
    </>}
  </details>;
}
