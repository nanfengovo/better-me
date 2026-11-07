import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Compass, X } from "lucide-react";
import type { AgentLesson } from "../lib/agent-tutorial";
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

export function AgentHelpHome({ context, onLesson, onClose }: {
  context: "conversation" | "memory" | "settings"; onLesson: (lesson: AgentLesson) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId();
  const common: AgentLesson[] = context === "memory" ? ["memory", "annotation", "recovery"] : context === "settings" ? ["tools", "annotation", "recovery"] : ["annotation", "tools", "recovery"];
  const other = topicOrder.filter(id => !common.includes(id));
  const topic = (id: AgentLesson) => <button type="button" key={id} aria-label={HELP_TOPICS[id].title} onClick={() => onLesson(id)}>
    <span><strong>{HELP_TOPICS[id].title}</strong><small>{HELP_TOPICS[id].description}</small></span><ArrowRight size={15} />
  </button>;
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
      <h2 id={titleId} tabIndex={-1}>需要哪方面的帮助？</h2>
      <p id={descriptionId}>选一个问题，直接看怎么做。</p>
      <nav className="agent-help-topics" aria-label="常用帮助">{common.map(topic)}</nav>
      <details className="agent-help-more"><summary>其他问题</summary>
        <nav className="agent-help-topics" aria-label="其他帮助">{other.map(topic)}</nav>
      </details>
    </div>
    <footer><span>只提供指引，不会修改简历。</span><button type="button" onClick={onClose}>返回工作</button></footer>
  </dialog>, document.body);
}
