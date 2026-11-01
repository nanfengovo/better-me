import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Compass, FileText, Play, RotateCcw, ShieldCheck } from "lucide-react";
import { AGENT_LESSONS, readTutorial, tutorialStorage, writeTutorial, type AgentLesson } from "../lib/agent-tutorial";
import "./agent-workflow-guide.css";
export { AGENT_LESSONS, type AgentLesson } from "../lib/agent-tutorial";

export function AgentWorkflowGuide({ step, active = true, storageKey = "betterme.agent-tutorial.v1:standalone", onStep, onClose, onAction }: {
  step: number; active?: boolean; storageKey?: string; onStep: (step: number) => void; onClose: () => void;
  onAction: (destination: "writing" | "memory" | "settings", lesson: AgentLesson) => void;
}) {
  const [keyboard, setKeyboard] = useState(false), [effects, setEffects] = useState(true);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [progress, setProgress] = useState(() => readTutorial(tutorialStorage(), storageKey));
  const [storageWarning, setStorageWarning] = useState(false);
  const [answers, setAnswers] = useState<Partial<Record<AgentLesson, number>>>({});
  const [candidate, setCandidate] = useState(false), [undone, setUndone] = useState(false);
  const [correction, setCorrection] = useState("");
  const index = Math.max(0, Math.min(AGENT_LESSONS.length - 1, step)), lesson = AGENT_LESSONS[index]!;
  const heading = useRef<HTMLHeadingElement>(null), content = useRef<HTMLElement>(null), animation = useRef<Animation | null>(null);
  const progressRef = useRef(progress);
  function remember(practiced = false) {
    const previous = progressRef.current;
    const next = { ...previous, current: lesson.id, viewed: [...new Set([...previous.viewed, lesson.id])], practiced: practiced ? [...new Set([...previous.practiced, lesson.id])] : previous.practiced };
    progressRef.current = next; setProgress(next); setStorageWarning(!writeTutorial(tutorialStorage(), storageKey, next));
  }
  useEffect(() => {
    if (!active) return;
    if (content.current) content.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
    const previous = progressRef.current;
    const next = { ...previous, current: lesson.id, viewed: [...new Set([...previous.viewed, lesson.id])] };
    progressRef.current = next; setProgress(next); setStorageWarning(!writeTutorial(tutorialStorage(), storageKey, next));
  }, [lesson.id, storageKey, active]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { animation.current?.cancel(); setReduced(media.matches); };
    media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, []);
  // Reuse the workspace tour's interruptible WAAPI entrance, never animate work itself.
  useEffect(() => {
    animation.current?.cancel();
    const cancel = () => animation.current?.cancel();
    if (active && !keyboard && effects && !reduced && content.current?.animate) {
      animation.current = content.current.animate([{ opacity: .55, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      void animation.current.finished.catch(() => {});
    }
    return cancel;
  }, [lesson.id, keyboard, effects, reduced, active]);
  const selected = answers[lesson.id], tried = progress.practiced.includes(lesson.id);
  return <section className="agent-workflow-guide" data-keyboard={keyboard} data-effects={effects && !reduced && active} onKeyDownCapture={() => setKeyboard(true)} onPointerDownCapture={() => setKeyboard(false)} aria-label="Agent 协作教程">
    <header className="agent-tutorial-header"><div><span><Compass size={14} />协作教程 · {index + 1} / {AGENT_LESSONS.length}</span><small>已看 {progress.viewed.length} 节 · 已练习 {progress.practiced.length} 节</small></div><button type="button" onClick={onClose}>返回工作</button></header>
    <nav className="agent-tutorial-progress" aria-label="教程章节">{AGENT_LESSONS.map((item, position) => <button key={item.id} type="button" aria-current={index === position ? "step" : undefined} data-viewed={progress.viewed.includes(item.id)} onClick={() => onStep(position)} aria-label={`第 ${position + 1} 节：${item.title}`} title={item.label}><span>{progress.practiced.includes(item.id) ? <Check size={12} /> : position + 1}</span><small>{item.label}</small></button>)}</nav>
    <details className="agent-tutorial-directory"><summary>按需要选择章节<ChevronDown size={13} /></summary><div>{AGENT_LESSONS.map((item, position) => <button type="button" key={item.id} aria-current={index === position ? "step" : undefined} onClick={event => { onStep(position); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{position + 1}. {item.label}<span>{progress.practiced.includes(item.id) ? "已练习" : progress.viewed.includes(item.id) ? "已看" : "未看"}</span></button>)}</div></details>
    <article ref={content} className="agent-tutorial-content" aria-labelledby="agent-tutorial-title">
      <div className="agent-tutorial-chapter">{String(index + 1).padStart(2, "0")} / {lesson.label}</div><h3 id="agent-tutorial-title" tabIndex={-1} ref={heading}>{lesson.title}</h3>
      <div className="agent-tutorial-outcome"><ShieldCheck size={15} /><p>{lesson.result}</p></div>
      <ol className="agent-tutorial-steps">{lesson.steps.map((text, position) => <li key={text}><span>{position + 1}</span>{text}</li>)}</ol>
      <section className="agent-tutorial-practice" aria-label="安全示例练习"><div className="agent-tutorial-practice-label"><Play size={13} />在示例中试一下<span>不使用你的资料</span></div>
        {lesson.id === "annotation" ? <><div className="agent-tutorial-annotation-demo"><div><FileText size={15} /><span>{candidate ? "编写接口重试与边界校验，补充失败场景测试。" : "参与接口开发。"}</span><i /></div><div><small>示例旁批</small>{candidate ? "候选只来自本人补充，没有添加未知数字。" : "你实际做了哪部分？如何验证？"}</div></div><p>{lesson.prompt}</p>
          <button type="button" onClick={() => { if (candidate) { setCandidate(false); setUndone(true); remember(true); } else { setCandidate(true); setUndone(false); } }}>{candidate ? <><RotateCcw size={13} />撤销示例修改</> : "查看示例候选"}</button><p role="status" className="agent-tutorial-feedback">{undone ? "示例已恢复原文。真实简历没有改变。" : candidate ? "这只是可编辑候选，还不是已采用的简历内容。" : "虚线表示来源关联，不代表内容已被自动采用。"}</p></>
          : <><p>{lesson.prompt}</p><div className="agent-tutorial-choices">{lesson.choices.map((choice, position) => <button type="button" key={choice} aria-pressed={selected === position} onClick={() => { setAnswers(current => ({ ...current, [lesson.id]: position })); if (position === lesson.correct) remember(true); }}>{choice}{selected === position && position === lesson.correct && <Check size={13} />}</button>)}</div>
          {lesson.id === "dialogue" && selected === lesson.correct && <label className="agent-tutorial-freeform">也可以这样自由补充（仅示例，不发送）<textarea rows={2} maxLength={400} value={correction} onChange={event => setCorrection(event.target.value)} placeholder="例如：这里的调度只指任务编排，不包括车辆路径规划。" /></label>}
          {selected !== undefined && <p className="agent-tutorial-feedback" role="status">{selected === lesson.correct ? lesson.feedback : "可以再试一次。先保留事实与用户控制，再决定下一步，不需要为了练习去改变真实设置。"}</p>}</>}
        <small className="agent-tutorial-practice-state">{tried ? <><Check size={12} />这节示例已练习，可重复查看</> : "练习可跳过，不限制你使用正式功能"}</small>
      </section>
      <p className="agent-tutorial-caution">{lesson.caution}</p>
      <button type="button" className="agent-guide-action" onClick={() => { remember(); onAction(lesson.destination, lesson.id); }}><Compass size={15} />{lesson.action}<ArrowRight size={15} /></button><small>只定位入口，不授权、不发送、不自动采用。随时可返回本节。</small>
    </article>
    {storageWarning && <p className="agent-tutorial-warning" role="status">教程进度仅在本页保留；浏览器未能保存。不会影响你的工作或阻止退出。</p>}
    <footer><button type="button" disabled={index === 0} onClick={() => onStep(index - 1)}><ArrowLeft size={14} />上一节</button><label title="系统减少动态效果优先"><input type="checkbox" checked={effects && !reduced} disabled={reduced} onChange={event => setEffects(event.target.checked)} />{reduced ? "减少动效" : "动效"}</label><button type="button" onClick={() => index === AGENT_LESSONS.length - 1 ? onClose() : onStep(index + 1)}>{index === AGENT_LESSONS.length - 1 ? "完成，继续协作" : "下一节"}<ArrowRight size={14} /></button></footer>
    <p className="agent-tutorial-boundary">这里记录的是教程阅读与示例练习，不是 Agent 任务进度或能力认证。</p>
  </section>;
}
