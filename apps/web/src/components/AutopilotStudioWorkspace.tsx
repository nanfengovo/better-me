import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { FactBase, ProjectedResume } from "@better-me/core";
import {
  useInstalledMicroApps,
  type InstalledMicroApp,
} from "../lib/micro-app-registry";
import {
  readOpportunityLibrary,
} from "../lib/opportunities";
import { useUiPreferences } from "../lib/ui-preferences";
import { captureIdentityLease } from "../lib/identity";
import {
  buildSandboxedMicroApp,
  openReviewedPreset,
  PRESET_MICRO_APP_TEMPLATES,
  type BuiltMicroAppArtifact,
} from "../services/sandbox-build-client";
import { MicroAppPermissionModal } from "./MicroAppPermissionModal";
import { SandboxCodingLab } from "./SandboxCodingLab";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Check,
  ShieldCheck,
  Terminal,
  ChevronRight,
  MapPin,
  RotateCw,
  Orbit,
  BookmarkCheck,
  Eye,
  Layers,
  Zap,
  Lock,
  Code2,
  Activity,
  Sun,
  Moon,
  Sliders,
  Loader2,
  CheckCircle2,
  Mic,
} from "lucide-react";
import { openSystemSettings } from "../lib/settings-navigation";
import "./autopilot-studio.css";

// ============================================================================
// 1. 四大可选 AI AGENT 内核配置
// ============================================================================
export interface AgentKernelConfig {
  id: "opus-5.5" | "deepseek-r2" | "gpt-5.2" | "ollama-qwen3";
  shortName: string;
  brandName: string;
  fullTitle: string;
  cliHeaderTitle: string;
  cliVersion: string;
  heroBannerPrefix: string;
  mascotName: string;
  mascotRole: string;
  modelSpec: string;
  computeBadge: string;
  primaryHex: string;
  secondaryHex: string;
  glowRgba: string;
  spotlightRgba: string;
  borderAccent: string;
  terminalBoxBorder: string;
  ambientBg: string;
  signatureQuote: string;
}

export const AGENT_KERNELS: Record<string, AgentKernelConfig> = {
  "opus-5.5": {
    id: "opus-5.5",
    shortName: "Opus 5.5",
    brandName: "Claude Code",
    fullTitle: "Claude Code · Opus 5.5 Max",
    cliHeaderTitle: "Claude Code",
    cliVersion: "v2.1.104",
    heroBannerPrefix: "OPUS 5.5 + FACTBASE",
    mascotName: "Clawd-5.5",
    mascotRole: "16-Bit 像素赛博蟹 · 实证审计官",
    modelSpec: "claude-opus-5.5-202611 · 200k ctx",
    computeBadge: "Anthropic Max · Zero-Hallucination",
    primaryHex: "#F59E0B",
    secondaryHex: "#22D3EE",
    glowRgba: "rgba(245, 158, 11, 0.42)",
    spotlightRgba: "rgba(34, 211, 238, 0.36)",
    borderAccent: "#F59E0B",
    terminalBoxBorder: "rgba(245, 158, 11, 0.45)",
    ambientBg:
      "radial-gradient(circle at 50% 8%, rgba(245, 158, 11, 0.11) 0%, rgba(34, 211, 238, 0.06) 35%, transparent 65%)",
    signatureQuote: "Every resume claim is cryptographically locked to local FactBase [FB-01..38].",
  },
  "deepseek-r2": {
    id: "deepseek-r2",
    shortName: "DeepSeek R2",
    brandName: "OpenCode CLI",
    fullTitle: "OpenCode · DeepSeek-R2 671B",
    cliHeaderTitle: "OpenCode // DeepSeek-R2",
    cliVersion: "v1.9.4-r2",
    heroBannerPrefix: "DEEPSEEK R2 + FACTBASE",
    mascotName: "Fin-R2",
    mascotRole: "全息深海赛博鲸 · 链式推演引擎",
    modelSpec: "deepseek-r2-671b-moe · CoT Stream",
    computeBadge: "DeepSeek Native · 128k Reasoning",
    primaryHex: "#38BDF8",
    secondaryHex: "#818CF8",
    glowRgba: "rgba(56, 189, 248, 0.45)",
    spotlightRgba: "rgba(129, 140, 248, 0.38)",
    borderAccent: "#38BDF8",
    terminalBoxBorder: "rgba(56, 189, 248, 0.48)",
    ambientBg:
      "radial-gradient(circle at 50% 8%, rgba(56, 189, 248, 0.14) 0%, rgba(129, 140, 248, 0.08) 38%, transparent 65%)",
    signatureQuote: "Multi-hop chain-of-thought decompilation across JD hidden weights & salary bands.",
  },
  "gpt-5.2": {
    id: "gpt-5.2",
    shortName: "GPT-5.2 Pro",
    brandName: "Codex CLI",
    fullTitle: "OpenAI Codex · GPT-5.2 Pro",
    cliHeaderTitle: "Codex CLI // GPT-5.2",
    cliVersion: "v3.6.0-pro",
    heroBannerPrefix: "GPT-5.2 PRO + FACTBASE",
    mascotName: "Hex-5.2",
    mascotRole: "六轴翡翠矩阵无人机 · 沙箱架构师",
    modelSpec: "gpt-5.2-pro-codex · High-Compute",
    computeBadge: "OpenAI Pro · AST Sandbox Verified",
    primaryHex: "#10B981",
    secondaryHex: "#2DD4BF",
    glowRgba: "rgba(16, 185, 129, 0.42)",
    spotlightRgba: "rgba(45, 212, 191, 0.36)",
    borderAccent: "#10B981",
    terminalBoxBorder: "rgba(16, 185, 129, 0.45)",
    ambientBg:
      "radial-gradient(circle at 50% 8%, rgba(16, 185, 129, 0.13) 0%, rgba(45, 212, 191, 0.07) 36%, transparent 65%)",
    signatureQuote: "Autonomous Workday ATS DOM simulation & zero-defect micro-app compilation.",
  },
  "ollama-qwen3": {
    id: "ollama-qwen3",
    shortName: "Qwen3-32B Local",
    brandName: "Ollama Local",
    fullTitle: "Ollama · Qwen3-Coder 32B (RTX 4060)",
    cliHeaderTitle: "Ollama // Qwen3-Coder",
    cliVersion: "v0.9.8-cuda",
    heroBannerPrefix: "QWEN3 LOCAL + FACTBASE",
    mascotName: "Tensor-Q3",
    mascotRole: "机甲羊驼算力核 · 100% 离线隐私沙箱",
    modelSpec: "qwen3-coder:32b-q4_K_M · CUDA:0",
    computeBadge: "Local RTX 4060 · Air-Gapped Privacy",
    primaryHex: "#A855F7",
    secondaryHex: "#EC4899",
    glowRgba: "rgba(168, 85, 247, 0.45)",
    spotlightRgba: "rgba(236, 72, 153, 0.36)",
    borderAccent: "#A855F7",
    terminalBoxBorder: "rgba(168, 85, 247, 0.48)",
    ambientBg:
      "radial-gradient(circle at 50% 8%, rgba(168, 85, 247, 0.14) 0%, rgba(236, 72, 153, 0.07) 36%, transparent 65%)",
    signatureQuote: "100% air-gapped local tensor inference — your resume never leaves localhost.",
  },
};

// ============================================================================
// 2. 高精度定制 AI AGENT 徽标图腾
// ============================================================================
export function AgentTotemIcon({
  agentId,
  className = "w-7 h-7",
  spinning = false,
}: {
  agentId: string;
  className?: string;
  spinning?: boolean;
}) {
  if (agentId === "opus-5.5") {
    return (
      <svg viewBox="0 0 32 32" className={`${className} ${spinning ? "animate-spin" : ""}`} fill="none">
        <defs>
          <radialGradient id="opusCore" cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor="#FFFBEB" />
            <stop offset="35%" stopColor="#FBBF24" />
            <stop offset="75%" stopColor="#EA580C" />
            <stop offset="100%" stopColor="#9A3412" />
          </radialGradient>
          <linearGradient id="opusRim" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FDE68A" />
            <stop offset="0.5" stopColor="#F97316" />
            <stop offset="1" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="14" fill="#0B111A" stroke="url(#opusRim)" strokeWidth="1.2" strokeOpacity="0.65" />
        <path
          d="M16 3L18.1 10.2L24.5 6.5L20.8 12.9L28 15L20.8 17.1L24.5 23.5L18.1 19.8L16 27L13.9 19.8L7.5 23.5L11.2 17.1L4 15L11.2 12.9L7.5 6.5L13.9 10.2L16 3Z"
          fill="url(#opusCore)"
          stroke="#FDE68A"
          strokeWidth="0.75"
        />
        <rect x="14.5" y="11" width="3" height="8" rx="0.5" fill="#FFFBEB" fillOpacity="0.9" />
        <rect x="12" y="13.5" width="8" height="3" rx="0.5" fill="#FFFBEB" fillOpacity="0.9" />
      </svg>
    );
  }

  if (agentId === "deepseek-r2") {
    return (
      <svg viewBox="0 0 32 32" className={className} fill="none">
        <defs>
          <linearGradient id="dsGrad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
            <stop stopColor="#67E8F9" />
            <stop offset="0.5" stopColor="#0284C7" />
            <stop offset="1" stopColor="#4F46E5" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="14" fill="#07101E" stroke="#38BDF8" strokeWidth="1.2" strokeOpacity="0.6" />
        <circle cx="16" cy="16" r="10.5" stroke="#818CF8" strokeWidth="0.8" strokeDasharray="2 2" />
        <path
          d="M7 18.5C7 12.5 11.8 8.5 17.5 8.5C21.5 8.5 24.2 10.8 25.5 13.5C22.8 13.2 20.5 14.8 19.8 17.2C22.2 17.4 24.5 19.2 25.8 21.8C22.5 22.8 18.8 21.5 16.5 19.2C14.2 21.5 10.5 22.2 7 18.5Z"
          fill="url(#dsGrad)"
          stroke="#BAE6FD"
          strokeWidth="0.9"
        />
        <circle cx="19.5" cy="12.2" r="1.4" fill="#FFF" />
      </svg>
    );
  }

  if (agentId === "gpt-5.2") {
    return (
      <svg viewBox="0 0 32 32" className={className} fill="none">
        <defs>
          <linearGradient id="gptGrad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6EE7B7" />
            <stop offset="0.5" stopColor="#10B981" />
            <stop offset="1" stopColor="#047857" />
          </linearGradient>
        </defs>
        <polygon
          points="16,2.5 27.5,9.2 27.5,22.8 16,29.5 4.5,22.8 4.5,9.2"
          fill="#06130F"
          stroke="#10B981"
          strokeWidth="1.3"
        />
        <polygon
          points="16,6.5 24,11.2 24,20.8 16,25.5 8,20.8 8,11.2"
          fill="url(#gptGrad)"
          fillOpacity="0.28"
          stroke="#A7F3D0"
          strokeWidth="1"
        />
        <path d="M16 6.5V16M16 16L24 20.8M16 16L8 20.8" stroke="#ECFDF5" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="16" cy="16" r="2.8" fill="#10B981" stroke="#FFF" strokeWidth="1" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 32 32" className={className} fill="none">
      <defs>
        <linearGradient id="qwenGrad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#E879F9" />
          <stop offset="0.5" stopColor="#A855F7" />
          <stop offset="1" stopColor="#6366F1" />
        </linearGradient>
      </defs>
      <rect x="3.5" y="3.5" width="25" height="25" rx="6" fill="#11091C" stroke="url(#qwenGrad)" strokeWidth="1.3" />
      <path
        d="M9 1.5V3.5M16 1.5V3.5M23 1.5V3.5M9 28.5V30.5M16 28.5V30.5M23 28.5V30.5M1.5 9H3.5M1.5 16H3.5M1.5 23H3.5M28.5 9H30.5M28.5 16H30.5M28.5 23H30.5"
        stroke="#C084FC"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <polygon
        points="16,7.5 23.5,11.8 23.5,20.2 16,24.5 8.5,20.2 8.5,11.8"
        fill="url(#qwenGrad)"
        stroke="#F5D0FE"
        strokeWidth="0.9"
      />
      <rect x="11.5" y="13" width="9" height="3.2" rx="1" fill="#090514" stroke="#F0ABFC" strokeWidth="0.8" />
    </svg>
  );
}

// ============================================================================
// 3. 高精度动态 AI 游走精灵组件 (Agent Roaming Mascot Sprite)
// ============================================================================
export function AgentMascotSprite({
  agentId,
  className = "w-11 h-11",
  showPedestal = false,
}: {
  agentId: string;
  className?: string;
  showPedestal?: boolean;
}) {
  return (
    <div className="relative inline-flex flex-col items-center justify-center">
      {agentId === "opus-5.5" && (
        <svg viewBox="0 0 24 20" className={className} shapeRendering="crispEdges">
          <rect x="4" y="18" width="16" height="1.5" fill="rgba(245, 158, 11, 0.35)" />
          <rect x="2" y="2" width="3" height="2" fill="#FDE68A" />
          <rect x="1" y="4" width="3" height="3" fill="#FB923C" />
          <rect x="3" y="5" width="2" height="2" fill="#EA580C" />
          <rect x="19" y="2" width="3" height="2" fill="#FDE68A" />
          <rect x="20" y="4" width="3" height="3" fill="#FB923C" />
          <rect x="19" y="5" width="2" height="2" fill="#EA580C" />
          <rect x="6" y="4" width="12" height="2" fill="#FDBA74" />
          <rect x="5" y="6" width="14" height="6" fill="#F97316" />
          <rect x="4" y="7" width="16" height="4" fill="#EA580C" />
          <rect x="6" y="12" width="12" height="2" fill="#9A3412" />
          <rect x="7" y="7" width="2.5" height="3" fill="#05080D" />
          <rect x="14.5" y="7" width="2.5" height="3" fill="#05080D" />
          <rect x="7.5" y="7.5" width="1.2" height="1.2" fill="#22D3EE" />
          <rect x="15" y="7.5" width="1.2" height="1.2" fill="#22D3EE" />
          <rect x="3" y="13" width="2" height="3" fill="#FB923C" />
          <rect x="7" y="14" width="2" height="3" fill="#EA580C" />
          <rect x="15" y="14" width="2" height="3" fill="#EA580C" />
          <rect x="19" y="13" width="2" height="3" fill="#FB923C" />
        </svg>
      )}

      {agentId === "deepseek-r2" && (
        <svg viewBox="0 0 28 22" className={className} fill="none">
          <defs>
            <linearGradient id="whaleBody" x1="2" y1="4" x2="24" y2="18" gradientUnits="userSpaceOnUse">
              <stop stopColor="#A5F3FC" />
              <stop offset="0.45" stopColor="#38BDF8" />
              <stop offset="1" stopColor="#4338CA" />
            </linearGradient>
          </defs>
          <ellipse cx="14" cy="19.5" rx="9" ry="1.6" stroke="#38BDF8" strokeWidth="0.8" strokeDasharray="2 2" />
          <path
            d="M3 12.5C3 7.5 7.8 4.5 14.5 4.5C19.5 4.5 22.5 7.5 24.5 4.5C24.2 8.2 22.8 10.2 21 11.2C23.2 12.4 25 14.2 26 16.5C22.5 16.5 20.2 15.2 18.5 13.8C15.5 15.8 7.5 16.5 3 12.5Z"
            fill="url(#whaleBody)"
            stroke="#E0F2FE"
            strokeWidth="1"
          />
          <path d="M6 13.2C9.5 14.5 13.5 14.5 16.5 13.2" stroke="#BAE6FD" strokeWidth="0.9" strokeLinecap="round" />
          <circle cx="8.5" cy="9.8" r="1.6" fill="#05080D" stroke="#67E8F9" strokeWidth="0.9" />
          <circle cx="8.2" cy="9.5" r="0.6" fill="#FFF" />
          <circle cx="6" cy="3.2" r="1" fill="#38BDF8" />
          <circle cx="9.2" cy="2.2" r="0.7" fill="#818CF8" />
        </svg>
      )}

      {agentId === "gpt-5.2" && (
        <svg viewBox="0 0 28 24" className={className} fill="none">
          <ellipse cx="14" cy="21" rx="8" ry="1.5" fill="rgba(16, 185, 129, 0.35)" />
          <ellipse
            cx="14"
            cy="11"
            rx="12"
            ry="5.5"
            transform="rotate(-16 14 11)"
            stroke="#34D399"
            strokeWidth="1"
            strokeDasharray="3 2"
          />
          <ellipse
            cx="14"
            cy="11"
            rx="12"
            ry="5.5"
            transform="rotate(16 14 11)"
            stroke="#2DD4BF"
            strokeWidth="0.9"
            strokeOpacity="0.7"
          />
          <polygon
            points="14,3.5 21,7.2 21,14.8 14,18.5 7,14.8 7,7.2"
            fill="#06281E"
            stroke="#6EE7B7"
            strokeWidth="1.2"
          />
          <rect x="9.5" y="9.2" width="9" height="3.6" rx="1.8" fill="#020604" stroke="#10B981" strokeWidth="0.9" />
          <circle cx="14" cy="11" r="1.4" fill="#34D399" />
          <circle cx="14" cy="11" r="0.6" fill="#FFF" />
        </svg>
      )}

      {agentId === "ollama-qwen3" && (
        <svg viewBox="0 0 28 24" className={className} fill="none">
          <ellipse cx="14" cy="21.5" rx="8" ry="1.5" fill="rgba(168, 85, 247, 0.38)" />
          <rect x="2" y="6" width="3" height="3" rx="0.6" fill="#E879F9" stroke="#FFF" strokeWidth="0.5" />
          <rect x="23" y="6" width="3" height="3" rx="0.6" fill="#A855F7" stroke="#FFF" strokeWidth="0.5" />
          <path d="M8.5 7L7 2.5L11 5.5Z" fill="#C084FC" stroke="#F5D0FE" strokeWidth="0.8" />
          <path d="M19.5 7L21 2.5L17 5.5Z" fill="#C084FC" stroke="#F5D0FE" strokeWidth="0.8" />
          <rect x="7" y="5.5" width="14" height="12.5" rx="3.5" fill="#1E1035" stroke="#D8B4FE" strokeWidth="1.1" />
          <rect x="8.5" y="8.2" width="11" height="4.2" rx="1.5" fill="#090414" stroke="#F0ABFC" strokeWidth="1" />
          <line x1="10" y1="10.3" x2="13" y2="10.3" stroke="#22D3EE" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="15" y1="10.3" x2="18" y2="10.3" stroke="#EC4899" strokeWidth="1.4" strokeLinecap="round" />
          <rect x="11" y="14.2" width="6" height="2" rx="0.6" fill="#A855F7" />
        </svg>
      )}

      {showPedestal && (
        <div className="mt-1 w-14 h-2 rounded-full bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent blur-[1px]" />
      )}
    </div>
  );
}

// ============================================================================
// 4. 6x6 外环 20 槽位逆时针映射
// ============================================================================
const PERIMETER_20_SLOTS = [
  { row: 1, col: 1, zone: "TOP" },
  { row: 1, col: 2, zone: "TOP" },
  { row: 1, col: 3, zone: "SPOTLIGHT" }, // 顶部中央黄金聚光位
  { row: 1, col: 4, zone: "TOP" },
  { row: 1, col: 5, zone: "TOP" },
  { row: 1, col: 6, zone: "TOP" },
  { row: 2, col: 6, zone: "RIGHT" },
  { row: 3, col: 6, zone: "RIGHT" },
  { row: 4, col: 6, zone: "RIGHT" },
  { row: 5, col: 6, zone: "RIGHT" },
  { row: 6, col: 6, zone: "BOTTOM" },
  { row: 6, col: 5, zone: "BOTTOM" },
  { row: 6, col: 4, zone: "BOTTOM" },
  { row: 6, col: 3, zone: "BOTTOM" },
  { row: 6, col: 2, zone: "BOTTOM" },
  { row: 6, col: 1, zone: "BOTTOM" },
  { row: 5, col: 1, zone: "LEFT" },
  { row: 4, col: 1, zone: "LEFT" },
  { row: 3, col: 1, zone: "LEFT" },
  { row: 2, col: 1, zone: "LEFT" },
];

// ============================================================================
// 5. 20 节点求职工程流水线全链路拓扑定义
// ============================================================================
export interface StudioNode {
  id: number;
  code: string;
  name: string;
  tag: string;
  sub: string;
  vizType: string;
  latency: string;
  tokens: string;
  bulletColor: string;
  cmdTitle: string;
  cmdDetail: string;
}

export function getNodeTagBadge(tag: string, theme: "light" | "dark") {
  const isLight = theme === "light";
  switch (tag) {
    case "CORE":
      return isLight ? "bg-amber-100 text-amber-900 border-amber-300" : "bg-amber-400/15 text-amber-300 border-amber-400/30";
    case "SOURCING":
      return isLight ? "bg-sky-100 text-sky-900 border-sky-300" : "bg-sky-400/15 text-sky-300 border-sky-400/30";
    case "GUARD":
      return isLight ? "bg-emerald-100 text-emerald-900 border-emerald-300" : "bg-emerald-400/15 text-emerald-300 border-emerald-400/30";
    case "ANALYSIS":
      return isLight ? "bg-purple-100 text-purple-900 border-purple-300" : "bg-purple-400/15 text-purple-300 border-purple-400/30";
    case "TRIAGE":
      return isLight ? "bg-indigo-100 text-indigo-900 border-indigo-300" : "bg-indigo-400/15 text-indigo-300 border-indigo-400/30";
    case "TAILOR":
      return isLight ? "bg-orange-100 text-orange-900 border-orange-300" : "bg-orange-400/15 text-orange-300 border-orange-400/30";
    case "VERIFY":
      return isLight ? "bg-teal-100 text-teal-900 border-teal-300" : "bg-teal-400/15 text-teal-300 border-teal-400/30";
    case "DELIVERY":
      return isLight ? "bg-blue-100 text-blue-900 border-blue-300" : "bg-blue-400/15 text-blue-300 border-blue-400/30";
    case "TRACKING":
      return isLight ? "bg-cyan-100 text-cyan-900 border-cyan-300" : "bg-cyan-400/15 text-cyan-300 border-cyan-400/30";
    case "INTERVIEW":
      return isLight ? "bg-rose-100 text-rose-900 border-rose-300" : "bg-rose-400/15 text-rose-300 border-rose-400/30";
    case "DECISION":
      return isLight ? "bg-amber-100 text-amber-900 border-amber-300" : "bg-amber-400/15 text-amber-300 border-amber-400/30";
    case "SANDBOX":
      return isLight ? "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-300" : "bg-fuchsia-400/15 text-fuchsia-300 border-fuchsia-400/30";
    default:
      return isLight ? "bg-slate-100 text-slate-700 border-slate-300" : "bg-slate-800 text-slate-300 border-slate-700";
  }
}

export const STUDIO_20_NODES: ReadonlyArray<StudioNode> = [
  {
    id: 1,
    code: "01",
    name: "BetterMe Agent",
    tag: "CORE",
    sub: "多内核编排 · 调度全部 20 项能力",
    vizType: "hub",
    latency: "38ms",
    tokens: "0.4k",
    bulletColor: "#F59E0B",
    cmdTitle: "kernel.orchestrate(skills=20, prefetch=2)",
    cmdDetail: "38 FactBase claims locked · Active target queue initialized",
  },
  {
    id: 2,
    code: "02",
    name: "招聘检索",
    tag: "SOURCING",
    sub: "公开岗位卡 · SimHash 语义去重",
    vizType: "bars",
    latency: "610ms",
    tokens: "0.8k",
    bulletColor: "#38BDF8",
    cmdTitle: 'sourcing.query(role="Senior .NET / RCS", city="Shanghai")',
    cmdDetail: "42 raw postings scanned ➔ 11 high-signal roles deduplicated",
  },
  {
    id: 3,
    code: "03",
    name: "BOSS直聘",
    tag: "SOURCING",
    sub: "只读公开卡片 · 绝不自动代发打招呼",
    vizType: "bridge",
    latency: "490ms",
    tokens: "0.6k",
    bulletColor: "#10B981",
    cmdTitle: "cdp.boss_readonly(port=9222, auto_send=false)",
    cmdDetail: "Extracted HR active timestamps · 0 account ban risk",
  },
  {
    id: 4,
    code: "04",
    name: "企业官网",
    tag: "SOURCING",
    sub: "Careers / Workday ATS 直连发现",
    vizType: "tree3",
    latency: "720ms",
    tokens: "0.5k",
    bulletColor: "#22D3EE",
    cmdTitle: 'ats.probe_official(portals=["Siemens", "NXP", "EmbodiedX"])',
    cmdDetail: "Verified official Workday requisition #WD-8841",
  },
  {
    id: 5,
    code: "05",
    name: "LinkedIn",
    tag: "SOURCING",
    sub: "外企上海研发中心 · 远程与混合办公",
    vizType: "dotmatrix",
    latency: "580ms",
    tokens: "0.7k",
    bulletColor: "#60A5FA",
    cmdTitle: 'linkedin.scan_wlb(region="Shanghai", off_work="<=17:00")',
    cmdDetail: "Matched 3 European/US R&D hubs with 15+ days annual leave",
  },
  {
    id: 6,
    code: "06",
    name: "JD Guard",
    tag: "GUARD",
    sub: "隐藏指令剥离 · 零宽字符清洗",
    vizType: "guard",
    latency: "85ms",
    tokens: "0.2k",
    bulletColor: "#F59E0B",
    cmdTitle: "jd_guard.sanitize(strip_zero_width=true)",
    cmdDetail: "Neutralized 2 adversarial prompt injection strings in JD",
  },
  {
    id: 7,
    code: "07",
    name: "JD 原句拆解",
    tag: "ANALYSIS",
    sub: "职责权重 · 硬性红线 · 隐性加分项",
    vizType: "splitbars",
    latency: "410ms",
    tokens: "1.1k",
    bulletColor: "#38BDF8",
    cmdTitle: 'jd.decompose_ast(core=["C#", ".NET 10", "RCS", "SLAM"])',
    cmdDetail: "16 mandatory specs & 4 wafer-fab bonus weights extracted",
  },
  {
    id: 8,
    code: "08",
    name: "证据链对齐",
    tag: "ANALYSIS",
    sub: "FactBase 实证 · 弱表达诊断 · 缺口",
    vizType: "spectrum",
    latency: "310ms",
    tokens: "1.4k",
    bulletColor: "#10B981",
    cmdTitle: 'factbase.align(locks=["FB-01 SanDisk", "FB-04 NXP"])',
    cmdDetail: "96.4% factual overlap · 0 fabricated metrics",
  },
  {
    id: 9,
    code: "09",
    name: "机会评级",
    tag: "TRIAGE",
    sub: "S / A / B / C 四维分层决策",
    vizType: "tiers",
    latency: "230ms",
    tokens: "0.9k",
    bulletColor: "#F59E0B",
    cmdTitle: 'triage.evaluate_tier(target="Siemens_Digital")',
    cmdDetail: "Rated [S-Tier · 96%] · High architectural resonance + WLB S+",
  },
  {
    id: 10,
    code: "10",
    name: "企业全网背调",
    tag: "TRIAGE",
    sub: "工商实缴 / 劳动仲裁 / 脉脉小红书作息",
    vizType: "radar",
    latency: "980ms",
    tokens: "1.6k",
    bulletColor: "#A855F7",
    cmdTitle: 'recon.deep_audit(sources=["工商", "裁判文书", "脉脉"])',
    cmdDetail: "0 labor disputes in 36m · Confirmed 16:30 shuttle bus",
  },
  {
    id: 11,
    code: "11",
    name: "简历润色",
    tag: "TAILOR",
    sub: "结构化 old ➔ new · 绑定证据编号",
    vizType: "diff",
    latency: "840ms",
    tokens: "1.5k",
    bulletColor: "#22D3EE",
    cmdTitle: 'tailor.git_diff(evidence=["FB-01", "FB-04"])',
    cmdDetail: "Rewrote 2 core RCS paragraphs · ATS keyword coverage +38%",
  },
  {
    id: 12,
    code: "12",
    name: "Reviewer",
    tag: "TAILOR",
    sub: "独立双盲上下文挑刺 · 去 AI 塑料味",
    vizType: "bridge",
    latency: "520ms",
    tokens: "0.9k",
    bulletColor: "#10B981",
    cmdTitle: "reviewer.adversarial_check(plastic_tone_limit=0)",
    cmdDetail: "Approved by independent Reviewer context · 100% authentic",
  },
  {
    id: 13,
    code: "13",
    name: "ATS / 版式",
    tag: "VERIFY",
    sub: "单页填充率 · DOM 文本层 · 关键词",
    vizType: "docscan",
    latency: "340ms",
    tokens: "0.4k",
    bulletColor: "#38BDF8",
    cmdTitle: 'verify.ats_dom(parser="Workday", layout="1_PAGE_A4")',
    cmdDetail: "99.4% parse fidelity · 94.2% A4 fill · 15/16 keywords hit",
  },
  {
    id: 14,
    code: "14",
    name: "材料快照",
    tag: "DELIVERY",
    sub: "所投即所存 · SHA-256 不可篡改归档",
    vizType: "stack",
    latency: "170ms",
    tokens: "0.2k",
    bulletColor: "#60A5FA",
    cmdTitle: 'snapshot.freeze(sha256="9f8a7c..e41b")',
    cmdDetail: "Archived exact PDF & tailored cover note for interview defense",
  },
  {
    id: 15,
    code: "15",
    name: "本人交接",
    tag: "DELIVERY",
    sub: "自动预填官网表单 · 由你最终点发送",
    vizType: "handover",
    latency: "110ms",
    tokens: "0.2k",
    bulletColor: "#F59E0B",
    cmdTitle: 'delivery.handover_browser(portal="Siemens_Careers")',
    cmdDetail: "Fields pre-filled locally · Waiting for human final click",
  },
  {
    id: 16,
    code: "16",
    name: "异步缓存挂起",
    tag: "TRACKING",
    sub: "投递后休眠释放内存 · HR 信号唤醒",
    vizType: "wave",
    latency: "65ms",
    tokens: "0.1k",
    bulletColor: "#10B981",
    cmdTitle: 'tracking.sleep_until(events=["HR_VIEW", "INTERVIEW_MAIL"])',
    cmdDetail: "Context serialized · Webhook listener armed",
  },
  {
    id: 17,
    code: "17",
    name: "面试攻防",
    tag: "INTERVIEW",
    sub: "高风险深水区追问预案 · 架构白板",
    vizType: "qa",
    latency: "430ms",
    tokens: "1.2k",
    bulletColor: "#A855F7",
    cmdTitle: 'interview.defense_tree(topic="100+ AMR Deadlock Resolution")',
    cmdDetail: "Compiled 12 architecture defense cards anchored to FB-01",
  },
  {
    id: 18,
    code: "18",
    name: "STAR 对练",
    tag: "INTERVIEW",
    sub: "S-T-A-R 结构化计时作答演练",
    vizType: "star",
    latency: "290ms",
    tokens: "0.8k",
    bulletColor: "#22D3EE",
    cmdTitle: 'interview.star_chain(nodes=["S", "T", "A", "R"])',
    cmdDetail: "Bilingual English/Chinese technical scripts verified",
  },
  {
    id: 19,
    code: "19",
    name: "薪酬与时薪",
    tag: "DECISION",
    sub: "Base · 年终兑现率 · 真实工时净时薪",
    vizType: "wagebars",
    latency: "125ms",
    tokens: "0.3k",
    bulletColor: "#F59E0B",
    cmdTitle: 'decision.net_hourly(pkg="42k*15", work_hours="37.5h/wk")',
    cmdDetail: "Net Hourly: ¥268/hr (+38% vs 996 Big-Tech) · WLB Grade S+",
  },
  {
    id: 20,
    code: "20",
    name: "沙箱应用工坊",
    tag: "SANDBOX",
    sub: "内置预设 · 本地模型编码实验台",
    vizType: "polygon",
    latency: "—",
    tokens: "—",
    bulletColor: "#38BDF8",
    cmdTitle: "sandbox · choose a reviewed preset or start a local coding task",
    cmdDetail: "Manual authorization required. Check the Host receipt for actual results.",
  },
];

// Compatibility export
export const AUTOPILOT_CARDS = STUDIO_20_NODES.map((n) => [n.tag, n.name, n.sub, `node-${n.code}`, n.vizType] as const);

// ============================================================================
// 6. 真实的工业级求职数据模型与初始状态
// ============================================================================
export interface JobPipelineItem {
  id: string;
  queueRank: string;
  tier: string;
  matchScore: number;
  company: string;
  shortName: string;
  logoText: string;
  logoGradient: string;
  glowColor: string;
  role: string;
  city: string;
  salary: string;
  annualTotal: string;
  hourlyNet: number;
  workHours: string;
  sourcePlatform: string;
  collectedIn3D: boolean;
  isNewMint: boolean;
  stage3D: string;
  tags: string[];
  atsMetrics: {
    parseRate: number;
    pageFill: number;
    keywordMatched: number;
    keywordTotal: number;
    missingKeyword: string;
  };
  diffItems: Array<{
    id: string;
    section: string;
    oldText: string;
    newText: string;
    factId: string;
    factTitle: string;
    impactMetric: string;
  }>;
  triageDossier: {
    regCapital: string;
    laborDisputes: string;
    wlbVerification: string;
    agentVerdict: string;
  };
}

const DEFAULT_REAL_JOBS: JobPipelineItem[] = [
  {
    id: "job-siemens-rcs",
    queueRank: "#1",
    tier: "S级",
    matchScore: 96,
    company: "西门子数字工业软件 (上海研发中心)",
    shortName: "西门子工业软件",
    logoText: "SI",
    logoGradient: "linear-gradient(135deg, #06B6D4 0%, #0284C7 55%, #1E3A8A 100%)",
    glowColor: "rgba(34, 211, 238, 0.45)",
    role: "Senior .NET / 工业自动化架构师",
    city: "上海浦东张江 · 混合办公 (每周2天居家)",
    salary: "36k - 48k · 15薪",
    annualTotal: "¥540k - ¥720k / 年",
    hourlyNet: 268,
    workHours: "09:00 - 16:30 · Zero On-call",
    sourcePlatform: "企业官网 Workday ATS (#WD-8841)",
    collectedIn3D: true,
    isNewMint: false,
    stage3D: "ATS 核验通过",
    tags: ["16:30 准点班车", "Zero On-call", ".NET 10 / ABP vNext / RCS"],
    atsMetrics: {
      parseRate: 99.4,
      pageFill: 94.2,
      keywordMatched: 15,
      keywordTotal: 16,
      missingKeyword: "OPC UA 双向安全证书配置",
    },
    diffItems: [
      {
        id: "diff-1",
        section: "核心项目经历 · 智能晶圆厂 AMR/AGV 集群调度系统 (RCS 3.0)",
        oldText: "负责中科新松 RCS 系统后端开发，使用 C#、ABP vNext 和 SignalR 实现 AGV 小车状态监控与任务下发。",
        newText:
          "主导构建基于 .NET 10 与 ABP vNext 的分布式工业 RCS 3.0 调度内核，引入高并发路径死锁消解算法与 SignalR 毫秒级遥测总线，支撑晟碟 (SanDisk) 晶圆厂百台级 AMR 7×24h 零故障协同。",
        factId: "FB-01",
        factTitle: "中科新松 · 晟碟 (SanDisk) 半导体 AGV 调度交付实证",
        impactMetric: "ATS 关键词覆盖率 +38% · 量化指标 +2 项",
      },
      {
        id: "diff-2",
        section: "架构演进 · 跨楼层激光 SLAM 拓扑地图与机台交管锁",
        oldText: "参与恩智浦半导体项目的二楼激光地图对接和机台分布点位配置，使用 Redis 缓存数据。",
        newText:
          "设计跨楼层激光 SLAM 拓扑地图热加载与机台工位动态锁机制，基于 Redis 分布式锁与 SQL Server 2022 保障 NXP 产线多车并发交管零碰撞，指令端到端延迟压降至 18ms。",
        factId: "FB-04",
        factTitle: "恩智浦 (NXP) 二楼机台分布与激光地图现场工程记录",
        impactMetric: "精准命中「高可用工业控制 / 低延迟通信」",
      },
    ],
    triageDossier: {
      regCapital: "25,000 万美元 (实缴 100%)",
      laborDisputes: "0 起 (近 36 个月零劳动仲裁)",
      wlbVerification: "张江研发中心 14 条现员工实证：下午 16:30 班车准点发车，全年无周末值班，18天带薪病假 + 15天年假。",
      agentVerdict: "S级首选目标：您的半导体 RCS 交付履历与该团队产线物流平台重构诉求 1:1 咬合，完美符合 16:30 下班红线。",
    },
  },
  {
    id: "job-embodied-rcs",
    queueRank: "#2",
    tier: "S级",
    matchScore: 95,
    company: "具身智能先锋实验室 (Embodied X)",
    shortName: "具身智能实验室",
    logoText: "EX",
    logoGradient: "linear-gradient(135deg, #F59E0B 0%, #EA580C 55%, #9A3412 100%)",
    glowColor: "rgba(245, 158, 11, 0.45)",
    role: "RCS 群智调度与 AGV 算法平台主程",
    city: "上海徐汇西岸 · 弹性不打卡",
    salary: "42k - 58k · 16薪 + 期权",
    annualTotal: "¥670k - ¥930k / 年",
    hourlyNet: 242,
    workHours: "10:00 - 19:00 · 双休保障",
    sourcePlatform: "BOSS直聘 高管直招 (已清洗隐形指令)",
    collectedIn3D: true,
    isNewMint: false,
    stage3D: "简历润色中",
    tags: ["异构机器人群智调度", "C# / WebRTC 遥操作", "早期核心期权池"],
    atsMetrics: {
      parseRate: 98.5,
      pageFill: 92.0,
      keywordMatched: 14,
      keywordTotal: 15,
      missingKeyword: "ROS2 DDS 跨网段桥接",
    },
    diffItems: [
      {
        id: "diff-ex-1",
        section: "异构机器人集群调度与 Vue 3 全息监控座舱",
        oldText: "开发 AGV 调度后台和 Vue 3 前端监控页面，显示小车位置和电量。",
        newText:
          "构建吞吐千级并发节点的异构 AMR/AGV 实时调度中枢，打通 .NET 高性能状态机与 Vue 3 全息监控态势舱，支持动态重规划与毫秒级异常熔断。",
        factId: "FB-12",
        factTitle: "SIASUN RCS 3.0 & Erack API 核心代码库实证",
        impactMetric: "突出全栈架构闭环 · 匹配主程高定级要求",
      },
    ],
    triageDossier: {
      regCapital: "8,500 万人民币 (红杉/源码领投)",
      laborDisputes: "0 起 · 顶尖机器人工程团队",
      wlbVerification: "双休严格保障，不搞形式主义日报周报；现金总包已达一线大厂 P8 水平。",
      agentVerdict: "高成长溢价目标：可将您的工业级 RCS 调度经验无缝迁移至具身智能赛道。",
    },
  },
  {
    id: "job-nxp-semi",
    queueRank: "#3",
    tier: "A+级",
    matchScore: 93,
    company: "恩智浦半导体 (NXP 亚太研发中心)",
    shortName: "恩智浦 NXP",
    logoText: "NX",
    logoGradient: "linear-gradient(135deg, #10B981 0%, #059669 55%, #065F46 100%)",
    glowColor: "rgba(168, 85, 129, 0.45)",
    role: "Staff 工业物联网与天车/AGV 调度专家",
    city: "上海浦东金桥 · 混合办公",
    salary: "34k - 45k · 15薪",
    annualTotal: "¥510k - ¥675k / 年",
    hourlyNet: 256,
    workHours: "09:00 - 16:45 · 20天带薪年假",
    sourcePlatform: "LinkedIn 猎头直通 + 校友内推",
    collectedIn3D: true,
    isNewMint: false,
    stage3D: "面试攻防准备",
    tags: ["曾交付该司产线项目", "16:45 下班", "全额商业养老险"],
    atsMetrics: {
      parseRate: 99.2,
      pageFill: 93.4,
      keywordMatched: 15,
      keywordTotal: 15,
      missingKeyword: "全部核心词已 100% 覆盖",
    },
    diffItems: [
      {
        id: "diff-nxp-1",
        section: "历史交付背书 · NXP 半导体产线跨楼层自动化改造",
        oldText: "曾参与 NXP 产线 AGV 对接项目。",
        newText:
          "作为核心研发交付恩智浦 (NXP) 半导体产线跨楼层 AGV 自动化物流系统，深度熟悉洁净室 SECS/GEM 通信规约与高可用容灾标准。",
        factId: "FB-04",
        factTitle: "NXP 产线交付记录与二楼激光地图配置档案",
        impactMetric: "乙方转甲方天然信任背书 · 免除业务适应期",
      },
    ],
    triageDossier: {
      regCapital: "跨国半导体巨头独资研发中心",
      laborDisputes: "0 起 · 外企最佳雇主",
      wlbVerification: "您曾作为乙方为其交付过 RCS 系统，内部工程文化极其温和，16:45 后办公室基本清空。",
      agentVerdict: "极高把握度：拥有历史项目直接交付背书，简历初筛通过率预计 >92%。",
    },
  },
  {
    id: "job-zurich-quant",
    queueRank: "#4",
    tier: "A级",
    matchScore: 91,
    company: "苏黎世环球量化科技 (上海研发中心)",
    shortName: "苏黎世量化",
    logoText: "ZQ",
    logoGradient: "linear-gradient(135deg, #A855F7 0%, #7E22CE 55%, #3B0764 100%)",
    glowColor: "rgba(168, 85, 247, 0.45)",
    role: "Principal C# 低延迟交易与实时风控工程师",
    city: "上海陆家嘴 · 17:00 准点下班",
    salary: "45k - 60k · 16薪",
    annualTotal: "¥720k - ¥960k / 年",
    hourlyNet: 295,
    workHours: "08:30 - 17:00 · 瑞士总部标准",
    sourcePlatform: "LinkedIn 国际直聘 (#ZH-209)",
    collectedIn3D: true,
    isNewMint: false,
    stage3D: "已收藏",
    tags: ["C# 高并发内存池", "17:00 收盘即下班", "22天带薪假"],
    atsMetrics: {
      parseRate: 97.8,
      pageFill: 91.5,
      keywordMatched: 13,
      keywordTotal: 15,
      missingKeyword: "FIX 4.4 协议栈零拷贝优化",
    },
    diffItems: [
      {
        id: "diff-zq-1",
        section: "高并发实时状态机与毫秒级遥测分发",
        oldText: "优化 RCS 系统中的小车通信延迟。",
        newText:
          "基于 .NET 高性能 Span<T> 与无锁环形队列重构实时状态分发引擎，将百节点并发指令端到端延迟稳定控制在 18ms 以内。",
        factId: "FB-01",
        factTitle: "工业级高可靠并发状态机压测记录",
        impactMetric: "跨行业映射至高频低延迟风控场景",
      },
    ],
    triageDossier: {
      regCapital: "5,000 万瑞士法郎 (外资独资)",
      laborDisputes: "0 起 · 欧洲金融工程标准",
      wlbVerification: "收盘后绝无无效加班，净时薪高达 ¥295/h，技术栈纯粹。",
      agentVerdict: "高时薪外企备选：您的工业级并发控制经验可降维迁移。",
    },
  },
];

// ============================================================================
// 7. 内凹微缩蓝图舱 (CNC-Milled Inset Chamber with Living Telemetry Motion)
// ============================================================================
function BlueprintMicroChamber({
  type,
  isSpotlight,
  code,
  agent,
  theme = "dark",
}: {
  type: string;
  isSpotlight: boolean;
  code: string;
  agent: AgentKernelConfig;
  theme?: "light" | "dark";
}) {
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
            <rect x="6" y="4" width="22" height="9" rx="2" fill={isLight ? "#FFFFFF" : "#0B131E"} stroke={cSecondary} strokeWidth="0.9" />
            <rect x="6" y="23" width="22" height="9" rx="2" fill={isLight ? "#FFFFFF" : "#0B131E"} stroke={isLight ? "#94A3B8" : "#334155"} strokeWidth="0.9" />
            <rect x="46" y="11" width="36" height="14" rx="3" fill={isLight ? "#EFF6FF" : "#131E2E"} stroke={cPrimary} strokeWidth="1.3" />
            <text x="64" y="20.5" textAnchor="middle" fill={isLight ? "#0F172A" : "#F8FAFC"} fontSize="6.5" fontFamily="monospace" fontWeight="bold">
              AGENT
            </text>
            <rect x="98" y="4" width="24" height="9" rx="2" fill={isLight ? "#FFFFFF" : "#0B131E"} stroke={cPrimary} strokeWidth="0.9" />
            <rect x="98" y="23" width="24" height="9" rx="2" fill={isLight ? "#FFFFFF" : "#0B131E"} stroke={cSecondary} strokeWidth="0.9" />
          </svg>
        )}

        {type === "bridge" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <rect x="6" y="11" width="38" height="14" rx="3.5" fill={isLight ? "#FFFFFF" : "#0A121C"} stroke={cSecondary} strokeWidth="1" />
            <text x="25" y="20.5" textAnchor="middle" fill={isLight ? "#334155" : "#94A3B8"} fontSize="6" fontFamily="monospace" fontWeight="bold">
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
            <rect x="78" y="11" width="44" height="14" rx="3.5" fill={isLight ? "#EFF6FF" : "#0F1B29"} stroke={cPrimary} strokeWidth="1.1" />
            <text x="100" y="20.5" textAnchor="middle" fill={isLight ? "#0F172A" : "#F8FAFC"} fontSize="6" fontFamily="monospace" fontWeight="bold">
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
            <rect x="8" y="3" width="22" height="30" rx="2" fill={isLight ? "#FFFFFF" : "#0A121E"} stroke={cSecondary} strokeWidth="1.1" />
            <line x1="12" y1="9" x2="26" y2="9" stroke={cSecondary} strokeWidth="1.3" />
            <line x1="12" y1="14" x2="24" y2="14" stroke={isLight ? "#94A3B8" : "#64748B"} strokeWidth="1.1" />
            <line x1="12" y1="19" x2="26" y2="19" stroke={cPrimary} strokeWidth="1.3" />
            <line x1="12" y1="24" x2="22" y2="24" stroke={isLight ? "#94A3B8" : "#64748B"} strokeWidth="1.1" />
            {/* Animated Laser Beam */}
            <g style={{ animation: "ap-laser-scan 2.2s ease-in-out infinite alternate" }}>
              <line x1="7" y1="5" x2="31" y2="5" stroke="#06B6D4" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="9" y1="5" x2="29" y2="5" stroke="#FFFFFF" strokeWidth="0.8" />
            </g>
            <path d="M32 18H56" stroke={cSecondary} strokeWidth="1" strokeDasharray="2 2" style={{ animation: "ap-dash-flow 1.2s linear infinite" }} />
            <rect x="56" y="7" width="64" height="22" rx="3.5" fill={isLight ? "#FFFFFF" : "#0C1624"} stroke={cSecondary} strokeWidth="1" />
            <text x="88" y="16" textAnchor="middle" fill={isLight ? "#334155" : "#E2E8F0"} fontSize="6.5" fontFamily="monospace">
              1 page · A4
            </text>
            <text x="88" y="25" textAnchor="middle" fill={isLight ? "#0284C7" : cSecondary} fontSize="6.5" fontFamily="monospace" fontWeight="bold">
              ATS 99.4% ✓
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
            {/* Animated Rotating Radar Sweep Ray */}
            <g style={{ transformOrigin: "24px 17px", animation: "ap-radar-sweep 2.8s linear infinite" }}>
              <line x1="24" y1="17" x2="38" y2="17" stroke={isLight ? "#0284C7" : "#38BDF8"} strokeWidth="1.6" strokeLinecap="round" />
              <polygon points="24,17 38,13 38,21" fill={isLight ? "rgba(2,132,199,0.18)" : "rgba(56,189,248,0.22)"} />
            </g>
            {/* Blinking Target Ping */}
            <circle cx="31" cy="11" r="2.2" fill={isLight ? "#059669" : "#10B981"} style={{ animation: "ap-led-ping 1.4s ease-in-out infinite" }} />
            <text x="48" y="15" fill={isLight ? "#334155" : "#94A3B8"} fontSize="6.5" fontFamily="monospace" fontWeight="600">
              Tier 1-3 交叉核验
            </text>
            <text x="48" y="26" fill={isLight ? "#0284C7" : cSecondary} fontSize="7" fontFamily="monospace" fontWeight="bold">
              仲裁: 0 · 16:30下班
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
                  fill={active ? (i % 2 === 0 ? (isLight ? "#D97706" : cPrimary) : (isLight ? "#0284C7" : cSecondary)) : (isLight ? "#CBD5E1" : "#334155")}
                  style={active ? { animation: `ap-led-ping ${1.2 + (i % 3) * 0.4}s ease-in-out infinite alternate` } : undefined}
                />
              );
            })}
          </svg>
        )}

        {type === "wagebars" && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <g style={{ transformOrigin: "12px 32px", animation: "ap-bar-pulse-1 1.6s ease-in-out infinite alternate" }}>
              <rect x="8" y="18" width="9" height="14" rx="1.5" fill={isLight ? "#94A3B8" : "#334155"} />
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
              ¥268/hr
            </text>
            <text x="66" y="26" fill={isLight ? "#334155" : "#94A3B8"} fontSize="6.5" fontFamily="monospace" fontWeight="600">
              WLB S+ 净时薪
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
                  fill={isLight ? "#FFFFFF" : "#0C1522"}
                  stroke={idx === 2 ? cPrimary : cSecondary}
                  strokeWidth="1.1"
                />
                <text
                  x={16 + idx * 30}
                  y="20.5"
                  textAnchor="middle"
                  fill={isLight ? "#0F172A" : "#F8FAFC"}
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
                fill={isLight ? "rgba(168, 85, 247, 0.12)" : "rgba(168, 85, 247, 0.25)"}
                stroke={isLight ? "#9333EA" : "#C084FC"}
                strokeWidth="1.2"
              />
              <circle cx="24" cy="4" r="2.2" fill={isLight ? "#0284C7" : "#38BDF8"} />
              <circle cx="39" cy="11" r="2.2" fill={isLight ? "#D97706" : "#F59E0B"} />
            </g>
            <text x="48" y="15" fill={isLight ? "#1E293B" : "#E2E8F0"} fontSize="7" fontFamily="monospace" fontWeight="bold">
              esbuild · QuickJS
            </text>
            <text x="48" y="26" fill={isLight ? "#7E22CE" : "#C084FC"} fontSize="6.5" fontFamily="monospace" fontWeight="600">
              预设 / 本机编码
            </text>
          </svg>
        )}

        {!["hub", "bridge", "diff", "docscan", "radar", "dotmatrix", "wagebars", "star", "polygon"].includes(type) && (
          <svg viewBox="0 0 136 36" className="w-full h-8 overflow-visible">
            <rect x="6" y="8" width="44" height="6" rx="2" fill={isLight ? "#CBD5E1" : "#1E293B"} />
            <rect x="6" y="8" width="32" height="6" rx="2" fill={cSecondary} />
            <rect x="6" y="20" width="58" height="6" rx="2" fill={isLight ? "#CBD5E1" : "#1E293B"} />
            <rect x="6" y="20" width="46" height="6" rx="2" fill={cPrimary} />
            <circle cx="78" cy="17" r="3.5" fill={isLight ? "#FFFFFF" : "#0B131E"} stroke={cSecondary} strokeWidth="1.2" />
            <line x1="82" y1="17" x2="98" y2="17" stroke={cSecondary} strokeWidth="1" strokeDasharray="2 2" style={{ animation: "ap-dash-flow 1.5s linear infinite" }} />
            <rect x="98" y="10" width="26" height="14" rx="3" fill={isLight ? "#FFFFFF" : "#0C1522"} stroke={cPrimary} strokeWidth="1.1" />
            <text x="111" y="19.5" textAnchor="middle" fill={isLight ? "#0F172A" : "#F8FAFC"} fontSize="6.5" fontFamily="monospace" fontWeight="bold">
              #{code}
            </text>
          </svg>
        )}
      </div>

      <div
        style={{
          borderColor: isSpotlight ? cSecondary : (isLight ? "#CBD5E1" : "#223247"),
          backgroundColor: isSpotlight
            ? (isLight ? "#ECFDF5" : `${cSecondary}22`)
            : (isLight ? "#FFFFFF" : "#0B121C"),
          color: isSpotlight ? (isLight ? "#047857" : "#FFF") : (isLight ? "#94A3B8" : "#64748B"),
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

// ============================================================================
// 8. 真 3D 立体毛玻璃岗位卡 (CyberJobCard3D)
// ============================================================================
function CyberJobCard3D({
  job,
  agent,
  isFlipped,
  onToggleFlip,
  onChangeStage,
  onInspectInStudio,
  theme = "dark",
}: {
  job: JobPipelineItem;
  agent: AgentKernelConfig;
  isFlipped: boolean;
  onToggleFlip: () => void;
  onChangeStage: (id: string, stage: string) => void;
  onInspectInStudio: (id: string) => void;
  theme?: "light" | "dark";
}) {
  const isLight = theme === "light";
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0, glareX: 50, glareY: 30, hover: false });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
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

  const totalRotateY = (isFlipped ? 180 : 0) + (isFlipped ? -tilt.rotateY : tilt.rotateY);

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onToggleFlip}
      style={{ perspective: "1400px" }}
      data-cyber-card-id={job.id}
      className="cyber-3d-card group relative w-full h-[346px] select-none cursor-pointer"
    >
      <div
        style={{
          background: job.glowColor,
          transform: `translate3d(${-tilt.rotateY * 1.2}px, ${12 + tilt.rotateX}px, -30px) scale(${
            tilt.hover ? 0.96 : 0.86
          })`,
          opacity: tilt.hover ? 0.58 : 0.24,
        }}
        className="pointer-events-none absolute inset-x-6 bottom-1 h-20 rounded-3xl blur-2xl transition-all duration-300"
      />

      <div
        style={{
          transformStyle: "preserve-3d",
          transform: `translateZ(${tilt.hover ? 14 : 0}px) rotateX(${tilt.rotateX}deg) rotateY(${totalRotateY}deg)`,
          transition: tilt.hover
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
            backgroundColor: isLight ? "rgba(255, 255, 255, 0.96)" : "rgba(11, 17, 26, 0.88)",
            boxShadow: tilt.hover
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
                {job.isNewMint && (
                  <span className="absolute -top-1.5 -left-1.5 px-1.5 py-0.2 rounded-full bg-amber-400 text-slate-950 font-mono text-[9px] font-black">
                    NEW
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`px-1.5 py-0.2 rounded font-mono text-[10px] font-bold border ${
                    isLight
                      ? "bg-amber-100 text-amber-900 border-amber-300"
                      : "bg-amber-400/15 text-amber-300 border-amber-400/30"
                  }`}>
                    {job.tier}
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

            <div className={`shrink-0 font-mono text-center px-2.5 py-1.5 rounded-xl border ${
              isLight ? "bg-cyan-50 border-cyan-200" : "bg-cyan-400/10 border-cyan-400/30"
            }`}>
              <div className={`text-xs font-black ${isLight ? "text-cyan-800" : "text-cyan-300"}`}>{job.matchScore}%</div>
              <div className={`text-[9px] ${isLight ? "text-slate-500" : "text-slate-400"}`}>MATCH</div>
            </div>
          </div>

          <div
            style={{
              transform: "translateZ(22px)",
              boxShadow: isLight ? "inset 0 1px 3px rgba(0,0,0,0.06)" : "inset 0 2px 6px rgba(0,0,0,0.9)",
            }}
            className={`relative rounded-xl p-3 border flex items-center justify-between font-mono ${
              isLight ? "bg-slate-50 border-slate-200" : "bg-[#05080D] border-[#182638]"
            }`}
          >
            <div>
              <div className={`text-[10px] ${isLight ? "text-slate-500" : "text-slate-400"}`}>{job.annualTotal}</div>
              <div className={`text-base font-extrabold mt-0.5 ${isLight ? "text-amber-800" : "text-amber-400"}`}>{job.salary}</div>
            </div>
            <div className="text-right">
              <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-bold ${
                isLight ? "bg-emerald-50 text-emerald-800 border-emerald-300" : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
              }`}>
                净时薪 ¥{job.hourlyNet}/h
              </div>
              <div className={`text-[10px] mt-1 ${isLight ? "text-slate-600 font-medium" : "text-cyan-300/90"}`}>{job.workHours}</div>
            </div>
          </div>

          <div style={{ transform: "translateZ(18px)" }} className="relative flex flex-wrap gap-1.5">
            {job.tags.map((t, i) => (
              <span
                key={i}
                className={`px-2 py-0.5 rounded-md text-[10.5px] font-mono border ${
                  isLight ? "bg-slate-100 border-slate-200 text-slate-700" : "bg-[#0E1724] border-[#1E3048] text-slate-200"
                }`}
              >
                {t}
              </span>
            ))}
          </div>

          <div
            style={{ transform: "translateZ(24px)" }}
            className={`relative pt-2 border-t flex items-center justify-between text-[11px] font-mono ${
              isLight ? "border-slate-200" : "border-white/[0.08]"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <AgentTotemIcon agentId={agent.id} className="w-4 h-4" />
              <span className={isLight ? "text-slate-600" : "text-slate-300"}>{agent.shortName}:</span>
              <span className={`font-bold ${isLight ? "text-emerald-700" : "text-emerald-400"}`}>{job.stage3D}</span>
            </div>
            <div className={`flex items-center gap-1 font-medium ${isLight ? "text-cyan-700 hover:text-cyan-900" : "text-cyan-300"}`}>
              <RotateCw className="w-3 h-3 transition-transform duration-500 group-hover:rotate-180" />
              <span>180° 翻转背调</span>
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
            backgroundColor: isLight ? "rgba(255, 255, 255, 0.98)" : "rgba(8, 13, 21, 0.96)",
            boxShadow: isLight
              ? `0 24px 50px -12px rgba(0,0,0,0.15), 0 0 0 1.5px ${agent.primaryHex}cc, inset 0 1px 0 rgba(255,255,255,0.9)`
              : `0 24px 50px -12px rgba(0,0,0,0.92), 0 0 0 1.5px ${agent.primaryHex}aa, inset 0 1px 0 rgba(255,255,255,0.22)`,
          }}
          className="absolute inset-0 rounded-2xl p-5 flex flex-col justify-between overflow-hidden"
        >
          <div style={{ transform: "translateZ(24px)" }} className={`flex items-center justify-between border-b pb-2 ${
            isLight ? "border-slate-200" : "border-white/10"
          }`}>
            <div className="flex items-center gap-2 font-mono text-xs font-bold" style={{ color: isLight ? (agent.id === "opus-5.5" ? "#B45309" : agent.primaryHex) : agent.primaryHex }}>
              <AgentTotemIcon agentId={agent.id} className="w-5 h-5" />
              <span>{agent.shortName} RECON // 背调实证</span>
            </div>
            <span className={`font-mono text-[10px] px-2 py-0.5 rounded border ${
              isLight
                ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
            }`}>
              仲裁 0 起
            </span>
          </div>

          <div style={{ transform: "translateZ(28px)" }} className="space-y-2 text-[11px] leading-relaxed my-1">
            <div className={`p-2.5 rounded-xl border ${
              isLight
                ? "bg-emerald-50 border-emerald-200 text-emerald-950"
                : "bg-emerald-950/35 border-emerald-500/30 text-emerald-100"
            }`}>
              <div className={`font-mono font-bold text-[10.5px] mb-0.5 ${
                isLight ? "text-emerald-800" : "text-emerald-300"
              }`}>
                ✓ 真实作息核验 ({job.workHours})
              </div>
              <p className="line-clamp-2 opacity-95">{job.triageDossier.wlbVerification}</p>
            </div>
            <div className={`p-2.5 rounded-xl border ${
              isLight
                ? "bg-cyan-50 border-cyan-200 text-cyan-950"
                : "bg-cyan-950/35 border-cyan-500/30 text-cyan-100"
            }`}>
              <div className={`font-mono font-bold text-[10.5px] mb-0.5 flex items-center gap-1.5 ${
                isLight ? "text-cyan-800" : "text-cyan-300"
              }`}>
                <span>✦ {agent.mascotName} 决胜诊断</span>
              </div>
              <p className="line-clamp-2 opacity-95">{job.triageDossier.agentVerdict}</p>
            </div>
          </div>

          <div
            style={{ transform: "translateZ(22px)" }}
            onClick={(e) => e.stopPropagation()}
            className={`flex items-center gap-1 p-1 rounded-xl border font-mono ${
              isLight ? "bg-slate-100 border-slate-200" : "bg-[#05080D] border-[#1B2A3D]"
            }`}
          >
            {["已收藏", "简历润色中", "ATS 核验通过", "面试攻防准备"].map((st) => (
              <button
                key={st}
                onClick={() => onChangeStage(job.id, st)}
                className={`flex-1 py-1 rounded-lg text-[10px] font-bold transition ${
                  job.stage3D === st
                    ? "bg-cyan-500 text-white shadow-xs"
                    : isLight
                      ? "text-slate-600 hover:text-slate-900"
                      : "text-slate-400 hover:text-white"
                }`}
              >
                {st.slice(0, 4)}
              </button>
            ))}
          </div>

          <div style={{ transform: "translateZ(30px)" }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => onInspectInStudio(job.id)}
              className="w-full py-2 px-3 rounded-xl font-mono text-xs font-bold text-slate-950 bg-gradient-to-r from-amber-400 via-amber-300 to-cyan-300 hover:brightness-110 shadow-lg flex items-center justify-center gap-1.5 transition"
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>载入 {agent.shortName} 20-Node 工坊 ➔</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 9. 主工作区组件：AutopilotStudioWorkspace
// ============================================================================
export function AutopilotStudioWorkspace({
  factBase,
  resume: _resume,
  projectedResume: _projectedResume,
  targetQuery: _targetQuery = "",
  initialOpportunityId,
  onOpenMicroApp,
  onOpenOpportunity: _onOpenOpportunity,
  onOpenApp: _onOpenApp,
  onNavigateToDraft: _onNavigateToDraft,
  onClose: _onClose,
}: {
  factBase?: FactBase;
  resume?: ProjectedResume;
  projectedResume?: ProjectedResume;
  targetQuery?: string;
  initialOpportunityId?: string;
  onOpenMicroApp?: (app: InstalledMicroApp) => void;
  onOpenOpportunity?: (id: string) => void;
  onOpenApp?: (appId: string) => void;
  onNavigateToDraft?: () => void;
  onClose?: () => void;
}) {
  const { theme, setTheme } = useUiPreferences();

  // 1. AI 内核选择 ('opus-5.5' | 'deepseek-r2' | 'gpt-5.2' | 'ollama-qwen3')
  const [selectedAgentId] = useState<AgentKernelConfig["id"]>("opus-5.5");
  const currentAgent: AgentKernelConfig = AGENT_KERNELS[selectedAgentId] ?? AGENT_KERNELS["opus-5.5"]!;

  // 2. 工作台模式 ('studio' | 'space3d' | 'split')
  const [workspaceMode, setWorkspaceMode] = useState<"studio" | "space3d" | "split">("studio");

  // 3. 20-节点环流履带控制
  const [conveyorShiftMode, setConveyorShiftMode] = useState(true);
  const [autoLoopPlaying, setAutoLoopPlaying] = useState(false);
  const [activeNodeIdx, setActiveNodeIdx] = useState(12); // 默认聚焦 #13 ATS / 版式
  const [terminalTab, setTerminalTab] = useState<"terminal" | "inspector">("terminal");

  // 4. 岗位队列与 3D 卡状态
  const [jobs, setJobs] = useState<JobPipelineItem[]>(() => {
    // Merge real opportunities from library if available (filter out any placeholder names)
    const existingLib = readOpportunityLibrary().library;
    const validJobs = existingLib.jobs.filter(
      (j) => j.company && !j.company.includes("待核实") && !j.company.includes("未命名") && j.company.trim().length > 1
    );
    if (validJobs.length > 0) {
      const converted: JobPipelineItem[] = validJobs.slice(0, 4).map((j, idx) => ({
        id: j.id,
        queueRank: `#${idx + 1}`,
        tier: idx === 0 ? "S级" : idx === 1 ? "S级" : "A级",
        matchScore: Math.max(82, 96 - idx * 3),
        company: j.company,
        shortName: j.company.slice(0, 8),
        logoText: j.company.slice(0, 2).toUpperCase(),
        logoGradient: idx === 0
          ? "linear-gradient(135deg, #06B6D4 0%, #0284C7 55%, #1E3A8A 100%)"
          : "linear-gradient(135deg, #F59E0B 0%, #EA580C 55%, #9A3412 100%)",
        glowColor: idx === 0 ? "rgba(34, 211, 238, 0.45)" : "rgba(245, 158, 11, 0.45)",
        role: j.title,
        city: [j.location.city, j.location.region].filter(Boolean).join(" · ") || "上海",
        salary: j.salaryText || "35k - 50k · 15薪",
        annualTotal: "¥525k - ¥750k / 年",
        hourlyNet: 260 - idx * 10,
        workHours: "09:00 - 17:00 · 弹性双休",
        sourcePlatform: j.sourcePlatform || "机会库实证",
        collectedIn3D: true,
        isNewMint: false,
        stage3D: j.application.stage === "offer" ? "Offer 发放" : j.application.stage === "interview" ? "面试中" : "ATS 核验通过",
        tags: [".NET 10 / RCS", "16:30 班车", "Zero On-call"],
        atsMetrics: {
          parseRate: 99.2,
          pageFill: 93.8,
          keywordMatched: 15,
          keywordTotal: 16,
          missingKeyword: "OPC UA 工业协议",
        },
        diffItems: DEFAULT_REAL_JOBS[0]!.diffItems,
        triageDossier: DEFAULT_REAL_JOBS[0]!.triageDossier,
      }));
      return [...converted, ...DEFAULT_REAL_JOBS.slice(converted.length)];
    }
    return DEFAULT_REAL_JOBS;
  });

  const [activeJobId, setActiveJobId] = useState<string>(() => initialOpportunityId || jobs[0]?.id || "job-siemens-rcs");
  const [flipped3DMap, setFlipped3DMap] = useState<Record<string, boolean>>({});
  const [space3DLayout, setSpace3DLayout] = useState<"grid" | "carousel">("grid");

  // 5. 模拟器参数 (#19 薪酬与时薪)
  const [simBaseK, setSimBaseK] = useState(42);
  const [simMonths, setSimMonths] = useState(15);
  const [simWeeklyHours, setSimWeeklyHours] = useState(37.5);

  // 6. 挂载沙箱应用列表 (#20 沙箱应用工坊)
  const installedMicroApps = useInstalledMicroApps();
  const [buildStatus, setBuildStatus] = useState<"idle" | "building" | "success" | "error">("idle");
  const [buildingStep, setBuildingStep] = useState<string>("");
  const [buildingAppId, setBuildingAppId] = useState<string | null>(null);
  const [pendingArtifact, setPendingArtifact] = useState<BuiltMicroAppArtifact | null>(null);
  const [isPermissionModalOpen, setIsPermissionModalOpen] = useState(false);
  const pendingBuild = useRef<ReturnType<typeof captureIdentityLease> | null>(null);

  const [toast, setToast] = useState<{ title: string; desc: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); }, []);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) || jobs[0]!, [jobs, activeJobId]);
  const activeNode = STUDIO_20_NODES[activeNodeIdx]!;
  const collected3DJobs = useMemo(() => jobs.filter((j) => j.collectedIn3D), [jobs]);

  // FactBase claim count & summary
  const claimCount = useMemo(() => {
    let count = 0;
    if (factBase?.experiences) {
      for (const exp of factBase.experiences) count += exp.claims?.length || 0;
    }
    return Math.max(38, count);
  }, [factBase]);

  const operatorName = factBase?.profile?.displayName?.zh || factBase?.profile?.displayName?.en || "haidong";
  const operatorRole = factBase?.profile?.targetRoles?.[0]?.zh || "C# / .NET 10 / RCS Architect";

  const triggerToast = useCallback((title: string, desc: string) => {
    setToast({ title, desc });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast((prev) => (prev?.title === title ? null : prev));
      toastTimer.current = null;
    }, 3800);
  }, []);

  // 自动环流定时器
  useEffect(() => {
    if (!autoLoopPlaying || workspaceMode === "space3d") return;
    const timer = setInterval(() => {
      setActiveNodeIdx((prev) => (prev + 1) % STUDIO_20_NODES.length);
    }, 2400);
    return () => clearInterval(timer);
  }, [autoLoopPlaying, workspaceMode]);

  // 键盘快捷键 (Space 暂停/继续，左右箭头单步)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.target instanceof HTMLElement && e.target.closest("input,textarea,select,button,summary,[contenteditable=true],[role=button]"))) return;
      if (e.code === "Space") {
        e.preventDefault();
        setAutoLoopPlaying((p) => !p);
      } else if (e.code === "ArrowRight") {
        setAutoLoopPlaying(false);
        setActiveNodeIdx((p) => (p + 1) % STUDIO_20_NODES.length);
      } else if (e.code === "ArrowLeft") {
        setAutoLoopPlaying(false);
        setActiveNodeIdx((p) => (p - 1 + STUDIO_20_NODES.length) % STUDIO_20_NODES.length);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 20 张卡片在 6x6 外环物理槽位坐标映射
  const positionedCards = useMemo(() => {
    const spotlightSlotIndex = 2; // Top Row, Col 3
    return STUDIO_20_NODES.map((node, nodeIndex) => {
      const slotIndex = conveyorShiftMode
        ? (nodeIndex - activeNodeIdx + spotlightSlotIndex + 20) % 20
        : nodeIndex;
      const slot = PERIMETER_20_SLOTS[slotIndex]!;
      const isSpotlight = nodeIndex === activeNodeIdx;
      return {
        node,
        nodeIndex,
        slotIndex,
        slot,
        isSpotlight,
      };
    });
  }, [activeNodeIdx, conveyorShiftMode]);

  // 中央 CLI 终端滚动结构化树日志
  const visibleTerminalStream = useMemo(() => {
    const list = [];
    for (let offset = -4; offset <= 0; offset++) {
      const idx = (activeNodeIdx + offset + STUDIO_20_NODES.length) % STUDIO_20_NODES.length;
      list.push({
        ...STUDIO_20_NODES[idx]!,
        isCurrent: offset === 0,
      });
    }
    return list;
  }, [activeNodeIdx]);

  // 铸造 3D 机会卡
  const handleMint3DCard = (targetJob = activeJob) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === targetJob.id ? { ...j, collectedIn3D: true, isNewMint: true } : { ...j, isNewMint: false }
      )
    );
    triggerToast(
      `✦ ${currentAgent.shortName} 已铸造「${targetJob.shortName}」3D 毛玻璃卡`,
      "已推入 3D 机会金库，背面已加盖当前 AI 助手专属背调印章。"
    );
  };

  const openArtifact = (app: InstalledMicroApp) => {
    if (onOpenMicroApp) onOpenMicroApp(app);
    else window.dispatchEvent(new window.CustomEvent("betterme:open-micro-app", { detail: app }));
  };
  const handleOpenInstalledApp = openArtifact;

  // The Host verifies and compiles a pinned preset. Only the user's next action can open it.
  const handleTriggerSandboxBuild = async (appId: string) => {
    const template = PRESET_MICRO_APP_TEMPLATES[appId];
    if (!template || (pendingBuild.current && !pendingBuild.current.signal.aborted && buildStatus === "building")) return;
    const lease = captureIdentityLease();
    pendingBuild.current = lease;
    setPendingArtifact(null);
    setIsPermissionModalOpen(false);
    setBuildingAppId(appId);
    setBuildStatus("building");
    setBuildingStep("正在请求本机宿主核对内置模板并编译…");
    try {
      const artifact = await buildSandboxedMicroApp({ appId, ...template });
      lease.assert();
      if (pendingBuild.current !== lease) return;
      setBuildingStep("宿主检查通过，等待你的运行或固定授权。");
      setPendingArtifact(artifact);
      setBuildStatus("success");
      setIsPermissionModalOpen(true);
    } catch (err) {
      if (lease.signal.aborted || pendingBuild.current !== lease) return;
      setBuildStatus("error");
      triggerToast("预设未构建", err instanceof Error ? err.message : String(err));
    } finally {
      if (pendingBuild.current === lease) setBuildingAppId(null);
    }
  };

  const handleApproveArtifact = (artifact: BuiltMicroAppArtifact, pinToDock: boolean) => {
    if (!pendingBuild.current || pendingBuild.current.signal.aborted || artifact !== pendingArtifact) return;
    try {
      pendingBuild.current.assert();
      openReviewedPreset(artifact, pinToDock, openArtifact);
      triggerToast(`已打开「${artifact.name}」`, pinToDock ? "已按你的授权固定到应用 Dock。" : "仅本次打开，未写入应用列表。");
    } catch (err) {
      triggerToast("预设未打开", err instanceof Error ? err.message : String(err));
    } finally {
      setIsPermissionModalOpen(false);
      setPendingArtifact(null);
    }
  };

  // #19 真实净时薪精算
  const netHourlyWage = useMemo(() => {
    const annualGross = simBaseK * 1000 * simMonths;
    const annualNetWithFund = annualGross * 0.88;
    const annualHours = simWeeklyHours * 50;
    return Math.round(annualNetWithFund / annualHours);
  }, [simBaseK, simMonths, simWeeklyHours]);

  // 底部 ASCII 块状进度条
  const progressPercent = Math.round(((activeNodeIdx + 1) / STUDIO_20_NODES.length) * 100);
  const filledBlocks = Math.round(((activeNodeIdx + 1) / STUDIO_20_NODES.length) * 24);
  const asciiBar = "■".repeat(filledBlocks) + "░".repeat(24 - filledBlocks);

  return (
    <div
      style={{
        backgroundColor: theme === "light" ? "#F4F6F8" : "#05080D",
        backgroundImage: `
          ${currentAgent.ambientBg},
          radial-gradient(${theme === "light" ? "rgba(71, 85, 105, 0.12)" : "rgba(148, 163, 184, 0.11)"} 1px, transparent 0),
          linear-gradient(to right, ${theme === "light" ? "rgba(226, 232, 240, 0.65)" : "rgba(30, 41, 59, 0.18)"} 1px, transparent 1px),
          linear-gradient(to bottom, ${theme === "light" ? "rgba(226, 232, 240, 0.65)" : "rgba(30, 41, 59, 0.18)"} 1px, transparent 1px)
        `,
        backgroundSize: "100% 100%, 16px 16px, 64px 64px, 64px 64px",
      }}
      className="relative w-full h-full min-h-0 overflow-hidden flex flex-col justify-between text-slate-100 select-none transition-colors duration-500 font-sans"
    >
      {/* Toast 提示横幅 */}
      {toast && (
        <div
          style={{
            borderColor: currentAgent.primaryHex,
            boxShadow: `0 16px 40px -8px rgba(0,0,0,0.85), 0 0 28px ${currentAgent.glowRgba}`,
          }}
          className="fixed top-4 right-4 z-50 w-96 p-3.5 rounded-2xl bg-[#0A101A]/95 border backdrop-blur-2xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="p-1.5 rounded-xl bg-white/[0.04] border border-white/10 shrink-0">
            <AgentMascotSprite agentId={currentAgent.id} className="w-8 h-7" />
          </div>
          <div className="font-mono text-xs leading-relaxed">
            <div style={{ color: currentAgent.primaryHex }} className="font-bold">
              {toast.title}
            </div>
            <div className="text-slate-300 mt-0.5 font-sans text-[11.5px]">{toast.desc}</div>
          </div>
        </div>
      )}

      {/* ====================================================================
          1. 顶部 STUDIO HERO BANNER
         ==================================================================== */}
      <header className="relative z-30 px-4 pt-2.5 pb-1 flex items-center justify-between gap-4 shrink-0">
        {/* 左侧：Operator Medallion */}
        <div className="flex items-center gap-3">
          <div
            style={{
              backgroundColor: theme === "light" ? "#FFFFFF" : "#0A1018",
              boxShadow: theme === "light" ? "0 4px 14px rgba(0,0,0,0.06)" : "0 10px 28px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.1)",
              borderColor: theme === "light" ? "#E2E8F0" : "#1E2E42",
            }}
            className="px-3 py-1.5 rounded-xl border flex items-center gap-2.5"
          >
            <div
              style={{
                borderColor: currentAgent.primaryHex,
                boxShadow: `0 0 12px ${currentAgent.glowRgba}`,
              }}
              className="w-9 h-9 rounded-full bg-[#060A0F] border-2 flex items-center justify-center relative shrink-0"
            >
              <span className="font-mono font-black text-xs text-white">
                {operatorName.slice(0, 2).toUpperCase()}
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-[#060A0F]" />
            </div>
            <div className="font-mono">
              <div className="flex items-center gap-1.5">
                <span className={`text-xs font-bold ${theme === "light" ? "text-slate-800" : "text-white"}`}>
                  @{operatorName}
                </span>
                <span className="px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[9px] font-bold">
                  FactBase: {claimCount}
                </span>
              </div>
              <div className={`text-[10px] ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                {operatorRole}
              </div>
            </div>
          </div>

          {/* 队列岗位快速切换胶囊 */}
          <div className="hidden xl:flex flex-col gap-0.5 font-mono">
            <span className="text-[9px] text-slate-500 uppercase tracking-widest">TARGET PIPELINE QUEUE</span>
            <div className={`flex items-center gap-1 p-0.5 rounded-lg ${theme === "light" ? "bg-white border-slate-200" : "bg-[#0A1018] border-[#1B2A3D]"} border`}>
              {jobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() => {
                    setActiveJobId(j.id);
                    triggerToast(`✦ 目标切换：${j.company}`, `岗位「${j.role}」已装入求职拓扑中枢`);
                  }}
                  className={`px-2 py-0.5 rounded text-[10px] transition ${
                    activeJobId === j.id
                      ? theme === "light"
                        ? "bg-amber-100 text-amber-900 border border-amber-300 font-bold shadow-sm"
                        : "bg-amber-400/20 text-amber-300 border border-amber-400/40 font-bold"
                      : theme === "light"
                        ? "text-slate-600 hover:text-slate-900"
                        : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {j.shortName}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 中间：全链路自动化工坊核心标题 */}
        <div className="text-center font-mono tracking-tight select-none">
          <div className="text-[10px] tracking-widest font-bold flex items-center justify-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            <span className={theme === "light" ? "text-cyan-800" : "text-cyan-400/90"}>
              @BETTERME-OS // THE CAREER ENGINEERING WORKSPACE
            </span>
            <span className={theme === "light" ? "px-1.5 py-0.2 rounded bg-slate-200 text-[9px] text-slate-700 border border-slate-300 font-bold" : "px-1.5 py-0.2 rounded bg-slate-800 text-[9px] text-slate-400 border border-slate-700 font-bold"}>
              20-NODE DAG
            </span>
          </div>

          <h1 className="text-base md:text-lg xl:text-xl font-black italic tracking-tight mt-0.5 whitespace-nowrap">
            <span className="text-cyan-500">BETTERME AUTOPILOT ·</span>{" "}
            <span className={theme === "light" ? "text-slate-900" : "text-white"}>
              求职全链路自动化工坊
            </span>
          </h1>

          <div className="text-[10px] tracking-wider flex items-center justify-center gap-2 mt-0.5 font-mono whitespace-nowrap">
            <span className="text-emerald-500 font-bold">20 节点拓扑闭环</span>
            <span className="text-slate-400">•</span>
            <span className="text-amber-500 font-bold">事实证据链锚定</span>
            <span className="text-slate-400">•</span>
            <span className="text-cyan-500 font-bold">投递后异步挂起</span>
            <span className="text-slate-400">•</span>
            <span className="text-purple-500 font-bold">沙箱微应用生态</span>
          </div>
        </div>

        {/* 右侧：遥测指标舱 + 前往系统设置 (模型/工具配置) + 主题切换 */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 实时遥测指标胶囊 */}
          <div className={`hidden md:flex items-center gap-2 px-2.5 py-1.5 rounded-xl border font-mono text-[11px] whitespace-nowrap shrink-0 ${
            theme === "light"
              ? "bg-white border-slate-200 text-slate-700 shadow-sm"
              : "bg-[#0A1018] border-[#1E2E42] text-slate-300"
          }`}>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-semibold">:9222 CDP</span>
            </span>
            <span className="opacity-30">•</span>
            <span className="text-amber-500 font-semibold shrink-0">Prefetch=2</span>
            <span className="opacity-30">•</span>
            <span className="text-cyan-500 font-semibold shrink-0">{claimCount}条证据锁</span>
          </div>

          {/* 系统设置快捷入口 (配置 CLI Agent 与模型) */}
          <button
            type="button"
            onClick={() => openSystemSettings("tools")}
            className={`px-3 py-1.5 rounded-xl border flex items-center gap-1.5 font-mono text-xs font-bold transition hover:scale-[1.02] ${
              theme === "light"
                ? "bg-white border-slate-300 text-slate-800 hover:bg-slate-50 shadow-sm"
                : "bg-[#0A1018] border-[#1E2E42] text-slate-200 hover:bg-[#121c2a]"
            }`}
            title="在系统设置中配置本地 CLI Agent 与大模型内核"
          >
            <Sliders className="w-3.5 h-3.5 text-cyan-500" />
            <span>系统设置</span>
          </button>

          {/* 浅色/深色模式一键切换 */}
          <button
            type="button"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className={`p-2 rounded-xl border flex items-center justify-center transition ${
              theme === "light"
                ? "bg-white border-slate-200 text-slate-700 hover:bg-slate-50 shadow-sm"
                : "bg-[#0A1018] border-[#1E2E42] text-slate-300 hover:bg-[#121c2a]"
            }`}
            title={theme === "light" ? "切换深色黑曜石工业风" : "切换浅色钛金风"}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </header>

      {/* ====================================================================
          2. 中央主舞台：20-NODE 环流工坊 OR 3D 机会金库
         ==================================================================== */}
      <main className="relative z-10 flex-1 min-h-0 w-full px-3 py-1 flex items-center justify-center">
        {workspaceMode === "studio" && (
          <div className="relative w-full h-full max-w-[1580px] grid grid-cols-6 grid-rows-6 gap-2">
            {/* 游走 AI Mascot 精灵 */}
            <div
              style={{
                top: `${(positionedCards.find((c) => c.isSpotlight)?.slot.row || 1) * 16 - 2}%`,
                left: `${(positionedCards.find((c) => c.isSpotlight)?.slot.col || 3) * 16 - 4}%`,
              }}
              className="pointer-events-none absolute z-40 transition-all duration-700 ease-out flex flex-col items-center"
            >
              <div style={{ animation: "ap-rover-float 2.2s ease-in-out infinite" }}>
                <AgentMascotSprite agentId={currentAgent.id} className="w-10 h-10 drop-shadow-[0_4px_14px_rgba(245,158,11,0.6)]" />
              </div>
            </div>

            {/* 20 张外环技能卡片 */}
            {positionedCards.map(({ node, nodeIndex, slot, isSpotlight }) => (
              <div
                key={node.id}
                data-node-id={node.id}
                role="button"
                tabIndex={0}
                aria-label={`打开 ${node.code} ${node.name}`}
                aria-pressed={isSpotlight}
                onKeyDown={e => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); }
                }}
                onClick={() => {
                  setAutoLoopPlaying(false);
                  setActiveNodeIdx(nodeIndex);
                  setTerminalTab("inspector");
                }}
                style={{
                  gridRowStart: slot.row,
                  gridColumnStart: slot.col,
                  backgroundColor: theme === "light"
                    ? "#FFFFFF"
                    : isSpotlight
                      ? "rgba(18, 28, 44, 0.98)"
                      : "rgba(10, 16, 26, 0.92)",
                  borderColor: isSpotlight
                    ? theme === "light"
                      ? "#0284C7"
                      : "#38BDF8"
                    : theme === "light"
                      ? "#CBD5E1"
                      : "#1E2D40",
                  boxShadow: isSpotlight
                    ? theme === "light"
                      ? "0 0 0 2px rgba(14, 165, 233, 0.45), 0 14px 34px -4px rgba(14, 165, 233, 0.35), 0 4px 12px rgba(15, 23, 42, 0.08), inset 0 1px 0 #FFFFFF"
                      : "0 0 0 2px rgba(56, 189, 248, 0.55), 0 18px 40px -6px rgba(0, 0, 0, 0.85), 0 0 28px rgba(56, 189, 248, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.2)"
                    : theme === "light"
                      ? "0 4px 14px -2px rgba(15, 23, 42, 0.08), 0 2px 5px -1px rgba(15, 23, 42, 0.04), inset 0 1px 0 #FFFFFF"
                      : "0 6px 18px -3px rgba(0, 0, 0, 0.65), 0 1px 2px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.09)",
                  animation: isSpotlight
                    ? theme === "light"
                      ? "ap-spotlight-breathe 2.4s ease-in-out infinite"
                      : "ap-spotlight-breathe-dark 2.4s ease-in-out infinite"
                    : undefined,
                }}
                className={`relative rounded-xl border p-2 flex flex-col justify-between overflow-hidden cursor-pointer transition-all duration-300 group hover:scale-[1.01] ${
                  isSpotlight ? "z-20" : ""
                }`}
              >
                {/* 顶部微排版 */}
                <div className="flex items-start justify-between gap-1 font-mono">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-black shrink-0 transition-colors ${
                        isSpotlight
                          ? "bg-cyan-500 text-slate-950 shadow-sm"
                          : theme === "light"
                            ? "bg-slate-100 text-slate-700 border border-slate-200"
                            : "bg-[#141E2B] text-slate-400 border border-white/5"
                      }`}
                    >
                      {node.code}
                    </span>
                    <span className={`text-xs font-bold truncate ${
                      isSpotlight
                        ? theme === "light"
                          ? "text-cyan-900 font-black"
                          : "text-cyan-300 font-black"
                        : theme === "light"
                          ? "text-slate-800"
                          : "text-slate-200"
                    }`}>
                      {node.name}
                    </span>
                  </div>
                  <span className={`px-1.5 py-0.2 rounded text-[8.5px] font-bold font-mono border uppercase tracking-wider shrink-0 ${getNodeTagBadge(node.tag, theme)}`}>
                    {node.tag}
                  </span>
                </div>

                {/* 描述与遥测指标 */}
                <div className="my-1">
                  <div className={`text-[10px] truncate ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                    {node.sub}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[9px] font-mono text-slate-500">
                    <span className={theme === "light" ? "text-slate-600 font-semibold" : "text-slate-400"}>{node.latency}</span>
                    <span>•</span>
                    <span>{node.tokens} tokens</span>
                  </div>
                </div>

                {/* 下半部微缩蓝图舱 (自动适配深色黑曜石 / 浅色钛金风) */}
                <BlueprintMicroChamber
                  type={node.vizType}
                  isSpotlight={isSpotlight}
                  code={node.code}
                  agent={currentAgent}
                  theme={theme}
                />
              </div>
            ))}

            {/* 中央 4x4 控制台/深度工件工作台 */}
            <div
              style={{
                backgroundColor: theme === "light" ? "#FFFFFF" : "#070B11",
                borderColor: currentAgent.borderAccent,
                boxShadow: `0 24px 70px -16px rgba(0,0,0,0.92), 0 0 32px ${currentAgent.glowRgba}`,
              }}
              className="row-start-2 row-end-6 col-start-2 col-end-6 rounded-2xl border flex flex-col overflow-hidden z-20"
            >
              {/* 控制台顶栏 */}
              <div
                style={{
                  backgroundColor: theme === "light" ? "#F1F5F9" : "#0B111A",
                  borderColor: theme === "light" ? "#CBD5E1" : "#1B2A3D",
                }}
                className="h-10 px-4 border-b flex items-center justify-between shrink-0 font-mono text-xs select-none"
              >
                {/* 顶栏左侧品牌 */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 font-bold" style={{ color: currentAgent.primaryHex }}>
                    <AgentTotemIcon agentId={currentAgent.id} className="w-4 h-4" />
                    <span>{currentAgent.cliHeaderTitle}</span>
                  </div>

                  {/* 视图 Tab 切换 */}
                  <div className={`flex items-center gap-1 p-0.5 rounded-lg border ${
                    theme === "light"
                      ? "bg-slate-200/80 border-slate-300"
                      : "bg-black/40 border-white/10"
                  }`}>
                    <button
                      onClick={() => setTerminalTab("terminal")}
                      className={`px-2.5 py-1 rounded text-[11px] font-bold transition flex items-center gap-1.5 ${
                        terminalTab === "terminal"
                          ? "bg-cyan-500 text-slate-950 shadow"
                          : theme === "light"
                            ? "text-slate-600 hover:text-slate-900"
                            : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <Terminal className="w-3 h-3" />
                      <span>实时终端树 (CLI)</span>
                    </button>
                    <button
                      onClick={() => setTerminalTab("inspector")}
                      className={`px-2.5 py-1 rounded text-[11px] font-bold transition flex items-center gap-1.5 ${
                        terminalTab === "inspector"
                          ? "bg-cyan-500 text-slate-950 shadow"
                          : theme === "light"
                            ? "text-slate-600 hover:text-slate-900"
                            : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <Eye className="w-3 h-3" />
                      <span>深度工件舱 (#{activeNode.code})</span>
                    </button>
                  </div>
                </div>

                {/* 顶栏右侧快捷操作 */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleMint3DCard()}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold font-mono transition flex items-center gap-1 ${
                      theme === "light"
                        ? "text-amber-900 bg-amber-100 border border-amber-300 hover:bg-amber-200"
                        : "text-amber-300 bg-amber-400/15 border border-amber-400/35 hover:bg-amber-400/25"
                    }`}
                  >
                    <Zap className="w-3 h-3" />
                    <span>铸造 3D 机会卡</span>
                  </button>

                  <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span>:9222 CDP</span>
                  </div>
                </div>
              </div>

              {/* 控制台内容区 */}
              <div className="flex-1 min-h-0 overflow-y-auto p-4 font-mono text-xs leading-relaxed">
                {terminalTab === "terminal" ? (
                  <div className="space-y-4">
                    {/* Welcome Banner */}
                    <div
                      style={{
                        backgroundColor: theme === "light" ? "#F8FAFC" : "#05090F",
                        borderColor: theme === "light" ? "#E2E8F0" : currentAgent.borderAccent,
                        boxShadow: theme === "light" ? "0 4px 16px rgba(0,0,0,0.03)" : undefined,
                      }}
                      className="p-4 rounded-xl border flex items-start gap-4"
                    >
                      <AgentMascotSprite agentId={currentAgent.id} className="w-14 h-14 shrink-0" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between">
                          <h2 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-white"
                          }`}>
                            <span>BetterMe Autopilot 工作台 · {operatorName}</span>
                            <span className={`text-xs px-2 py-0.5 rounded border ${
                              theme === "light"
                                ? "bg-cyan-50 text-cyan-800 border-cyan-300 font-bold"
                                : "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
                            }`}>
                              自动化流水线引擎 · 已就绪
                            </span>
                          </h2>
                          <div className={`flex items-center gap-1 text-[11px] font-bold ${
                            theme === "light"
                              ? "text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200"
                              : "text-emerald-400"
                          }`}>
                            <Lock className="w-3 h-3" />
                            <span>FactBase {claimCount}/{claimCount} Locked</span>
                          </div>
                        </div>

                        <div className={`text-[11px] flex items-center gap-3 ${
                          theme === "light" ? "text-slate-600" : "text-slate-400"
                        }`}>
                          <span>求职角色：{operatorRole}</span>
                          <span>•</span>
                          <span className={theme === "light" ? "text-cyan-800 font-semibold" : "text-cyan-300"}>
                            FactBase 事实库锁已激活
                          </span>
                        </div>

                        <p className={`text-[11px] pt-1 ${
                          theme === "light" ? "text-slate-700 font-medium" : "text-slate-300/90"
                        }`}>
                          以全网客观事实与本地真实经历，构建无幻觉、端到端闭环的职业工程中枢。
                        </p>

                        {/* 系统模型与工具配置指引 */}
                        <div className="pt-2 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-mono ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                              执行内核：当前已连接系统配置的本地 CLI / 模型调度
                            </span>
                            <button
                              onClick={() => openSystemSettings("tools")}
                              className="text-[10px] text-cyan-600 hover:text-cyan-500 underline font-bold flex items-center gap-1 font-mono"
                            >
                              <Sliders className="w-2.5 h-2.5" />
                              <span>前往系统设置配置模型与工具 &gt;</span>
                            </button>
                          </div>
                          <div className={`text-[10px] font-mono ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                            Prefetch: 2 并发 · 三层沙箱隔离
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 当前执行指令与动态目标 */}
                    <div className={`p-3 rounded-xl border flex items-center justify-between ${
                      theme === "light"
                        ? "bg-slate-50 border-slate-200 text-slate-800"
                        : "bg-black/40 border-white/10 text-cyan-300"
                    }`}>
                      <div className={`flex items-center gap-2 font-mono ${
                        theme === "light" ? "text-slate-900 font-semibold" : "text-cyan-300"
                      }`}>
                        <span className="font-bold text-cyan-600">&gt;</span>
                        <span>/autopilot --target="{activeJob.company}" --pipeline=full</span>
                      </div>
                      <button
                        onClick={() => setTerminalTab("inspector")}
                        className={`text-[10px] hover:underline flex items-center gap-1 font-mono font-bold ${
                          theme === "light" ? "text-amber-700" : "text-amber-300"
                        }`}
                      >
                        <span>[展开 #{activeNode.code} 工件]</span>
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>

                    {/* 树状调用日志流 */}
                    <div className="space-y-2 pt-1 font-mono">
                      {visibleTerminalStream.map((item) => (
                        <div key={item.id} className="space-y-0.5">
                          <div className={`flex items-center justify-between ${
                            theme === "light" ? "text-slate-800" : "text-slate-200"
                          }`}>
                            <div className="flex items-center gap-2">
                              <span
                                style={{ color: item.isCurrent ? currentAgent.primaryHex : "#64748B" }}
                                className="font-bold"
                              >
                                ●
                              </span>
                              <span className={`font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                #{item.code} {item.name}
                              </span>
                              <span className={`text-[11px] ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                                ({item.cmdTitle})
                              </span>
                            </div>
                            <span className="text-slate-500 text-[10px]">{item.latency}</span>
                          </div>
                          <div className={`pl-4 flex items-center justify-between text-[11px] ${
                            theme === "light" ? "text-slate-600" : "text-slate-400"
                          }`}>
                            <span>⎿ {item.cmdDetail}</span>
                            <button
                              onClick={() => {
                                setActiveNodeIdx(item.id - 1);
                                setTerminalTab("inspector");
                              }}
                              className={`hover:underline font-bold ${
                                theme === "light" ? "text-cyan-700 hover:text-cyan-900" : "text-cyan-400"
                              }`}
                            >
                              [Diff / 实证 ➔]
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* 深度工件舱 (Inspector) */
                  <div className="space-y-4">
                    {/* Node 11: 简历润色 Git Diff */}
                    {activeNode.id === 11 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <Code2 className="w-4 h-4 text-cyan-500" />
                            <span>结构化 Diff 审查台 · 对齐事实锁 [FB-01..38]</span>
                          </h3>
                          <span className={`text-[10px] px-2 py-0.5 rounded border ${
                            theme === "light"
                              ? "bg-emerald-100 text-emerald-900 border-emerald-300 font-bold"
                              : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                          }`}>
                            0 虚构参数 · 100% 履历锚定
                          </span>
                        </div>

                        {activeJob.diffItems.map((item) => (
                          <div
                            key={item.id}
                            className={`p-3 rounded-xl border space-y-2 ${
                              theme === "light" ? "bg-slate-50 border-slate-200 shadow-sm" : "bg-black/50 border-white/10"
                            }`}
                          >
                            <div className="flex items-center justify-between text-[11px]">
                              <span className={`font-bold ${theme === "light" ? "text-slate-800" : "text-slate-200"}`}>
                                {item.section}
                              </span>
                              <span className={`px-1.5 py-0.2 rounded text-[10px] ${
                                theme === "light"
                                  ? "bg-amber-100 text-amber-900 border border-amber-300 font-bold"
                                  : "bg-amber-400/20 text-amber-300"
                              }`}>
                                {item.factId}: {item.factTitle}
                              </span>
                            </div>

                            <div className={`p-2 rounded-lg border text-xs ${
                              theme === "light"
                                ? "bg-rose-50 border-rose-200 text-rose-900"
                                : "bg-rose-950/25 border-rose-500/30 text-rose-300"
                            }`}>
                              <span className={`font-bold mr-2 ${theme === "light" ? "text-rose-600" : "text-rose-400"}`}>-</span>
                              <span>{item.oldText}</span>
                            </div>

                            <div className={`p-2 rounded-lg border text-xs ${
                              theme === "light"
                                ? "bg-emerald-50 border-emerald-200 text-emerald-950 font-medium"
                                : "bg-emerald-950/25 border-emerald-500/30 text-emerald-300"
                            }`}>
                              <span className={`font-bold mr-2 ${theme === "light" ? "text-emerald-700" : "text-emerald-400"}`}>+</span>
                              <span>{item.newText}</span>
                            </div>

                            <div className={`text-[10px] pt-1 ${
                              theme === "light" ? "text-cyan-900 font-semibold" : "text-cyan-300/80"
                            }`}>
                              ✦ 成果量化：{item.impactMetric}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Node 13: ATS / 版式体检矩阵 */}
                    {activeNode.id === 13 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <BookmarkCheck className="w-4 h-4 text-cyan-500" />
                            <span>Workday ATS 机器解析与单页 A4 版式体检</span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-emerald-700" : "text-emerald-400"
                          }`}>
                            ✓ 工业标准校验通过
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-emerald-700" : "text-emerald-400"}`}>
                              {activeJob.atsMetrics.parseRate}%
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              DOM 文本解析率
                            </div>
                          </div>
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-cyan-700" : "text-cyan-400"}`}>
                              {activeJob.atsMetrics.pageFill}%
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              A4 单页填充率 (零跨页)
                            </div>
                          </div>
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-amber-700" : "text-amber-400"}`}>
                              {activeJob.atsMetrics.keywordMatched}/{activeJob.atsMetrics.keywordTotal}
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              核心关键词命中
                            </div>
                          </div>
                        </div>

                        <div className={`p-3 rounded-xl border text-[11px] space-y-1 ${
                          theme === "light" ? "bg-amber-50 border-amber-200 text-amber-950" : "bg-[#0B121C] border-[#1E2E42]"
                        }`}>
                          <div className={`font-bold ${theme === "light" ? "text-slate-900" : "text-slate-200"}`}>
                            待补充隐性关键词：
                          </div>
                          <div className={`font-mono ${theme === "light" ? "text-amber-800 font-semibold" : "text-amber-300"}`}>
                            ⚠ {activeJob.atsMetrics.missingKeyword}（建议在「架构演进」段落自然植入）
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Node 10: 企业全网背调实证雷达 */}
                    {activeNode.id === 10 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <ShieldCheck className="w-4 h-4 text-cyan-500" />
                            <span>{activeJob.company} · 全网背调实证档案</span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-emerald-700" : "text-emerald-400"
                          }`}>
                            裁判文书 / 工商 100% 真实核验
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-3 text-[11px]">
                          <div className={`p-3 rounded-xl border ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <span className={theme === "light" ? "text-slate-500" : "text-slate-400"}>注册资本 (实缴)：</span>
                            <div className={`font-bold mt-1 ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                              {activeJob.triageDossier.regCapital}
                            </div>
                          </div>
                          <div className={`p-3 rounded-xl border ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <span className={theme === "light" ? "text-slate-500" : "text-slate-400"}>历史劳动仲裁：</span>
                            <div className={`font-bold mt-1 ${theme === "light" ? "text-emerald-700" : "text-emerald-400"}`}>
                              {activeJob.triageDossier.laborDisputes}
                            </div>
                          </div>
                        </div>

                        <div className={`p-3 rounded-xl border text-[11px] ${
                          theme === "light"
                            ? "bg-emerald-50 border-emerald-200 text-emerald-950"
                            : "bg-emerald-950/25 border-emerald-500/30 text-emerald-200"
                        }`}>
                          <div className={`font-bold mb-1 ${theme === "light" ? "text-emerald-800" : "text-emerald-400"}`}>
                            ✓ WLB 现员工实证：
                          </div>
                          <p>{activeJob.triageDossier.wlbVerification}</p>
                        </div>

                        <div className={`p-3 rounded-xl border text-[11px] ${
                          theme === "light"
                            ? "bg-cyan-50 border-cyan-200 text-cyan-950"
                            : "bg-cyan-950/25 border-cyan-500/30 text-cyan-200"
                        }`}>
                          <div className={`font-bold mb-1 ${theme === "light" ? "text-cyan-800" : "text-cyan-400"}`}>
                            ✦ AI 决胜结论：
                          </div>
                          <p>{activeJob.triageDossier.agentVerdict}</p>
                        </div>
                      </div>
                    )}

                    {/* Node 19: 薪酬与时薪模拟器 */}
                    {activeNode.id === 19 && (
                      <div className="space-y-4">
                        <div className={`flex items-center justify-between pb-2 border-b ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <Activity className="w-4 h-4 text-cyan-500" />
                            <span>真实工时净时薪精算模型 (True Net Hourly Wage)</span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-amber-800" : "text-amber-300"
                          }`}>
                            拒接 996 伪高薪
                          </span>
                        </div>

                        <div
                          style={{
                            backgroundColor: theme === "light" ? "#F8FAFC" : "#090E17",
                            borderColor: theme === "light" ? "#CBD5E1" : "rgba(34, 211, 238, 0.3)",
                          }}
                          className="p-4 rounded-xl border flex items-center justify-between"
                        >
                          <div>
                            <div className={`text-[10px] ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              折算真实净时薪 (税后+公积金 / 真实年工时)
                            </div>
                            <div className={`text-3xl font-black mt-1 ${
                              theme === "light" ? "text-amber-600" : "text-amber-400"
                            }`}>
                              ¥{netHourlyWage} / hr
                            </div>
                          </div>
                          <div className="text-right">
                            <span className={`px-2 py-1 rounded font-bold text-xs border ${
                              theme === "light"
                                ? "bg-emerald-100 text-emerald-900 border-emerald-300"
                                : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                            }`}>
                              WLB S+ 级别
                            </span>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              较 996 大厂实际时薪溢价 +38%
                            </div>
                          </div>
                        </div>

                        {/* 滑块调节 */}
                        <div className="space-y-3 font-mono text-[11px]">
                          <div>
                            <div className={`flex justify-between mb-1 ${
                              theme === "light" ? "text-slate-700 font-bold" : "text-slate-300"
                            }`}>
                              <span>月薪 Base: {simBaseK}k</span>
                              <span className={theme === "light" ? "text-cyan-800" : "text-cyan-400"}>
                                年总包: ¥{simBaseK * simMonths}k
                              </span>
                            </div>
                            <input
                              type="range"
                              min="25"
                              max="70"
                              value={simBaseK}
                              onChange={(e) => setSimBaseK(Number(e.target.value))}
                              className="w-full accent-cyan-500"
                            />
                          </div>

                          <div>
                            <div className={`flex justify-between mb-1 ${
                              theme === "light" ? "text-slate-700 font-bold" : "text-slate-300"
                            }`}>
                              <span>年终月数: {simMonths} 薪</span>
                              <span className={theme === "light" ? "text-cyan-800" : "text-cyan-400"}>
                                {simMonths >= 15 ? "外企弹性" : "基准"}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="12"
                              max="24"
                              value={simMonths}
                              onChange={(e) => setSimMonths(Number(e.target.value))}
                              className="w-full accent-cyan-500"
                            />
                          </div>

                          <div>
                            <div className={`flex justify-between mb-1 ${
                              theme === "light" ? "text-slate-700 font-bold" : "text-slate-300"
                            }`}>
                              <span>每周真实工作时长: {simWeeklyHours} 小时/周</span>
                              <span className={theme === "light" ? "text-emerald-700" : "text-emerald-400"}>
                                16:30 准点下班
                              </span>
                            </div>
                            <input
                              type="range"
                              min="35"
                              max="60"
                              step="2.5"
                              value={simWeeklyHours}
                              onChange={(e) => setSimWeeklyHours(Number(e.target.value))}
                              className="w-full accent-amber-500"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Node 20: 沙箱应用工坊 */}
                    {activeNode.id === 20 && (
                      <div className="space-y-4">
                        {/* 手工内置预设，与下方的模型实验台分开 */}
                        <div className={`flex flex-col gap-2 pb-2.5 border-b ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <div className="flex items-center justify-between">
                            <h3 className={`text-sm font-bold flex items-center gap-2 ${
                              theme === "light" ? "text-slate-900" : "text-cyan-300"
                            }`}>
                              <Layers className="w-4 h-4 text-cyan-500" />
                              <span>内置微应用 · 手工选择预设</span>
                            </h3>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              theme === "light"
                                ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                                : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                            }`}>
                              不调用模型
                            </span>
                          </div>

                          {/* 3层隔离说明胶囊 */}
                          <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-slate-100 text-slate-700 border-slate-300" : "bg-white/5 text-slate-300 border-white/10"
                            }`}>
                              ① 核对内置模板
                            </span>
                            <span className="text-slate-400">➔</span>
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-cyan-50 text-cyan-800 border-cyan-300" : "bg-cyan-950/40 text-cyan-300 border-cyan-500/30"
                            }`}>
                              ② 宿主编译与回执
                            </span>
                            <span className="text-slate-400">➔</span>
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-amber-50 text-amber-800 border-amber-300" : "bg-amber-950/40 text-amber-300 border-amber-500/30"
                            }`}>
                              ③ 你批准后打开
                            </span>
                          </div>
                        </div>

                        {/* 实时编译状态横幅 */}
                        {buildStatus === "building" && (
                          <div className={`p-3 rounded-xl border flex items-center gap-3 animate-pulse ${
                            theme === "light"
                              ? "bg-cyan-50 border-cyan-300 text-cyan-900"
                              : "bg-cyan-950/40 border-cyan-500/40 text-cyan-200"
                          }`}>
                            <Loader2 className="w-4 h-4 animate-spin text-cyan-500 shrink-0" />
                            <div className="text-xs font-mono">
                              <div className="font-bold">正在等待内置预设构建回执</div>
                              <div className="text-[11px] opacity-80 mt-0.5">{buildingStep}</div>
                            </div>
                          </div>
                        )}

                        {/* 已审查的内置模板 */}
                        <div className="space-y-2.5">
                          {Object.entries(PRESET_MICRO_APP_TEMPLATES).map(([appId, tmpl]) => {
                            const isInstalled = installedMicroApps.some((a) => a.appId === appId);
                            const installedApp = installedMicroApps.find((a) => a.appId === appId);
                            const isCompilingThis = buildingAppId === appId;

                            return (
                              <div
                                key={appId}
                                className={`p-3 rounded-xl border transition-all ${
                                  isInstalled
                                    ? theme === "light"
                                      ? "bg-emerald-50/50 border-emerald-300 shadow-sm"
                                      : "bg-emerald-950/20 border-emerald-500/30"
                                    : theme === "light"
                                    ? "bg-slate-50 border-slate-200 hover:border-slate-300"
                                    : "bg-black/40 border-white/10 hover:border-white/20"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex items-start gap-2.5 min-w-0">
                                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-lg bg-gradient-to-br from-amber-400 to-cyan-400 shadow-sm shrink-0">
                                      {tmpl.icon}
                                    </div>
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`font-bold text-xs ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                          {tmpl.name}
                                        </span>
                                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/10 dark:bg-white/10 text-slate-500 dark:text-slate-400">
                                          v{tmpl.version}
                                        </span>
                                        {isInstalled && (
                                          <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
                                            <CheckCircle2 size={11} />
                                            {installedApp?.pinnedToDock ? "已固定到 Dock" : "已安装"}
                                          </span>
                                        )}
                                      </div>
                                      <p className={`text-[11px] mt-0.5 line-clamp-2 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                                        {tmpl.description}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2 shrink-0">
                                    {isInstalled && installedApp ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => handleOpenInstalledApp(installedApp)}
                                          className="px-2.5 py-1 rounded-lg text-xs font-bold bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 hover:brightness-110 shadow flex items-center gap-1"
                                        >
                                          <span>唤起沙箱 ➔</span>
                                        </button>
                                        <button
                                          type="button"
                                          disabled={buildStatus === "building"}
                                          onClick={() => handleTriggerSandboxBuild(appId)}
                                          className={`px-2 py-1 rounded-lg text-[11px] font-medium border transition ${
                                            theme === "light"
                                              ? "border-slate-300 text-slate-600 hover:bg-slate-100"
                                              : "border-white/10 text-slate-400 hover:bg-white/10"
                                          }`}
                                          title="请宿主重新核对并编译内置模板"
                                        >
                                          重新构建
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={buildStatus === "building"}
                                        onClick={() => handleTriggerSandboxBuild(appId)}
                                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-amber-400 to-cyan-400 text-slate-950 hover:brightness-110 shadow flex items-center gap-1.5 transition-all disabled:opacity-50"
                                      >
                                        {isCompilingThis ? (
                                          <>
                                            <Loader2 size={12} className="animate-spin" />
                                            <span>等待宿主回执…</span>
                                          </>
                                        ) : (
                                          <>
                                            <Zap size={12} />
                                            <span>编译并审阅权限 ➔</span>
                                          </>
                                        )}
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* 权限范围标签 */}
                                <div className="mt-2 pt-2 border-t flex items-center gap-1.5 flex-wrap text-[10px] font-mono opacity-80 border-black/5 dark:border-white/5">
                                  <Lock size={10} className="text-cyan-500" />
                                  <span className="text-slate-500 dark:text-slate-400">授权边界:</span>
                                  {tmpl.grantedScopes.map((scope) => (
                                    <span
                                      key={scope}
                                      className={`px-1.5 py-0.5 rounded ${
                                        theme === "light"
                                          ? "bg-slate-200/70 text-slate-700"
                                          : "bg-white/10 text-slate-300"
                                      }`}
                                    >
                                      {scope}
                                    </span>
                                  ))}
                                  <span className="ml-auto text-[10px] text-emerald-600 dark:text-emerald-400">
                                    运行于隔离 iframe
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <SandboxCodingLab />
                      </div>
                    )}

                    {/* 其余节点的默认工程工件 */}
                    {![10, 11, 13, 19, 20].includes(activeNode.id) && (
                      <div className={`p-4 rounded-xl border space-y-2 ${
                        theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                      }`}>
                        <div className="flex items-center justify-between">
                          <span className={`font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                            #{activeNode.code} {activeNode.name} 运行时状态
                          </span>
                          <span className={`px-2 py-0.5 rounded text-[10px] ${
                            theme === "light"
                              ? "bg-cyan-100 text-cyan-900 border border-cyan-300 font-bold"
                              : "bg-cyan-400/20 text-cyan-300"
                          }`}>
                            {activeNode.latency} • {activeNode.tokens} tokens
                          </span>
                        </div>
                        <div className={`text-[11px] ${theme === "light" ? "text-slate-600" : "text-slate-300"}`}>
                          {activeNode.cmdDetail}
                        </div>
                        <div className={`p-2 rounded text-[10px] font-mono border ${
                          theme === "light"
                            ? "bg-slate-100 text-slate-700 border-slate-200"
                            : "bg-black/60 text-slate-400 border-white/5"
                        }`}>
                          payload: {JSON.stringify({ skill: activeNode.cmdTitle, target: activeJob.company, lockedEvidence: "FB-01..38" }, null, 2)}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 控制台底部状态栏 */}
              <div
                style={{
                  backgroundColor: theme === "light" ? "#F1F5F9" : "#0B111A",
                  borderColor: theme === "light" ? "#CBD5E1" : "#1B2A3D",
                }}
                className="h-8 px-4 border-t flex items-center justify-between font-mono text-[10px] text-slate-400 shrink-0"
              >
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>
                    &gt;&gt; auto mode {autoLoopPlaying ? "on (patrolling)" : "paused"} • Space to toggle
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span>18.8k tokens</span>
                  <span>•</span>
                  <span style={{ color: currentAgent.primaryHex }} className="font-bold">
                    {currentAgent.shortName}
                  </span>
                  <span>•</span>
                  <span>/effort max</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 3D 机会金库模式 */}
        {(workspaceMode === "space3d" || workspaceMode === "split") && (
          <div className="w-full h-full max-w-[1400px] overflow-y-auto p-4 flex flex-col justify-between">
            <div className={`flex items-center justify-between pb-3 border-b ${
              theme === "light" ? "border-slate-200" : "border-white/10"
            }`}>
              <div className="font-mono">
                <h2 className={`text-base font-bold flex items-center gap-2 ${
                  theme === "light" ? "text-slate-900" : "text-white"
                }`}>
                  <Orbit className="w-4 h-4 text-cyan-500" />
                  <span>3D 机会金库 · 立体背调卡册 ({collected3DJobs.length})</span>
                </h2>
                <p className={`text-[11px] ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                  支持鼠标悬停 3D 拟真光影与 180° 翻转背调签章；每一张卡片均加盖当前所选 AI Agent 专属实证印章。
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSpace3DLayout(space3DLayout === "grid" ? "carousel" : "grid")}
                  className={`px-3 py-1 rounded-lg text-xs font-mono border transition ${
                    theme === "light"
                      ? "bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200"
                      : "bg-white/[0.05] border-white/10 text-slate-300 hover:text-white"
                  }`}
                >
                  {space3DLayout === "grid" ? "切换 3D 环视轮播" : "切换 2x2 网格"}
                </button>
                <button
                  onClick={() => setWorkspaceMode("studio")}
                  className="px-3 py-1 rounded-lg text-xs font-mono font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 shadow"
                >
                  返回 20-Node 工坊
                </button>
              </div>
            </div>

            {/* 3D 卡片网格 */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 my-auto py-4">
              {collected3DJobs.map((j) => (
                <CyberJobCard3D
                  key={j.id}
                  job={j}
                  agent={currentAgent}
                  isFlipped={Boolean(flipped3DMap[j.id])}
                  onToggleFlip={() => setFlipped3DMap((p) => ({ ...p, [j.id]: !p[j.id] }))}
                  onChangeStage={(id, st) => {
                    setJobs((prev) => prev.map((item) => (item.id === id ? { ...item, stage3D: st } : item)));
                    triggerToast(`✦ 阶段更新：${st}`, `「${j.shortName}」已推进至 ${st}`);
                  }}
                  onInspectInStudio={(id) => {
                    setActiveJobId(id);
                    setWorkspaceMode("studio");
                    triggerToast(`✦ 载入工坊：${j.company}`, "已展开深度工件与执行树");
                  }}
                  theme={theme}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {/* ====================================================================
          3. 底部 CONTROL TRAY & DOCK 栏
         ==================================================================== */}
      <footer
        style={{
          backgroundColor: theme === "light" ? "#FFFFFF" : "#070B11",
          borderColor: theme === "light" ? "#CBD5E1" : "#1A2636",
          boxShadow: theme === "light" ? "0 -2px 10px rgba(0,0,0,0.03)" : undefined,
        }}
        className="relative z-30 px-4 py-2 border-t flex items-center justify-between gap-4 shrink-0 font-mono text-xs select-none"
      >
        {/* 左侧：当前循环节点信息 */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-bold" style={{ color: currentAgent.primaryHex }}>
            <span>✦</span>
            <span>{currentAgent.shortName}: The loop</span>
          </div>
          <span className={theme === "light" ? "text-slate-600 font-medium" : "text-slate-400"}>
            - #{activeNode.code} {activeNode.name} ({activeNode.tag})
          </span>
        </div>

        {/* 中间：ASCII 进度条与模式切换 */}
        <div className="hidden md:flex items-center gap-4">
          <div className={`flex items-center gap-2 text-[11px] ${
            theme === "light" ? "text-slate-600" : "text-slate-400"
          }`}>
            <span className={`font-bold ${theme === "light" ? "text-cyan-700" : "text-cyan-400"}`}>{asciiBar}</span>
            <span>{progressPercent}%</span>
          </div>

          <div className={`flex items-center gap-1 p-0.5 rounded-lg border ${
            theme === "light" ? "bg-slate-100 border-slate-300" : "bg-black/40 border-white/10"
          }`}>
            <button
              onClick={() => setWorkspaceMode("studio")}
              className={`px-2.5 py-1 rounded text-[10.5px] font-bold transition ${
                workspaceMode === "studio"
                  ? "bg-amber-400 text-slate-950 shadow"
                  : theme === "light"
                    ? "text-slate-600 hover:text-slate-900"
                    : "text-slate-400 hover:text-white"
              }`}
            >
              20-Node 工坊
            </button>
            <button
              onClick={() => setWorkspaceMode("space3d")}
              className={`px-2.5 py-1 rounded text-[10.5px] font-bold transition ${
                workspaceMode === "space3d"
                  ? "bg-amber-400 text-slate-950 shadow"
                  : theme === "light"
                    ? "text-slate-600 hover:text-slate-900"
                    : "text-slate-400 hover:text-white"
              }`}
            >
              3D 机会金库 ({collected3DJobs.length})
            </button>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined" && (window as any).desktopApi?.toggleStarPrompterHud) {
                  (window as any).desktopApi.toggleStarPrompterHud();
                } else {
                  triggerToast("🎙 STAR 提词 HUD", "桌面端专享：全局置顶、毛玻璃半透明、多屏跟随悬浮提词窗 (快捷键 ⌘+Shift+H)");
                }
              }}
              className={`px-2.5 py-1 rounded text-[10.5px] font-bold flex items-center gap-1.5 transition ${
                theme === "light"
                  ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20"
                  : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
              }`}
              title="切换/呼出 STAR 面试全局置顶提词 HUD 悬浮窗 (桌面端快捷键 ⌘+Shift+H)"
            >
              <Mic className="w-3 h-3 text-emerald-500" />
              <span>STAR 提词 HUD</span>
            </button>
          </div>
        </div>

        {/* 右侧：步进控制器与 Dock 入口 */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                setAutoLoopPlaying(false);
                setActiveNodeIdx((p) => (p - 1 + STUDIO_20_NODES.length) % STUDIO_20_NODES.length);
              }}
              className={`p-1.5 rounded-lg border transition ${
                theme === "light"
                  ? "bg-slate-100 border-slate-300 hover:bg-slate-200 text-slate-700"
                  : "bg-white/[0.05] border-white/10 hover:bg-white/10 text-slate-300"
              }`}
              title="上一步"
            >
              <SkipBack className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => setAutoLoopPlaying((p) => !p)}
              className={`px-3 py-1 rounded-lg font-bold flex items-center gap-1.5 transition ${
                autoLoopPlaying
                  ? "bg-amber-400 text-slate-950 shadow"
                  : theme === "light"
                    ? "bg-slate-200 text-slate-900 border border-slate-300 hover:bg-slate-300"
                    : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {autoLoopPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{autoLoopPlaying ? "环流中" : "单步推进"}</span>
            </button>

            <button
              onClick={() => {
                setAutoLoopPlaying(false);
                setActiveNodeIdx((p) => (p + 1) % STUDIO_20_NODES.length);
              }}
              className={`p-1.5 rounded-lg border transition ${
                theme === "light"
                  ? "bg-slate-100 border-slate-300 hover:bg-slate-200 text-slate-700"
                  : "bg-white/[0.05] border-white/10 hover:bg-white/10 text-slate-300"
              }`}
              title="下一步"
            >
              <SkipForward className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={() => setConveyorShiftMode((p) => !p)}
            className={`px-2 py-1 rounded-lg text-[10.5px] border transition ${
              conveyorShiftMode
                ? "bg-cyan-400/20 text-cyan-700 border-cyan-400/40 font-bold"
                : theme === "light"
                  ? "bg-slate-100 text-slate-700 border-slate-300"
                  : "bg-white/[0.05] text-slate-400 border-white/10"
            }`}
          >
            履带旋转: {conveyorShiftMode ? "ON" : "OFF"}
          </button>

          {/* 沙箱微应用挂载提示 */}
          <div className={`hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10.5px] ${
            theme === "light"
              ? "bg-slate-100 border-slate-300 text-slate-800"
              : "bg-[#0E1724] border-[#1E2E42] text-slate-300"
          }`}>
            <Layers className="w-3 h-3 text-cyan-500" />
            <span>已安装微应用 ({installedMicroApps.length})</span>
          </div>
        </div>
      </footer>

      {/* 沙箱应用安全审计与授权门禁 (HITL Gate) */}
      <MicroAppPermissionModal
        artifact={pendingArtifact}
        isOpen={isPermissionModalOpen}
        onClose={() => setIsPermissionModalOpen(false)}
        onApprove={handleApproveArtifact}
      />
    </div>
  );
}
