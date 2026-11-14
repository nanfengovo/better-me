import { BookOpen, Compass, FileCheck2, MessagesSquare, ScanText, ArrowUpRight, ArrowLeft, Settings2, Pencil } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import "./agent-task-workspace.css";
import "./advisor-compact.css";

export type AgentTaskView = "job" | "resume" | "career" | "learning" | "practice" | "handoff";
export function AgentTaskNavigation({ active, onSelect, jobTitle, onBack, onEdit, needsConfig, onConfig, onOpenArea, onTailor, tailoring }: { active: AgentTaskView | "growth" | "studio"; onSelect: (view: AgentTaskView) => void; jobTitle?: string; onBack?: () => void; onEdit?: () => void; needsConfig?: boolean; onConfig?: () => void; onOpenArea?: (area: "growth" | "studio") => void; onTailor?: () => void; tailoring?: boolean }) {
  const { t } = useUiPreferences();
  const tasks = [
    { id: "job", icon: ScanText, label: t("岗位研判", "Job analysis") },
    { id: "resume", icon: FileCheck2, label: t("简历与经历", "Resume & experience") },
    { id: "career", icon: Compass, label: t("职业规划", "Career direction") },
    { id: "learning", icon: BookOpen, label: t("学习提升", "Learning") },
    { id: "practice", icon: MessagesSquare, label: t("训练与面试", "Practice & interviews") },
  ] as const;
  return <header className="advisor-navigation advisor-navigation-compact">
    <h1 className="sr-only">{t("AI 顾问工作台", "AI Career Workspace")}</h1>
    <div className="advisor-nav-shell">
      {onBack && <button type="button" className="advisor-back" onClick={onBack} title={t("返回简历", "Back to resume")} aria-label={t("返回简历", "Back to resume")}><ArrowLeft size={15} /></button>}
      <nav className="advisor-tasks" aria-label={t("顾问任务", "Advisor tasks")}>
        {tasks.map(({ id, icon: Icon, label }) => <button type="button" key={id} aria-current={active === id ? "page" : undefined} onClick={() => onSelect(id)}><Icon size={16} /><strong>{label}</strong></button>)}
        {onOpenArea && <><button type="button" aria-current={active === "growth" ? "page" : undefined} onClick={() => onOpenArea("growth")}><BookOpen size={16} /><strong>{t("资料与练习", "Materials & exercises")}</strong></button><button type="button" aria-current={active === "studio" ? "page" : undefined} onClick={() => onOpenArea("studio")}><FileCheck2 size={16} /><strong>{t("演练与证据", "Practice & evidence")}</strong></button></>}
      </nav>
      <button type="button" className="advisor-handoff" aria-label={t("外部协作", "External collaboration")} title={t("外部协作", "External collaboration")} aria-pressed={active === "handoff"} onClick={() => onSelect("handoff")}><ArrowUpRight size={14} /><span>{t("协作", "Collaborate")}</span></button>
    </div>
    <div className="advisor-context">
      <span className="advisor-target" title={jobTitle}>{jobTitle || t("未选择目标岗位", "No target role")}</span>
      <span className="advisor-context-spacer" />
      {onEdit && <button type="button" className="advisor-context-action" onClick={onEdit}><Pencil size={12} />{t("编辑岗位", "Edit role")}</button>}
      {onTailor && <button type="button" className="advisor-context-action" aria-pressed={tailoring} onClick={onTailor}><FileCheck2 size={14} />{t("定制简历", "Tailor resume")}</button>}
      {needsConfig && <button type="button" className="advisor-context-action advisor-config-state" onClick={onConfig}><Settings2 size={12} />{t("配置模型", "Configure model")}</button>}
    </div>
  </header>;
}
