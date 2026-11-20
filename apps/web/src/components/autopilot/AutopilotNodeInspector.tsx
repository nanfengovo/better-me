import { Activity, ArrowUpRight, CheckCircle2, Clock3, Cpu, PauseCircle } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import type { StudioNode } from "../AutopilotStudioWorkspace";
import { selectNodeKernelTasks, type AutopilotKernelTelemetry, type KernelTaskSummary } from "./autopilot-telemetry";

const TASK_STATUS: Record<KernelTaskSummary["status"], [string, string]> = {
  ready: ["待开始", "Ready"],
  running: ["运行中", "Running"],
  awaiting_answer: ["待回答", "Awaiting answer"],
  awaiting_review: ["待审核", "Awaiting review"],
  paused: ["已暂停", "Paused"],
  interrupted: ["已中断", "Interrupted"],
  budget_exhausted: ["预算耗尽", "Budget exhausted"],
  failed: ["失败", "Failed"],
  revoked: ["已撤回", "Revoked"],
  completed: ["已完成", "Completed"],
};

export function AutopilotNodeInspector({
  node,
  theme,
  savedJobsCount,
  claimCount,
  telemetry,
  onOpenOpportunitySources,
  onAnalyzeActiveJob,
  onOpenActiveRecord,
}: {
  node: StudioNode;
  theme: "light" | "dark";
  savedJobsCount: number;
  claimCount: number;
  telemetry: AutopilotKernelTelemetry;
  onOpenOpportunitySources?: () => void;
  onAnalyzeActiveJob?: () => void;
  onOpenActiveRecord?: () => void;
}) {
  const { t } = useUiPreferences();
  const isLight = theme === "light";
  const matchedTasks = selectNodeKernelTasks(node, telemetry);
  const totalTokens = telemetry.usage?.models.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0) ?? 0;

  return (
    <div className={`p-4 rounded-xl border space-y-3 ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className={`font-bold ${isLight ? "text-slate-900" : "text-white"}`}>
          #{node.code} {node.name} {t("运行时状态", "runtime status")}
        </span>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={`px-2 py-0.5 rounded text-[10px] border ${
              isLight
                ? "bg-white border-slate-300 text-slate-700 font-semibold"
                : "bg-white/5 border-white/15 text-slate-300"
            }`}
          >
            {t("监控与快捷入口", "Monitor & shortcut")}
          </span>
          <span className={`px-2 py-0.5 rounded text-[10px] ${isLight ? "bg-cyan-100 text-cyan-900 border border-cyan-300 font-bold" : "bg-cyan-400/20 text-cyan-300"}`}>
            {telemetry.authenticated
              ? t(`全局 ${telemetry.runningCount} 运行中 · ${telemetry.readyCount} 待开始`, `All tasks · ${telemetry.runningCount} running · ${telemetry.readyCount} ready`)
              : t("任务概览不可用", "Task summary unavailable")}
          </span>
        </div>
      </div>

      <div className={`text-[11px] ${isLight ? "text-slate-600" : "text-slate-300"}`}>
        {node.cmdDetail}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10.5px] font-mono">
        <div className={`p-2 rounded-lg border ${isLight ? "bg-white border-slate-200 text-slate-800" : "bg-black/50 border-white/10 text-slate-200"}`}>
          <div className="opacity-65">{t("求职任务总数", "All career tasks")}</div>
          <div className="font-bold mt-0.5 flex items-center gap-1">
            <Activity className="w-3 h-3 text-cyan-500" />
            <span>{telemetry.authenticated ? telemetry.totalTasks : "—"}</span>
          </div>
        </div>
        <div className={`p-2 rounded-lg border ${isLight ? "bg-white border-slate-200 text-slate-800" : "bg-black/50 border-white/10 text-slate-200"}`}>
          <div className="opacity-65">{t("全局待处理 / 暂停", "All awaiting / paused")}</div>
          <div className="font-bold mt-0.5 flex items-center gap-1">
            <Clock3 className="w-3 h-3 text-amber-500" />
            <span>{telemetry.authenticated ? telemetry.awaitingCount + telemetry.pausedCount : "—"}</span>
          </div>
        </div>
        <div className={`p-2 rounded-lg border ${isLight ? "bg-white border-slate-200 text-slate-800" : "bg-black/50 border-white/10 text-slate-200"}`}>
          <div className="opacity-65">{t("岗位 / 事实", "Jobs / facts")}</div>
          <div className="font-bold mt-0.5 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            <span>{savedJobsCount} / {claimCount}</span>
          </div>
        </div>
        <div className={`p-2 rounded-lg border ${isLight ? "bg-white border-slate-200 text-slate-800" : "bg-black/50 border-white/10 text-slate-200"}`}>
          <div className="opacity-65">{t("今日 Token", "Today tokens")}</div>
          <div className="font-bold mt-0.5 flex items-center gap-1">
            <Cpu className="w-3 h-3 text-purple-500" />
            <span>{telemetry.usage ? totalTokens.toLocaleString() : "—"}</span>
          </div>
        </div>
      </div>

      {matchedTasks.length > 0 ? (
        <div className={`p-2.5 rounded-lg border space-y-1.5 text-[10.5px] font-mono ${isLight ? "bg-white border-slate-200 text-slate-700" : "bg-black/55 border-white/10 text-slate-300"}`}>
          <div className="font-bold opacity-80">{t("此阶段近期任务（全局）", "Recent tasks by stage (all jobs)")}</div>
          {matchedTasks.map((task) => (
            <div key={task.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{task.kind} · {task.title}</span>
              <span className={`px-1.5 py-0.5 rounded text-[9.5px] shrink-0 ${
                task.status === "completed"
                  ? "bg-emerald-500/15 text-emerald-500"
                  : task.status === "running"
                    ? "bg-cyan-500/15 text-cyan-500"
                    : "bg-amber-500/15 text-amber-500"
              }`}>
                {t(...TASK_STATUS[task.status])}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className={`p-2.5 rounded-lg border flex items-center justify-between gap-2 text-[10.5px] font-mono ${isLight ? "bg-slate-100 text-slate-600 border-slate-200" : "bg-black/55 text-slate-400 border-white/10"}`}>
          <span className="flex items-center gap-1.5">
            <PauseCircle className="w-3.5 h-3.5 shrink-0" />
            <span>
              {telemetry.authenticated
                ? t("暂无此阶段任务", "No tasks for this stage")
                : t("暂未取得本机任务概览，请确认已登录且本机服务可用。", "Task summary is unavailable. Check that you are signed in and the local service is running.")}
            </span>
          </span>
        </div>
      )}

      {(onAnalyzeActiveJob || onOpenActiveRecord || onOpenOpportunitySources) && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {onAnalyzeActiveJob && (
            <button
              type="button"
              onClick={onAnalyzeActiveJob}
              className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-gradient-to-r from-amber-400 to-cyan-400 text-slate-950 hover:brightness-110 shadow transition flex items-center gap-1"
            >
              <span>{t("送入顾问执行", "Run in advisor")}</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          )}
          {onOpenActiveRecord && (
            <button
              type="button"
              onClick={onOpenActiveRecord}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${isLight ? "bg-white border-slate-300 text-slate-800 hover:bg-slate-100" : "bg-white/10 border-white/15 text-slate-100 hover:bg-white/15"}`}
            >
              {t("核对岗位记录", "Open opportunity")}
            </button>
          )}
          {!onAnalyzeActiveJob && onOpenOpportunitySources && (
            <button
              type="button"
              onClick={onOpenOpportunitySources}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${isLight ? "bg-white border-slate-300 text-slate-800 hover:bg-slate-100" : "bg-white/10 border-white/15 text-slate-100 hover:bg-white/15"}`}
            >
              {t("打开真实岗位库", "Open opportunities")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
