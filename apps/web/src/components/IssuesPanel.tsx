import { useState } from "react";
import type { ClaimIssue } from "@better-me/core";
import { ShieldAlert, ShieldCheck, ChevronDown, ChevronRight, Info } from "lucide-react";

export function IssuesPanel({ issues }: { issues: ClaimIssue[] }) {
  const [open, setOpen] = useState(false);

  if (issues.length === 0) {
    return (
      <div className="no-print flex items-center justify-between rounded-xl border border-emerald-200/80 bg-emerald-50/70 px-4 py-2.5 text-xs text-emerald-800 shadow-2xs">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <span className="font-semibold">Fact 事实质量体检通过：</span>
          <span>未发现未确认量化指标或明显空洞套话，简历处于健康可答辩状态。</span>
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
            事实库体检提示：
          </span>
          <span className="text-xs text-amber-800">
            发现 <strong>{issues.length}</strong> 处质量建议（未确认的量化指标已自动从简历投影中过滤）
          </span>
        </div>

        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-xs font-semibold text-amber-900 hover:text-amber-950 transition"
        >
          <span>{open ? "收起明细" : "查看明细"}</span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {open && (
        <div className="border-t border-amber-200/60 bg-white/70 px-4 py-3 text-xs space-y-2">
          <p className="text-slate-500 flex items-center gap-1.5 text-[11px]">
            <Info className="h-3.5 w-3.5 text-amber-600 shrink-0" />
            <span>
              防编造守则：带有量化数字（如百分比、指标提升）的条目，必须提供对比基线或因果链，并在编辑区勾选「已核实」，方可在对外简历中展示。
            </span>
          </p>

          <ul className="space-y-1.5 pt-1">
            {issues.map((issue) => (
              <li
                key={`${issue.claimId}-${issue.code}`}
                className="flex items-start gap-2 text-slate-700 bg-amber-50/40 p-1.5 rounded border border-amber-100"
              >
                <span className="font-mono text-[10px] bg-amber-100 text-amber-800 px-1 rounded shrink-0 mt-0.5">
                  {issue.code}
                </span>
                <span className="font-medium">{issue.message}</span>
                <span className="font-mono text-[10px] text-slate-400 ml-auto">
                  ID: {issue.claimId}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
