import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { captureIdentityLease, capturePrivateStorage } from "../lib/identity";
import { CodingHttpError, CodingInputSchema, sandboxCodingClient, validCodingModelName, type CodingInput, type CodingSummary, type CodingTask, type SandboxCodingClient } from "../services/sandbox-coding-client";
import "./sandbox-coding-lab.css";

const pointer = "sandbox-coding.active.v1";
const example = JSON.stringify([{id:"zero",input:0,expected:0},{id:"positive",input:3,expected:6}],null,2);
const labels:Record<CodingTask["status"],string>={ready:"可推进",running:"宿主运行中",paused:"已暂停",interrupted:"上轮中断",budget_exhausted:"预算已耗尽",review_ready:"候选待审阅"};
const outcomes:Record<NonNullable<CodingTask["lastAttempt"]>["outcome"],string>={running:"宿主正在执行",accepted:"本轮候选已保留",regression:"拒绝回归，保留上一版",failed:"本轮失败",interrupted:"本轮中断"};
const stopReasons:Record<string,string>={coding_review_ready:"固定用例已全部通过，等待人工审阅",coding_budget_exhausted:"轮数或主动用时预算已用完",
  coding_lease_invalid:"运行授权已失效",coding_model_digest_changed:"本机模型的指纹已变化，未切换模型",coding_manually_paused:"已按你的要求暂停",
  coding_host_stopped:"宿主已关闭",coding_host_restarted:"宿主重启，原授权没有恢复",coding_auto_outcome_unknown:"上一轮结果不确定，已停止"};
const identities=new WeakMap<AbortSignal,number>(); let sequence=0;
function identitySnapshot(){const l=captureIdentityLease();return l.signal.aborted||!l.ownerId?null:l.signal;}
function subscribeIdentity(notify:()=>void){
  const {signal}=captureIdentityLease();let live=true;
  const change=()=>{notify();queueMicrotask(()=>{if(live)notify();});};signal.addEventListener("abort",change);
  return ()=>{live=false;signal.removeEventListener("abort",change);};
}
export function SandboxCodingLab({client=sandboxCodingClient}:{client?:SandboxCodingClient}){
  const generation=useSyncExternalStore(subscribeIdentity,identitySnapshot,()=>null);
  if(!generation)return <section className="coding-lab"><h3>本地模型编码实验台</h3><p>请先登录当前账号；不会读取或跨账号显示任务。</p></section>;
  if(!identities.has(generation))identities.set(generation,++sequence);
  return <Lab key={identities.get(generation)} client={client}/>;
}
function Lab({client}:{client:SandboxCodingClient}){
  const [scope]=useState(()=>({lease:captureIdentityLease(),store:capturePrivateStorage()}));
  const mounted=useRef(false), selected=useRef(""),lastRevision=useRef(-1),requestNumber=useRef(0),catalogNumber=useRef(0),locked=useRef(false),pausing=useRef(false);
  const settledAction=useRef(0);
  const [entries,setEntries]=useState<CodingSummary[]>([]), [task,setTask]=useState<CodingTask|null>(null);
  const [goal,setGoal]=useState(""),[model,setModel]=useState("gemma4:e2b-it-qat"),[fixtures,setFixtures]=useState(example),[attempts,setAttempts]=useState("3"),[consent,setConsent]=useState(false);
  const [seconds,setSeconds]=useState("180");
  const [busy,setBusy]=useState<""|"create"|"load"|"step"|"run">(""),[pausePending,setPausePending]=useState(false);
  const [note,setNote]=useState(""),[error,setError]=useState(""),[catalogError,setCatalogError]=useState("");
  const alive=()=>mounted.current&&!scope.lease.signal.aborted;
  function remember(id:string){if(!alive())return;try{if(id)scope.store.setItem(pointer,id);else scope.store.removeItem(pointer);}catch{/* History still lives on the owner Host. */}}
  function accept(item:CodingTask){
    if(!alive()||item.id!==selected.current||item.revision<lastRevision.current)return;
    lastRevision.current=item.revision;setTask(item);remember(item.id);
    setEntries(old=>[item,...old.filter(t=>t.id!==item.id)]);
  }
  async function list(signal?:AbortSignal){
    const n=++catalogNumber.current;
    try{const all=await client.list(signal);if(alive()&&!signal?.aborted&&catalogNumber.current===n){setEntries(all);setCatalogError("");}}
    catch{if(alive()&&!signal?.aborted&&catalogNumber.current===n)setCatalogError("无法读取本账号的任务目录；可重试，不会调用模型。");}
  }
  async function load(id:string,signal?:AbortSignal){
    const n=++requestNumber.current;selected.current=id;lastRevision.current=-1;setTask(null);setError("");setNote("");setBusy("load");
    try{const result=await client.get(id,signal);if(alive()&&!signal?.aborted&&n===requestNumber.current)accept(result);}
    catch{if(alive()&&!signal?.aborted&&n===requestNumber.current)setError("无法读取这个任务。请从本账号的目录重新选择；没有重跑模型。");}
    finally{if(alive()&&!signal?.aborted&&n===requestNumber.current)setBusy("");}
  }
  useEffect(()=>{
    mounted.current=true;const ctrl=new AbortController();void list(ctrl.signal);
    try{const id=scope.store.getItem(pointer);if(id)void load(id,ctrl.signal);}catch{/* No pointer needed for list recovery. */}
    return ()=>{mounted.current=false;ctrl.abort();};
    // Restoring a new account uses a fresh keyed Lab. Its first render never POSTs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[client,scope]);
  // A separate window may advance/pause a task. Poll only its receipt, never the model.
  const pollId=task?.id, observe=task?.autoRunning===true||task?.status==="running"||busy==="step"||busy==="run";
  useEffect(()=>{
    if(!pollId||!observe)return;const ctrl=new AbortController();let pending=false;
    const timer=window.setInterval(()=>{if(pending)return;pending=true;const observedAfter=settledAction.current;void client.get(pollId,ctrl.signal)
      .then(item=>{if(!ctrl.signal.aborted&&observedAfter===settledAction.current)accept(item);}).catch(()=>{}).finally(()=>{pending=false;});},1100);
    return ()=>{ctrl.abort();window.clearInterval(timer);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[client,pollId,observe]);
  function validate():{input?:CodingInput;reason?:string}{
    if(!goal.trim()||!model.trim())return {reason:"填写通用目标和本机已安装的 Ollama 模型名。"};
    if(!validCodingModelName(model))return {reason:"只接受本机 Ollama 模型名，不接受 URL 或云端别名。"};
    if(!Number.isInteger(Number(seconds))||Number(seconds)<1||Number(seconds)>300)return {reason:"累计主动用时需为 1–300 个整秒；等待人工操作不扣。"};
    try{const parsed=CodingInputSchema.safeParse({goal,model,cases:JSON.parse(fixtures),maxAttempts:Number(attempts),maxActiveMs:Number(seconds)*1000,consent:true});
      return parsed.success?{input:parsed.data}:{reason:"用例需 1–12 个，每项包含唯一英文或数字 id、input、expected；每个输入及预期 ≤32 KiB、合计 ≤64 KiB，尝试上限 1–8。"};}
    catch{return {reason:"用例不是有效的 JSON 数组。"};}
  }
  const validation=validate();
  async function create(){
    if(locked.current||!alive()||!consent||!validation.input)return;
    locked.current=true;setBusy("create");setError("");setNote("");setConsent(false);
    try{const item=await client.create(validation.input);if(!alive())return;selected.current=item.id;lastRevision.current=-1;accept(item);setNote("实验已创建；尚未推进模型。");}
    catch(e){if(alive())setError("未确认创建。先刷新任务目录再决定是否重试，未自动重发。"+detail(e));}
    finally{locked.current=false;if(alive())setBusy("");}
  }
  async function act(kind:"step"|"run"|"pause"){
    if(!task||!alive()||!selected.current||pausing.current||(kind!=="pause"&&(locked.current||task.autoRunning)))return;
    const id=task.id, revision=task.revision;
    if(kind!=="pause"){locked.current=true;setBusy(kind);}else{pausing.current=true;setPausePending(true);}
    setError("");setNote("");
    try{const item=await client[kind](id,revision);if(alive()&&id===selected.current){settledAction.current++;accept(item);}}
    catch(e){if(!alive()||id!==selected.current)return;
      const conflict=e instanceof CodingHttpError&&e.status===409;
      setError((conflict?"版本冲突；只重新读取宿主状态，不会再次调用模型。":"未能确认本次操作。只读取宿主状态，不自动重试。")+detail(e));
      try{accept(await client.get(id));}catch{/* Unknown stays unknown; user can refresh. */}
    }finally{if(kind!=="pause"){locked.current=false;if(alive())setBusy("");}else{pausing.current=false;if(alive())setPausePending(false);}}
  }
  const last=task?.lastAttempt,best=task?.best;
  const canStep=!!task&&!task.autoRunning&&["ready","paused","interrupted"].includes(task.status)&&task.attemptsUsed<task.maxAttempts&&task.activeMs<task.maxActiveMs;
  const changeForm=(fn:()=>void)=>{fn();setConsent(false);setNote("");};
  return <section className="coding-lab" aria-label="本地模型编码实验台">
    <header><h3>本地模型编码实验台</h3><p>让本机 Ollama 编写一个同步 JSON 转换函数，用你给的固定用例逐轮验证。只处理合成示例；不要输入真实简历、个人记录、密钥或内网地址。</p></header>
    <details><summary>本账号的实验（{entries.length}）</summary>
      <div className="coding-actions"><button type="button" onClick={()=>void list()}>刷新任务目录</button></div>
      {entries.map(item=><button type="button" className="coding-history" key={item.id} disabled={!!busy||pausePending} onClick={()=>void load(item.id)}>{item.goal} · {item.autoRunning?"连续修复中":labels[item.status]}</button>)}
    </details>
    {catalogError&&<p role="status">{catalogError}</p>}
    {!task&&busy!=="load"&&<div className="coding-form">
      <label>通用目标<textarea name="coding-goal" maxLength={4000} placeholder="例如：将输入的合成数字乘以二，返回一个数字。" value={goal} onChange={e=>changeForm(()=>setGoal(e.target.value))}/></label>
      <label>本机 Ollama 模型名<input name="coding-model" value={model} onChange={e=>changeForm(()=>setModel(e.target.value))}/></label>
      <div className="coding-bounds"><label>最多尝试几轮<input name="coding-attempts" type="number" min={1} max={8} value={attempts} onChange={e=>changeForm(()=>setAttempts(e.target.value))}/></label>
        <label>累计主动用时（秒）<input name="coding-seconds" type="number" min={1} max={300} step={1} value={seconds} onChange={e=>changeForm(()=>setSeconds(e.target.value))}/></label></div>
      <label>固定合成用例（JSON 数组）<textarea name="coding-cases" spellCheck={false} rows={5} value={fixtures} maxLength={70000} onChange={e=>changeForm(()=>setFixtures(e.target.value))}/></label>
      <small>{validation.reason??"创建后固定这些输入和预期结果。等待人工操作不扣主动用时；任务开始后关闭窗口不等于暂停。你可再授权单轮调用或连续修复。"}</small>
      <label className="coding-grant"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我确认这些都是合成数据，并授权保存本账号的实验{validation.input&&<>：最多 {validation.input.maxAttempts} 轮、累计主动用时 {validation.input.maxActiveMs/1000} 秒</>}。</label>
      <div><button className="coding-primary" type="button" disabled={!validation.input||!consent||!!busy} onClick={()=>void create()}>创建实验（不调用模型）</button></div>
    </div>}
    {busy==="load"&&<p role="status">正在读取本账号的实验…</p>}
    {task&&<div className="coding-task"><h4>{task.goal}</h4><p><strong>{task.autoRunning?"连续修复中":labels[task.status]}</strong> · {task.model} · 已用 {task.attemptsUsed}/{task.maxAttempts} 轮 · 主动用时 {Math.ceil(task.activeMs/1000)}/{Math.ceil(task.maxActiveMs/1000)} 秒</p>
      <details><summary>任务编号与模型指纹</summary><p><code>{task.id}</code><br/><code>{task.modelDigest}</code> · 任务版本 {task.revision}</p></details>
      <h4>固定验收清单</h4><ol>{task.cases.map(c=>{const accepted=best?.checks.find(i=>i.id===c.id),latest=last?.checks.find(i=>i.id===c.id);return <li key={c.id}><strong>{c.id}</strong> · 保留版本：{accepted?(accepted.passed?"通过":"未通过"):"未验证"}{latest&&<> · 最近一轮：{latest.passed?"通过":"失败"}{latest.error&&<>（{latest.error}）</>}</>}<details><summary>查看输入与预期</summary><pre>{JSON.stringify({input:c.input,expected:c.expected},null,2)}</pre></details></li>;})}</ol>
      {last&&<p role="status">第 {last.number} 轮 · 目标用例 {last.targetCaseId} · {outcomes[last.outcome]}{last.error&&<>：{last.error}</>}</p>}
      {task.history&&task.history.length>0&&<details><summary>逐轮记录（{task.history.length}）</summary>
        <ol>{task.history.map(h=><li key={h.number}>第 {h.number} 轮 · 目标 {h.targetCaseId} · {outcomes[h.outcome]} · {h.passedIds.length+h.failedIds.length
          ? <>检查通过 {h.passedIds.length}/{task.cases.length}</> : "没有完成检查"} · {h.activeMs} ms{h.error&&<>（{h.error}）</>}</li>)}</ol>
      </details>}
      {busy==="step"&&<p role="status">正在等待宿主返回本轮结果。关闭面板不会额外发起一轮；返回可从目录核对。</p>}
      {task.autoRunning&&<p role="status"><strong>连续修复授权中。</strong> 宿主会在授权范围内推进；关闭面板不等于暂停，重新打开只读取进度。可随时暂停。</p>}
      {!task.autoRunning&&task.autoStopReason&&<p>连续修复已停止：<span title={task.autoStopReason}>{stopReasons[task.autoStopReason]??"宿主已停止本次授权（"+task.autoStopReason+"）"}</span>。不会自动续跑。</p>}
      {canStep&&<p>授权范围：仅向本机 Ollama 端点的 <strong>{task.model}</strong> 提交通用目标、固定合成用例、此前候选源码及逐例结果；最多还可用 {task.maxAttempts-task.attemptsUsed} 轮，剩余主动用时不超过 {Math.ceil((task.maxActiveMs-task.activeMs)/1000)} 秒。连续模式在待审、预算耗尽、暂停、撤权或宿主中断后停止，不安装候选。</p>}
      <div className="coding-actions">
        {canStep&&<><button className="coding-primary" type="button" disabled={!!busy||pausePending} onClick={()=>void act("run")}>授权连续修复至待审</button>
          <button type="button" disabled={!!busy||pausePending} onClick={()=>void act("step")}>授权调用 {task.model} 一轮</button></>}
        {(task.status==="running"||task.autoRunning)&&<button type="button" disabled={pausePending} onClick={()=>void act("pause")}>暂停此实验</button>}
        <button type="button" disabled={!!busy||pausePending} onClick={()=>void load(task.id)}>重新读取任务</button>
        <button type="button" disabled={!!busy||pausePending} onClick={()=>{selected.current="";lastRevision.current=-1;remember("");setTask(null);setError("");setNote("");setConsent(false);}}>新建另一个实验</button>
      </div>
      {best&&<div className="coding-source"><h4>{task.status==="review_ready"?"候选源码 · 待人工审阅":"保留的部分候选 · 尚未通过全部用例"}</h4><p>指纹 <code>{best.sourceHash}</code>。这里只显示文本，不安装、不发布、不写入职业资料；通过示例不等于普遍正确。</p>
        <pre><code>{best.source}</code></pre><button type="button" onClick={async()=>{try{await navigator.clipboard.writeText(best.source);if(alive())setNote("已复制候选文本。");}catch{if(alive())setError("无法写入剪贴板；可以手动选择上方代码复制。");}}}>复制候选文本</button></div>}
    </div>}
    {error&&<p className="coding-error" role="alert">{error}</p>}{note&&<p role="status">{note}</p>}
  </section>;
}
function detail(e:unknown){return e instanceof CodingHttpError?`（HTTP ${e.status}：${e.code}）`:e instanceof Error?`（${e.message}）`:"";}
