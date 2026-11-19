import { useRef, useState } from "react";
import { ChevronRight, MapPin, RotateCw, Terminal } from "lucide-react";
import type { Opportunity } from "../../lib/opportunities";
import { useUiPreferences } from "../../lib/ui-preferences";
import { StudioRuntimeIcon } from "../StudioRuntimeIcon";
import type { AgentKernelConfig } from "./AutopilotAgentSprites";

export interface JobPipelineItem {
  id: string;
  queueRank: string;
  tier: string;
  company: string;
  shortName: string;
  logoText: string;
  logoGradient: string;
  glowColor: string;
  role: string;
  city: string;
  salary: string;
  annualTotal: string;
  workHours: string;
  sourcePlatform: string;
  sourceUrl: string;
  description: string;
  nextAction: string;
  updatedAt: string;
  materialsCount: number;
  communicationsCount: number;
  collectedIn3D: boolean;
  isNewMint: boolean;
  stage3D: string;
  tags: string[];
  sourceJob: Opportunity;
}

export interface CyberJobCard3DProps {
  job: JobPipelineItem;
  agent: AgentKernelConfig;
  isFlipped: boolean;
  stageLabelText: string;
  onToggleFlip: () => void;
  onInspectInStudio: (id: string) => void;
  onAnalyze?: (job: Opportunity) => void;
  onOpenRecord?: (id: string) => void;
  theme?: "light" | "dark";
}

export function CyberJobCard3D({
  job,
  agent,
  isFlipped,
  stageLabelText,
  onToggleFlip,
  onInspectInStudio,
  onAnalyze,
  onOpenRecord,
  theme = "dark",
}: CyberJobCard3DProps) {
  const { t, locale } = useUiPreferences();
  const isLight = theme === "light";
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0, glareX: 50, glareY: 30, hover: false });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isFlipped || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const rotY = ((x - rect.width / 2) / (rect.width / 2)) * 11;
    const rotX = -((y - rect.height / 2) / (rect.height / 2)) * 11;
    setTilt({
      rotateX: Number(rotX.toFixed(2)),
      rotateY: Number(rotY.toFixed(2)),
      glareX: Math.round((x / rect.width) * 100),
      glareY: Math.round((y / rect.height) * 100),
      hover: true,
    });
  };

  const handleMouseLeave = () => {
    setTilt({ rotateX: 0, rotateY: 0, glareX: 50, glareY: 25, hover: false });
  };

  const activeTiltX = isFlipped ? 0 : tilt.rotateX;
  const activeTiltY = isFlipped ? 0 : tilt.rotateY;
  const totalRotateY = (isFlipped ? 180 : 0) + activeTiltY;
  const updatedText = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(job.updatedAt));

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onToggleFlip}
      style={{ perspective: "1400px" }}
      data-cyber-card-id={job.id}
      data-job-id={job.id}
      className="cyber-3d-card group relative w-full h-[356px] select-none cursor-pointer"
    >
      <div
        style={{
          background: job.glowColor,
          transform: `translate3d(${-activeTiltY * 1.2}px, ${12 + activeTiltX}px, -30px) scale(${
            tilt.hover && !isFlipped ? 0.96 : 0.86
          })`,
          opacity: tilt.hover && !isFlipped ? 0.58 : 0.24,
        }}
        className="pointer-events-none absolute inset-x-6 bottom-1 h-20 rounded-3xl blur-2xl transition-all duration-300"
      />

      <div
        style={{
          transformStyle: "preserve-3d",
          transform: `translateZ(${tilt.hover && !isFlipped ? 14 : 0}px) rotateX(${activeTiltX}deg) rotateY(${totalRotateY}deg)`,
          transition: tilt.hover && !isFlipped
            ? "transform 110ms cubic-bezier(0.2, 0.85, 0.3, 1)"
            : "transform 650ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
        className="relative w-full h-full"
      >
        {/* 正面 */}
        <div
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
            transformStyle: "preserve-3d",
            backdropFilter: "blur(28px) saturate(190%)",
            backgroundColor: "var(--ap-tone-26)",
            pointerEvents: isFlipped ? "none" : "auto",
            boxShadow: tilt.hover && !isFlipped
              ? isLight
                ? `0 22px 48px -10px rgba(0,0,0,0.14), 0 0 0 1.5px ${agent.primaryHex}cc, inset 0 1px 0 rgba(255,255,255,0.95)`
                : `0 24px 50px -12px rgba(0,0,0,0.9), 0 0 0 1.5px ${agent.secondaryHex}aa, inset 0 1px 0 rgba(255,255,255,0.24)`
              : isLight
                ? "0 10px 28px -10px rgba(0,0,0,0.08), 0 0 0 1px #CBD5E1, inset 0 1px 0 rgba(255,255,255,0.95)"
                : "0 20px 42px -12px rgba(0,0,0,0.8), 0 0 0 1px #1E2E42, inset 0 1px 0 rgba(255,255,255,0.12)",
          }}
          className="absolute inset-0 rounded-2xl p-5 flex flex-col justify-between overflow-hidden"
        >
          <div
            style={{
              background: `radial-gradient(circle at ${tilt.glareX}% ${tilt.glareY}%, ${agent.secondaryHex}28 0%, transparent 62%)`,
            }}
            className="pointer-events-none absolute inset-0"
          />

          <div style={{ transform: "translateZ(32px)" }} className="relative flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div
                style={{
                  background: job.logoGradient,
                  boxShadow: "0 10px 18px -4px rgba(0,0,0,0.55), inset 0 1px 1px rgba(255,255,255,0.5)",
                }}
                className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-mono font-black text-sm shrink-0 relative"
              >
                {job.logoText}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`px-1.5 py-0.2 rounded font-mono text-[10px] font-bold border ${
                      isLight
                        ? "bg-amber-100 text-amber-900 border-amber-300"
                        : "bg-amber-400/15 text-amber-300 border-amber-400/30"
                    }`}
                  >
                    {job.queueRank} · {stageLabelText}
                  </span>
                  <span className={`text-xs font-medium truncate ${isLight ? "text-slate-600 font-semibold" : "text-slate-300"}`}>
                    {job.company}
                  </span>
                </div>
                <h3 className={`text-[15px] font-bold tracking-tight mt-0.5 truncate ${isLight ? "text-slate-900" : "text-white"}`}>
                  {job.role}
                </h3>
                <div className={`text-[11px] mt-0.5 flex items-center gap-1 ${isLight ? "text-slate-500" : "text-slate-400"}`}>
                  <MapPin className="w-3 h-3 text-cyan-500 shrink-0" />
                  <span className="truncate">{job.city}</span>
                </div>
              </div>
            </div>

            <div
              className={`shrink-0 font-mono text-center px-2.5 py-1.5 rounded-xl border ${
                isLight ? "bg-cyan-50 border-cyan-200" : "bg-cyan-400/10 border-cyan-400/30"
              }`}
            >
              <div className={`text-xs font-black ${isLight ? "text-cyan-800" : "text-cyan-300"}`}>{job.materialsCount}</div>
              <div className={`text-[9px] ${isLight ? "text-slate-500" : "text-slate-400"}`}>{t("快照", "SNAP")}</div>
            </div>
          </div>

          <div
            style={{
              transform: "translateZ(22px)",
              boxShadow: isLight ? "inset 0 1px 3px rgba(0,0,0,0.06)" : "inset 0 2px 6px rgba(0,0,0,0.9)",
            }}
            className={`relative rounded-xl p-3 border flex items-center justify-between gap-2 font-mono ${
              isLight ? "bg-slate-50 border-slate-200" : "bg-[#05080D] border-[#182638]"
            }`}
          >
            <div className="min-w-0">
              <div className={`text-[10px] truncate ${isLight ? "text-slate-500" : "text-slate-400"}`}>{job.annualTotal}</div>
              <div className={`text-sm font-extrabold mt-0.5 truncate ${isLight ? "text-amber-800" : "text-amber-400"}`}>{job.salary}</div>
            </div>
            <div className="text-right shrink-0">
              <div
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold ${
                  isLight ? "bg-emerald-50 text-emerald-800 border-emerald-300" : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                }`}
              >
                {updatedText}
              </div>
              <div className={`text-[10px] mt-1 ${isLight ? "text-slate-600 font-medium" : "text-cyan-300/90"}`}>{job.workHours}</div>
            </div>
          </div>

          <div style={{ transform: "translateZ(18px)" }} className="relative flex flex-wrap gap-1.5">
            {job.tags.map((tag, i) => (
              <span
                key={i}
                className={`px-2 py-0.5 rounded-md text-[10.5px] font-mono border ${
                  isLight ? "bg-slate-100 border-slate-200 text-slate-700" : "bg-[#0E1724] border-[#1E3048] text-slate-200"
                }`}
              >
                {tag}
              </span>
            ))}
          </div>

          <div
            style={{ transform: "translateZ(24px)" }}
            className={`relative pt-2 border-t flex items-center justify-between text-[11px] font-mono ${
              isLight ? "border-slate-200" : "border-white/[0.08]"
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <StudioRuntimeIcon agentId={agent.id} className="w-4 h-4 shrink-0" />
              <span className={`truncate ${isLight ? "text-slate-600" : "text-slate-300"}`}>{agent.shortName}</span>
            </div>
            <div className={`flex items-center gap-1 font-medium shrink-0 ${isLight ? "text-cyan-700 hover:text-cyan-900" : "text-cyan-300"}`}>
              <RotateCw className="w-3 h-3 transition-transform duration-500 group-hover:rotate-180" />
              <span>{t("180° 翻转详情", "Flip 180° details")}</span>
            </div>
          </div>
        </div>

        {/* 背面 */}
        <div
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
            transform: "rotateY(180deg)",
            transformStyle: "preserve-3d",
            backdropFilter: "blur(30px) saturate(200%)",
            backgroundColor: "var(--ap-tone-27)",
            pointerEvents: isFlipped ? "auto" : "none",
            boxShadow: isLight
              ? `0 24px 50px -12px rgba(0,0,0,0.15), 0 0 0 1.5px ${agent.primaryHex}cc, inset 0 1px 0 rgba(255,255,255,0.9)`
              : `0 24px 50px -12px rgba(0,0,0,0.92), 0 0 0 1.5px ${agent.primaryHex}aa, inset 0 1px 0 rgba(255,255,255,0.22)`,
          }}
          className="absolute inset-0 rounded-2xl p-5 flex flex-col justify-between overflow-hidden"
        >
          <div
            style={{ transform: "translateZ(24px)" }}
            className={`flex items-center justify-between border-b pb-2 gap-2 ${
              isLight ? "border-slate-200" : "border-white/10"
            }`}
          >
            <div className="flex items-center gap-2 font-mono text-xs font-bold truncate" style={{ color: isLight ? (agent.id === "opus-5.5" ? "#B45309" : agent.primaryHex) : agent.primaryHex }}>
              <StudioRuntimeIcon agentId={agent.id} className="w-5 h-5 shrink-0" />
              <span className="truncate">{job.sourcePlatform}</span>
            </div>
            <span
              className={`font-mono text-[10px] px-2 py-0.5 rounded border shrink-0 ${
                isLight
                  ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                  : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
              }`}
            >
              {stageLabelText}
            </span>
          </div>

          <div style={{ transform: "translateZ(28px)" }} className="space-y-2 text-[11px] leading-relaxed my-1">
            <div
              className={`p-2.5 rounded-xl border ${
                isLight
                  ? "bg-emerald-50 border-emerald-200 text-emerald-950"
                  : "bg-emerald-950/35 border-emerald-500/30 text-emerald-100"
              }`}
            >
              <div
                className={`font-mono font-bold text-[10.5px] mb-0.5 ${
                  isLight ? "text-emerald-800" : "text-emerald-300"
                }`}
              >
                {t("下一步跟进", "Next follow-up")}
              </div>
              <p className="line-clamp-2 opacity-95">{job.nextAction}</p>
            </div>
            <div
              className={`p-2.5 rounded-xl border ${
                isLight
                  ? "bg-cyan-50 border-cyan-200 text-cyan-950"
                  : "bg-cyan-950/35 border-cyan-500/30 text-cyan-100"
              }`}
            >
              <div
                className={`font-mono font-bold text-[10.5px] mb-0.5 ${
                  isLight ? "text-cyan-800" : "text-cyan-300"
                }`}
              >
                {t(`沟通 ${job.communicationsCount} · 材料 ${job.materialsCount}`, `Comms ${job.communicationsCount} · Snapshots ${job.materialsCount}`)}
              </div>
              <p className="line-clamp-2 opacity-95">
                {job.description ? job.description : t("尚未保存 JD 正文；背调与匹配需送入顾问执行后生成真实回执。", "No description saved yet; run Advisor for real research and match receipts.")}
              </p>
            </div>
          </div>

          <div style={{ transform: "translateZ(30px)" }} onClick={(e) => e.stopPropagation()} className="grid grid-cols-2 gap-2">
            {onOpenRecord && (
              <button
                type="button"
                onClick={() => onOpenRecord(job.id)}
                className={`py-1.5 px-2.5 rounded-xl font-mono text-[11px] font-bold border transition ${
                  isLight ? "bg-slate-100 border-slate-300 text-slate-800 hover:bg-slate-200" : "bg-white/10 border-white/15 text-slate-100 hover:bg-white/15"
                }`}
              >
                {t("核对岗位记录", "Review record")}
              </button>
            )}
            {onAnalyze && (
              <button
                type="button"
                onClick={() => onAnalyze(job.sourceJob)}
                className="py-1.5 px-2.5 rounded-xl font-mono text-[11px] font-bold text-slate-950 bg-gradient-to-r from-amber-400 via-amber-300 to-cyan-300 hover:brightness-110 shadow flex items-center justify-center gap-1 transition"
              >
                <span>{t("送入顾问", "Send to advisor")}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onInspectInStudio(job.id)}
              className={`col-span-2 py-1.5 px-3 rounded-xl font-mono text-[11px] font-bold border flex items-center justify-center gap-1.5 transition ${
                isLight ? "bg-cyan-50 border-cyan-300 text-cyan-900 hover:bg-cyan-100" : "bg-cyan-500/15 border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/25"
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>{t(`载入 ${agent.shortName} 20-Node 工坊`, `Open ${agent.shortName} in the 20-Node studio`)} ➔</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
