import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { captureIdentityLease, capturePrivateStorage } from "../lib/identity";
import { useUiPreferences } from "../lib/ui-preferences";
import { CodingHttpError, CodingInputSchema, sandboxCodingClient, validCodingModelName, type CodingInput, type CodingSummary, type CodingTask, type SandboxCodingClient } from "../services/sandbox-coding-client";
import "./sandbox-coding-lab.css";

const pointer = "sandbox-coding.active.v1";
const example = JSON.stringify([{id:"zero",input:0,expected:0},{id:"positive",input:3,expected:6}],null,2);
const identities=new WeakMap<AbortSignal,number>(); let sequence=0;
function identitySnapshot(){const l=captureIdentityLease();return l.signal.aborted||!l.ownerId?null:l.signal;}
function subscribeIdentity(notify:()=>void){
  const {signal}=captureIdentityLease();let live=true;
  const change=()=>{notify();queueMicrotask(()=>{if(live)notify();});};signal.addEventListener("abort",change);
  return ()=>{live=false;signal.removeEventListener("abort",change);};
}
export function SandboxCodingLab({client=sandboxCodingClient}:{client?:SandboxCodingClient}){
  const {t}=useUiPreferences();
  const generation=useSyncExternalStore(subscribeIdentity,identitySnapshot,()=>null);
  if(!generation)return <section className="coding-lab"><h3>{t("本地模型编码实验台","Local model coding lab")}</h3><p>{t("请先登录当前账号；不会读取或跨账号显示任务。","Sign in to the current account. Tasks are never read or shown across accounts.")}</p></section>;
  if(!identities.has(generation))identities.set(generation,++sequence);
  return <Lab key={identities.get(generation)} client={client}/>;
}
function Lab({client}:{client:SandboxCodingClient}){
  const {t}=useUiPreferences();
  const labels:Record<CodingTask["status"],string>={ready:t("可推进","Ready"),running:t("宿主运行中","Running on Host"),paused:t("已暂停","Paused"),interrupted:t("上轮中断","Last run interrupted"),budget_exhausted:t("预算已耗尽","Budget exhausted"),review_ready:t("候选待审阅","Candidate ready for review")};
  const outcomes:Record<NonNullable<CodingTask["lastAttempt"]>["outcome"],string>={running:t("宿主正在执行","Host is running"),accepted:t("本轮候选已保留","Candidate retained"),regression:t("拒绝回归，保留上一版","Regression rejected; previous version retained"),failed:t("本轮失败","Run failed"),interrupted:t("本轮中断","Run interrupted")};
  const stopReasons:Record<string,string>={coding_review_ready:t("固定用例已全部通过，等待人工审阅","All fixed cases passed; awaiting human review"),coding_budget_exhausted:t("轮数或主动用时预算已用完","Attempt or active-time budget exhausted"),
    coding_lease_invalid:t("运行授权已失效","Run authorization expired"),coding_model_digest_changed:t("本机模型的指纹已变化，未切换模型","Local model fingerprint changed; no model was switched"),coding_manually_paused:t("已按你的要求暂停","Paused at your request"),
    coding_host_stopped:t("宿主已关闭","Host stopped"),coding_host_restarted:t("宿主重启，原授权没有恢复","Host restarted; the prior authorization was not restored"),coding_auto_outcome_unknown:t("上一轮结果不确定，已停止","The previous outcome is unknown; execution stopped")};
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
    catch{if(alive()&&!signal?.aborted&&catalogNumber.current===n)setCatalogError(t("无法读取本账号的任务目录；可重试，不会调用模型。","Could not read this account’s task catalog. You can retry; no model will be called."));}
  }
  async function load(id:string,signal?:AbortSignal){
    const n=++requestNumber.current;selected.current=id;lastRevision.current=-1;setTask(null);setError("");setNote("");setBusy("load");
    try{const result=await client.get(id,signal);if(alive()&&!signal?.aborted&&n===requestNumber.current)accept(result);}
    catch{if(alive()&&!signal?.aborted&&n===requestNumber.current)setError(t("无法读取这个任务。请从本账号的目录重新选择；没有重跑模型。","Could not read this task. Select it again from this account’s catalog; the model was not rerun."));}
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
    if(!goal.trim()||!model.trim())return {reason:t("填写通用目标和本机已安装的 Ollama 模型名。","Enter a generic goal and the name of an installed local Ollama model.")};
    if(!validCodingModelName(model))return {reason:t("只接受本机 Ollama 模型名，不接受 URL 或云端别名。","Only a local Ollama model name is accepted, not a URL or cloud alias.")};
    if(!Number.isInteger(Number(seconds))||Number(seconds)<1||Number(seconds)>300)return {reason:t("累计主动用时需为 1–300 个整秒；等待人工操作不扣。","Cumulative active time must be 1–300 whole seconds; waiting for human input is not counted.")};
    try{const parsed=CodingInputSchema.safeParse({goal,model,cases:JSON.parse(fixtures),maxAttempts:Number(attempts),maxActiveMs:Number(seconds)*1000,consent:true});
      return parsed.success?{input:parsed.data}:{reason:t("用例需 1–12 个，每项包含唯一英文或数字 id、input、expected；每个输入及预期 ≤32 KiB、合计 ≤64 KiB，尝试上限 1–8。","Provide 1–12 cases with unique alphanumeric IDs, input, and expected values. Each input and expected value must be ≤32 KiB, ≤64 KiB total, with 1–8 attempts.")};}
    catch{return {reason:t("用例不是有效的 JSON 数组。","Cases must be a valid JSON array.")};}
  }
  const validation=validate();
  async function create(){
    if(locked.current||!alive()||!consent||!validation.input)return;
    locked.current=true;setBusy("create");setError("");setNote("");setConsent(false);
    try{const item=await client.create(validation.input);if(!alive())return;selected.current=item.id;lastRevision.current=-1;accept(item);setNote(t("实验已创建；尚未推进模型。","Experiment created; the model has not been advanced."));}
    catch(e){if(alive())setError(t("未确认创建。先刷新任务目录再决定是否重试，未自动重发。","Creation was not confirmed. Refresh the task catalog before deciding whether to retry; nothing was resent automatically.")+detail(e));}
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
      setError((conflict?t("版本冲突；只重新读取宿主状态，不会再次调用模型。","Revision conflict. Only the Host state will be reread; the model will not be called again."):t("未能确认本次操作。只读取宿主状态，不自动重试。","This operation could not be confirmed. Only the Host state will be read; no automatic retry."))+detail(e));
      try{accept(await client.get(id));}catch{/* Unknown stays unknown; user can refresh. */}
    }finally{if(kind!=="pause"){locked.current=false;if(alive())setBusy("");}else{pausing.current=false;if(alive())setPausePending(false);}}
  }
  const last=task?.lastAttempt,best=task?.best;
  const canStep=!!task&&!task.autoRunning&&["ready","paused","interrupted"].includes(task.status)&&task.attemptsUsed<task.maxAttempts&&task.activeMs<task.maxActiveMs;
  const changeForm=(fn:()=>void)=>{fn();setConsent(false);setNote("");};
  return <section className="coding-lab" aria-label={t("本地模型编码实验台","Local model coding lab")}>
    <header><h3>{t("本地模型编码实验台","Local model coding lab")}</h3><p>{t("让本机 Ollama 编写一个同步 JSON 转换函数，用你给的固定用例逐轮验证。只处理合成示例；不要输入真实简历、个人记录、密钥或内网地址。","Have local Ollama write a synchronous JSON transform and verify it round by round against your fixed cases. Use synthetic examples only; do not enter real resumes, personal records, secrets, or internal addresses.")}</p></header>
    <details><summary>{t(`本账号的实验（${entries.length}）`,`Experiments for this account (${entries.length})`)}</summary>
      <div className="coding-actions"><button type="button" onClick={()=>void list()}>{t("刷新任务目录","Refresh task catalog")}</button></div>
      {entries.map(item=><button type="button" className="coding-history" key={item.id} disabled={!!busy||pausePending} onClick={()=>void load(item.id)}>{item.goal} · {item.autoRunning?t("连续修复中","Continuous repair running"):labels[item.status]}</button>)}
    </details>
    {catalogError&&<p role="status">{catalogError}</p>}
    {!task&&busy!=="load"&&<div className="coding-form">
      <label>{t("通用目标","Generic goal")}<textarea name="coding-goal" maxLength={4000} placeholder={t("例如：将输入的合成数字乘以二，返回一个数字。","Example: multiply a synthetic input number by two and return a number.")} value={goal} onChange={e=>changeForm(()=>setGoal(e.target.value))}/></label>
      <label>{t("本机 Ollama 模型名","Local Ollama model name")}<input name="coding-model" value={model} onChange={e=>changeForm(()=>setModel(e.target.value))}/></label>
      <div className="coding-bounds"><label>{t("最多尝试几轮","Maximum attempts")}<input name="coding-attempts" type="number" min={1} max={8} value={attempts} onChange={e=>changeForm(()=>setAttempts(e.target.value))}/></label>
        <label>{t("累计主动用时（秒）","Cumulative active time (seconds)")}<input name="coding-seconds" type="number" min={1} max={300} step={1} value={seconds} onChange={e=>changeForm(()=>setSeconds(e.target.value))}/></label></div>
      <label>{t("固定合成用例（JSON 数组）","Fixed synthetic cases (JSON array)")}<textarea name="coding-cases" spellCheck={false} rows={5} value={fixtures} maxLength={70000} onChange={e=>changeForm(()=>setFixtures(e.target.value))}/></label>
      <small>{validation.reason??t("创建后固定这些输入和预期结果。等待人工操作不扣主动用时；任务开始后关闭窗口不等于暂停。你可再授权单轮调用或连续修复。","These inputs and expected results are fixed after creation. Waiting for human input does not count as active time, and closing the window does not pause a started task. You can authorize one round or continuous repair separately.")}</small>
      <label className="coding-grant"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>{t("我确认这些都是合成数据，并授权保存本账号的实验","I confirm that all data is synthetic and authorize saving this experiment to my account")}{validation.input&&t(`：最多 ${validation.input.maxAttempts} 轮、累计主动用时 ${validation.input.maxActiveMs/1000} 秒`,`: up to ${validation.input.maxAttempts} attempts and ${validation.input.maxActiveMs/1000} seconds of cumulative active time`)}{t("。",".")}</label>
      <div><button className="coding-primary" type="button" disabled={!validation.input||!consent||!!busy} onClick={()=>void create()}>{t("创建实验（不调用模型）","Create experiment (no model call)")}</button></div>
    </div>}
    {busy==="load"&&<p role="status">{t("正在读取本账号的实验…","Reading this account’s experiments…")}</p>}
    {task&&<div className="coding-task"><h4>{task.goal}</h4><p><strong>{task.autoRunning?t("连续修复中","Continuous repair running"):labels[task.status]}</strong> · {task.model} · {t(`已用 ${task.attemptsUsed}/${task.maxAttempts} 轮`,`Used ${task.attemptsUsed}/${task.maxAttempts} attempts`)} · {t(`主动用时 ${Math.ceil(task.activeMs/1000)}/${Math.ceil(task.maxActiveMs/1000)} 秒`,`Active time ${Math.ceil(task.activeMs/1000)}/${Math.ceil(task.maxActiveMs/1000)} seconds`)}</p>
      <details><summary>{t("任务编号与模型指纹","Task ID and model fingerprint")}</summary><p><code>{task.id}</code><br/><code>{task.modelDigest}</code> · {t(`任务版本 ${task.revision}`,`Task revision ${task.revision}`)}</p></details>
      <h4>{t("固定验收清单","Fixed acceptance checklist")}</h4><ol>{task.cases.map(c=>{const accepted=best?.checks.find(i=>i.id===c.id),latest=last?.checks.find(i=>i.id===c.id);return <li key={c.id}><strong>{c.id}</strong> · {t("保留版本：","Retained version: ")}{accepted?(accepted.passed?t("通过","passed"):t("未通过","failed")):t("未验证","not verified")}{latest&&<> · {t("最近一轮：","Latest run: ")}{latest.passed?t("通过","passed"):t("失败","failed")}{latest.error&&<>（{latest.error}）</>}</>}<details><summary>{t("查看输入与预期","View input and expected result")}</summary><pre>{JSON.stringify({input:c.input,expected:c.expected},null,2)}</pre></details></li>;})}</ol>
      {last&&<p role="status">{t(`第 ${last.number} 轮 · 目标用例 ${last.targetCaseId}`,`Attempt ${last.number} · Target case ${last.targetCaseId}`)} · {outcomes[last.outcome]}{last.error&&<>：{last.error}</>}</p>}
      {task.history&&task.history.length>0&&<details><summary>{t(`逐轮记录（${task.history.length}）`,`Attempt history (${task.history.length})`)}</summary>
        <ol>{task.history.map(h=><li key={h.number}>{t(`第 ${h.number} 轮 · 目标 ${h.targetCaseId}`,`Attempt ${h.number} · Target ${h.targetCaseId}`)} · {outcomes[h.outcome]} · {h.passedIds.length+h.failedIds.length
          ? t(`检查通过 ${h.passedIds.length}/${task.cases.length}`,`Checks passed ${h.passedIds.length}/${task.cases.length}`) : t("没有完成检查","No checks completed")} · {h.activeMs} ms{h.error&&<>（{h.error}）</>}</li>)}</ol>
      </details>}
      {busy==="step"&&<p role="status">{t("正在等待宿主返回本轮结果。关闭面板不会额外发起一轮；返回可从目录核对。","Waiting for the Host to return this attempt. Closing the panel will not start another attempt; reopen the catalog to verify the result.")}</p>}
      {task.autoRunning&&<p role="status"><strong>{t("连续修复授权中。","Continuous repair is authorized.")}</strong> {t("宿主会在授权范围内推进；关闭面板不等于暂停，重新打开只读取进度。可随时暂停。","The Host will advance within the grant. Closing the panel does not pause it; reopening only reads progress. You can pause at any time.")}</p>}
      {!task.autoRunning&&task.autoStopReason&&<p>{t("连续修复已停止：","Continuous repair stopped: ")}<span title={task.autoStopReason}>{stopReasons[task.autoStopReason]??t(`宿主已停止本次授权（${task.autoStopReason}）`,`Host stopped this authorization (${task.autoStopReason})`)}</span>{t("。不会自动续跑。",". It will not resume automatically.")}</p>}
      {canStep&&<p>{t("授权范围：仅向本机 Ollama 端点的","Grant scope: send only to the local Ollama endpoint for")} <strong>{task.model}</strong> {t(`提交通用目标、固定合成用例、此前候选源码及逐例结果；最多还可用 ${task.maxAttempts-task.attemptsUsed} 轮，剩余主动用时不超过 ${Math.ceil((task.maxActiveMs-task.activeMs)/1000)} 秒。连续模式在待审、预算耗尽、暂停、撤权或宿主中断后停止，不安装候选。`,`the generic goal, fixed synthetic cases, prior candidate source, and per-case results. Up to ${task.maxAttempts-task.attemptsUsed} attempts and ${Math.ceil((task.maxActiveMs-task.activeMs)/1000)} seconds of active time remain. Continuous mode stops for review, exhausted budget, pause, revoked access, or Host interruption, and never installs the candidate.`)}</p>}
      <div className="coding-actions">
        {canStep&&<><button className="coding-primary" type="button" disabled={!!busy||pausePending} onClick={()=>void act("run")}>{t("授权连续修复至待审","Authorize continuous repair until review")}</button>
          <button type="button" disabled={!!busy||pausePending} onClick={()=>void act("step")}>{t(`授权调用 ${task.model} 一轮`,`Authorize one ${task.model} attempt`)}</button></>}
        {(task.status==="running"||task.autoRunning)&&<button type="button" disabled={pausePending} onClick={()=>void act("pause")}>{t("暂停此实验","Pause this experiment")}</button>}
        <button type="button" disabled={!!busy||pausePending} onClick={()=>void load(task.id)}>{t("重新读取任务","Reread task")}</button>
        <button type="button" disabled={!!busy||pausePending} onClick={()=>{selected.current="";lastRevision.current=-1;remember("");setTask(null);setError("");setNote("");setConsent(false);}}>{t("新建另一个实验","Create another experiment")}</button>
      </div>
      {best&&<div className="coding-source"><h4>{task.status==="review_ready"?t("候选源码 · 待人工审阅","Candidate source · Awaiting human review"):t("保留的部分候选 · 尚未通过全部用例","Retained partial candidate · Not all cases pass")}</h4><p>{t("指纹","Fingerprint")} <code>{best.sourceHash}</code>{t("。这里只显示文本，不安装、不发布、不写入职业资料；通过示例不等于普遍正确。",". This is text-only: it is not installed, published, or written into career records. Passing examples does not prove general correctness.")}</p>
        <pre><code>{best.source}</code></pre><button type="button" onClick={async()=>{try{await navigator.clipboard.writeText(best.source);if(alive())setNote(t("已复制候选文本。","Candidate text copied."));}catch{if(alive())setError(t("无法写入剪贴板；可以手动选择上方代码复制。","Could not write to the clipboard; select and copy the code above manually."));}}}>{t("复制候选文本","Copy candidate text")}</button></div>}
    </div>}
    {error&&<p className="coding-error" role="alert">{error}</p>}{note&&<p role="status">{note}</p>}
  </section>;
}
function detail(e:unknown){return e instanceof CodingHttpError?`（HTTP ${e.status}：${e.code}）`:e instanceof Error?`（${e.message}）`:"";}
