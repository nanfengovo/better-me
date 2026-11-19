import {
  AlertTriangle,
  Building2,
  Check,
  Copy,
  Crosshair,
  Edit3,
  ExternalLink,
  ImagePlus,
  Lightbulb,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { triggerAgentGuide } from "../../lib/agent-guide";
import type { ChatMessage } from "../../services/agent-client";

export type TranslateFn = (zh: string, en: string) => string;

export type ResumeProposalDecisionState = {
  status: "saving" | "approved" | "rejected" | "conflict" | "error";
  message?: string;
};

export interface AgentReplyActionsCardProps {
  msgId: string;
  actions: NonNullable<ChatMessage["actions"]>;
  isDark: boolean;
  t: TranslateFn;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
  resumeProposalStates: Record<string, ResumeProposalDecisionState>;
  onDecideResumeProposal: (
    key: string,
    action: NonNullable<ChatMessage["actions"]>[number],
    approve: boolean,
  ) => void;
}

export function AgentReplyActionsCard({
  msgId,
  actions,
  isDark,
  t,
  copiedId,
  onCopy,
  resumeProposalStates,
  onDecideResumeProposal,
}: AgentReplyActionsCardProps) {
  if (actions.length === 0) return null;

  return (
    <div className="w-full max-w-[95%] space-y-2.5 pl-2">
      {actions.map((action, aIdx) => (
        <div
          key={aIdx}
          className={`rounded-2xl border p-3.5 shadow-md space-y-2.5 ${
            isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)]" : "border-slate-200 bg-white"
          }`}
        >
          {/* Company Card */}
          {action.type === "company_card" && (
            <>
              <div className="flex items-center justify-between">
                <div className={`flex items-center gap-1.5 font-bold text-xs ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                  <Building2 size={14} className={isDark ? "text-emerald-400" : "text-emerald-600"} />
                  <span>{action.companyName}</span>
                </div>
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                    isDark
                      ? "bg-[var(--ui-surface-raised,#2e3038)] text-emerald-300 border-emerald-500/30"
                      : "bg-emerald-50 text-emerald-700 border-emerald-200"
                  }`}
                >
                  {action.ownership || "实控人核查"}
                </span>
              </div>
              <p className={`text-xs leading-relaxed ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                {action.summary}
              </p>
              {action.officialUrl && (
                <a
                  href={action.officialUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex items-center gap-1 text-[11px] hover:underline ${
                    isDark ? "text-emerald-400" : "text-emerald-700 font-semibold"
                  }`}
                >
                  <span>{t("访问招聘官网 / 工商链接", "Visit careers website")}</span>
                  <ExternalLink size={11} />
                </a>
              )}
            </>
          )}

          {/* Resume Proposal Card */}
          {action.type === "resume_proposal" && (
            <>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className={`font-bold flex min-w-0 items-center gap-1.5 ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                  <Edit3 size={13} className={isDark ? "text-teal-400" : "text-teal-600"} />
                  <span className="truncate">{t("简历修改提案", "Resume edit proposal")} · {action.targetSection}</span>
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold ${
                    action.sourceVerified
                      ? isDark
                        ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
                        : "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : isDark
                        ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                        : "border-amber-200 bg-amber-50 text-amber-800"
                  }`}
                >
                  {action.sourceVerified ? t("已绑定简历原文", "Source verified") : t("只读 · 未绑定原文", "Read-only · unlinked")}
                </span>
              </div>
              {action.sourceVerified && action.originalText && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className={`min-w-0 rounded-xl border p-3 ${isDark ? "border-[var(--ui-border,#484b58)] bg-black/15" : "border-slate-200 bg-slate-50"}`}>
                    <div className={`mb-1.5 text-[10px] font-semibold ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                      {t("当前原文", "Current text")}
                    </div>
                    <p className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"}`}>
                      {action.originalText}
                    </p>
                  </div>
                  <div className={`min-w-0 rounded-xl border p-3 ${isDark ? "border-teal-500/30 bg-teal-500/5" : "border-teal-200 bg-teal-50/60"}`}>
                    <div className={`mb-1.5 text-[10px] font-semibold ${isDark ? "text-teal-300" : "text-teal-800"}`}>
                      {t("建议替换为", "Suggested replacement")}
                    </div>
                    <p className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>
                      {action.proposedText}
                    </p>
                  </div>
                </div>
              )}
              {!action.sourceVerified && (
                <div className={`rounded-xl border p-3 text-xs leading-relaxed ${isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)]" : "border-slate-200 bg-slate-50 text-slate-800"}`}>
                  <p>{action.proposedText}</p>
                  {action.sourceIssue === "original_mismatch" && (
                    <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      {t(
                        "模型返回的原文与当前简历字段不一致；为避免错写，已禁用批准。请重新生成建议。",
                        "The model’s source text does not exactly match the current resume field. Approval is disabled to prevent an incorrect write; regenerate the proposal.",
                      )}
                    </p>
                  )}
                  {action.sourceIssue === "not_shared" && (
                    <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-300">
                      {t("该目标不在本次授权的简历字段中，不能写回。", "This target was not included in the fields you shared, so it cannot be written back.")}
                    </p>
                  )}
                </div>
              )}
              <p className={`text-[11px] leading-relaxed flex items-center gap-1.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                <Lightbulb size={13} className="text-amber-500 shrink-0" />
                <span>{action.rationale}</span>
              </p>
              {(() => {
                const proposalKey = `${msgId}:${aIdx}`;
                const decision = resumeProposalStates[proposalKey];
                return (
                  <div className="space-y-2 pt-1">
                    {decision?.message && (
                      <p
                        role="status"
                        className={`text-[11px] ${
                          decision.status === "conflict" || decision.status === "error"
                            ? "text-rose-500"
                            : decision.status === "approved"
                              ? "text-emerald-500"
                              : isDark
                                ? "text-[var(--ui-text-muted,#a7adbd)]"
                                : "text-slate-500"
                        }`}
                      >
                        {decision.message}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          triggerAgentGuide({
                            section: action.targetRef?.kind === "profile_headline" ? "headline" : "experience",
                            text: action.proposedText,
                            label: t("定位简历中的建议目标", "Locate the proposed resume field"),
                            actionType: "suggest",
                          })
                        }
                        className={`agent-btn-press inline-flex items-center gap-1 rounded-xl border px-3 py-1.5 text-xs transition ${
                          isDark
                            ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] hover:border-teal-500/40"
                            : "border-slate-200 bg-white text-slate-700 hover:border-teal-300"
                        }`}
                      >
                        <Crosshair size={12} />
                        <span>{t("定位目标", "Locate target")}</span>
                      </button>
                      {action.sourceVerified && !decision && (
                        <>
                          <button
                            type="button"
                            onClick={() => void onDecideResumeProposal(proposalKey, action, false)}
                            className={`agent-btn-press rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                              isDark ? "border-rose-500/30 text-rose-200 hover:bg-rose-500/10" : "border-rose-200 text-rose-700 hover:bg-rose-50"
                            }`}
                          >
                            {t("拒绝", "Reject")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDecideResumeProposal(proposalKey, action, true)}
                            className="agent-btn-press inline-flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-1.5 text-xs font-bold text-white shadow-xs transition hover:bg-teal-500"
                          >
                            <Check size={12} />
                            <span>{t("批准并写回简历", "Approve & write to resume")}</span>
                          </button>
                        </>
                      )}
                      {decision?.status === "saving" && (
                        <span className="text-[11px] text-slate-400">{t("正在核对原文并保存…", "Checking source and saving…")}</span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {/* Interview Defense Card */}
          {action.type === "interview_defense" && (
            <>
              <div className={`flex items-center gap-1.5 font-bold text-xs ${isDark ? "text-amber-300" : "text-amber-800"}`}>
                <ShieldCheck size={14} className="text-amber-500" />
                <span>{t("面试答辩攻防点", "Interview defense")}：{action.gapItem}</span>
              </div>
              <div className={`text-xs space-y-1.5 ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"}`}>
                <p className={`font-semibold text-xs ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                  【{t("防守策略", "Strategy")}】：{action.strategy}
                </p>
                <div
                  className={`p-2.5 rounded-xl text-xs leading-relaxed border ${
                    isDark
                      ? "bg-[var(--ui-input,#22232a)] border-amber-500/30 text-amber-100"
                      : "bg-amber-50/70 border-amber-200 text-slate-800"
                  }`}
                >
                  “{action.sampleAnswer}”
                </div>
              </div>
              <div className="pt-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => onCopy(action.sampleAnswer || "", `card-${aIdx}`)}
                  className={`agent-btn-press inline-flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-xl cursor-pointer ${
                    isDark
                      ? "text-[var(--ui-text-secondary,#c7cad4)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-hover,#41434e)]"
                      : "text-slate-700 hover:text-slate-900 border-slate-200 bg-slate-50"
                  }`}
                >
                  {copiedId === `card-${aIdx}` ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                  <span>{copiedId === `card-${aIdx}` ? t("已复制话术", "Copied") : t("复制答辩话术", "Copy script")}</span>
                </button>
              </div>
            </>
          )}

          {/* vork 3D Physical Raytraced Badge Card */}
          {action.type === "badge_3d" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className={`font-bold flex min-w-0 items-center gap-1.5 ${isDark ? "text-purple-300" : "text-purple-900"}`}>
                  <Sparkles size={14} className="text-purple-400 shrink-0" />
                  <span className="truncate">{action.title}</span>
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold ${
                    isDark ? "border-purple-500/40 bg-purple-500/10 text-purple-200" : "border-purple-200 bg-purple-50 text-purple-800"
                  }`}
                >
                  ⚡️ vork Metal 物理光追 {action.renderDurationMs ? `· ${(action.renderDurationMs / 1000).toFixed(1)}s` : ""}
                </span>
              </div>

              <p className={`text-xs leading-relaxed font-medium ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"}`}>
                {action.highlight}
              </p>

              {action.imageUrl && (
                <div className="relative overflow-hidden rounded-xl border border-purple-500/30 bg-black/40 shadow-inner group">
                  <img
                    src={action.imageUrl}
                    alt={action.title}
                    className="w-full h-44 object-cover object-center transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute bottom-2 right-2 flex items-center gap-1.5 bg-black/75 backdrop-blur-md px-2 py-1 rounded-md text-[10px] text-purple-200 border border-purple-500/30">
                    <span>OpenPBR 物理着色 · Metal 硬件加速</span>
                  </div>
                </div>
              )}

              {action.rationale && (
                <p className={`text-[11px] leading-relaxed flex items-center gap-1.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                  <Lightbulb size={13} className="text-amber-500 shrink-0" />
                  <span>{action.rationale}</span>
                </p>
              )}

              <div className="pt-1 flex flex-wrap items-center justify-end gap-2">
                {action.imageUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = action.imageUrl!;
                      a.download = `${action.title || "3d-architecture-badge"}.png`;
                      a.click();
                    }}
                    className={`agent-btn-press inline-flex items-center gap-1 rounded-xl border px-3 py-1.5 text-xs transition ${
                      isDark
                        ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] hover:border-purple-500/40"
                        : "border-slate-200 bg-white text-slate-700 hover:border-purple-300"
                    }`}
                  >
                    <ImagePlus size={12} />
                    <span>{t("下载 3D 徽章高清图", "Download 3D Badge")}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => onCopy(`![${action.title}](${action.imageUrl || ""})\n> **${action.title}**\n> ${action.highlight}`, `badge-${aIdx}`)}
                  className={`agent-btn-press inline-flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-xl cursor-pointer ${
                    isDark
                      ? "text-[var(--ui-text-secondary,#c7cad4)] hover:text-white border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-hover,#41434e)]"
                      : "text-slate-700 hover:text-slate-900 border-slate-200 bg-slate-50"
                  }`}
                >
                  {copiedId === `badge-${aIdx}` ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                  <span>{copiedId === `badge-${aIdx}` ? t("已复制引用代码", "Copied markdown") : t("复制作品集引用", "Copy markdown")}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
