import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Edit3,
  Lightbulb,
  Target,
  X,
} from "lucide-react";
import { triggerAgentGuide } from "../../lib/agent-guide";
import type { MatchProposal, ProposalDecision } from "../../services/agent-client";
import type { TranslateFn } from "./AgentReplyActionsCard";

export interface AgentProposalListSectionProps {
  isDark: boolean;
  t: TranslateFn;
  loading: boolean;
  proposals: MatchProposal[];
  gapProposals: MatchProposal[];
  filteredProposals: MatchProposal[];
  proposalFilter: "all" | "accepted" | "pending" | "rejected";
  decisions: Record<string, ProposalDecision>;
  editingProposalId: string | null;
  editedText: string;
  activeDiffProposalId: string | null;
  showGapsSummary: boolean;
  onToggleGapsSummary: () => void;
  onAskGap: (jdItem: string) => void;
  onSetActiveDiffProposalId: (id: string | null) => void;
  onDecision: (proposalId: string, status: "accepted" | "rejected") => void;
  onStartEdit: (proposal: MatchProposal) => void;
  onSaveEdit: (proposalId: string) => void;
  onCancelEdit: () => void;
  onChangeEditedText: (text: string) => void;
  getClaimText: (claimId?: string) => string | null;
}

export function AgentProposalListSection({
  isDark,
  t,
  loading,
  proposals,
  gapProposals,
  filteredProposals,
  proposalFilter,
  decisions,
  editingProposalId,
  editedText,
  activeDiffProposalId,
  showGapsSummary,
  onToggleGapsSummary,
  onAskGap,
  onSetActiveDiffProposalId,
  onDecision,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onChangeEditedText,
  getClaimText,
}: AgentProposalListSectionProps) {
  return (
    <div
      className={`flex-1 overflow-y-auto p-3 space-y-2.5 min-h-0 agent-custom-scrollbar ${
        isDark ? "bg-[var(--ui-surface,#27282f)]" : "bg-slate-50/40"
      }`}
    >
      {loading && (
        <div className="space-y-2.5" aria-busy="true">
          <p className={`text-[11px] ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
            {t("正在比对岗位与履历…", "Matching job against your profile…")}
          </p>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className={`rounded-xl border px-3 py-3 space-y-2 ${
                isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)]" : "border-slate-200/80 bg-white"
              }`}
            >
              <div className={`h-2.5 rounded-full w-2/5 animate-pulse ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-200"}`} />
              <div className={`h-2 rounded-full w-full animate-pulse ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-100"}`} />
              <div className={`h-2 rounded-full w-4/5 animate-pulse ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-100"}`} />
            </div>
          ))}
        </div>
      )}

      {!loading && proposals.length === 0 && (
        <div className={`py-12 text-center space-y-2 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
          <Target size={28} className={`mx-auto ${isDark ? "text-[var(--ui-border,#484b58)]" : "text-slate-300"}`} />
          <p className="text-xs">
            {t(
              "暂无提案。点击「授权当前简历并分析」后生成，结果仍需逐条审阅。",
              "No proposals yet. Share the current resume to analyze; review each result before applying.",
            )}
          </p>
        </div>
      )}

      {!loading && gapProposals.length > 0 && proposalFilter === "all" && (
        <div
          className={`rounded-xl border ${
            isDark ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)]" : "border-slate-200/80 bg-white"
          }`}
        >
          <button
            type="button"
            onClick={onToggleGapsSummary}
            className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left cursor-pointer ${
              isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"
            }`}
          >
            <span className="text-[12px] font-medium">
              {t(`${gapProposals.length} 项缺口`, `${gapProposals.length} gaps`)}
              <span className={`ml-2 font-normal ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                {t("面试时需要应答", "Worth preparing")}
              </span>
            </span>
            {showGapsSummary ? <ChevronUp size={14} className="shrink-0 opacity-60" /> : <ChevronDown size={14} className="shrink-0 opacity-60" />}
          </button>
          {showGapsSummary && (
            <ul className={`border-t text-[12px] leading-relaxed ${isDark ? "border-[var(--ui-border,#484b58)]" : "border-slate-100"}`}>
              {gapProposals.map((g) => (
                <li
                  key={g.id}
                  className={`flex items-start justify-between gap-3 px-3 py-2.5 ${
                    isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"
                  }`}
                >
                  <span>
                    <span className={`font-medium ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>{g.jdItem}</span>
                    <span className={isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}> · {g.rationale}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onAskGap(g.jdItem)}
                    className={`shrink-0 text-[11px] cursor-pointer hover:underline ${isDark ? "text-emerald-300" : "text-emerald-700"}`}
                  >
                    {t("问顾问", "Ask")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!loading && filteredProposals.length === 0 && proposals.length > 0 && (
        <div className={`py-10 text-center text-xs ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400"}`}>
          {t("当前筛选条件下没有提案", "No proposals under this filter")}
        </div>
      )}

      {!loading && filteredProposals.map((proposal, idx) => {
        const decision = decisions[proposal.id];
        const isAccepted = decision?.status === "accepted";
        const isEdited = decision?.status === "edited";
        const isRejected = decision?.status === "rejected";
        const isEditing = editingProposalId === proposal.id;
        const isDiffOpen = activeDiffProposalId === proposal.id;

        const displayText = isEdited ? decision.editedSuggestion : proposal.suggestion;
        const currentOriginalClaim = getClaimText(proposal.profileEntryId);
        const evidenceBorder =
          proposal.evidenceType === "verified"
            ? "border-l-emerald-500"
            : proposal.evidenceType === "claimed"
              ? "border-l-amber-500"
              : "border-l-rose-500";

        return (
          <div
            key={proposal.id}
            style={{ animationDelay: `${Math.min(idx * 50, 400)}ms` }}
            className={`agent-stagger-item rounded-xl border border-l-[3px] ${evidenceBorder} transition-all duration-200 p-3 space-y-2.5 ${
              isAccepted
                ? isDark
                  ? "border-emerald-500/40 bg-emerald-950/15"
                  : "border-emerald-200 bg-emerald-50/40"
                : isEdited
                  ? isDark
                    ? "border-teal-500/40 bg-teal-950/15"
                    : "border-teal-200 bg-teal-50/40"
                  : isRejected
                    ? isDark
                      ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] opacity-50"
                      : "border-slate-200 bg-slate-100/60 opacity-60"
                    : isDark
                      ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] hover:bg-[var(--ui-surface-raised,#2e3038)]"
                      : "bg-white border-slate-200 hover:border-slate-300"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold shrink-0 mt-0.5 ${
                    isDark
                      ? "bg-[var(--ui-surface,#27282f)] text-[var(--ui-text-muted,#a7adbd)]"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {idx + 1}
                </span>
                <h4 className={`text-xs font-semibold leading-snug ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                  {proposal.jdItem}
                </h4>
              </div>

              <span
                className={`text-[10px] font-medium shrink-0 ${
                  proposal.evidenceType === "verified"
                    ? isDark
                      ? "text-emerald-400"
                      : "text-emerald-700"
                    : proposal.evidenceType === "claimed"
                      ? isDark
                        ? "text-amber-400"
                        : "text-amber-700"
                      : isDark
                        ? "text-rose-400"
                        : "text-rose-700"
                }`}
              >
                {proposal.evidenceType === "verified"
                  ? t("已核实", "Verified")
                  : proposal.evidenceType === "claimed"
                    ? t("待核验", "Claimed")
                    : t("缺口", "Gap")}
              </span>
            </div>

            {/* Suggestion text or Inline Editor */}
            {isEditing ? (
              <div className="space-y-2">
                <textarea
                  value={editedText}
                  onChange={(e) => onChangeEditedText(e.target.value)}
                  rows={3}
                  className={`w-full rounded-xl border p-3 text-xs outline-none font-sans leading-relaxed ${
                    isDark
                      ? "border-teal-500/60 bg-[var(--ui-input,#22232a)] text-[var(--ui-text,#edeef4)]"
                      : "border-teal-400 bg-white text-slate-900 shadow-inner"
                  }`}
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className={`agent-btn-press px-2.5 py-1 text-xs rounded-lg cursor-pointer ${
                      isDark ? "text-[var(--ui-text-muted,#a7adbd)] hover:bg-[var(--ui-hover,#41434e)]" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {t("取消", "Cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveEdit(proposal.id)}
                    className="agent-btn-press px-3 py-1 text-xs font-bold text-white bg-teal-600 hover:bg-teal-500 rounded-lg cursor-pointer"
                  >
                    {t("保存修改", "Save edit")}
                  </button>
                </div>
              </div>
            ) : (
              <p
                className={`text-xs leading-relaxed font-sans ${
                  isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-800"
                }`}
              >
                {displayText}
              </p>
            )}

            <p
              className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${
                isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"
              }`}
            >
              <Lightbulb size={12} className="text-amber-400 shrink-0 mt-0.5" />
              <span>{proposal.rationale}</span>
            </p>

            {/* Diff Comparison Accordion when Locating */}
            {isDiffOpen && (
              <div
                className={`agent-diff-popover p-3 rounded-xl border space-y-2 text-xs ${
                  isDark
                    ? "bg-[var(--ui-surface-raised,#2e3038)] border-emerald-500/40"
                    : "bg-slate-50 border-emerald-300 shadow-sm"
                }`}
              >
                <div className="flex items-center justify-between text-[11px] font-bold">
                  <span className={isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}>
                    {currentOriginalClaim ? t("原始履历记录", "Original Claim") : t("当前简历状态", "Current Resume")}
                  </span>
                  <ArrowRight size={12} className={isDark ? "text-emerald-400" : "text-emerald-600"} />
                  <span className={isDark ? "text-emerald-400" : "text-emerald-700"}>
                    {t("建议定制优化表达", "Proposed Resume Expression")}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div
                    className={`p-2.5 rounded-xl border text-[11px] leading-relaxed ${
                      isDark
                        ? "bg-[var(--ui-input,#22232a)] border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#a7adbd)]"
                        : "bg-white border-slate-200 text-slate-600"
                    }`}
                  >
                    {currentOriginalClaim || (
                      <span className="italic">
                        {t("（简历中暂无明确对应经历，此项为针对 JD 要求的补充或应答建议）", "(No existing claim in resume; this is gap defense / addition suggestion)")}
                      </span>
                    )}
                  </div>
                  <div
                    className={`p-2.5 rounded-xl border text-[11px] leading-relaxed ${
                      isDark
                        ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-200"
                        : "bg-emerald-50 border-emerald-200 text-emerald-900"
                    }`}
                  >
                    {displayText}
                  </div>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className={`flex items-center justify-between pt-2.5 border-t ${isDark ? "border-[var(--ui-border,#484b58)]" : "border-slate-100"}`}>
              <div className="flex items-center gap-1.5">
                {isAccepted && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                    <CheckCircle2 size={13} />
                    {t("已采纳", "Accepted")}
                  </span>
                )}
                {isEdited && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-400">
                    <Edit3 size={13} />
                    {t("已微调并采纳", "Edited & Accepted")}
                  </span>
                )}
                {isRejected && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--ui-text-muted,#a7adbd)]">
                    <X size={13} />
                    {t("已忽略", "Rejected")}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    onSetActiveDiffProposalId(isDiffOpen ? null : proposal.id);
                    triggerAgentGuide({
                      claimId: proposal.profileEntryId,
                      text: proposal.suggestion,
                      label: t("🤖 Agent 建议定位此处", "🤖 Locate here"),
                      actionType: "suggest",
                    });
                  }}
                  title={t("在简历对应履历进行视觉引导高亮与前后对比", "Locate claim with diff preview")}
                  className={`agent-btn-press inline-flex items-center gap-1 h-[30px] px-3 rounded-lg text-xs font-medium border transition cursor-pointer ${
                    isDark
                      ? "text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/30"
                      : "text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200"
                  }`}
                >
                  <Crosshair size={12} />
                  <span>{isDiffOpen ? t("收起对比", "Hide Diff") : t("定位", "Locate")}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onDecision(proposal.id, "accepted")}
                  className={`agent-btn-press inline-flex items-center gap-1 h-[30px] px-3 rounded-lg text-xs font-semibold transition cursor-pointer ${
                    isAccepted
                      ? "bg-emerald-600 text-white shadow-xs"
                      : isDark
                        ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] hover:bg-emerald-600/30 hover:text-emerald-300 border border-[var(--ui-border,#484b58)]"
                        : "bg-slate-100 text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 border border-slate-200"
                  }`}
                >
                  <Check size={12} />
                  <span>{t("采纳", "Accept")}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onStartEdit(proposal)}
                  className={`agent-btn-press inline-flex items-center gap-1 h-[30px] px-3 rounded-lg text-xs font-semibold transition cursor-pointer ${
                    isEdited
                      ? "bg-teal-600 text-white shadow-xs"
                      : isDark
                        ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-secondary,#c7cad4)] hover:bg-teal-600/30 hover:text-teal-300 border border-[var(--ui-border,#484b58)]"
                        : "bg-slate-100 text-slate-700 hover:bg-teal-50 hover:text-teal-700 border border-slate-200"
                  }`}
                >
                  <Edit3 size={12} />
                  <span>{t("微调", "Edit")}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onDecision(proposal.id, "rejected")}
                  className={`agent-btn-press inline-flex items-center gap-1 h-[30px] px-3 rounded-lg text-xs font-semibold transition cursor-pointer ${
                    isRejected
                      ? "bg-slate-600 text-white"
                      : isDark
                        ? "bg-[var(--ui-surface-raised,#2e3038)] text-[var(--ui-text-muted,#a7adbd)] hover:bg-rose-950/40 hover:text-rose-400 border border-[var(--ui-border,#484b58)]"
                        : "bg-slate-100 text-slate-500 hover:bg-rose-50 hover:text-rose-700 border border-slate-200"
                  }`}
                >
                  <X size={12} />
                  <span>{t("忽略", "Reject")}</span>
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
