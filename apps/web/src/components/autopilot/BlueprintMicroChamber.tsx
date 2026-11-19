import { Check } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import type { AgentKernelConfig } from "./AutopilotAgentSprites";

export interface BlueprintMicroChamberProps {
  type: string;
  isSpotlight: boolean;
  code: string;
  agent: AgentKernelConfig;
  theme?: "light" | "dark";
}

export function BlueprintMicroChamber({
  type,
  isSpotlight,
  code,
  agent,
  theme = "dark",
}: BlueprintMicroChamberProps) {
  const { t } = useUiPreferences();
  const isLight = theme === "light";
  const cPrimary = isLight ? (agent.id === "opus-5.5" ? "#B45309" : agent.primaryHex) : agent.primaryHex;
  const cSecondary = isLight ? (agent.id === "opus-5.5" ? "#0284C7" : agent.secondaryHex) : agent.secondaryHex;

  return (
    <div
      style={{
        backgroundColor: isLight
          ? isSpotlight ? "#ECFDF5" : "#EBF1F6"
          : isSpotlight ? "#020810" : "#03060A",
        boxShadow: isLight
          ? isSpotlight
            ? "inset 0 3px 6px -1px rgba(6, 95, 70, 0.18), inset 0 1px 2px rgba(6, 95, 70, 0.15), 0 0 12px rgba(16, 185, 129, 0.22), 0 1px 0 rgba(255, 255, 255, 0.95)"
            : "inset 0 3px 6px -1px rgba(15, 23, 42, 0.18), inset 0 1px 2px rgba(15, 23, 42, 0.15), inset 0 0 0 1px rgba(15, 23, 42, 0.06), 0 1px 0 rgba(255, 255, 255, 0.95)"
          : isSpotlight
            ? "inset 0 4px 10px rgba(0, 0, 0, 0.98), inset 0 1px 4px rgba(0, 0, 0, 0.95), 0 0 16px rgba(56, 189, 248, 0.25), 0 1px 0 rgba(255, 255, 255, 0.12)"
            : "inset 0 4px 10px rgba(0, 0, 0, 0.98), inset 0 1px 4px rgba(0, 0, 0, 0.95), inset 0 0 0 1px rgba(255, 255, 255, 0.03), 0 1px 0 rgba(255, 255, 255, 0.08)",
        border: isLight
          ? isSpotlight ? "1px solid rgba(16, 185, 129, 0.5)" : "1px solid rgba(203, 213, 225, 0.8)"
          : isSpotlight ? "1px solid rgba(56, 189, 248, 0.45)" : "1px solid rgba(0, 0, 0, 0.9)",
      }}
      className="relative w-full h-[52px] rounded-lg overflow-hidden flex items-center justify-between px-2.5 py-1 transition-all duration-300"
    >
      <div
        style={{
          backgroundImage: isLight
            ? "radial-gradient(rgba(100, 116, 139, 0.28) 0.75px, transparent 0.75px)"
            : "radial-gradient(rgba(56, 189, 248, 0.16) 0.75px, transparent 0.75px)",
          backgroundSize: "6px 6px",
        }}
        className="pointer-events-none absolute inset-0 opacity-70"
      />

      <div className="relative z-10 flex-1 h-full flex items-center pr-1.5 overflow-hidden">
        {type === "hub" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <line x1="64" y1="18" x2="22" y2="8" stroke={cSecondary} strokeWidth="1.2" strokeDasharray="3 3" style={{ animation: "ap-dash-flow 1.5s linear infinite" }} />
            <line x1="64" y1="18" x2="22" y2="28" stroke={cSecondary} strokeWidth="1.2" strokeDasharray="3 3" style={{ animation: "ap-dash-flow 1.5s linear infinite" }} />
            <line x1="64" y1="18" x2="106" y2="8" stroke={cPrimary} strokeWidth="1.2" strokeDasharray="3 3" style={{ animation: "ap-dash-flow 1.5s linear infinite" }} />
            <line x1="64" y1="18" x2="106" y2="28" stroke={cSecondary} strokeWidth="1.2" strokeDasharray="3 3" style={{ animation: "ap-dash-flow 1.5s linear infinite" }} />
            <rect x="6" y="4" width="22" height="9" rx="2" fill={"var(--ap-tone-1)"} stroke={cSecondary} strokeWidth="0.9" />
            <rect x="6" y="23" width="22" height="9" rx="2" fill={"var(--ap-tone-1)"} stroke={"var(--ap-tone-2)"} strokeWidth="0.9" />
            <rect x="46" y="11" width="36" height="14" rx="3" fill={"var(--ap-tone-3)"} stroke={cPrimary} strokeWidth="1.3" />
            <text x="64" y="20.5" textAnchor="middle" fill={"var(--ap-tone-4)"} fontSize="6.5" fontFamily="monospace" fontWeight="bold">
              AGENT
            </text>
            <rect x="98" y="4" width="24" height="9" rx="2" fill={"var(--ap-tone-1)"} stroke={cPrimary} strokeWidth="0.9" />
            <rect x="98" y="23" width="24" height="9" rx="2" fill={"var(--ap-tone-1)"} stroke={cSecondary} strokeWidth="0.9" />
          </svg>
        )}

        {type === "bridge" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <rect x="6" y="11" width="38" height="14" rx="3.5" fill={"var(--ap-tone-5)"} stroke={cSecondary} strokeWidth="1" />
            <text x="25" y="20.5" textAnchor="middle" fill={"var(--ap-tone-6)"} fontSize="6" fontFamily="monospace" fontWeight="bold">
              {code === "12" ? "DRAFT" : "CARD"}
            </text>
            <line x1="44" y1="15" x2="78" y2="15" stroke={cPrimary} strokeWidth="1.1" />
            <line
              x1="44"
              y1="21"
              x2="78"
              y2="21"
              stroke={cSecondary}
              strokeWidth="1.2"
              strokeDasharray="3 3"
              style={{ animation: "ap-dash-flow 1.2s linear infinite" }}
            />
            <rect x="78" y="11" width="44" height="14" rx="3.5" fill={"var(--ap-tone-7)"} stroke={cPrimary} strokeWidth="1.1" />
            <text x="100" y="20.5" textAnchor="middle" fill={"var(--ap-tone-4)"} fontSize="6" fontFamily="monospace" fontWeight="bold">
              {code === "12" ? "REVIEW" : "VERIFY"}
            </text>
          </svg>
        )}

        {type === "diff" && (
          <div className="w-full space-y-1.5 font-mono text-[8px]">
            <div className="flex items-center gap-1.5">
              <span className={`w-6 ${isLight ? "text-slate-600 font-bold" : "text-slate-500"}`}>old</span>
              <div className={`h-2 w-14 rounded-xs ${isLight ? "bg-slate-300" : "bg-slate-700/80"}`} />
              <div className={`h-2 w-9 rounded-xs ${isLight ? "bg-rose-100 border border-rose-300 text-rose-800" : "bg-rose-500/45 border border-rose-400/50"}`} />
            </div>
            <div className="flex items-center gap-1.5">
              <span style={{ color: cSecondary }} className="font-bold w-6">
                new
              </span>
              <div className="relative h-2 w-12 rounded-xs overflow-hidden" style={{ backgroundColor: cSecondary }}>
                <div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent"
                  style={{ animation: "ap-shimmer-slide 1.8s ease-in-out infinite" }}
                />
              </div>
              <div className="relative h-2 w-16 rounded-xs overflow-hidden" style={{ backgroundColor: cPrimary }}>
                <div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent"
                  style={{ animation: "ap-shimmer-slide 1.8s ease-in-out infinite 0.4s" }}
                />
              </div>
            </div>
          </div>
        )}

        {type === "docscan" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-hidden">
            <rect x="8" y="3" width="22" height="30" rx="2" fill={"var(--ap-tone-8)"} stroke={cSecondary} strokeWidth="1.1" />
            <line x1="12" y1="9" x2="26" y2="9" stroke={cSecondary} strokeWidth="1.3" />
            <line x1="12" y1="14" x2="24" y2="14" stroke={"var(--ap-tone-9)"} strokeWidth="1.1" />
            <line x1="12" y1="19" x2="26" y2="19" stroke={cPrimary} strokeWidth="1.3" />
            <line x1="12" y1="24" x2="22" y2="24" stroke={"var(--ap-tone-9)"} strokeWidth="1.1" />
            <g style={{ animation: "ap-laser-scan 2.2s ease-in-out infinite alternate" }}>
              <line x1="7" y1="5" x2="31" y2="5" stroke="#06B6D4" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="9" y1="5" x2="29" y2="5" stroke="#FFFFFF" strokeWidth="0.8" />
            </g>
            <path d="M32 18H56" stroke={cSecondary} strokeWidth="1" strokeDasharray="2 2" style={{ animation: "ap-dash-flow 1.2s linear infinite" }} />
            <rect x="56" y="7" width="64" height="22" rx="3.5" fill={"var(--ap-tone-10)"} stroke={cSecondary} strokeWidth="1" />
            <text x="88" y="16" textAnchor="middle" fill={"var(--ap-tone-11)"} fontSize="6.5" fontFamily="monospace">
              1 page · A4
            </text>
            <text x="88" y="25" textAnchor="middle" fill={isLight ? "#0284C7" : cSecondary} fontSize="6.5" fontFamily="monospace" fontWeight="bold">
              {t("待顾问核验", "Advisor check")}
            </text>
          </svg>
        )}

        {type === "radar" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <polygon
              points="24,3 39,13 33,31 15,31 9,13"
              fill={isLight ? `${cSecondary}14` : `${cSecondary}20`}
              stroke={cSecondary}
              strokeWidth="1"
              strokeDasharray="2 2"
            />
            <polygon
              points="24,8 34,15 30,27 18,27 14,15"
              fill={isLight ? `${cPrimary}18` : `${cPrimary}28`}
              stroke={cPrimary}
              strokeWidth="0.9"
            />
            <g style={{ transformOrigin: "24px 17px", animation: "ap-radar-sweep 2.8s linear infinite" }}>
              <line x1="24" y1="17" x2="38" y2="17" stroke={"var(--ap-tone-12)"} strokeWidth="1.6" strokeLinecap="round" />
              <polygon points="24,17 38,13 38,21" fill={"var(--ap-tone-13)"} />
            </g>
            <circle cx="31" cy="11" r="2.2" fill={"var(--ap-tone-14)"} style={{ animation: "ap-led-ping 1.4s ease-in-out infinite" }} />
            <text x="48" y="15" fill={"var(--ap-tone-6)"} fontSize="6.5" fontFamily="monospace" fontWeight="600">
              {t("来源与发布方", "Origin audit")}
            </text>
            <text x="48" y="26" fill={isLight ? "#0284C7" : cSecondary} fontSize="7" fontFamily="monospace" fontWeight="bold">
              {t("核对原始链接", "Inspect source")}
            </text>
          </svg>
        )}

        {type === "dotmatrix" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            {Array.from({ length: 24 }).map((_, i) => {
              const col = i % 8;
              const row = Math.floor(i / 8);
              const active = i === 3 || i === 10 || i === 13 || i === 19;
              return (
                <circle
                  key={i}
                  cx={12 + col * 14}
                  cy={8 + row * 10}
                  r={active ? 2.4 : 1.2}
                  fill={active ? (i % 2 === 0 ? (isLight ? "#D97706" : cPrimary) : (isLight ? "#0284C7" : cSecondary)) : ("var(--ap-tone-15)")}
                  style={active ? { animation: `ap-led-ping ${1.2 + (i % 3) * 0.4}s ease-in-out infinite alternate` } : undefined}
                />
              );
            })}
          </svg>
        )}

        {type === "wagebars" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <g style={{ transformOrigin: "12px 32px", animation: "ap-bar-pulse-1 1.6s ease-in-out infinite alternate" }}>
              <rect x="8" y="18" width="9" height="14" rx="1.5" fill={"var(--ap-tone-2)"} />
            </g>
            <g style={{ transformOrigin: "26px 32px", animation: "ap-bar-pulse-2 1.8s ease-in-out infinite alternate 0.2s" }}>
              <rect x="22" y="12" width="9" height="20" rx="1.5" fill={isLight ? "#0284C7" : cSecondary} />
            </g>
            <g style={{ transformOrigin: "40px 32px", animation: "ap-bar-pulse-3 1.5s ease-in-out infinite alternate 0.4s" }}>
              <rect x="36" y="5" width="9" height="27" rx="1.5" fill={isLight ? "#D97706" : cPrimary} />
            </g>
            <g style={{ transformOrigin: "54px 32px", animation: "ap-bar-pulse-4 1.7s ease-in-out infinite alternate 0.1s" }}>
              <rect x="50" y="9" width="9" height="23" rx="1.5" fill="#10B981" />
            </g>
            <text x="66" y="16" fill={isLight ? "#B45309" : cPrimary} fontSize="7.5" fontFamily="monospace" fontWeight="bold">
              {t("假设测算", "Simulator")}
            </text>
            <text x="66" y="26" fill={"var(--ap-tone-6)"} fontSize="6.5" fontFamily="monospace" fontWeight="600">
              {t("用户滑块折算", "Slider only")}
            </text>
          </svg>
        )}

        {type === "star" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            {["S", "T", "A", "R"].map((letter, idx) => (
              <g key={letter}>
                {idx < 3 && (
                  <line
                    x1={24 + idx * 30}
                    y1="18"
                    x2={36 + idx * 30}
                    y2="18"
                    stroke={cSecondary}
                    strokeWidth="1.2"
                    strokeDasharray="2 2"
                    style={{ animation: "ap-dash-flow 1.4s linear infinite" }}
                  />
                )}
                <rect
                  x={8 + idx * 30}
                  y="10"
                  width="16"
                  height="16"
                  rx="3"
                  fill={"var(--ap-tone-16)"}
                  stroke={idx === 2 ? cPrimary : cSecondary}
                  strokeWidth="1.1"
                />
                <text
                  x={16 + idx * 30}
                  y="20.5"
                  textAnchor="middle"
                  fill={"var(--ap-tone-4)"}
                  fontSize="7"
                  fontFamily="monospace"
                  fontWeight="bold"
                >
                  {letter}
                </text>
              </g>
            ))}
          </svg>
        )}

        {type === "polygon" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <g style={{ transformOrigin: "24px 17px", animation: "ap-spin-slow 10s linear infinite" }}>
              <polygon
                points="24,4 39,11 35,29 14,30 9,13"
                fill={"var(--ap-tone-17)"}
                stroke={"var(--ap-tone-18)"}
                strokeWidth="1.2"
              />
              <circle cx="24" cy="4" r="2.2" fill={"var(--ap-tone-12)"} />
              <circle cx="39" cy="11" r="2.2" fill={"var(--ap-tone-19)"} />
            </g>
            <text x="48" y="15" fill={"var(--ap-tone-20)"} fontSize="7" fontFamily="monospace" fontWeight="bold">
              esbuild · QuickJS
            </text>
            <text x="48" y="26" fill={"var(--ap-tone-21)"} fontSize="6.5" fontFamily="monospace" fontWeight="600">
              {t("预设 / 本机编码", "Preset / local coding")}
            </text>
          </svg>
        )}

        {!["hub", "bridge", "diff", "docscan", "radar", "dotmatrix", "wagebars", "star", "polygon"].includes(type) && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <rect x="6" y="8" width="44" height="6" rx="2" fill={"var(--ap-tone-22)"} />
            <rect x="6" y="8" width="32" height="6" rx="2" fill={cSecondary} />
            <rect x="6" y="20" width="58" height="6" rx="2" fill={"var(--ap-tone-22)"} />
            <rect x="6" y="20" width="46" height="6" rx="2" fill={cPrimary} />
            <circle cx="78" cy="17" r="3.5" fill={"var(--ap-tone-1)"} stroke={cSecondary} strokeWidth="1.2" />
            <line x1="82" y1="17" x2="98" y2="17" stroke={cSecondary} strokeWidth="1" strokeDasharray="2 2" style={{ animation: "ap-dash-flow 1.5s linear infinite" }} />
            <rect x="98" y="10" width="26" height="14" rx="3" fill={"var(--ap-tone-16)"} stroke={cPrimary} strokeWidth="1.1" />
            <text x="111" y="19.5" textAnchor="middle" fill={"var(--ap-tone-4)"} fontSize="6.5" fontFamily="monospace" fontWeight="bold">
              #{code}
            </text>
          </svg>
        )}
      </div>

      <div
        style={{
          borderColor: isSpotlight ? cSecondary : ("var(--ap-tone-23)"),
          backgroundColor: isSpotlight
            ? (isLight ? "#ECFDF5" : `${cSecondary}22`)
            : ("var(--ap-tone-24)"),
          color: isSpotlight ? ("var(--ap-tone-25)") : ("var(--ap-tone-9)"),
          boxShadow: isSpotlight ? `0 0 10px ${cSecondary}55` : "none",
          animation: isSpotlight ? "ap-glow-pulse 2s ease-in-out infinite" : undefined,
        }}
        className="relative z-10 w-[18px] h-[18px] rounded-[5px] flex items-center justify-center border shrink-0 transition-all"
      >
        <Check className="w-2.5 h-2.5 stroke-[2.8]" />
      </div>
    </div>
  );
}
