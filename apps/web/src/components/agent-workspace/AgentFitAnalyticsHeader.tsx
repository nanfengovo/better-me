import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, PanelRightClose, RefreshCw, Sparkles } from "lucide-react";
import type { TranslateFn } from "./AgentReplyActionsCard";

function useAnimatedCounter(target: number, duration = 800) {
  const [current, setCurrent] = useState(0);
  const lastFrameValue = useRef(0);
  useEffect(() => {
    const start = lastFrameValue.current;
    const startTime = performance.now();
    let frameId: number;

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Apple-like ease-out curve
      const ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      lastFrameValue.current = Math.round(start + (target - start) * ease);
      setCurrent(lastFrameValue.current);
      if (progress < 1) {
        frameId = requestAnimationFrame(step);
      }
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [target, duration]);

  return current;
}

export interface AgentFitStats {
  total: number;
  verified: number;
  claimed: number;
  gaps: number;
  score: number;
  acceptedCount: number;
  pendingCount: number;
  rejectedCount: number;
}

export interface AgentFitAnalyticsHeaderProps {
  isDark: boolean;
  t: TranslateFn;
  loading: boolean;
  isApplying: boolean;
  stats: AgentFitStats;
  jobTitle?: string;
  company?: string;
  errorNotice: string | null;
  proposalFilter: "all" | "accepted" | "pending" | "rejected";
  onChangeFilter: (filter: "all" | "accepted" | "pending" | "rejected") => void;
  onHideRightPane: () => void;
  onRunMatching: () => void;
  onApply: () => void;
  children?: ReactNode;
}

export function AgentFitAnalyticsHeader({
  isDark,
  t,
  loading,
  isApplying,
  stats,
  jobTitle,
  company,
  errorNotice,
  proposalFilter,
  onChangeFilter,
  onHideRightPane,
  onRunMatching,
  onApply,
  children,
}: AgentFitAnalyticsHeaderProps) {
  const animatedScore = useAnimatedCounter(stats.score, 900);
  const ringR = 20;
  const ringC = 2 * Math.PI * ringR;
  const ringOffset = ringC - (Math.max(0, Math.min(100, animatedScore)) / 100) * ringC;
  const scoreTone =
    stats.score >= 80 ? "text-emerald-600" : stats.score >= 55 ? "text-teal-600" : stats.score >= 35 ? "text-amber-600" : "text-rose-600";
  const scoreStroke =
    stats.score >= 80 ? "stroke-emerald-500" : stats.score >= 55 ? "stroke-teal-500" : stats.score >= 35 ? "stroke-amber-500" : "stroke-rose-500";
  const scoreLabel = loading
    ? t("正在比对", "Matching")
    : stats.total === 0
      ? t("尚无结果", "No result")
      : stats.score >= 80
        ? t("高度契合", "Strong fit")
        : stats.score >= 55
          ? t("基本契合", "Fair fit")
          : stats.score >= 35
            ? t("部分契合", "Partial fit")
            : t("差距较大", "Wide gap");
  const mixTotal = Math.max(stats.total, 1);

  return (
    <>
      <div
        className={`px-4 py-3.5 border-b shrink-0 ${
          isDark ? "bg-[var(--ui-surface-raised,#2e3038)] border-[var(--ui-border,#484b58)]" : "bg-white border-slate-200"
        }`}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="min-w-0 flex items-center gap-3.5">
            <div className="relative h-[52px] w-[52px] shrink-0" aria-hidden>
              <svg className="h-[52px] w-[52px] -rotate-90" viewBox="0 0 56 56">
                <circle
                  cx="28"
                  cy="28"
                  r={ringR}
                  strokeWidth="3"
                  fill="none"
                  className={isDark ? "stroke-[var(--ui-border,#484b58)]" : "stroke-slate-200"}
                />
                {loading ? (
                  <circle
                    cx="28"
                    cy="28"
                    r={ringR}
                    strokeWidth="3"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${ringC * 0.22} ${ringC}`}
                    className="stroke-emerald-500 fit-ring-pending"
                  />
                ) : (
                  <circle
                    cx="28"
                    cy="28"
                    r={ringR}
                    strokeWidth="3"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={ringC}
                    strokeDashoffset={ringOffset}
                    className={`fit-ring-value ${scoreStroke}`}
                  />
                )}
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  className={`text-[13px] font-semibold tabular-nums tracking-tight leading-none ${
                    loading ? (isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400") : isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"
                  }`}
                >
                  {loading ? "…" : animatedScore}
                </span>
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 min-w-0">
                <p className={`text-[13px] font-semibold tracking-tight truncate ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
                  {jobTitle || t("目标岗位", "Target role")}
                </p>
                <span className={`text-[11px] shrink-0 tabular-nums ${loading ? (isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-400") : scoreTone}`}>
                  {loading ? "" : `${animatedScore}%`}
                  <span className={`ml-1 font-medium ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-600"}`}>
                    {scoreLabel}
                  </span>
                </span>
              </div>
              {company ? (
                <p className={`text-[11px] truncate mt-0.5 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                  {company}
                </p>
              ) : null}

              <div
                className={`mt-2 h-1 w-full rounded-full overflow-hidden flex ${isDark ? "bg-[var(--ui-border,#484b58)]" : "bg-slate-100"}`}
                aria-hidden
              >
                {loading || stats.total === 0 ? (
                  <div className={`h-full w-1/3 rounded-full ${loading ? "bg-emerald-400/70 animate-pulse" : ""}`} />
                ) : (
                  <>
                    <div className="fit-mix-seg h-full bg-emerald-500" style={{ width: `${(stats.verified / mixTotal) * 100}%` }} />
                    <div className="fit-mix-seg h-full bg-amber-400" style={{ width: `${(stats.claimed / mixTotal) * 100}%` }} />
                    <div className="fit-mix-seg h-full bg-rose-400" style={{ width: `${(stats.gaps / mixTotal) * 100}%` }} />
                  </>
                )}
              </div>
              <div className={`mt-1.5 flex items-center gap-3 text-[11px] tabular-nums ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {loading ? "—" : stats.verified} {t("已核实", "verified")}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  {loading ? "—" : stats.claimed} {t("待核验", "claimed")}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
                  {loading ? "—" : stats.gaps} {t("缺口", "gaps")}
                </span>
                <span className="sr-only">{t("契合度", "fit")}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-center">
            <button
              type="button"
              onClick={onHideRightPane}
              className={`agent-btn-press hidden lg:inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] font-medium cursor-pointer ${
                isDark
                  ? "border-[var(--ui-border,#484b58)] text-[var(--ui-text-muted,#a7adbd)] hover:text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:text-slate-900"
              }`}
              title={t("收起匹配结果", "Collapse match results")}
            >
              <PanelRightClose size={13} />
              <span>{t("收起", "Hide")}</span>
            </button>
            <button
              type="button"
              onClick={onRunMatching}
              disabled={loading}
              className={`agent-btn-press inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition disabled:opacity-50 cursor-pointer ${
                isDark
                  ? "border-[var(--ui-border,#484b58)] bg-[var(--ui-surface-soft,#363842)] text-[var(--ui-text-secondary,#c7cad4)] hover:text-white hover:bg-[var(--ui-hover,#41434e)]"
                  : "border-slate-200 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50"
              }`}
            >
              <RefreshCw size={12} className={loading ? "animate-spin text-emerald-500" : ""} />
              <span>{loading ? t("分析中…", "Analyzing…") : t("授权当前简历并分析", "Share resume & analyze")}</span>
            </button>

            <button
              type="button"
              onClick={onApply}
              disabled={stats.acceptedCount === 0 || isApplying}
              className="agent-btn-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isApplying ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              <span>
                {isApplying
                  ? t("应用中…", "Applying…")
                  : t(`应用已采纳 (${stats.acceptedCount})`, `Apply accepted (${stats.acceptedCount})`)}
              </span>
            </button>
          </div>
        </div>

        {errorNotice && (
          <div
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-[11px] ${
              isDark
                ? "bg-rose-950/40 border-rose-500/30 text-rose-300"
                : "bg-rose-50 border-rose-200 text-rose-700"
            }`}
          >
            <AlertTriangle size={13} className="shrink-0 text-rose-500" />
            <span className="truncate">{errorNotice}</span>
          </div>
        )}
      </div>

      <div className={`flex-1 flex flex-col min-h-0 ${isDark ? "bg-[var(--ui-surface,#27282f)]" : "bg-[#f7f6f3]"}`}>
        <div className="px-3 pt-3 shrink-0">
          <div
            className={`grid grid-cols-4 p-0.5 rounded-lg ${
              isDark ? "bg-[var(--ui-surface-soft,#363842)]" : "bg-slate-200/70"
            }`}
          >
            {(
              [
                ["all", t("全部提案", "All"), stats.total],
                ["accepted", t("已采纳", "Accepted"), stats.acceptedCount],
                ["pending", t("待审核", "Pending"), stats.pendingCount],
                ["rejected", t("已忽略", "Rejected"), stats.rejectedCount],
              ] as const
            ).map(([key, label, count]) => {
              const active = proposalFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onChangeFilter(key)}
                  className={`agent-btn-press py-1.5 rounded-md text-[11px] font-medium tabular-nums cursor-pointer transition-colors ${
                    active
                      ? isDark
                        ? "bg-[var(--ui-surface,#27282f)] text-[var(--ui-text,#edeef4)] shadow-sm"
                        : "bg-white text-slate-900 shadow-sm"
                      : isDark
                        ? "text-[var(--ui-text-muted,#a7adbd)] hover:text-[var(--ui-text,#edeef4)]"
                        : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {label}
                  <span className={`ml-1 ${active ? "" : "opacity-70"}`}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>
        {children}
      </div>
    </>
  );
}
