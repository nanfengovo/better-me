import type { PersistenceStatus } from "@better-me/storage";
import { Check, CloudOff, Loader2 } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";

/** Presentation only: this component never changes persistence or autosave settings. */
export function DocumentSaveStatus({ status, autoSaveEnabled }: { status: PersistenceStatus; autoSaveEnabled: boolean }) {
  const { t } = useUiPreferences();
  const saved = status.kind === "saved" && !status.hasPendingChanges;
  const label = saved ? t("简历已保存", "Resume saved") : status.kind === "draft" ? status.draftSavedAt ? t("草稿已保护 · 完整简历待保存", "Draft protected · Resume save pending") : t("完整简历待保存", "Resume save pending") : status.kind === "pending" || status.kind === "saved" ? t("等待保存", "Save pending") : status.kind === "error" ? t("保存需要处理", "Save needs attention") : t("正在载入", "Loading");
  return <span className={`save-indicator ${status.kind}`} title={[status.message, status.historyError].filter(Boolean).join(" · ")} role="status" aria-live="polite">{status.kind === "pending" || status.kind === "loading" ? <Loader2 size={12} className="animate-spin" /> : status.kind === "error" || status.historyError ? <CloudOff size={12} /> : <Check size={12} />}<span>{label}{status.historyError && ` · ${t("历史备份需处理", "History backup needs attention")}`} · {autoSaveEnabled ? t("自动保存开", "Autosave on") : t("自动保存关", "Autosave off")}</span></span>;
}
