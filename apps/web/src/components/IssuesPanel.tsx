import { useUiPreferences } from "../lib/ui-preferences";
import { useId, useState } from "react";
import type { ClaimIssue, FactBase } from "@better-me/core";
import { ShieldAlert, ShieldCheck, ChevronDown, ChevronRight, Info } from "lucide-react";
import { getIssueGuidance } from "../lib/issue-guidance";
import { createIssueNavigation } from "../lib/issue-navigation";

type Props = {
  issues: ClaimIssue[];
  factBase: FactBase;
  onNavigate: (issue: ClaimIssue) => void;
  activeIssue?: ClaimIssue;
};

function summarize(text: string): string {
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  return characters.length > 90 ? `${characters.slice(0, 90).join("")}…` : characters.join("");
}

export function IssuesPanel({ issues, factBase, onNavigate, activeIssue }: Props) {
  const { t, locale } = useUiPreferences();

  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const navigateToIssue = (issue: ClaimIssue) => {
    setOpen(false);
    onNavigate(issue);
  };

  if (issues.length === 0) {
    return (
      <div className="no-print flex items-center justify-between rounded-xl border border-emerald-200/80 bg-emerald-50/70 px-4 py-2.5 text-xs text-emerald-800 shadow-2xs">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <span className="font-semibold">{t("内容检查：", "Content review:")}</span>
          <span>{t("未发现待确认的量化或明显空洞表述。投递前请核对真实经历。", "No unverified metrics or obvious vague wording found. Check your actual experience before applying.")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="no-print rounded-xl border border-amber-200/90 bg-amber-50/80 shadow-2xs overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600" />
          <span className="text-xs font-bold text-amber-900">
            {t("内容检查：", "Content review:")}</span>
          <span className="text-xs text-amber-800">
            <strong>{issues.length}</strong> {t("项待检查 · 未核实的量化内容暂不展示", "items to review · unverified metrics are excluded")}</span>
        </div>

        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={detailsId}
          className="flex items-center gap-1 text-xs font-semibold text-amber-900 hover:text-amber-950 transition"
        >
          <span>{open ? t("收起明细", "Hide details") : t("查看明细", "Show details")}</span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {open && (
        <div id={detailsId} className="border-t border-amber-200/60 bg-white/70 px-4 py-3 text-xs space-y-2">
          <p className="text-slate-500 flex items-center gap-1.5 text-[11px]">
            <Info className="h-3.5 w-3.5 text-amber-600 shrink-0" />
            <span>
              {t("双击问题条目，或点“定位并修改”，即可跳到编辑区查看修改指导。量化数字必须由你核对后勾选“已核实”；比较基线或因果说明也只能填写有依据的内容。", "Double-click an issue or choose Locate and edit to open guidance in the editor. Verify metrics yourself before confirming them. Use supported facts for baselines and causes.")}</span>
          </p>

          <ul className="max-h-[min(40dvh,22rem)] overflow-y-auto space-y-1.5 pt-1">
            {issues.map((issue) => {
              const guidance = getIssueGuidance(issue.code, locale);
              const experience = factBase.experiences.find((item) => item.id === issue.experienceId);
              const claim = experience?.claims.find((item) => item.id === issue.claimId);
              const organization = experience?.org.zh.trim() || experience?.org.en?.trim() || t("单位待填写", "Organization not entered");
              const context = experience?.projectName?.zh.trim() || experience?.projectName?.en?.trim() || experience?.title.zh.trim() || experience?.title.en?.trim();
              const field = createIssueNavigation(factBase, issue, 0)?.field;
              const englishText = claim?.text.en?.trim();
              const showEnglish = field === "text-en" && !!englishText;
              const text = (showEnglish ? englishText : claim?.text.zh.trim()) || englishText || t("要点已删除或暂不可用，请核对当前文档。", "This entry was deleted or is unavailable. Check the current document.");
              const isActive = activeIssue?.experienceId === issue.experienceId && activeIssue.claimId === issue.claimId && activeIssue.code === issue.code;
              return (
                <li
                  key={`${issue.experienceId}-${issue.claimId}-${issue.code}`}
                  onDoubleClick={() => navigateToIssue(issue)}
                  aria-current={isActive ? "true" : undefined}
                  className={`flex flex-col items-start gap-2 rounded-lg border p-3 text-slate-700 transition sm:flex-row sm:justify-between ${isActive ? "border-amber-400 bg-amber-100/70 ring-1 ring-amber-300" : "border-amber-100 bg-amber-50/40 hover:border-amber-300 hover:bg-amber-50"}`}
                >
                  <div className="min-w-0 flex-1 space-y-1 break-words">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-amber-950">{guidance.title}</span>
                      {isActive && <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-950">{t("当前定位", "Selected issue")}</span>}
                    </div>
                    <p className="text-[11px] text-slate-500">{organization}{context ? ` · ${context}` : ""}</p>
                    <p title={text} className="font-medium">{showEnglish && <span className="mr-1.5 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-600">{t("英文", "English")}</span>}<span lang={showEnglish ? "en" : undefined}>{summarize(text)}</span></p>
                    <p className="text-[11px] leading-relaxed text-slate-600">{guidance.description}</p>
                  </div>
                  <button
                    type="button"
                    aria-label={t(`定位并修改：${organization}，${guidance.title}`, `Locate and edit: ${organization}, ${guidance.title}`)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (event.detail <= 1) navigateToIssue(issue);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-2 font-semibold text-amber-900 transition hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
                  >
                    {t("定位并修改", "Locate and edit")}</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
