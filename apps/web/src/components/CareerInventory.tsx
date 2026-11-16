import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpenCheck, ChevronRight, X } from "lucide-react";
import { ProfileTopicSchema, careerRuntimeBinding, inventoryKey, type InventoryAction, type InventoryAnswer, type InventoryProfile, type InventorySource, type InventoryView } from "@better-me/agent-contracts";
import type { LlmConfig } from "@better-me/core";
import { inventoryClient,inventoryProbe } from "../services/inventory-client";
import { captureIdentityLease } from "../lib/identity";
import { useAgentTaskRuntime } from "../lib/agent-task-runtime";
import { choiceLabels,interviewStep,topics } from "../lib/inventory-interview";
import { inventoryRefinements } from "../lib/inventory-refinements";
import { writingTargetKey, type WritingSource } from "../lib/resume-copilot";
import { InventoryVoice } from "./InventoryVoice";
import "./career-inventory.css";

type Props={source:InventorySource;fields:WritingSource[];config:LlmConfig;onClose:()=>void;onRefine:()=>void;
  onPickSource:(field:WritingSource,view:InventoryView)=>void;onConfirmed:(v:InventoryView)=>void;assertSource:()=>void};
type D=NonNullable<InventoryAnswer["disposition"]>;
const phaseNames=["现在与底稿","倒序经历","工作偏好","共识与选材"];

/** A native modal supplies focus containment and an accessible escape hatch on Web and Electron. */
export function CareerInventory({source,fields,config,onClose,onRefine,onPickSource,onConfirmed,assertSource}:Props){
  const dlg=useRef<HTMLDialogElement>(null), lease=useState(captureIdentityLease)[0], alive=useRef(true), lock=useRef(false);
  const [v,setView]=useState<InventoryView|null>(null),[loaded,setLoaded]=useState(false),[stale,setStale]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[selected,setSelected]=useState<string[]>([]);
  const [text,setText]=useState(""),[disposition,setDisposition]=useState<D>("feature"),[cat,setCat]=useState<"work"|"portfolio"|"other"|"education">("other");
  const [more,setMore]=useState(false),[uses,setUses]=useState<NonNullable<InventoryAnswer["uses"]>>(["strategy"]);
  const [term,setTerm]=useState(""),[strategyTerm,setStrategyTerm]=useState(""),[editId,setEditId]=useState(""),[editText,setEditText]=useState("");
  const [profile,setProfile]=useState<InventoryProfile|null>(null),[probing,setProbing]=useState(false),[probeReady,setProbeReady]=useState(false);
  const [follow,setFollow]=useState(""),[extra,setExtra]=useState(""),[forgetId,setForgetId]=useState("");
  const [voicePending,setVoicePending]=useState(false);
  const abort=useRef<AbortController|null>(null),runtime=useAgentTaskRuntime(config);
  const step=v ? interviewStep(v.session) : undefined;
  const isProfile=ProfileTopicSchema.safeParse(step?.target).success;
  const revision=v?.session.revision;
  const refinements=useMemo(()=>inventoryRefinements(v?.session,fields),[v?.session,fields]);
  const take=useCallback((next:InventoryView)=>{
    setView(next);setProfile(next.profile);setStale(next.session.source.fingerprint!==source.fingerprint);
    setEditId("");setForgetId("");
  },[source.fingerprint]);
  const load=useCallback(async()=>{
    setLoaded(false);setError("");
    try{lease.assert(); const got=await inventoryClient.get(inventoryKey(source));lease.assert();
      if(!alive.current)return;
      if(got)take(got);else{setView(null);setStale(false);setProfile(await inventoryClient.profile());}
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:"未能读取盘点。");}
    finally{if(alive.current)setLoaded(true);}
  },[lease,source,take]);
  useEffect(()=>{alive.current=true;const dialog=dlg.current;dialog?.showModal();void load();
    return()=>{alive.current=false;abort.current?.abort();dialog?.close();};},[load]);
  useEffect(()=>{
    if(!v)return;
    const frame=requestAnimationFrame(()=>{const dialog=dlg.current;if(!dialog?.open)return;
      dialog.querySelector<HTMLElement>("#inventory-title")?.focus({preventScroll:true});dialog.scrollTop=0;});
    return()=>cancelAnimationFrame(frame);
  },[v?.session.id,v?.session.cursor,v?.session.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{setText("");setExtra("");setTerm("");setStrategyTerm("");setFollow("");setProbeReady(false);setMore(false);setDisposition("feature");
    setUses(step?.target==="intent"?["strategy","planning"]:step?.target==="redline"||step?.target==="avoid"?["jd"]:["strategy"]);
  },[revision,step?.target]);
  useEffect(()=>{setProbeReady(false);setFollow("");setExtra("");abort.current?.abort();},[runtime.key]);
  async function op(operation:()=>Promise<InventoryView>){
    if(lock.current)return;lock.current=true;setBusy(true);setError("");setProbeReady(false);abort.current?.abort();
    try{lease.assert();assertSource();const next=await operation();lease.assert();assertSource();
      if(!alive.current)return;take(next);
      if(next.session.phase==="confirmed"){onConfirmed(next);window.dispatchEvent(new Event("betterme:inventory-profile"));}
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:"未保存。");}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  function act(a:InventoryAction){if(v&&!stale){
    // Confirmation starts with an explicit selection; editing a quote never silently rechecks excluded answers.
    if(a.kind==="review" || a.kind==="again")setSelected([]);
    void op(()=>inventoryClient.command(v,a));
  }}
  async function pick(groupId:string,field:WritingSource){
    if(!v?.session.receipt||stale||lock.current)return;
    lock.current=true;setBusy(true);setError("");
    try{
      lease.assert();assertSource();
      const latest=await inventoryClient.get(inventoryKey(source));
      if(!alive.current)return;
      lease.assert();assertSource();
      if(latest?.session.phase!=="confirmed"||latest.session.id!==v.session.id||latest.session.revision!==v.session.revision||
        latest.session.receipt?.reviewHash!==v.session.receipt.reviewHash||latest.session.source.fingerprint!==source.fingerprint||
        !inventoryRefinements(latest.session,fields).get(groupId)?.fields.some(f=>writingTargetKey(f.targetRef)===writingTargetKey(field.targetRef)&&f.text===field.text))
        throw Error("这份选材策略或原句已变化，请重新读取后再选择。");
      onPickSource(field,latest);
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:"暂时无法定位原句。");}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  const probeRequest=v&&step?.target?{sessionId:v.session.id,revision:v.session.revision,target:step.target,prompt:step.prompt,priorAnswer:text.trim()}:null;
  async function ask(){
    if(!probeRequest||!probeReady||probing||lock.current)return;
    const controller=new AbortController();abort.current=controller;setProbing(true);setProbeReady(false);setError("");
    try{lease.assert();assertSource();runtime.assertSelected();
      const q=await inventoryProbe(probeRequest,source.documentId,runtime.runtime,runtime.preferredRuntimeId,controller.signal,runtime.assertSelected);
      lease.assert();assertSource();if(alive.current&&!controller.signal.aborted)setFollow(q);
    }catch(e){if(alive.current&&!controller.signal.aborted)setError(e instanceof Error?e.message:"追问不可用，可继续文字盘点。");}
    finally{if(alive.current)setProbing(false);}
  }
  function submit(){
    const target=step?.target;if(!target)return;
    const answer=[text.trim(),extra.trim()].filter(Boolean).join("\n");
    if(!answer||answer.length>7000){setError("本轮原话须为 1–7000 个字符；不会裁掉你的内容。");return;}
    act(target==="new"?{kind:"add",target,text:answer,category:cat,more}:{kind:"answer",target,text:answer,
      ...(step?.group?{disposition}:{}),...(isProfile?{uses,...(uses.includes("jd")&&term.trim()?{matchTerm:term.trim()}:{}),
        ...(uses.includes("strategy")&&strategyTerm.trim()?{strategyTerm:strategyTerm.trim()}:{})}:{}),...(follow?{question:follow}:{})});
  }
  const stage=v?.session.phase==="interview"&&!stale?step?.stage??1 : !v||stale?1:4;
  const active=!!v && !stale, reviewing=active&&v.session.phase==="review",done=active&&v.session.phase==="confirmed";
  const frozen=busy||probing||voicePending;
  function appendVoice(value:string,toFollow:boolean){
    const combined=[toFollow?extra:text,value].filter(Boolean).join("\n");
    if((toFollow?[text,combined].filter(Boolean).join("\n"):combined).length>7000){
      setError("加上这段转写会超过 7000 字，请缩短后再填入；原回答未变。");return false;}
    setError("");
    if(toFollow)setExtra(combined);
    else{setText(combined);setProbeReady(false);setFollow("");setExtra("");}
    return true;
  }
  function voiceFor(slot:"answer"|"follow"){return <InventoryVoice key={[v?.session.id,revision,step?.target,slot].join(":")}
    disabled={busy||probing} signal={lease.signal} authorize={()=>{lease.assert();assertSource();}}
    append={words=>appendVoice(words,slot==="follow")} onPending={setVoicePending}/>;}
  function close(){abort.current?.abort();onClose();}
  let destination="当前底座";try{destination=careerRuntimeBinding(runtime.runtime,runtime.preferredRuntimeId).label;}catch{/* unavailable runtime: explicit send still fails closed */}
  const answerName=(a:InventoryAnswer)=>a.target==="new"?"旧稿外新增材料":topics[a.target]??v?.session.source.groups.find(g=>g.id===a.target)?.label??a.target;
  return <dialog ref={dlg} className="inventory-dialog no-print" aria-labelledby="inventory-title" onCancel={e=>{e.preventDefault();close();}}>
    <header><div className="iv-eyebrow"><BookOpenCheck size={17}/> 履历工作台</div><button aria-label="关闭履历盘点" onClick={close}><X size={18}/></button></header>
    <div className="iv-body"><ol className="iv-steps" aria-label="盘点阶段">{phaseNames.map((p,i)=><li key={p} aria-current={stage===i+1?"step":undefined}><span>{i+1}</span>{p}</li>)}</ol>
    <h2 id="inventory-title" tabIndex={-1}>{!active?"一起盘点最近的变化":reviewing?"核对全景共识卡":done?"整份简历，先这样选材":step?.heading}</h2>
    {!loaded && <p role="status">正在读取本人盘点…</p>}
    {error && <div role="alert" className="iv-error">{error} <button disabled={frozen} onClick={()=>void load()}>重新读取</button></div>}
    {loaded && (!active) && <><p>{stale?"这份底稿和上次不同。旧记录保留，旧共识不能应用到新版。":"从现在说起，补上旧稿遗漏的经历，再决定哪些值得写。盘点可以中途离开，已提交的回答保存在本人账号。"} </p>
      <p className="iv-muted">可以打字，也可以用本机普通话输入。回答不会直接改简历；需要模型追问时，再由你决定是否发送。</p>
      <div className="iv-actions"><button className="iv-primary" disabled={frozen||!!error} onClick={()=>void op(()=>inventoryClient.start(source))}>{stale?"重新核对这份底稿":"开始盘点"}<ChevronRight size={16}/></button><button onClick={close}>直接编辑简历</button></div></>}
    {active&&v.session.phase==="interview"&&step&&<><p className="iv-question">{step.prompt}</p>
      {step.target==="baseline"&&<div className="iv-context">{source.fileModifiedAt && <p>文件修改于 {source.fileModifiedAt.slice(0,10)}（只是线索）</p>}
        {source.groups.find(g=>g.kind==="work") && <p>旧稿最近任职：{source.groups.find(g=>g.kind==="work")!.label} · {source.groups.find(g=>g.kind==="work")!.period}</p>}
        <small>导入时间与文件日期都不代表内容更新到那一天。</small></div>}
      {step.group&&<details className="iv-context" open><summary>旧稿材料{step.group.period?" · "+step.group.period:""}</summary>
        {step.group.evidence.length?step.group.evidence.map((e,i)=><p key={i}>{e}</p>):<small>旧稿没有更多说明。</small>}</details>}
      <label className="iv-field">我的回答<textarea autoFocus key={step.target} maxLength={7000} disabled={frozen} value={text} onChange={e=>{setText(e.target.value);setProbeReady(false);setFollow("");setExtra("");}} placeholder="用自己的话说，也可以说不确定。"/></label>
      {!follow&&!probeReady&&voiceFor("answer")}
      {step.target==="new"&&<div className="iv-options"><label>材料类型 <select value={cat} onChange={e=>setCat(e.target.value as typeof cat)}><option value="portfolio">独立作品 / 业余项目</option><option value="work">工作经历</option><option value="education">教育 / 学习</option><option value="other">其他 / 暂不确定</option></select></label><label><input type="checkbox" checked={more} onChange={e=>setMore(e.target.checked)}/>还想再补一件</label></div>}
      {step.group&&<label className="iv-field">这段怎么用<select value={disposition} onChange={e=>setDisposition(e.target.value as D)}>{Object.entries(choiceLabels).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>}
      {isProfile&&<fieldset className="iv-options"><legend>确认后，允许用于</legend>{(["strategy","jd","planning"] as const).map((use,i)=><label key={use}><input type="checkbox" checked={uses.includes(use)} onChange={e=>setUses(e.target.checked?[...uses,use]:uses.filter(x=>x!==use))}/>{["选材","岗位提醒","规划"][i]}</label>)}
        {uses.includes("strategy")&&(step.target==="like"||step.target==="intent")&&<label className="iv-field">同为重点时，优先找什么材料？（可选）<input value={strategyTerm} maxLength={120} onChange={e=>setStrategyTerm(e.target.value)} placeholder="例如：系统架构"/></label>}
        {uses.includes("jd")&&<label className="iv-field">希望核对的岗位原词（可选）<input value={term} maxLength={120} onChange={e=>setTerm(e.target.value)} placeholder="例如：长期驻场"/></label>}</fieldset>}
      {probeReady&&<div className="iv-context"><strong>这次向 {destination} 发送什么？</strong><p>仅发送下面这个问题和这段回答。最多一次模型请求，使用当前工作区额度；不会发送整份简历或工作画像。</p><blockquote>{step.prompt}<br/>{text}</blockquote>
        <button onClick={()=>void ask()} disabled={frozen}>同意发送这两段 · 追问一次</button> <button onClick={()=>setProbeReady(false)}>不发送</button></div>}
      {follow&&<><label className="iv-field">模型追问：{follow}<textarea value={extra} disabled={frozen} maxLength={7000} onChange={e=>setExtra(e.target.value)} placeholder="可补充，也可留空。题目本身不会当作你的原话。"/></label>{voiceFor("follow")}</>}
      <div className="iv-actions"><button className="iv-primary" disabled={frozen||!text.trim()} onClick={submit}>保存回答并继续</button><button disabled={frozen} onClick={()=>act({kind:"skip",target:step.target!})}>跳过这项</button>
        {!probeReady&&!follow&&<button disabled={frozen||!text.trim()||!!runtime.error} onClick={()=>setProbeReady(true)}>{probing?"追问中…":"请模型追问"}</button>}</div>
      <div className="iv-footer"><small>{v.session.cursor+1} / {step.total} 个话题 · 可随时提前结束</small><button disabled={frozen} onClick={()=>act({kind:"review"})}>先看共识卡</button></div></>}
    {reviewing&&<><p>勾选愿意长期保留的原话。勾选的新偏好替换同主题旧偏好；不选则保留原状。私人偏好不会出现在简历里。</p>
      {!!v.session.answers.length&&<button onClick={()=>setSelected(selected.length===v.session.answers.length?[]:v.session.answers.map(a=>a.id))}>{selected.length===v.session.answers.length?"取消全选":"全选本次原话"}</button>}
      {!v.session.answers.length&&<p className="iv-muted">本次还没有原话，未问到或跳过的材料将标为待补。</p>}
      {v.session.answers.map(a=><div className="iv-row" key={a.id}><label><input type="checkbox" checked={selected.includes(a.id)} onChange={e=>setSelected(e.target.checked?[...selected,a.id]:selected.filter(x=>x!==a.id))}/><strong>{answerName(a)}</strong></label>
        {editId===a.id?<><textarea aria-label="修正原话" value={editText} maxLength={7000} onChange={e=>setEditText(e.target.value)}/><button disabled={frozen||!editText.trim()} onClick={()=>act({kind:"edit",answerId:a.id,text:editText})}>保存修正</button></>:<><p>{a.text}</p>
          {a.uses&&<small>用途：{a.uses.map(u=>({strategy:"选材",jd:"岗位提醒",planning:"规划"})[u]).join("、")||"仅本人留存"}{a.strategyTerm&&" · 选材优先词："+a.strategyTerm}{a.matchTerm&&" · 岗位核对词："+a.matchTerm}</small>}
          <button onClick={()=>{setEditId(a.id);setEditText(a.text);}}>修正原话</button></>}</div>)}
      <details className="iv-context"><summary>旧稿与未确定项 · {source.groups.length} 组</summary>{source.groups.map(g=><p key={g.id}>{g.label} · {v.session.answers.some(a=>a.target===g.id&&selected.includes(a.id))?"有本人选用说明":"待核对 / 未选"}</p>)}</details>
      <div className="iv-actions"><button className="iv-primary" disabled={frozen||!!editId} onClick={()=>act({kind:"confirm",selected,reviewHash:v.reviewHash})}>确认所选并生成选材策略（{selected.length}）</button>
        {step?.target&&<button disabled={frozen} onClick={()=>act({kind:"back"})}>继续访谈</button>}</div></>}
    {done&&v.session.receipt&&<><p>已确认 {v.session.receipt.selected.length} 条原话。以下是建议，没有改动简历正文。</p>
      <div className="iv-context">底稿内容截至：{v.session.receipt.baseline?.text??"未确认"}</div>
      {v.session.receipt.strategy.map(g=>{
        const targets=refinements.get(g.groupId)?.fields;
        return <div className="iv-row" key={g.groupId}><strong>{g.label}</strong><span className="iv-tag">{choiceLabels[g.disposition]}</span><p>{g.reason}</p>
          {targets?.length ? <details className="iv-refine"><summary>选择要精修的原句</summary>
            <small>只打开所选原句；是否引用盘点原话，由你下一步决定。</small>
            {targets.map(f=><button type="button" key={writingTargetKey(f.targetRef)} disabled={frozen} aria-label={"精修原句："+f.text} onClick={()=>void pick(g.groupId,f)}>
              {f.text}</button>)}</details> : (g.disposition==="feature"||g.disposition==="compress")&&<small>本版没有可定位的对应原句。这份材料会单独保留，不会挂到其他经历。</small>}
        </div>;
      })}
      <h3>下一步</h3>{v.session.receipt.nextSteps.map(s=><p key={s}>{s}</p>)}{v.session.receipt.direction.length>0&&<p>当时选材方向：{v.session.receipt.direction.join("；")}</p>}
      <div className="iv-actions"><button className="iv-primary" onClick={onRefine}>进入逐条精修</button><button disabled={frozen} onClick={()=>act({kind:"again"})}>重新盘点近况</button></div></>}
    {!!profile?.entries.length&&<details className="iv-context"><summary>本人私有工作画像（{profile.entries.length} 项）</summary>
      {profile.entries.map(e=><div className="iv-row" key={e.id}><strong>{topics[e.topic]}</strong><p>{e.quote}</p>
        <button disabled={frozen} onClick={()=>{if(forgetId!==e.id){setForgetId(e.id);return;}
          void (async()=>{setBusy(true);try{const p=await inventoryClient.forget(e.id,profile.revision);lease.assert();window.dispatchEvent(new Event("betterme:inventory-profile"));if(alive.current){setProfile(p);setForgetId("");await load();}}
            catch(err){if(alive.current)setError(String(err));}finally{if(alive.current)setBusy(false);}})();}}>{forgetId===e.id?"确认撤回后续使用":"撤回这项偏好"}</button></div>)}</details>}
    </div></dialog>;
}
