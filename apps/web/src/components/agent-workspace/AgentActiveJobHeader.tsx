import { BookmarkPlus, Edit3, ExternalLink, MapPin } from "lucide-react";
import type { DrawerJobContext } from "../JdMatchDrawer";

type Translate = (chinese: string, english: string) => string;

interface AgentActiveJobHeaderProps {
  isDark: boolean;
  t: Translate;
  jobView: DrawerJobContext;
  canEdit: boolean;
  onEdit: () => void;
  onSave?: () => void;
}

export function AgentActiveJobHeader({
  isDark,
  t,
  jobView,
  canEdit,
  onEdit,
  onSave,
}: AgentActiveJobHeaderProps) {
  return (
    <div className="flex items-start gap-2.5">
        <div
          className={`mt-0.5 h-8 w-8 rounded-lg border flex items-center justify-center text-xs font-semibold shrink-0 ${
            isDark
              ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-300"
              : "bg-emerald-50 border-emerald-200/80 text-emerald-800"
          }`}
        >
          {(jobView.company || jobView.title || "岗").slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className={`text-sm font-semibold leading-snug ${isDark ? "text-[var(--ui-text,#edeef4)]" : "text-slate-900"}`}>
            {jobView.title}
          </h2>
          <p className={`text-xs leading-snug ${isDark ? "text-[var(--ui-text-secondary,#c7cad4)]" : "text-slate-700"}`}>
            {jobView.company}
          </p>
          {jobView.location ? (
            <p className={`text-[11px] leading-snug flex items-start gap-1 ${isDark ? "text-[var(--ui-text-muted,#a7adbd)]" : "text-slate-500"}`}>
              <MapPin size={11} className="shrink-0 mt-0.5 opacity-70" />
              <span>{jobView.location.replace(/\s+/g, " ")}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-0.5 text-[11px]">
            {jobView.salary ? (
              <span className={`tabular-nums font-medium ${isDark ? "text-emerald-300" : "text-emerald-700"}`}>
                {jobView.salary}
              </span>
            ) : null}
            {jobView.sourceUrl ? (
              <a
                href={jobView.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-0.5 hover:underline ${isDark ? "text-emerald-300" : "text-emerald-700"}`}
              >
                {jobView.sourcePlatform || t("来源", "Source")}
                <ExternalLink size={10} />
              </a>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className={`agent-btn-press inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border cursor-pointer ${
                isDark
                  ? "text-[var(--ui-text-secondary,#c7cad4)] border-[var(--ui-border,#484b58)] hover:text-white"
                  : "text-slate-600 border-slate-200 bg-white hover:text-slate-900"
              }`}
              title={t("修改岗位与 JD 信息", "Edit Job Details")}
            >
              <Edit3 size={12} />
              <span>{t("编辑岗位", "Edit")}</span>
            </button>
          )}
          {onSave ? (
            <button
              type="button"
              onClick={onSave}
              className={`agent-btn-press inline-flex items-center justify-center h-7 w-7 rounded-lg border cursor-pointer ${
                isDark
                  ? "text-[var(--ui-text-secondary,#c7cad4)] border-[var(--ui-border,#484b58)] hover:text-white"
                  : "text-slate-600 border-slate-200 bg-white hover:text-slate-900"
              }`}
              title={t("收藏", "Save")}
              aria-label={t("收藏", "Save")}
            >
              <BookmarkPlus size={13} />
            </button>
          ) : null}
        </div>
    </div>
  );
}
