import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Compass, FileText, Play, RotateCcw, ShieldCheck, Sparkles, X } from "lucide-react";
import { AGENT_LESSONS, readTutorial, tutorialInstruction, tutorialStorage, writeTutorial, type AgentLesson } from "../lib/agent-tutorial";
import { SpotlightGuide, useGuideEffects } from "./SpotlightGuide";
import "./agent-workflow-guide.css";
export { AGENT_LESSONS, type AgentLesson } from "../lib/agent-tutorial";

// Point to a specific entry/title rather than boxing an entire scrolling sidebar on a phone.
const entries: Record<string, string> = { "writing-note": ".writing-source", "agent-reader": "select", "understanding-summary": "h3", "contribution-review": "h3" };
const targets = AGENT_LESSONS.map(lesson => lesson.targets.flatMap(name => {
  const root = '[data-agent-guide="' + name + '"]';
  return entries[name] ? [root + " " + entries[name], root] : [root];
}));

export function AgentWorkflowGuide({ step, active = true, storageKey = "betterme.agent-tutorial.v1:standalone", onStep, onClose, onAction, onDirectory }: {
  step: number; active?: boolean; storageKey?: string; onStep: (step: number) => void; onClose: () => void;
  onDirectory?: () => void;
  onAction: (destination: "writing" | "memory" | "settings", lesson: AgentLesson) => void;
}) {
  const { setEffects, reduced, animated } = useGuideEffects();
  const [progress, setProgress] = useState(() => readTutorial(tutorialStorage(), storageKey));
  const [storageWarning, setStorageWarning] = useState(false);
  const [answers, setAnswers] = useState<Partial<Record<AgentLesson, number>>>({});
  const [candidate, setCandidate] = useState(false), [undone, setUndone] = useState(false);
  const [correction, setCorrection] = useState("");
  const index = Math.max(0, Math.min(AGENT_LESSONS.length - 1, step)), lesson = AGENT_LESSONS[index]!;
  const dialog = useRef<HTMLDialogElement>(null), progressRef = useRef(progress);
  function remember(practiced = false) {
    const previous = progressRef.current;
    const next = { ...previous, current: lesson.id, viewed: [...new Set([...previous.viewed, lesson.id])], practiced: practiced ? [...new Set([...previous.practiced, lesson.id])] : previous.practiced };
    progressRef.current = next; setProgress(next); setStorageWarning(!writeTutorial(tutorialStorage(), storageKey, next));
  }
  useEffect(() => {
    if (!active) return;
    const previous = progressRef.current;
    const next = { ...previous, current: lesson.id, viewed: [...new Set([...previous.viewed, lesson.id])] };
    progressRef.current = next; setProgress(next); setStorageWarning(!writeTutorial(tutorialStorage(), storageKey, next));
  }, [lesson.id, storageKey, active]);
  function close() { dialog.current?.close(); onClose(); }
  function navigate(next: number) { onStep(Math.max(0, Math.min(AGENT_LESSONS.length - 1, next))); }
  const selected = answers[lesson.id], tried = progress.practiced.includes(lesson.id);
  if (!active) return null;
  return <SpotlightGuide dialogRef={dialog} stepId={lesson.id} targets={targets[index]!} titleId="agent-tutorial-title" descriptionId="agent-tutorial-description" animated={animated} className="agent-workflow-guide" onClose={close} onNavigate={offset => navigate(index + offset)}>{selector => <>
    <header className="guide-top"><span><span className="guide-brand-dot" />BETTERME <b>/ 协作引导</b></span><button type="button" className="guide-icon-button" aria-label="返回工作" title="返回工作，保留当前章节" onClick={close}><X size={18} /></button></header>
    <article className="guide-copy agent-tutorial-content" key={lesson.id} aria-labelledby="agent-tutorial-title">
      {onDirectory && <button type="button" className="agent-guide-directory" onClick={() => { dialog.current?.close(); onDirectory(); }}><ArrowLeft size={14} />所有主题</button>}
      <div className="guide-chapter"><Sparkles size={14} />{String(index + 1).padStart(2, "0")} / {lesson.label}</div>
      <h2 id="agent-tutorial-title" tabIndex={-1}>{lesson.title}</h2>
      <p id="agent-tutorial-description">{lesson.result}</p>
      <div className="guide-hint agent-tutorial-location"><Compass size={16} /><span>{tutorialInstruction(lesson.id, selector?.match(/"([^"]+)"/)?.[1] ?? "")}</span></div>
      <button type="button" className="guide-primary agent-guide-action" onClick={() => { remember(); dialog.current?.close(); onAction(lesson.destination, lesson.id); }}>{lesson.action}<ArrowRight size={15} /></button>
      <small className="agent-tutorial-safe">只定位，不替你授权、发送或采用。</small>
      <details className="agent-tutorial-practice"><summary><Play size={13} />用示例了解这一步<span>不使用你的资料</span></summary>
        <section aria-label="安全示例练习">
        <ol className="agent-tutorial-steps">{lesson.steps.map(text => <li key={text}>{text}</li>)}</ol>
        <p className="agent-tutorial-caution"><ShieldCheck size={14} />{lesson.caution}</p>
        {lesson.id === "annotation" ? <><div className="agent-tutorial-annotation-demo"><div><FileText size={15} /><span>{candidate ? "编写接口重试与边界校验，补充失败场景测试。" : "参与接口开发。"}</span><i /></div><div><small>示例旁批</small>{candidate ? "候选只来自本人补充，没有添加未知数字。" : "你实际做了哪部分？如何验证？"}</div></div><p>{lesson.prompt}</p>
          <button type="button" className="guide-secondary" onClick={() => { if (candidate) { setCandidate(false); setUndone(true); remember(true); } else { setCandidate(true); setUndone(false); } }}>{candidate ? <><RotateCcw size={13} />撤销示例修改</> : "查看示例候选"}</button><p role="status" className="agent-tutorial-feedback">{undone ? "示例已恢复原文。真实简历没有改变。" : candidate ? "这只是可编辑候选，还不是已采用的简历内容。" : "虚线表示来源关联，不代表内容已被自动采用。"}</p></>
          : <><p>{lesson.prompt}</p><div className="agent-tutorial-choices">{lesson.choices.map((choice, position) => <button type="button" key={choice} aria-pressed={selected === position} onClick={() => { setAnswers(current => ({ ...current, [lesson.id]: position })); if (position === lesson.correct) remember(true); }}>{choice}{selected === position && position === lesson.correct && <Check size={13} />}</button>)}</div>
          {lesson.id === "dialogue" && selected === lesson.correct && <label className="agent-tutorial-freeform">也可以这样自由补充（仅示例，不发送）<textarea rows={2} maxLength={400} value={correction} onChange={event => setCorrection(event.target.value)} placeholder="例如：这里的调度只指任务编排，不包括车辆路径规划。" /></label>}
          {selected !== undefined && <p className="agent-tutorial-feedback" role="status">{selected === lesson.correct ? lesson.feedback : "可以再试一次。先保留事实与用户控制，再决定下一步，不需要为了练习去改变真实设置。"}</p>}</>}
        <small className="agent-tutorial-practice-state">{tried ? <><Check size={12} />这节示例已练习，可重复查看</> : "练习可跳过，不限制你使用正式功能"}</small>
        </section>
      </details>
      {storageWarning && <p className="agent-tutorial-warning" role="status">教程进度仅在本页保留；浏览器未能保存。不会影响你的工作或阻止退出。</p>}
    </article>
    <footer className="guide-footer">
      <nav className="guide-progress" aria-label="协作引导步骤">{AGENT_LESSONS.map((item, position) => <button key={item.id} type="button" aria-current={index === position ? "step" : undefined} className={progress.viewed.includes(item.id) ? "is-reached" : ""} onClick={() => navigate(position)} aria-label={"第 " + (position + 1) + " 节：" + item.title} title={item.label}><span />{item.label}</button>)}</nav>
      <div className="guide-actions"><button type="button" className="guide-secondary" onClick={() => index === 0 ? close() : navigate(index - 1)}>{index === 0 ? "稍后再说" : <><ArrowLeft size={15} />上一步</>}</button><button type="button" className="guide-secondary" onClick={() => index === AGENT_LESSONS.length - 1 ? close() : navigate(index + 1)}>{index === AGENT_LESSONS.length - 1 ? "完成引导，返回工作" : "下一步"}<ArrowRight size={17} /></button></div>
      <div className="guide-utilities"><label><input type="checkbox" checked={animated} disabled={reduced} onChange={event => setEffects(event.target.checked)} />{reduced ? "跟随系统 · 减少动效" : "沉浸动效"}</label><span>{index + 1} / {AGENT_LESSONS.length}</span><button type="button" onClick={() => index === AGENT_LESSONS.length - 1 ? close() : navigate(index + 1)}>{index === AGENT_LESSONS.length - 1 ? "返回工作" : "跳过本步"}</button></div>
    </footer>
  </>}</SpotlightGuide>;
}
