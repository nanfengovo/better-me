import type { ReactNode } from "react";
import { useUiPreferences } from "../lib/ui-preferences";

export function WorkspaceTaskSummary({ goal, material, status, next }: { goal: ReactNode; material: ReactNode; status: ReactNode; next: ReactNode }) {
  const { t } = useUiPreferences();
  return <dl className="workspace-task-summary" aria-label={t("当前任务概览", "Current task overview")}>
    <div><dt>{t("当前目标", "Current goal")}</dt><dd>{goal}</dd></div>
    <div><dt>{t("本次材料", "Session material")}</dt><dd>{material}</dd></div>
    <div><dt>{t("运行状态", "Task status")}</dt><dd role="status">{status}</dd></div>
    <div><dt>{t("下一步", "Next step")}</dt><dd>{next}</dd></div>
  </dl>;
}
