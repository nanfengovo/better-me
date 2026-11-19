import { Check, ChevronDown, Copy, FileText, Layers } from "lucide-react";
import type { ProjectedResume } from "@better-me/core";
import type { MatchProposal, StructuredJd } from "../../services/agent-client";
import type { DrawerJobContext } from "../JdMatchDrawer";
import type { TranslateFn } from "./AgentReplyActionsCard";

export interface AgentJdDetailsViewProps {
  isDark: boolean;
  t: TranslateFn;
  currentJob: DrawerJobContext | null;
  currentJobView: DrawerJobContext;
  resume: ProjectedResume | null;
  structuredJd: StructuredJd | null;
  proposals: MatchProposal[];
  displayResponsibilities: string[];
  displayQualifications: string[];
  isJobSpecFolded: boolean;
  onToggleFold: () => void;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
}

export function AgentJdDetailsView({
  isDark,
  t,
  currentJob,
  currentJobView,
  resume,
  structuredJd,
  proposals,
  displayResponsibilities,
  displayQualifications,
  isJobSpecFolded,
  onToggleFold,
  copiedId,
  onCopy,
}: AgentJdDetailsViewProps) {
  return (
    <div
      style={{ overflowY: "auto" }}
      className={`overflow-y-auto min-h-0 flex-1 agent-custom-scrollbar p-4 space-y-3.5 pb-8 ${
        isDark ? "bg-[var(--ui-surface,#27282f)]" : "bg-slate-50/30"
      }`}
    >
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={15} className="text-emerald-500" />
          <h3 className={`text-xs font-bold ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
            {t("完整岗位 JD 与要求", "Complete Job Profile & Requirements")}
          </h3>
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-medium border ${
              isDark ? "bg-[var(--ui-surface-soft,#363842)] text-[var(--ui-text-secondary,#c7cad4)] border-[var(--ui-border,#484b58)]" : "bg-slate-200 text-slate-700 border-slate-300"
            }`}
          >
            {displayQualifications.length + displayResponsibilities.length} 项要求
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleFold}
            className={`agent-btn-press text-[11px] flex items-center gap-1 px-2.5 py-1 rounded-lg border cursor-pointer transition ${
              isDark
                ? "text-[var(--ui-text-secondary,#c7cad4)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-hover,#41434e)]"
                : "text-slate-600 hover:text-slate-900 border-slate-200 bg-white shadow-2xs"
            }`}
            title={isJobSpecFolded ? t("展开岗位JD要求", "Expand Job Spec") : t("收起岗位JD要求", "Collapse Job Spec")}
          >
            <ChevronDown size={12} className={`transition-transform duration-200 ${isJobSpecFolded ? "-rotate-90" : ""}`} />
            <span>{isJobSpecFolded ? t("展开JD", "Expand") : t("收起JD", "Collapse")}</span>
          </button>

          {currentJob?.description && (
            <button
              type="button"
              onClick={() => onCopy(currentJobView.description, "raw-jd")}
              className={`agent-btn-press text-[11px] flex items-center gap-1 px-2.5 py-1 rounded-lg border cursor-pointer transition ${
                isDark
                  ? "text-[var(--ui-text-secondary,#c7cad4)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-hover,#41434e)]"
                  : "text-slate-600 hover:text-slate-900 border-slate-200 bg-white shadow-2xs"
              }`}
            >
              {copiedId === "raw-jd" ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
              <span>{copiedId === "raw-jd" ? t("已复制", "Copied") : t("复制 JD", "Copy JD")}</span>
            </button>
          )}
        </div>
      </div>

      {!isJobSpecFolded && (
        <>
          {/* Tech Stack Chips Bar */}
          {structuredJd?.techStack && structuredJd.techStack.length > 0 && (() => {
            const candidateSkills = (resume?.skills || []).map((s) => s.toLowerCase());
            const matched = structuredJd.techStack.filter((tech) =>
              candidateSkills.some((s) => s.includes(tech.toLowerCase()) || tech.toLowerCase().includes(s)),
            );
            const unmatched = structuredJd.techStack.filter((tech) => !matched.includes(tech));
            return (
              <div
                className={`p-3.5 rounded-2xl border space-y-2.5 transition-colors ${
                  isDark ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200 shadow-2xs"
                }`}
              >
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 font-bold">
                    <Layers size={13} className="text-emerald-400" />
                    <span className={`text-[11px] uppercase tracking-wider font-mono ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-700"}`}>
                      {t("核心技术栈要求", "Required Tech Stack")}
                    </span>
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                      matched.length > 0
                        ? isDark
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                          : "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : isDark
                          ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-muted,#a7adbd)] border-[var(--ui-border,#484b58)]"
                          : "bg-slate-100 text-slate-600 border-slate-200"
                    }`}
                  >
                    {t(`已命中 ${matched.length} / ${structuredJd.techStack.length} 项`, `${matched.length}/${structuredJd.techStack.length} Matched`)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {matched.map((tech) => (
                    <span
                      key={tech}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border font-mono transition shadow-2xs ${
                        isDark
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35 shadow-[0_0_8px_rgba(16,185,129,0.15)]"
                          : "bg-emerald-50 text-emerald-800 border-emerald-300"
                      }`}
                    >
                      <Check size={11} className="text-emerald-500 stroke-[2.5]" />
                      <span>{tech}</span>
                    </span>
                  ))}
                  {unmatched.map((tech) => (
                    <span
                      key={tech}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border font-mono transition ${
                        isDark
                          ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] border-[var(--ui-border,#484b58)] hover:border-[var(--ui-border-strong,#656877)]"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-500/50" />
                      <span>{tech}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* 1. Job Responsibilities Section */}
          <div
            className={`p-3.5 rounded-2xl border space-y-2.5 transition-colors ${
              isDark ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200 shadow-2xs"
            }`}
          >
            <div className="flex items-center justify-between">
              <h4 className={`text-xs font-bold flex items-center gap-1.5 ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span>{t("岗位核心职责", "Job Responsibilities")}</span>
              </h4>
              <span className={`text-[10px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                {displayResponsibilities.length} {t("项核心任务", "tasks")}
              </span>
            </div>
            <div className="space-y-2 text-xs leading-relaxed font-sans">
              {displayResponsibilities.map((item, idx) => (
                <div
                  key={idx}
                  className={`p-3 rounded-xl border transition-all duration-150 flex items-start gap-2.5 ${
                    isDark
                      ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)] hover:border-[var(--ui-border-strong,#656877)] text-[var(--ui-text-secondary,#c7cad4)]"
                      : "bg-slate-50/80 border-slate-200/80 hover:border-slate-300 text-slate-800 shadow-2xs"
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 rounded-full font-mono font-bold text-[10px] items-center justify-center shrink-0 mt-0.5 border ${
                      isDark ? "bg-[var(--ui-surface,#27282f)] text-[var(--ui-text-muted,#a7adbd)] border-[var(--ui-border,#484b58)]" : "bg-slate-200 text-slate-600 border-slate-300"
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <p className="flex-1 whitespace-pre-wrap leading-relaxed">{item}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 2. Job Qualifications & Requirements Section */}
          <div
            className={`p-3.5 rounded-2xl border space-y-2.5 transition-colors ${
              isDark ? "bg-[var(--ui-surface-soft,#363842)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200 shadow-2xs"
            }`}
          >
            <div className="flex items-center justify-between">
              <h4 className={`text-xs font-bold flex items-center gap-1.5 ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />
                <span>{t("任职资格与硬性门槛", "Qualifications & Requirements")}</span>
              </h4>
              <span className={`text-[10px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
                {displayQualifications.length} {t("项硬性要求", "criteria")}
              </span>
            </div>
            <div className="space-y-2 text-xs leading-relaxed font-sans">
              {displayQualifications.map((item, idx) => {
                const matchingProposal = proposals.find((p) => item.includes(p.jdItem.slice(0, 15)) || p.jdItem.includes(item.slice(0, 15)));
                const isVerified = matchingProposal?.evidenceType === "verified";
                const isGap = matchingProposal?.evidenceType === "gap";

                return (
                  <div
                    key={idx}
                    className={`p-3 rounded-xl border transition-all duration-150 flex items-start gap-2.5 ${
                      isVerified
                        ? isDark
                          ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-200"
                          : "bg-emerald-50/70 border-emerald-300 text-emerald-900"
                        : isGap
                          ? isDark
                            ? "bg-rose-950/20 border-rose-500/30 text-rose-200"
                            : "bg-rose-50/70 border-rose-200 text-rose-900"
                          : isDark
                            ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)] hover:border-[var(--ui-border-strong,#656877)] text-[var(--ui-text-secondary,#c7cad4)]"
                            : "bg-slate-50/80 border-slate-200/80 hover:border-slate-300 text-slate-800 shadow-2xs"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 rounded-full font-mono font-bold text-[10px] items-center justify-center shrink-0 mt-0.5 border ${
                        isDark ? "bg-[var(--ui-surface,#27282f)] text-[var(--ui-text-muted,#a7adbd)] border-[var(--ui-border,#484b58)]" : "bg-slate-200 text-slate-600 border-slate-300"
                      }`}
                    >
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="whitespace-pre-wrap leading-relaxed">{item}</p>
                      {matchingProposal && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <span
                            className={`text-[9px] font-semibold px-2 py-0.5 rounded-full border ${
                              isVerified
                                ? isDark
                                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                                  : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : isGap
                                  ? isDark
                                    ? "bg-rose-500/20 text-rose-300 border-rose-500/30"
                                    : "bg-rose-50 text-rose-700 border-rose-200"
                                  : isDark
                                    ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                                    : "bg-amber-50 text-amber-700 border-amber-200"
                            }`}
                          >
                            {isVerified ? t("✓ 履历已核实", "Verified") : isGap ? t("⚠️ 技能缺口", "Gap") : t("⚡ 待补充证据", "Claimed")}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
