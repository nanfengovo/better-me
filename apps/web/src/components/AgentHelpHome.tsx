import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Compass, X } from "lucide-react";
import type { AgentLesson } from "../lib/agent-tutorial";
import { useUiPreferences } from "../lib/ui-preferences";
import "./agent-help-home.css";

type HelpTopic = { title: [zh: string, en: string]; description: [zh: string, en: string] };
export const HELP_TOPICS: Record<AgentLesson, HelpTopic> = {
  annotation: { title: ["完善一条简历经历", "Improve a resume experience"], description: ["找到旁批，补充事实，核对候选后再采用。", "Find the annotation, add facts, and verify a candidate before adopting it."] },
  tools: { title: ["让助手可以开始工作", "Get the assistant ready"], description: ["分清模型与阅读工具，检查配置和可用状态。", "Distinguish models from reading tools, then check configuration and availability."] },
  recovery: { title: ["助手没响应，怎么办", "When the assistant does not respond"], description: ["先看真实任务状态，避免重复发送。", "Check the real task state first to avoid sending it twice."] },
  evidence: { title: ["安全地提供项目资料", "Share project material safely"], description: ["只授权必要范围；资料不等于个人贡献。", "Grant only the necessary scope; material does not prove personal contribution."] },
  dialogue: { title: ["纠正助手的理解", "Correct the assistant's understanding"], description: ["没有合适选项时，直接说明你的意思。", "Explain what you mean directly when none of the options fit."] },
  consensus: { title: ["核对项目理解", "Verify project understanding"], description: ["确认术语和边界，不替你认领成果。", "Confirm terms and boundaries without claiming outcomes for you."] },
  contribution: { title: ["说明自己做了什么", "Describe what you did"], description: ["区分实现、设计与团队工作。", "Distinguish implementation, design and team work."] },
  memory: { title: ["找回记录与备份", "Recover records and backups"], description: ["查看历史，迁移前先备份。", "Review history and back up before migrating."] },
};
const topicOrder: AgentLesson[] = ["annotation", "tools", "recovery", "evidence", "dialogue", "consensus", "contribution", "memory"];

export function AgentHelpHome({ context, onLesson, onClose }: {
  context: "conversation" | "memory" | "settings"; onLesson: (lesson: AgentLesson) => void; onClose: () => void;
}) {
  const { t } = useUiPreferences();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId();
  const common: AgentLesson[] = context === "memory" ? ["memory", "annotation", "recovery"] : context === "settings" ? ["tools", "annotation", "recovery"] : ["annotation", "tools", "recovery"];
  const other = topicOrder.filter(id => !common.includes(id));
  const topic = (id: AgentLesson) => {
    const item = HELP_TOPICS[id];
    const title = t(...item.title);
    return <button type="button" key={id} aria-label={title} onClick={() => onLesson(id)}>
      <span><strong>{title}</strong><small>{t(...item.description)}</small></span><ArrowRight size={15} />
    </button>;
  };
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog?.open) dialog?.showModal();
    dialog?.querySelector<HTMLElement>("h2")?.focus();
    return () => dialog?.close();
  }, []);
  return createPortal(<dialog ref={ref} className="agent-help-home no-print" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><span><Compass size={17} />{t("使用指南", "Guide")}</span><button type="button" className="agent-help-close" aria-label={t("关闭使用指南", "Close guide")} onClick={onClose}><X size={18} /></button></header>
    <div className="agent-help-body">
      <h2 id={titleId} tabIndex={-1}>{t("需要哪方面的帮助？", "What do you need help with?")}</h2>
      <p id={descriptionId}>{t("选一个问题，直接看怎么做。", "Choose a question to see the steps.")}</p>
      <nav className="agent-help-topics" aria-label={t("常用帮助", "Common help topics")}>{common.map(topic)}</nav>
      <details className="agent-help-more"><summary>{t("其他问题", "Other questions")}</summary>
        <nav className="agent-help-topics" aria-label={t("其他帮助", "Other help topics")}>{other.map(topic)}</nav>
      </details>
    </div>
    <footer><span>{t("只提供指引，不会修改简历。", "Guidance only; your resume will not be changed.")}</span><button type="button" onClick={onClose}>{t("返回工作", "Return to work")}</button></footer>
  </dialog>, document.body);
}
