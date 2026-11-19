import { Sparkles } from "lucide-react";

type Translate = (chinese: string, english: string) => string;

interface AgentEmptyPromptCardsProps {
  isDark: boolean;
  t: Translate;
  company?: string;
  onSendMessage: (message: string) => Promise<void> | void;
  onTriggerGuide: (guide: { section: "headline" | "experience"; label: string }) => void;
}

export function AgentEmptyPromptCards({
  isDark,
  t,
  company,
  onSendMessage,
  onTriggerGuide,
}: AgentEmptyPromptCardsProps) {
  return (
    <div
      className={`p-3.5 rounded-xl border transition-colors ${
        isDark ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200 shadow-2xs"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <div
          className={`h-6 w-6 rounded-lg border flex items-center justify-center shrink-0 shadow-xs ${
            isDark
              ? "bg-gradient-to-br from-emerald-500/20 to-teal-500/30 text-emerald-400 border-emerald-500/30"
              : "bg-gradient-to-br from-emerald-50 to-teal-100 text-emerald-700 border-emerald-200"
          }`}
        >
          <Sparkles size={12} />
        </div>
        <h4 className={`text-xs font-bold ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
          {t("BetterMe 专属求职顾问已就绪", "BetterMe Career Copilot Ready")}
        </h4>
      </div>
      <p className={`text-[11px] leading-relaxed mb-2.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
        {t("可以一起调研雇主、打磨一条项目经历，或准备面试追问。", "Research an employer, refine a project contribution, or prepare for interview questions.")}
      </p>

      {/* Quick Prompt Cards */}
      <div className="grid grid-cols-3 gap-1.5 text-left">
        <button
          type="button"
          onClick={() => void onSendMessage(`帮我深入调研 ${company || "这家公司"} 的企业背景、实控人与经营稳定性`)}
          className={`agent-btn-press p-2 rounded-lg border text-xs transition cursor-pointer flex items-center gap-1.5 ${
            isDark
              ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] hover:bg-[var(--ui-hover,#41434e)] hover:border-emerald-500/40 text-[var(--ui-text-secondary,#c7cad4)]"
              : "border-slate-200 bg-slate-50 hover:bg-emerald-50/50 hover:border-emerald-300 text-slate-700 shadow-2xs"
          }`}
        >
          <span className="text-xs shrink-0">🏢</span>
          <span className={`font-semibold text-[11px] truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>{t("查公司", "Company")}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            onTriggerGuide({
              section: "headline",
              label: t("🤖 Agent 正在针对岗位优化个人优势", "🤖 Refining headline for job"),
            });
            void onSendMessage(t("对照目标岗位，找一条最有依据的经历，写清交付对象和本人动作；缺少关键细节就先问我。", "Help me refine one supported contribution for the target role. Ask me for missing details before suggesting a rewrite."));
          }}
          className={`agent-btn-press p-2 rounded-lg border text-xs transition cursor-pointer flex items-center gap-1.5 ${
            isDark
              ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] hover:bg-[var(--ui-hover,#41434e)] hover:border-emerald-500/40 text-[var(--ui-text-secondary,#c7cad4)]"
              : "border-slate-200 bg-slate-50 hover:bg-emerald-50/50 hover:border-emerald-300 text-slate-700 shadow-2xs"
          }`}
        >
          <span className="text-xs shrink-0">✍️</span>
          <span className={`font-semibold text-[11px] truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>{t("打磨一条经历", "Refine a bullet")}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            onTriggerGuide({
              section: "experience",
              label: t("🤖 Agent 正在结合缺口准备面试防守", "🤖 Analyzing gaps for defense"),
            });
            void onSendMessage("针对本岗位任职要求中我可能存在的经验缺口，提供高情商的面试应答防守策略");
          }}
          className={`agent-btn-press p-2 rounded-lg border text-xs transition cursor-pointer flex items-center gap-1.5 ${
            isDark
              ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] hover:bg-[var(--ui-hover,#41434e)] hover:border-emerald-500/40 text-[var(--ui-text-secondary,#c7cad4)]"
              : "border-slate-200 bg-slate-50 hover:bg-emerald-50/50 hover:border-emerald-300 text-slate-700 shadow-2xs"
          }`}
        >
          <span className="text-xs shrink-0">🛡️</span>
          <span className={`font-semibold text-[11px] truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>{t("面试防守", "Defense")}</span>
        </button>
      </div>
    </div>
  );
}
