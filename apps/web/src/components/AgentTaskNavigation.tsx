import { BookOpen, Compass, FileCheck2, MessagesSquare, ScanText, ArrowUpRight, ArrowLeft, Settings2, Pencil } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import "./agent-task-workspace.css";
import "./advisor-compact.css";

export type AgentTaskView = "job" | "resume" | "career" | "learning" | "practice" | "handoff";
export function AgentTaskNavigation({ active, onSelect, jobTitle, onBack, onEdit, needsConfig, onConfig }: { active: AgentTaskView; onSelect: (view: AgentTaskView) => void; jobTitle?: string; onBack?: () => void; onEdit?: () => void; needsConfig?: boolean; onConfig?: () => void }) {
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
    <div className="advisor-nav-row"><nav className="advisor-tasks" aria-label={t("顾问任务", "Advisor tasks")}>{tasks.map(({ id, icon: Icon, label }) => <button type="button" key={id} aria-current={active === id ? "page" : undefined} onClick={() => onSelect(id)}><Icon size={16} /><strong>{label}</strong></button>)}</nav><button type="button" className="advisor-handoff" aria-label={t("外部协作", "External collaboration")} title={t("外部协作", "External collaboration")} aria-pressed={active === "handoff"} onClick={() => onSelect("handoff")}><ArrowUpRight size={14} /><span>{t("外部协作", "External collaboration")}</span></button></div>
    <div className="advisor-context"><button type="button" className="advisor-context-action" onClick={onBack} title={t("返回简历编辑", "Back to resume editor")} aria-label={t("返回简历", "Back to resume")}><ArrowLeft size={14} /></button><span className="advisor-context-dot" /><span className="advisor-target" title={jobTitle}>{jobTitle || t("尚未绑定岗位 · 从下方导入，或直接规划职业目标", "Import a job below, or start with a career goal")}</span>{onEdit && <button type="button" className="advisor-context-action" onClick={onEdit}><Pencil size={12} />{t("编辑 JD", "Edit JD")}</button>}<span className="advisor-context-spacer" />{needsConfig ? <button type="button" className="advisor-context-action advisor-config-state" onClick={onConfig} title={t("当前岗位推理尚未配置；仍可整理 JD 或使用外部协作。", "Inference is not configured; prepare a JD or use external collaboration.")}><Settings2 size={12} />{t("推理待配置", "Configure inference")}</button> : <span className="advisor-context-note">{t("来源先核对 · 内容由你确认", "Verify sources · Confirm changes")}</span>}</div>
  </header>;
}
