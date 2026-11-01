import { useEffect, useRef, useState } from "react";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { practiceBundle, practiceEvidence, readPracticeBundle, runPractice, TRANSITION_EXERCISE } from "../lib/career-coach/practice";
import type { PracticeReceipt } from "../lib/career-coach/types";

export function CareerPractice({ source, onSource, onReceipt, disabled }: {
  source: string | undefined; onSource: (value: string) => void;
  onReceipt: (receipt: PracticeReceipt, evidence: string) => boolean; disabled: boolean;
}) {
  const { agent } = useBetterMeAgent();
  const code = source ?? TRANSITION_EXERCISE.starter;
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [receipt, setReceipt] = useState<PracticeReceipt>();
  const active = useRef<{ controller: AbortController; id: string } | undefined>(undefined);
  const latest = useRef({ code, onReceipt }); latest.current = { code, onReceipt };
  useEffect(() => () => { active.current?.controller.abort(); if (active.current) void agent?.stop(active.current.id); }, [agent]);
  const run = async () => {
    if (!consent || active.current || disabled) return;
    const controller = new AbortController(), id = crypto.randomUUID();
    active.current = { controller, id }; setBusy(true); setError(""); setReceipt(undefined);
    const submitted = code;
    try {
      const produce = (signal: AbortSignal) => runPractice(submitted, AbortSignal.any([signal, controller.signal]));
      const result = agent ? await agent.run({ id, origin: "growth", label: "隔离实践 · 状态迁移", input: "本人运行已选练习代码；不发送给模型。", destination: "浏览器隔离沙盒 · 无网络", shareMemories: false, execution: "local" },
        signal => produce(signal), value => `${value.checks.filter(item => item.passed).length}/${value.checks.length} 项练习测试通过；不是能力认证。`) : await produce(controller.signal);
      if (controller.signal.aborted) return;
      if (!latest.current.onReceipt(result, practiceEvidence(result))) throw new Error("测试已运行，但回执未能加入当前任务。代码保留，请先核对页面的保存或计划状态。");
      setReceipt(result);
    } catch (failure) { setError(controller.signal.aborted ? "练习已停止，代码保留；未生成成绩。" : failure instanceof Error ? failure.message : "练习失败，代码保留。"); }
    finally { if (active.current?.id === id) { active.current = undefined; setBusy(false); } }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([practiceBundle(code)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "betterme-state-transitions-v1.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="coach-compose" aria-label="隔离代码实践">
    <details><summary>动手练习 · {TRANSITION_EXERCISE.title}</summary>
      <p className="coach-note">原创练习 v1 · {TRANSITION_EXERCISE.language}。仅当它适合当前任务时使用；测试通过不代表任务的全部验收条件完成。</p>
      <p>{TRANSITION_EXERCISE.instructions}</p>
      <p className="coach-note"><a href={TRANSITION_EXERCISE.resources[0].url} target="_blank" rel="noreferrer">{TRANSITION_EXERCISE.resources[0].title}</a> · 官方参考链接，不宣称实时联网核验。</p>
      <label>练习代码<textarea aria-label="练习代码" className="coach-code" spellCheck={false} rows={10} value={code} maxLength={20000} disabled={busy || disabled} onChange={event => onSource(event.target.value)} /></label>
      <div className="coach-inline-actions"><button type="button" onClick={download}>导出练习文件</button><label className="coach-import">导入本练习 JSON<input type="file" accept=".json,application/json" disabled={busy || disabled} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (file.size > 128000) { setError("练习文件超过 128 KB；没有读取或执行。"); return; }
        void file.text().then(raw => { onSource(readPracticeBundle(raw)); setReceipt(undefined); setError(""); }).catch(failure => setError(failure instanceof Error ? failure.message : "练习文件无法读取。"));
      }} /></label></div>
      <label className="coach-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />我确认这段代码是本次练习，关联到当前任务并仅在浏览器隔离沙盒运行</label>
      <small>无文件系统、业务项目或模型访问；禁用网络，执行上限 2 秒。仅支持小型 JavaScript 函数练习，不是本机 C# / 项目运行器；不支持时明确失败，不降级到主页面执行。</small>
      <div className="coach-inline-actions"><button type="button" className="coach-primary" disabled={!consent || busy || disabled} onClick={() => void run()}>{busy ? "正在执行实际测试…" : "运行并保存练习回执"}</button>
        {busy && <button type="button" onClick={() => active.current?.controller.abort()}>停止练习</button>}</div>
      {error && <p role="alert" className="coach-alert">{error}</p>}
      {receipt && <div className="coach-feedback" role="status"><strong>实际测试：{receipt.checks.filter(item => item.passed).length}/{receipt.checks.length} 通过 · 0 跳过</strong>
        <p>回执与提交代码已关联当前任务；尚不等于完整能力证明。</p>
        <details><summary>逐项依据与代码指纹</summary><code>{receipt.sourceHash}</code>{receipt.checks.map(check => <p key={check.name}>{check.passed ? "通过" : "失败"} {check.name} · 实际 {check.actual} · 期望 {check.expected}</p>)}</details>
      </div>}
    </details>
  </section>;
}
