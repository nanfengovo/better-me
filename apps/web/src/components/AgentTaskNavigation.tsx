import { BookOpen, Compass, FileCheck2, MessagesSquare, ScanText, ArrowUpRight } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import "./agent-task-workspace.css";

export type AgentTaskView = "job" | "resume" | "career" | "learning" | "practice" | "handoff";
export function AgentTaskNavigation({ active, onSelect, jobTitle }: { active: AgentTaskView; onSelect: (view: AgentTaskView) => void; jobTitle?: string }) {
  const { t } = useUiPreferences();
  const tasks = [
    { id: "job", icon: ScanText, label: t("岗位研判", "Job analysis"), subtitle: t("提取与理解要求", "Understand requirements") },
    { id: "resume", icon: FileCheck2, label: t("简历与经历", "Resume & experience"), subtitle: t("以事实支撑表达", "Grounded in facts") },
    { id: "career", icon: Compass, label: t("职业规划", "Career direction"), subtitle: t("明确下一步", "Choose your next step") },
    { id: "learning", icon: BookOpen, label: t("学习提升", "Learning"), subtitle: t("计划、资料与复盘", "Plan, learn & reflect") },
    { id: "practice", icon: MessagesSquare, label: t("训练与面试", "Practice & interviews"), subtitle: t("从练习中改进", "Improve through practice") },
  ] as const;
  return <header className="advisor-navigation">
    <div className="advisor-heading"><div><span className="advisor-eyebrow">BETTERME / CAREER WORKSPACE</span><h1>{t("每一步，都更接近目标。", "Make your next step count.")}</h1></div><button type="button" className="advisor-handoff" aria-pressed={active === "handoff"} onClick={() => onSelect("handoff")}><ArrowUpRight size={15} />{t("外部协作", "External collaboration")}</button></div>
    <nav className="advisor-tasks" aria-label={t("顾问任务", "Advisor tasks")}>{tasks.map(({ id, icon: Icon, label, subtitle }) => <button type="button" key={id} aria-current={active === id ? "page" : undefined} onClick={() => onSelect(id)}><Icon size={18} /><span><strong>{label}</strong><small>{subtitle}</small></span></button>)}</nav>
    <div className="advisor-context"><span className="advisor-context-dot" /><span>{jobTitle || t("尚未绑定岗位 · 也可以从职业目标开始", "No target job · You can start with a career goal")}</span><span className="advisor-context-note">{t("来源先核对 · 内容由你确认", "Verify sources · Confirm changes")}</span></div>
  </header>;
}
