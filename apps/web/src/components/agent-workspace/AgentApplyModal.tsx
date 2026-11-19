import { Check, Loader2, Sparkles } from "lucide-react";
import type { TranslateFn } from "./AgentReplyActionsCard";

export interface AgentApplyModalProps {
  isDark: boolean;
  t: TranslateFn;
  applyStep: 1 | 2 | 3;
  acceptedCount: number;
  company?: string;
  title?: string;
}

export function AgentApplyModal({
  isDark,
  t,
  applyStep,
  acceptedCount,
  company,
  title,
}: AgentApplyModalProps) {
  const stepClass = (threshold: number) =>
    applyStep >= threshold
      ? isDark
        ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-200"
        : "bg-emerald-50 border-emerald-200 text-emerald-800"
      : isDark
        ? "bg-[var(--ui-surface-soft,#363842)]/50 border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#8b90a0)]"
        : "bg-slate-100 border-slate-200 text-slate-400";

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md ${isDark ? "bg-black/70" : "bg-slate-900/40"}`}>
      <div
        className={`agent-diff-popover w-full max-w-md rounded-3xl border p-6 shadow-2xl space-y-5 text-center ${
          isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)] text-[var(--ui-text,#edeef4)]" : "bg-white border-slate-200 text-slate-900"
        }`}
      >
        <div
          className={`h-14 w-14 mx-auto rounded-3xl border flex items-center justify-center shadow-xs ${
            isDark
              ? "bg-gradient-to-br from-emerald-500/20 to-teal-500/30 text-emerald-400 border-emerald-500/30"
              : "bg-gradient-to-br from-emerald-50 to-teal-100 text-emerald-700 border-emerald-200"
          }`}
        >
          <Sparkles size={28} className="animate-spin text-emerald-500" />
        </div>

        <div>
          <h3 className="text-base font-bold tracking-tight">
            {t("AI 顾问正在生成专属定制版简历", "Generating Tailored Resume...")}
          </h3>
          <p className={`text-xs mt-1 ${isDark ? "text-[var(--ui-text-muted,#8b90a0)]" : "text-slate-500"}`}>
            {company} · {title}
          </p>
        </div>

        {/* Stepper Checklist */}
        <div className="space-y-3 text-left max-w-xs mx-auto text-xs">
          <div className={`flex items-center gap-3 p-2.5 rounded-xl border transition ${stepClass(1)}`}>
            <span
              className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                applyStep >= 1 ? "bg-emerald-500 text-slate-950" : "bg-slate-400 text-white"
              }`}
            >
              {applyStep > 1 ? <Check size={12} /> : "1"}
            </span>
            <span className="font-semibold">{t("创建岗位专属定制简历副本", "Create a tailored resume copy for this role")}</span>
          </div>

          <div className={`flex items-center gap-3 p-2.5 rounded-xl border transition ${stepClass(2)}`}>
            <span
              className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                applyStep >= 2 ? "bg-emerald-500 text-slate-950" : "bg-slate-400 text-white"
              }`}
            >
              {applyStep > 2 ? <Check size={12} /> : "2"}
            </span>
            <span className="font-semibold">{t(`整理 ${acceptedCount} 项已审阅的表达建议`, `Organize ${acceptedCount} reviewed expression suggestions`)}</span>
          </div>

          <div className={`flex items-center gap-3 p-2.5 rounded-xl border transition ${stepClass(3)}`}>
            <span
              className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                applyStep >= 3 ? "bg-emerald-500 text-slate-950" : "bg-slate-400 text-white"
              }`}
            >
              {applyStep === 3 ? <Loader2 size={12} className="animate-spin" /> : "3"}
            </span>
            <span className="font-semibold">{t("自动平滑切回编辑器并定位高亮条目", "Switch back to editor and highlight updated items")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
