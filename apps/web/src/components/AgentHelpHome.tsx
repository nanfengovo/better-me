import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, BookOpen, Check, Compass, X } from "lucide-react";
import { readTutorial, tutorialStorage, type AgentLesson } from "../lib/agent-tutorial";
import "./agent-help-home.css";

export const HELP_TOPICS: Record<AgentLesson, { title: string; description: string }> = {
  annotation: { title: "完善一条简历经历", description: "找到旁批，补充事实，核对候选后再采用。" },
  tools: { title: "让助手可以开始工作", description: "分清模型与阅读工具，检查配置和可用状态。" },
  recovery: { title: "助手没响应，怎么办", description: "先看真实任务状态，避免重复发送。" },
  evidence: { title: "安全地提供项目资料", description: "只授权必要范围；资料不等于个人贡献。" },
  dialogue: { title: "纠正助手的理解", description: "没有合适选项时，直接说明你的意思。" },
  consensus: { title: "核对项目理解", description: "确认术语和边界，不替你认领成果。" },
  contribution: { title: "说明自己做了什么", description: "区分实现、设计与团队工作。" },
  memory: { title: "找回记录与备份", description: "查看历史，迁移前先备份。" },
};
const topicOrder: AgentLesson[] = ["annotation", "tools", "recovery", "evidence", "dialogue", "consensus", "contribution", "memory"];

export function AgentHelpHome({ context, storageKey, onLesson, onClose }: {
  context: "conversation" | "memory" | "settings"; storageKey: string; onLesson: (lesson: AgentLesson) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId();
  const progress = readTutorial(tutorialStorage(), storageKey);
  const recommended: AgentLesson = context === "settings" ? "tools" : context === "memory" ? "memory" : "annotation";
  const recommendation = HELP_TOPICS[recommended];
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog?.open) dialog?.showModal();
    dialog?.querySelector<HTMLElement>("h2")?.focus();
    return () => dialog?.close();
  }, []);
  return createPortal(<dialog ref={ref} className="agent-help-home no-print" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><span><Compass size={17} />使用指南</span><button type="button" className="agent-help-close" aria-label="关闭使用指南" onClick={onClose}><X size={18} /></button></header>
    <div className="agent-help-body">
      <h2 id={titleId} tabIndex={-1}>你现在想解决什么？</h2>
      <p id={descriptionId}>按需查看，不必从头学起。打开指南不会发送请求或修改简历。</p>
      <section className="agent-help-recommendation" aria-label="当前页面推荐">
        <small>适合当前页面 · {context === "settings" ? "模型与工具" : context === "memory" ? "共识与进度" : "伴写对话"}</small>
        <h3>{recommendation.title}</h3><p>{recommendation.description}</p>
        <button type="button" onClick={() => onLesson(recommended)}>查看怎么做<ArrowRight size={16} /></button>
      </section>
      {progress.viewed.length > 0 && <button type="button" className="agent-help-resume" aria-label="继续上次阅读" onClick={() => onLesson(progress.current)}><BookOpen size={16} /><span>继续上次阅读<small>{HELP_TOPICS[progress.current].title}</small></span><ArrowRight size={15} /></button>}
      <h3 className="agent-help-section-title">所有主题 <span>随时跳转 · 不需要逐节完成</span></h3>
      <nav className="agent-help-topics" aria-label="按问题查看帮助">{topicOrder.map(id => <button type="button" key={id} aria-label={HELP_TOPICS[id].title} onClick={() => onLesson(id)}>
        <span><strong>{HELP_TOPICS[id].title}</strong><small>{HELP_TOPICS[id].description}</small></span>
        {progress.viewed.includes(id) ? <span className="agent-help-read"><Check size={13} />已读</span> : <ArrowRight size={15} />}
      </button>)}</nav>
    </div>
    <footer><span>只讲解与定位，授权、发送和采用仍由你决定。</span><button type="button" onClick={onClose}>返回工作</button></footer>
  </dialog>, document.body);
}
