import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { FactBase, ProjectedResume } from "@better-me/core";
import useSWR from "swr";
import {
  useInstalledMicroApps,
  type InstalledMicroApp,
} from "../lib/micro-app-registry";
import {
  readOpportunityLibrary,
  type Opportunity,
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
import { useLocalAgentRuntime } from "../lib/local-agent-runtime";
import { StudioRuntimeIcon } from "./StudioRuntimeIcon";
import "./autopilot-studio.css";

// ============================================================================
// 1. 四大可选 AI AGENT 内核配置
// ============================================================================
export interface AgentKernelConfig {
  id: string;
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
    signatureQuote: "Every resume claim is grounded in the local FactBase.",
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
    mascotRole: "机甲羊驼算力核 · 全隔离本地隐私沙箱",
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
    signatureQuote: "Air-gapped local tensor inference — your resume stays on localhost.",
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
    latency: "Ready",
    tokens: "Local",
    bulletColor: "#F59E0B",
    cmdTitle: "kernel.orchestrate(skills=20, mode='local-first')",
    cmdDetail: "FactBase lock & saved opportunity library ready for advisor execution",
  },
  {
    id: 2,
    code: "02",
    name: "招聘检索",
    tag: "SOURCING",
    sub: "公开岗位卡 · SimHash 语义去重",
    vizType: "bars",
    latency: "待运行",
    tokens: "—",
    bulletColor: "#38BDF8",
    cmdTitle: "sourcing.query(sources=['careers', 'greenhouse', 'lever'])",
    cmdDetail: "Reads verified public sources configured in Opportunity Space",
  },
  {
    id: 3,
    code: "03",
    name: "BOSS直聘",
    tag: "SOURCING",
    sub: "只读公开卡片 · 绝不自动代发打招呼",
    vizType: "bridge",
    latency: "只读",
    tokens: "—",
    bulletColor: "#10B981",
    cmdTitle: "cdp.boss_readonly(auto_send=false)",
    cmdDetail: "Read-only capture with user confirmation; zero auto-messaging",
  },
  {
    id: 4,
    code: "04",
    name: "企业官网",
    tag: "SOURCING",
    sub: "Careers / ATS 公开招聘直连",
    vizType: "tree3",
    latency: "待运行",
    tokens: "—",
    bulletColor: "#22D3EE",
    cmdTitle: "ats.probe_official(mode='public_api')",
    cmdDetail: "Fetches official postings via authenticated / public adapters",
  },
  {
    id: 5,
    code: "05",
    name: "LinkedIn",
    tag: "SOURCING",
    sub: "外企研发中心 · 远程与混合办公筛选",
    vizType: "dotmatrix",
    latency: "待运行",
    tokens: "—",
    bulletColor: "#60A5FA",
    cmdTitle: "linkedin.read_public_card(filter_work_mode=true)",
    cmdDetail: "Preserves original URL and publication timestamp verbatim",
  },
  {
    id: 6,
    code: "06",
    name: "JD Guard",
    tag: "GUARD",
    sub: "隐藏指令剥离 · 零宽字符清洗",
    vizType: "guard",
    latency: "Guard",
    tokens: "—",
    bulletColor: "#F59E0B",
    cmdTitle: "jd_guard.sanitize(strip_zero_width=true)",
    cmdDetail: "Isolates untrusted JD markup before prompt construction",
  },
  {
    id: 7,
    code: "07",
    name: "JD 原句拆解",
    tag: "ANALYSIS",
    sub: "职责权重 · 硬性门槛 · 隐性加分项",
    vizType: "splitbars",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#38BDF8",
    cmdTitle: "jd.decompose_requirements(source='saved_opportunity')",
    cmdDetail: "Send job to Advisor to generate structured requirement breakdown",
  },
  {
    id: 8,
    code: "08",
    name: "证据链对齐",
    tag: "ANALYSIS",
    sub: "FactBase 实证 · 弱表达诊断 · 缺口",
    vizType: "spectrum",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#10B981",
    cmdTitle: "factbase.align(ground_truth_only=true)",
    cmdDetail: "Links resume phrasing directly to saved FactBase claims",
  },
  {
    id: 9,
    code: "09",
    name: "机会评级",
    tag: "TRIAGE",
    sub: "按真实需求与阶段做人工分层",
    vizType: "tiers",
    latency: "人工/顾问",
    tokens: "—",
    bulletColor: "#F59E0B",
    cmdTitle: "triage.evaluate(requires_advisor_receipt=true)",
    cmdDetail: "Scores appear only after explicit Advisor execution receipt",
  },
  {
    id: 10,
    code: "10",
    name: "企业来源核对",
    tag: "TRIAGE",
    sub: "发布主体 / 原始链接 / 时间核验",
    vizType: "radar",
    latency: "待核验",
    tokens: "—",
    bulletColor: "#A855F7",
    cmdTitle: "recon.inspect_provenance(source='opportunity_record')",
    cmdDetail: "Displays verified origin metadata without fabricated verdicts",
  },
  {
    id: 11,
    code: "11",
    name: "简历润色",
    tag: "TAILOR",
    sub: "结构化 old -> new · 绑定真实经历",
    vizType: "diff",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#22D3EE",
    cmdTitle: "tailor.prepare_diff(grounded_in_factbase=true)",
    cmdDetail: "Open job in Advisor to review candidate rewrite proposals",
  },
  {
    id: 12,
    code: "12",
    name: "Reviewer",
    tag: "TAILOR",
    sub: "独立复核 · 拒绝虚构参数",
    vizType: "bridge",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#10B981",
    cmdTitle: "reviewer.verify_claims(allow_invented=false)",
    cmdDetail: "Verifies every tailored bullet against your local FactBase",
  },
  {
    id: 13,
    code: "13",
    name: "ATS / 版式",
    tag: "VERIFY",
    sub: "简历材料快照 · 单页版式与 DOM 检查",
    vizType: "docscan",
    latency: "Ready",
    tokens: "—",
    bulletColor: "#38BDF8",
    cmdTitle: "verify.check_materials(target='saved_opportunity')",
    cmdDetail: "Inspect saved resume snapshots or run Advisor ATS check",
  },
  {
    id: 14,
    code: "14",
    name: "材料快照",
    tag: "DELIVERY",
    sub: "所投即所存 · 独立 Markdown 快照归档",
    vizType: "stack",
    latency: "Local",
    tokens: "—",
    bulletColor: "#60A5FA",
    cmdTitle: "snapshot.record_material(immutable_copy=true)",
    cmdDetail: "Subsequent resume edits never mutate archived job snapshots",
  },
  {
    id: 15,
    code: "15",
    name: "本人交接",
    tag: "DELIVERY",
    sub: "保留原申请页入口 · 由本人确认投递",
    vizType: "handover",
    latency: "Human",
    tokens: "—",
    bulletColor: "#F59E0B",
    cmdTitle: "delivery.human_confirm(require_explicit_submit=true)",
    cmdDetail: "Opening a link never fakes an applied status",
  },
  {
    id: 16,
    code: "16",
    name: "投递追踪",
    tag: "TRACKING",
    sub: "收藏 -> 投递 -> 面试 -> Offer 阶段树",
    vizType: "wave",
    latency: "Local",
    tokens: "—",
    bulletColor: "#10B981",
    cmdTitle: "tracking.stage_history(local_storage=true)",
    cmdDetail: "Tracks real stage transitions and user follow-up reminders",
  },
  {
    id: 17,
    code: "17",
    name: "面试攻防",
    tag: "INTERVIEW",
    sub: "基于真实项目经历组织深挖预案",
    vizType: "qa",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#A855F7",
    cmdTitle: "interview.prepare(source='factbase')",
    cmdDetail: "Send job to Advisor for tailored interview drill",
  },
  {
    id: 18,
    code: "18",
    name: "STAR 对练",
    tag: "INTERVIEW",
    sub: "S-T-A-R 结构化复盘演练",
    vizType: "star",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#22D3EE",
    cmdTitle: "interview.star_chain(nodes=['S', 'T', 'A', 'R'])",
    cmdDetail: "Builds structured STAR prompts around your verified work",
  },
  {
    id: 19,
    code: "19",
    name: "薪酬测算",
    tag: "DECISION",
    sub: "用户假设模拟 · 非岗位实际待遇承诺",
    vizType: "wagebars",
    latency: "Sim",
    tokens: "—",
    bulletColor: "#F59E0B",
    cmdTitle: "decision.simulate_hourly(tax_assumption=0.88)",
    cmdDetail: "Hypothetical calculator based on user sliders only",
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
// 6. 真实机会库映射（不注入任何演示岗位或虚构指标）
// ============================================================================
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

const STUDIO_STAGE_ZH: Record<Opportunity["application"]["stage"], string> = {
  saved: "已收藏",
  evaluating: "待评估",
  preparing: "准备中",
  applied: "已投递",
  interview: "面试中",
  offer: "Offer",
  rejected: "未通过",
  withdrawn: "已撤回",
};

const STUDIO_WORK_MODE_TEXT: Record<Opportunity["workMode"], readonly [string, string]> = {
  remote: ["远程办公", "Remote"],
  hybrid: ["混合办公", "Hybrid"],
  "on-site": ["现场办公", "On-site"],
  unknown: ["办公方式待核", "Work mode unverified"],
};

const STUDIO_EMP_TEXT: Record<Opportunity["employmentType"], readonly [string, string]> = {
  social: ["社招", "Experienced"],
  campus: ["校招", "New grad"],
  internship: ["实习", "Internship"],
  unknown: ["招聘类型待核", "Type unverified"],
};

const CARD_PALETTES = [
  { gradient: "linear-gradient(135deg, #06B6D4 0%, #0284C7 55%, #1E3A8A 100%)", glow: "rgba(34, 211, 238, 0.42)" },
  { gradient: "linear-gradient(135deg, #F59E0B 0%, #EA580C 55%, #9A3412 100%)", glow: "rgba(245, 158, 11, 0.42)" },
  { gradient: "linear-gradient(135deg, #10B981 0%, #059669 55%, #065F46 100%)", glow: "rgba(16, 185, 129, 0.42)" },
  { gradient: "linear-gradient(135deg, #A855F7 0%, #7E22CE 55%, #3B0764 100%)", glow: "rgba(168, 85, 247, 0.42)" },
] as const;

function companyMonogram(company: string): string {
  const cleaned = company.trim().replace(/[^\p{L}\p{N}]/gu, "");
  return (cleaned.slice(0, 2) || "BM").toUpperCase();
}

function opportunityToPipelineItem(job: Opportunity, index: number, t: Translate): JobPipelineItem {
  const palette = CARD_PALETTES[index % CARD_PALETTES.length]!;
  const city = [job.location.city, job.location.region, job.location.country].filter(Boolean).join(" · ") || t("地点未披露", "Location not disclosed");
  const modePair = STUDIO_WORK_MODE_TEXT[job.workMode];
  const empPair = STUDIO_EMP_TEXT[job.employmentType];
  const stage3D = STUDIO_STAGE_ZH[job.application.stage];
  return {
    id: job.id,
    queueRank: `#${index + 1}`,
    tier: stageLabel(stage3D, t),
    company: job.company,
    shortName: job.company.slice(0, 12),
    logoText: companyMonogram(job.company),
    logoGradient: palette.gradient,
    glowColor: palette.glow,
    role: job.title,
    city,
    salary: job.salaryText || t("未披露", "Not disclosed"),
    annualTotal: job.sourcePlatform || t("来源待核验", "Source unverified"),
    workHours: t(`${modePair[0]} · ${empPair[0]}`, `${modePair[1]} · ${empPair[1]}`),
    sourcePlatform: job.sourcePlatform || t("手动录入 / 待核验", "Manual / unverified"),
    sourceUrl: job.sourceUrl || "",
    description: job.description || "",
    nextAction: job.application.nextAction || t("下一步：核对岗位原文与申请入口", "Next: review original posting and application link"),
    updatedAt: job.updatedAt,
    materialsCount: job.materials.length,
    communicationsCount: job.application.communications.length,
    collectedIn3D: true,
    isNewMint: index === 0,
    stage3D,
    tags: [
      job.sourcePlatform || t("来源待核验", "Source unverified"),
      t(modePair[0], modePair[1]),
      job.employmentType !== "unknown" ? t(empPair[0], empPair[1]) : "",
    ].filter(Boolean),
    sourceJob: job,
  };
}

// ============================================================================
// 7. 内凹微缩蓝图舱 (CNC-Milled Inset Chamber with Living Telemetry Motion)
// ============================================================================
type Translate = (chinese: string, english: string) => string;
const STAGE_TEXT: Record<string, readonly [string, string]> = {
  "已收藏": ["Saved", "Saved"],
  "待评估": ["Evaluating", "Eval"],
  "准备中": ["Preparing", "Prep"],
  "已投递": ["Applied", "Sent"],
  "面试中": ["Interviewing", "Intv"],
  "Offer": ["Offer", "Offer"],
  "未通过": ["Rejected", "Decl"],
  "已撤回": ["Withdrawn", "Wdr"],
  "简历润色中": ["Polishing resume", "Polish"],
  "ATS 核验通过": ["ATS check passed", "ATS ok"],
  "面试攻防准备": ["Interview prep", "Prep"],
};
const stageLabel = (stage: string, t: Translate) => t(stage, STAGE_TEXT[stage]?.[0] ?? stage);

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
            {/* Animated Laser Beam */}
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
            {/* Animated Rotating Radar Sweep Ray */}
            <g style={{ transformOrigin: "24px 17px", animation: "ap-radar-sweep 2.8s linear infinite" }}>
              <line x1="24" y1="17" x2="38" y2="17" stroke={"var(--ap-tone-12)"} strokeWidth="1.6" strokeLinecap="round" />
              <polygon points="24,17 38,13 38,21" fill={"var(--ap-tone-13)"} />
            </g>
            {/* Blinking Target Ping */}
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

// ============================================================================
// 8. 真 3D 立体毛玻璃岗位卡 (CyberJobCard3D)
// ============================================================================
function CyberJobCard3D({
  job,
  agent,
  isFlipped,
  onToggleFlip,
  onInspectInStudio,
  onAnalyze,
  onOpenRecord,
  theme = "dark",
}: {
  job: JobPipelineItem;
  agent: AgentKernelConfig;
  isFlipped: boolean;
  onToggleFlip: () => void;
  onInspectInStudio: (id: string) => void;
  onAnalyze?: (job: Opportunity) => void;
  onOpenRecord?: (id: string) => void;
  theme?: "light" | "dark";
}) {
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
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
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
                  <span className={`px-1.5 py-0.2 rounded font-mono text-[10px] font-bold border ${
                    isLight
                      ? "bg-amber-100 text-amber-900 border-amber-300"
                      : "bg-amber-400/15 text-amber-300 border-amber-400/30"
                  }`}>
                    {job.queueRank} · {stageLabel(job.stage3D, t)}
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
              <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold ${
                isLight ? "bg-emerald-50 text-emerald-800 border-emerald-300" : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
              }`}>
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
          <div style={{ transform: "translateZ(24px)" }} className={`flex items-center justify-between border-b pb-2 gap-2 ${
            isLight ? "border-slate-200" : "border-white/10"
          }`}>
            <div className="flex items-center gap-2 font-mono text-xs font-bold truncate" style={{ color: isLight ? (agent.id === "opus-5.5" ? "#B45309" : agent.primaryHex) : agent.primaryHex }}>
              <StudioRuntimeIcon agentId={agent.id} className="w-5 h-5 shrink-0" />
              <span className="truncate">{job.sourcePlatform}</span>
            </div>
            <span className={`font-mono text-[10px] px-2 py-0.5 rounded border shrink-0 ${
              isLight
                ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
            }`}>
              {stageLabel(job.stage3D, t)}
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
                {t("下一步跟进", "Next follow-up")}
              </div>
              <p className="line-clamp-2 opacity-95">{job.nextAction}</p>
            </div>
            <div className={`p-2.5 rounded-xl border ${
              isLight
                ? "bg-cyan-50 border-cyan-200 text-cyan-950"
                : "bg-cyan-950/35 border-cyan-500/30 text-cyan-100"
            }`}>
              <div className={`font-mono font-bold text-[10.5px] mb-0.5 ${
                isLight ? "text-cyan-800" : "text-cyan-300"
              }`}>
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

// ============================================================================
// 9. 主工作区组件：AutopilotStudioWorkspace
// ============================================================================
export type AutopilotStudioWorkspaceProps = {
  factBase?: FactBase;
  resume?: ProjectedResume;
  projectedResume?: ProjectedResume;
  targetQuery?: string;
  initialOpportunityId?: string;
  onOpenMicroApp?: (app: InstalledMicroApp) => void;
  onOpenOpportunity?: (id: string) => void;
  onOpenOpportunitySources?: () => void;
  onAnalyzeOpportunity?: (job: Opportunity) => void;
  onOpenApp?: (appId: string) => void;
  onNavigateToDraft?: () => void;
  onClose?: () => void;
};

export function AutopilotStudioWorkspace(props: AutopilotStudioWorkspaceProps) {
  const { data: libraryState, mutate } = useSWR("studio:opportunity-library", () => readOpportunityLibrary(), { refreshInterval: 5_000 });
  useEffect(() => {
    const sync = () => { void mutate(); };
    window.addEventListener("betterme:opportunities-updated", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("betterme:opportunities-updated", sync);
      window.removeEventListener("storage", sync);
    };
  }, [mutate]);
  const jobs = libraryState?.library?.jobs ?? [];
  return (
    <AutopilotWorkbenchPrototype
      {...props}
      opportunities={jobs}
      loadingOpportunities={!libraryState}
      opportunityError={libraryState?.error}
      onRefreshOpportunities={() => { void mutate(); }}
    />
  );
}

export function AutopilotWorkbenchPrototype({
  factBase,
  resume,
  projectedResume,
  targetQuery: _targetQuery = "",
  initialOpportunityId,
  opportunities = [],
  loadingOpportunities = false,
  opportunityError = "",
  onRefreshOpportunities,
  onOpenMicroApp,
  onOpenOpportunity,
  onOpenOpportunitySources,
  onAnalyzeOpportunity,
  onOpenApp: _onOpenApp,
  onNavigateToDraft: _onNavigateToDraft,
  onClose: _onClose,
}: AutopilotStudioWorkspaceProps & {
  opportunities?: Opportunity[];
  loadingOpportunities?: boolean;
  opportunityError?: string;
  onRefreshOpportunities?: () => void;
}) {
  const { theme, setTheme, t } = useUiPreferences();

  // 1. 工坊身份跟随系统设置；视觉配色不再决定执行运行时。
  const { selectedRuntime, selectedRuntimeId, ready: runtimeReady, loading: runtimeLoading, online } = useLocalAgentRuntime();
  const runtimeName = selectedRuntime?.name ?? (selectedRuntimeId ? t("所选 Agent 暂不可用", "Selected Agent is unavailable") : t("未配置 Agent", "No Agent configured"));
  const runtimeStatus = runtimeLoading ? t("正在检测", "Detecting") : online === false ? t("Host 未连接", "Host not connected") : runtimeReady ? t("本机可用", "Available locally") : selectedRuntimeId ? t("暂不可用", "Unavailable") : t("待配置", "Needs setup");
  const currentAgent: AgentKernelConfig = {
    ...AGENT_KERNELS["opus-5.5"]!,
    id: selectedRuntimeId || "unconfigured",
    shortName: runtimeName, brandName: runtimeName, fullTitle: runtimeName,
    cliHeaderTitle: runtimeName, cliVersion: selectedRuntime?.version ?? t("版本未提供", "Version not provided"),
    heroBannerPrefix: `${runtimeName} + FACTBASE`, mascotName: runtimeName,
    mascotRole: t("跟随系统设置 · 本机执行入口", "Follows system settings · local run entry"),
    modelSpec: selectedRuntime?.version ?? t("模型由运行时配置", "Model set by the runtime"),
    computeBadge: runtimeStatus, signatureQuote: t("执行入口与系统设置保持一致。", "The run entry matches system settings."),
  };
  const studioNodes = useMemo(() => STUDIO_20_NODES.map(node => node.id === 1
    ? { ...node, name: runtimeName, sub: t(`系统设置 · ${runtimeStatus}`, `System settings · ${runtimeStatus}`) }
    : node), [runtimeName, runtimeStatus, t]);

  // 2. 工作台模式 ('studio' | 'space3d' | 'split')
  const [workspaceMode, setWorkspaceMode] = useState<"studio" | "space3d" | "split">("studio");

  // 3. 20-节点环流履带控制
  const [conveyorShiftMode, setConveyorShiftMode] = useState(true);
  const [autoLoopPlaying, setAutoLoopPlaying] = useState(false);
  const [activeNodeIdx, setActiveNodeIdx] = useState(12); // 默认聚焦 #13 ATS / 版式
  const [terminalTab, setTerminalTab] = useState<"terminal" | "inspector">("terminal");

  // 4. 真实岗位队列与 3D 卡状态
  const jobs = useMemo(() => opportunities.map((job, idx) => opportunityToPipelineItem(job, idx, t)), [opportunities, t]);
  const sourcedJobsCount = useMemo(() => opportunities.filter((job) => Boolean(job.sourceUrl)).length, [opportunities]);

  const [activeJobId, setActiveJobId] = useState<string>(() => initialOpportunityId || opportunities[0]?.id || "");
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

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) || jobs[0] || null, [jobs, activeJobId]);
  const activeNode = studioNodes[activeNodeIdx]!;
  const collected3DJobs = jobs;
  const activeResumeProjection = projectedResume ?? resume;
  const resumeSectionCount = activeResumeProjection?.experiences?.length ?? 0;

  // FactBase claim count & summary
  const claimCount = useMemo(() => {
    let count = 0;
    if (factBase?.experiences) {
      for (const exp of factBase.experiences) count += exp.claims?.length || 0;
    }
    return count;
  }, [factBase]);

  const operatorName = factBase?.profile?.displayName?.zh || factBase?.profile?.displayName?.en || t("本地用户", "Local user");
  const operatorRole = factBase?.profile?.targetRoles?.[0]?.zh || t("职业方向未填写", "Target role not set");

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
    if (!runtimeReady || !autoLoopPlaying || workspaceMode === "space3d") return;
    const timer = setInterval(() => {
      setActiveNodeIdx((prev) => (prev + 1) % STUDIO_20_NODES.length);
    }, 2400);
    return () => clearInterval(timer);
  }, [autoLoopPlaying, workspaceMode, runtimeReady]);

  useEffect(() => { setAutoLoopPlaying(false); }, [selectedRuntimeId, runtimeReady]);

  // 键盘快捷键 (Space 暂停/继续，左右箭头单步)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || (e.target instanceof HTMLElement && e.target.closest("input,textarea,select,button,summary,[contenteditable=true],[role=button],[role=dialog]"))) return;
      if (e.code === "Space") {
        if (!runtimeReady) return;
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
  }, [runtimeReady]);

  // 20 张卡片在 6x6 外环物理槽位坐标映射
  const positionedCards = useMemo(() => {
    const spotlightSlotIndex = 2; // Top Row, Col 3
    return studioNodes.map((node, nodeIndex) => {
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
  }, [activeNodeIdx, conveyorShiftMode, studioNodes]);

  // 中央 CLI 终端滚动结构化树日志
  const visibleTerminalStream = useMemo(() => {
    const list = [];
    for (let offset = -4; offset <= 0; offset++) {
      const idx = (activeNodeIdx + offset + STUDIO_20_NODES.length) % STUDIO_20_NODES.length;
      list.push({
        ...studioNodes[idx]!,
        isCurrent: offset === 0,
      });
    }
    return list;
  }, [activeNodeIdx, studioNodes]);

  // 切换至 3D 机会金库查看已收藏卡片
  const handleOpen3DVault = () => {
    setWorkspaceMode("space3d");
    triggerToast(
      t(`✦ 已切换至 3D 机会金库 (${collected3DJobs.length})`, `Switched to 3D opportunity vault (${collected3DJobs.length})`),
      t("仅展示本地机会库已保存的真实岗位与当前状态。", "Showing only real saved opportunities and current stages from your local library.")
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
    setBuildingStep(t("正在请求本机宿主核对内置模板并编译…", "Asking the local host to check and compile the built-in template…"));
    try {
      const artifact = await buildSandboxedMicroApp({ appId, ...template });
      lease.assert();
      if (pendingBuild.current !== lease) return;
      setBuildingStep(t("宿主检查通过，等待你的运行或固定授权。", "Host check passed; waiting for you to run it or authorize pinning."));
      setPendingArtifact(artifact);
      setBuildStatus("success");
      setIsPermissionModalOpen(true);
    } catch (err) {
      if (lease.signal.aborted || pendingBuild.current !== lease) return;
      setBuildStatus("error");
      triggerToast(t("预设未构建", "Preset not built"), err instanceof Error ? err.message : String(err));
    } finally {
      if (pendingBuild.current === lease) setBuildingAppId(null);
    }
  };

  const handleApproveArtifact = (artifact: BuiltMicroAppArtifact, pinToDock: boolean) => {
    if (!pendingBuild.current || pendingBuild.current.signal.aborted || artifact !== pendingArtifact) return;
    try {
      pendingBuild.current.assert();
      openReviewedPreset(artifact, pinToDock, openArtifact);
      triggerToast(t(`已打开「${artifact.name}」`, `Opened ${artifact.name}`), pinToDock ? t("已按你的授权固定到应用 Dock。", "Pinned to the app Dock as you authorized.") : t("仅本次打开，未写入应用列表。", "Opened this time only; not added to the app list."));
    } catch (err) {
      triggerToast(t("预设未打开", "Preset not opened"), err instanceof Error ? err.message : String(err));
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
        backgroundColor: "var(--ap-tone-28)",
        backgroundImage: `
          ${currentAgent.ambientBg},
          radial-gradient(${"var(--ap-tone-29)"} 1px, transparent 0),
          linear-gradient(to right, ${"var(--ap-tone-30)"} 1px, transparent 1px),
          linear-gradient(to bottom, ${"var(--ap-tone-30)"} 1px, transparent 1px)
        `,
        backgroundSize: "100% 100%, 16px 16px, 64px 64px, 64px 64px",
      }}
      data-theme={theme}
      className={`studio-workshop relative w-full h-full min-h-0 overflow-hidden flex flex-col justify-between select-none transition-colors duration-500 font-sans ${theme === "light" ? "text-slate-900" : "text-slate-100"}`}
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
            <StudioRuntimeIcon agentId={currentAgent.id} className="w-8 h-7" />
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
              backgroundColor: "var(--ap-tone-31)",
              boxShadow: theme === "light" ? "0 4px 14px rgba(0,0,0,0.06)" : "0 10px 28px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.1)",
              borderColor: "var(--ap-tone-32)",
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
            <span className="text-[9px] text-slate-500 uppercase tracking-widest">{t("真实岗位队列", "LIVE OPPORTUNITY QUEUE")}</span>
            <div className={`flex items-center gap-1 p-0.5 rounded-lg ${theme === "light" ? "bg-white border-slate-200" : "bg-[#0A1018] border-[#1B2A3D]"} border`}>
              {jobs.length > 0 ? (
                jobs.slice(0, 4).map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    data-queue-job-id={j.id}
                    onClick={() => {
                      setActiveJobId(j.id);
                      triggerToast(t(`✦ 目标切换：${j.company}`, `Target switched: ${j.company}`), t(`岗位「${j.role}」已载入控制台`, `${j.role} loaded into console`));
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] transition ${
                      activeJob?.id === j.id
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
                ))
              ) : (
                <span className={`px-2 py-0.5 text-[10px] ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                  {t("未接入真实岗位", "No real jobs yet")}
                </span>
              )}
              {onOpenOpportunitySources && (
                <button
                  type="button"
                  onClick={onOpenOpportunitySources}
                  className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                >
                  {t("接入真实岗位", "Connect real opportunities")}
                </button>
              )}
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
              {t("求职全链路自动化工坊", "End-to-end job-search automation studio")}
            </span>
          </h1>

          <div className="text-[10px] tracking-wider flex items-center justify-center gap-2 mt-0.5 font-mono whitespace-nowrap">
            <span className="text-emerald-500 font-bold">{t("20 节点拓扑闭环", "20-node closed loop")}</span>
            <span className="text-slate-400">•</span>
            <span className="text-amber-500 font-bold">{t("事实证据链锚定", "Anchored to a fact evidence chain")}</span>
            <span className="text-slate-400">•</span>
            <span className="text-cyan-500 font-bold">{t("投递后异步挂起", "Async hold after applying")}</span>
            <span className="text-slate-400">•</span>
            <span className="text-purple-500 font-bold">{t("沙箱微应用生态", "Sandboxed micro-app ecosystem")}</span>
          </div>
        </div>

        {/* 右侧：遥测指标舱 + 刷新 + 前往系统设置 + 主题切换 */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 实时真实数据计数胶囊 */}
          <div className={`studio-live-summary hidden md:flex items-center gap-2 px-2.5 py-1.5 rounded-xl border font-mono text-[11px] whitespace-nowrap shrink-0 ${
            theme === "light"
              ? "bg-white border-slate-200 text-slate-700 shadow-sm"
              : "bg-[#0A1018] border-[#1E2E42] text-slate-300"
          }`} aria-label={t("真实数据概览", "Real data summary")}>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className={`w-2 h-2 rounded-full ${jobs.length > 0 ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
              <span className="font-semibold">{jobs.length}{t(" 岗位", " jobs")}</span>
            </span>
            <span className="opacity-30">•</span>
            <span className="text-amber-500 font-semibold shrink-0">{sourcedJobsCount}{t(" 带来源", " sourced")}</span>
            <span className="opacity-30">•</span>
            <span className="text-cyan-500 font-semibold shrink-0">{t(`事实库要点${claimCount}`, `${claimCount} fact claims`)}</span>
          </div>

          {onRefreshOpportunities && (
            <button
              type="button"
              onClick={onRefreshOpportunities}
              className={`px-2.5 py-1.5 rounded-xl border flex items-center gap-1.5 font-mono text-xs font-bold transition ${
                theme === "light"
                  ? "bg-white border-slate-300 text-slate-800 hover:bg-slate-50 shadow-sm"
                  : "bg-[#0A1018] border-[#1E2E42] text-slate-200 hover:bg-[#121c2a]"
              }`}
            >
              <RotateCw className="w-3.5 h-3.5 text-emerald-500" />
              <span>{t("刷新", "Refresh")}</span>
            </button>
          )}

          {/* 系统设置快捷入口 (配置 CLI Agent 与模型) */}
          <button
            type="button"
            onClick={() => openSystemSettings("tools")}
            className={`px-3 py-1.5 rounded-xl border flex items-center gap-1.5 font-mono text-xs font-bold transition hover:scale-[1.02] ${
              theme === "light"
                ? "bg-white border-slate-300 text-slate-800 hover:bg-slate-50 shadow-sm"
                : "bg-[#0A1018] border-[#1E2E42] text-slate-200 hover:bg-[#121c2a]"
            }`}
            title={t("在系统设置中配置本地 CLI Agent 与大模型内核", "Configure local CLI agents and model kernels in System settings")}
          >
            <Sliders className="w-3.5 h-3.5 text-cyan-500" />
            <span>{t("系统设置", "System settings")}</span>
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
            title={theme === "light" ? t("切换深色黑曜石工业风", "Switch to the dark obsidian industrial look") : t("切换浅色钛金风", "Switch to the light titanium look")}
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
            <div hidden={!runtimeReady} data-testid="studio-agent-courier"
              style={{
                top: `${(positionedCards.find((c) => c.isSpotlight)?.slot.row || 1) * 16 - 2}%`,
                left: `${(positionedCards.find((c) => c.isSpotlight)?.slot.col || 3) * 16 - 4}%`,
              }}
              className="pointer-events-none absolute z-40 transition-all duration-700 ease-out flex flex-col items-center"
            >
              <div style={{ animation: "ap-rover-float 2.2s ease-in-out infinite" }}>
                <StudioRuntimeIcon agentId={currentAgent.id} className="w-10 h-10 drop-shadow-[0_4px_14px_rgba(245,158,11,0.6)]" />
              </div>
            </div>

            {/* 20 张外环技能卡片 */}
            {positionedCards.map(({ node, nodeIndex, slot, isSpotlight }) => (
              <button
                type="button"
                aria-pressed={isSpotlight}
                key={node.id}
                data-node-id={node.id}
                aria-label={t(`打开 ${node.code} ${node.name}`, `Open ${node.code} ${node.name}`)}
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
                    ? "var(--ap-tone-12)"
                    : "var(--ap-tone-33)",
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
                    <span>{node.tokens === "—" ? t("按需触发", "On demand") : node.tokens}</span>
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
              </button>
            ))}

            {/* 中央 4x4 控制台/深度工件工作台 */}
            <div
              style={{
                backgroundColor: "var(--ap-tone-34)",
                borderColor: currentAgent.borderAccent,
                boxShadow: `0 24px 70px -16px rgba(0,0,0,0.92), 0 0 32px ${currentAgent.glowRgba}`,
              }}
              className="row-start-2 row-end-6 col-start-2 col-end-6 rounded-2xl border flex flex-col overflow-hidden z-20"
            >
              {/* 控制台顶栏 */}
              <div
                style={{
                  backgroundColor: "var(--ap-tone-35)",
                  borderColor: "var(--ap-tone-36)",
                }}
                className="h-10 px-4 border-b flex items-center justify-between shrink-0 font-mono text-xs select-none"
              >
                {/* 顶栏左侧品牌 */}
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => openSystemSettings("tools")} aria-label={t(`${runtimeName}，打开 Agent 设置`, `${runtimeName}, open Agent settings`)} className="studio-agent-trigger flex items-center gap-1.5 font-bold" style={{ color: theme === "light" ? "#925509" : currentAgent.primaryHex }}>
                    <StudioRuntimeIcon agentId={currentAgent.id} className="w-6 h-6" />
                    <span>{currentAgent.cliHeaderTitle}</span>
                    <Sliders className="w-3 h-3" aria-hidden="true" />
                  </button>

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
                      <span>{t("实时终端树 (CLI)", "Live terminal tree (CLI)")}</span>
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
                      <span>{t("深度工件舱", "Artifact inspector")} (#{activeNode.code})</span>
                    </button>
                  </div>
                </div>

                {/* 顶栏右侧快捷操作 */}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleOpen3DVault}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold font-mono transition flex items-center gap-1 ${
                      theme === "light"
                        ? "text-amber-900 bg-amber-100 border border-amber-300 hover:bg-amber-200"
                        : "text-amber-300 bg-amber-400/15 border border-amber-400/35 hover:bg-amber-400/25"
                    }`}
                  >
                    <Orbit className="w-3 h-3" />
                    <span>{t(`3D 机会金库 (${collected3DJobs.length})`, `3D opportunity vault (${collected3DJobs.length})`)}</span>
                  </button>

                  <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                    <span className={`w-2 h-2 rounded-full ${runtimeReady ? "bg-emerald-400" : "bg-slate-400"}`} />
                    <span role="status">{runtimeStatus}</span>
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
                        backgroundColor: "var(--ap-tone-37)",
                        borderColor: theme === "light" ? "var(--ap-tone-36)" : currentAgent.borderAccent,
                        boxShadow: theme === "light" ? "0 4px 16px rgba(0,0,0,0.03)" : undefined,
                      }}
                      className="p-4 rounded-xl border flex items-start gap-4"
                    >
                      <StudioRuntimeIcon agentId={currentAgent.id} className="w-14 h-14 shrink-0" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <h2 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-white"
                          }`}>
                            <span>{t("BetterMe Autopilot 工作台", "BetterMe Autopilot workbench")} · {operatorName}</span>
                            <span className={`text-xs px-2 py-0.5 rounded border ${
                              theme === "light"
                                ? "bg-cyan-50 text-cyan-800 border-cyan-300 font-bold"
                                : "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
                            }`}>
                              {t("真实数据模式", "Real data mode")} · {runtimeStatus}
                            </span>
                          </h2>
                          <div className={`flex items-center gap-1 text-[11px] font-bold ${
                            theme === "light"
                              ? "text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200"
                              : "text-emerald-400"
                          }`}>
                            <Lock className="w-3 h-3" />
                            <span>{t(`FactBase ${claimCount} 条要点 · ${resumeSectionCount} 段经历`, `FactBase ${claimCount} claims · ${resumeSectionCount} entries`)}</span>
                          </div>
                        </div>

                        <div className={`text-[11px] flex items-center gap-3 flex-wrap ${
                          theme === "light" ? "text-slate-600" : "text-slate-400"
                        }`}>
                          <span>{t("求职角色：", "Target role: ")}{operatorRole}</span>
                          <span>•</span>
                          <span className={theme === "light" ? "text-cyan-800 font-semibold" : "text-cyan-300"}>
                            {t("只读取本地真实机会与经历，零虚构指标", "Reads local opportunities & facts only, zero invented telemetry")}
                          </span>
                        </div>

                        <p className={`text-[11px] pt-1 ${
                          theme === "light" ? "text-slate-700 font-medium" : "text-slate-300/90"
                        }`}>
                          {t("以全网客观事实与本地真实经历，构建无幻觉、端到端闭环的职业工程中枢。", "Builds a hallucination-free, end-to-end career engineering hub from objective facts on the web and your real local experience.")}
                        </p>

                        {/* 系统模型与工具配置指引 */}
                        <div className="pt-2 flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-mono ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                              {t("执行内核：连接系统设置配置的本地 Agent", "Run kernel: connected to configured local Agent")}
                            </span>
                            <button
                              type="button"
                              onClick={() => openSystemSettings("tools")}
                              className="text-[10px] text-cyan-600 hover:text-cyan-500 underline font-bold flex items-center gap-1 font-mono"
                            >
                              <Sliders className="w-2.5 h-2.5" />
                              <span>{t("前往系统设置配置模型与工具", "Configure models and tools in System settings")} &gt;</span>
                            </button>
                          </div>
                          <div className={`text-[10px] font-mono ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                            {t("沙箱边界受控 · 本人确认投递", "Sandboxed runtime · Human-confirmed delivery")}
                          </div>
                        </div>
                      </div>
                    </div>

                    {opportunityError && (
                      <div
                        role="alert"
                        className={`p-3 rounded-xl border text-xs font-mono ${
                          theme === "light"
                            ? "bg-rose-50 border-rose-200 text-rose-800"
                            : "bg-rose-950/30 border-rose-500/35 text-rose-200"
                        }`}
                      >
                        <strong>{t("读取本地机会库失败：", "Failed to read local opportunity library: ")}</strong>
                        <span>{opportunityError}</span>
                      </div>
                    )}

                    {/* 当前聚焦的真实岗位摘要或空状态引导 */}
                    {activeJob ? (
                      <div className="space-y-2.5">
                        <div className={`p-3 rounded-xl border flex items-center justify-between gap-2 flex-wrap ${
                          theme === "light"
                            ? "bg-slate-50 border-slate-200 text-slate-800"
                            : "bg-black/40 border-white/10 text-cyan-300"
                        }`}>
                          <div className={`flex items-center gap-2 font-mono min-w-0 ${
                            theme === "light" ? "text-slate-900 font-semibold" : "text-cyan-300"
                          }`}>
                            <span className="font-bold text-cyan-600">&gt;</span>
                            <span className="truncate">/autopilot --target="{activeJob.company}" --pipeline=real</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setTerminalTab("inspector")}
                            className={`text-[10px] hover:underline flex items-center gap-1 font-mono font-bold shrink-0 ${
                              theme === "light" ? "text-amber-700" : "text-amber-300"
                            }`}
                          >
                            <span>{t(`[展开 #${activeNode.code} 工件]`, `[Expand #${activeNode.code} artifact]`)}</span>
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        </div>

                        {jobs.length > 1 && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {jobs.map((j) => (
                              <button
                                key={j.id}
                                type="button"
                                onClick={() => setActiveJobId(j.id)}
                                className={`px-2 py-1 rounded-lg border text-[10.5px] font-mono transition ${
                                  activeJob.id === j.id
                                    ? "bg-cyan-500 text-slate-950 border-cyan-400 font-bold"
                                    : theme === "light"
                                      ? "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                                      : "bg-white/[0.04] border-white/10 text-slate-300 hover:bg-white/[0.08]"
                                }`}
                              >
                                {j.company} · {j.role}
                              </button>
                            ))}
                          </div>
                        )}

                        <div
                          data-job-id={activeJob.id}
                          className={`p-3.5 rounded-xl border space-y-2 ${
                            theme === "light"
                              ? "bg-white border-slate-200 shadow-sm text-slate-800"
                              : "bg-black/45 border-white/10 text-slate-200"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <div className="min-w-0">
                              <div className={`text-sm font-bold truncate ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                {activeJob.role}
                              </div>
                              <div className={`text-[11px] ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                                {activeJob.company} · {activeJob.sourcePlatform}
                              </div>
                            </div>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                              theme === "light"
                                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                            }`}>
                              {stageLabel(activeJob.stage3D, t)}
                            </span>
                          </div>

                          <div className={`flex flex-wrap gap-2 text-[10.5px] font-mono ${theme === "light" ? "text-slate-600" : "text-slate-300"}`}>
                            <span>{t("地点: ", "Location: ")}{activeJob.city}</span>
                            <span>•</span>
                            <span>{t("薪资: ", "Salary: ")}{activeJob.salary}</span>
                            <span>•</span>
                            <span>{activeJob.workHours}</span>
                            <span>•</span>
                            <span>{t(`材料 ${activeJob.materialsCount} · 沟通 ${activeJob.communicationsCount}`, `Materials ${activeJob.materialsCount} · Comms ${activeJob.communicationsCount}`)}</span>
                          </div>

                          <div className={`text-[11px] ${theme === "light" ? "text-slate-700" : "text-slate-300"}`}>
                            {activeJob.nextAction}
                          </div>

                          <div className="pt-1 flex items-center gap-2 flex-wrap">
                            {onAnalyzeOpportunity && (
                              <button
                                type="button"
                                onClick={() => onAnalyzeOpportunity(activeJob.sourceJob)}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-gradient-to-r from-amber-400 to-cyan-400 text-slate-950 hover:brightness-110 shadow transition"
                              >
                                {t("送入顾问核验", "Run Advisor review")} ➔
                              </button>
                            )}
                            {onOpenOpportunity && (
                              <button
                                type="button"
                                onClick={() => onOpenOpportunity(activeJob.id)}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                                  theme === "light"
                                    ? "bg-slate-100 border-slate-300 text-slate-800 hover:bg-slate-200"
                                    : "bg-white/10 border-white/15 text-slate-100 hover:bg-white/15"
                                }`}
                              >
                                {t("核对岗位记录", "Open saved record")}
                              </button>
                            )}
                            {activeJob.sourceUrl && (
                              <a
                                href={activeJob.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] text-cyan-500 hover:underline font-mono ml-auto"
                              >
                                {t("查看原始发布链接", "Original source URL")} ↗
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : loadingOpportunities ? (
                      <div className={`p-4 rounded-xl border text-xs font-mono ${
                        theme === "light" ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-black/40 border-white/10 text-slate-400"
                      }`}>
                        {t("正在读取本地已保存的真实岗位…", "Loading locally saved opportunities…")}
                      </div>
                    ) : (
                      <div className={`p-4 rounded-xl border space-y-2.5 ${
                        theme === "light" ? "bg-slate-50 border-slate-200 text-slate-700" : "bg-black/45 border-white/10 text-slate-300"
                      }`}>
                        <div className={`text-sm font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                          {t("当前还没有接入真实岗位", "No real opportunities saved yet")}
                        </div>
                        <p className="text-[11px] leading-relaxed opacity-90">
                          {t("本工坊严格只绑定本地真实机会库与 FactBase 事实经历；在保存首批岗位前，不注入任何模拟公司、薪资、ATS 分数或背调结论。", "This studio binds strictly to your saved opportunities and local FactBase—no demo companies, salaries, ATS scores, or synthetic checks are generated.")}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap pt-1">
                          {onOpenOpportunitySources && (
                            <button
                              type="button"
                              onClick={onOpenOpportunitySources}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 shadow transition"
                            >
                              {t("接入真实岗位", "Connect real opportunities")}
                            </button>
                          )}
                          {onRefreshOpportunities && (
                            <button
                              type="button"
                              onClick={onRefreshOpportunities}
                              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                                theme === "light"
                                  ? "bg-white border-slate-300 text-slate-700 hover:bg-slate-100"
                                  : "bg-white/10 border-white/15 text-slate-200 hover:bg-white/15"
                              }`}
                            >
                              {t("刷新机会库", "Refresh library")}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

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
                              type="button"
                              onClick={() => {
                                setActiveNodeIdx(item.id - 1);
                                setTerminalTab("inspector");
                              }}
                              className={`hover:underline font-bold ${
                                theme === "light" ? "text-cyan-700 hover:text-cyan-900" : "text-cyan-400"
                              }`}
                            >
                              {t("[查看工件 ➔]", "[Inspect node ➔]")}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* 深度工件舱 (Inspector) */
                  <div className="space-y-4">
                    {/* Node 11: 简历润色 FactBase 绑定视图 */}
                    {activeNode.id === 11 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b gap-2 flex-wrap ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <Code2 className="w-4 h-4 text-cyan-500" />
                            <span>{t(`结构化 Diff 准备 · 绑定本地 FactBase (${claimCount} 条要点)`, `Structured diff setup · linked to local FactBase (${claimCount} claims)`)}</span>
                          </h3>
                          <span className={`text-[10px] px-2 py-0.5 rounded border ${
                            theme === "light"
                              ? "bg-emerald-100 text-emerald-900 border-emerald-300 font-bold"
                              : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                          }`}>
                            {t("0 虚构参数 · 仅保留事实锚定", "0 invented parameters · grounded in FactBase only")}
                          </span>
                        </div>

                        {activeJob ? (
                          <div className={`p-3.5 rounded-xl border space-y-2.5 ${
                            theme === "light" ? "bg-slate-50 border-slate-200 shadow-sm" : "bg-black/50 border-white/10"
                          }`}>
                            <div className="flex items-center justify-between text-[11px] gap-2 flex-wrap">
                              <span className={`font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                {activeJob.company} · {activeJob.role}
                              </span>
                              <span className="text-cyan-500 font-mono">
                                {t(`已存档材料 ${activeJob.materialsCount} 份 · 当前简历 ${resumeSectionCount} 段经历`, `Archived materials: ${activeJob.materialsCount} · Resume entries: ${resumeSectionCount}`)}
                              </span>
                            </div>
                            <p className={`text-[11px] leading-relaxed ${theme === "light" ? "text-slate-600" : "text-slate-300"}`}>
                              {t("结构化 old -> new 改写 Diff 仅在你将此真实岗位送入本地顾问并完成 FactBase 对齐后生成，此处不预设虚构改写结果。", "Structured old -> new rewrite diffs are produced only after Advisor reviews this saved job against your FactBase; no synthetic rewrites are pre-filled.")}
                            </p>
                            <div className="flex items-center gap-2 flex-wrap pt-1">
                              {onAnalyzeOpportunity && (
                                <button
                                  type="button"
                                  onClick={() => onAnalyzeOpportunity(activeJob.sourceJob)}
                                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                                >
                                  {t("送入顾问生成 Diff 建议", "Send to Advisor for rewrite diffs")}
                                </button>
                              )}
                              {onOpenOpportunity && (
                                <button
                                  type="button"
                                  onClick={() => onOpenOpportunity(activeJob.id)}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                                    theme === "light"
                                      ? "bg-white border-slate-300 text-slate-700 hover:bg-slate-100"
                                      : "bg-white/10 border-white/15 text-slate-200 hover:bg-white/15"
                                  }`}
                                >
                                  {t("查看岗位与已存档材料", "View job & materials")}
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className={`p-3.5 rounded-xl border text-[11px] ${
                            theme === "light" ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-black/40 border-white/10 text-slate-400"
                          }`}>
                            {t("请先保存并选择一个真实岗位，再生成基于 FactBase 的结构化简历润色 Diff。", "Save and select a real opportunity first before generating FactBase-anchored resume diffs.")}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Node 13: ATS / 版式与真实材料体检 */}
                    {activeNode.id === 13 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b gap-2 flex-wrap ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <BookmarkCheck className="w-4 h-4 text-cyan-500" />
                            <span>{t("简历版式与真实投递材料状态", "Resume layout and real application material status")}</span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-emerald-700" : "text-emerald-400"
                          }`}>
                            {t("只展示本地真实计数 · 无预填评分", "Live local counts only · no pre-filled scores")}
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-emerald-700" : "text-emerald-400"}`}>
                              {resumeSectionCount}
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("当前投影简历经历", "Projected resume entries")}
                            </div>
                          </div>
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-cyan-700" : "text-cyan-400"}`}>
                              {claimCount}
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("FactBase 可用事实要点", "Available FactBase claims")}
                            </div>
                          </div>
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-amber-700" : "text-amber-400"}`}>
                              {activeJob ? activeJob.materialsCount : 0}
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("该岗位已存档材料快照", "Archived job snapshots")}
                            </div>
                          </div>
                        </div>

                        <div className={`p-3 rounded-xl border text-[11px] space-y-2 ${
                          theme === "light" ? "bg-slate-50 border-slate-200 text-slate-700" : "bg-[#0B121C] border-[#1E2E42] text-slate-300"
                        }`}>
                          {activeJob ? (
                            <>
                              <div className="font-bold">
                                {activeJob.company} · {activeJob.role}
                              </div>
                              <div>
                                {t("如需核查该岗位的关键词覆盖与版式适配，请送入顾问运行实时比对，不要依赖预设虚假百分比。", "Run Advisor against this saved job to inspect keyword fit and formatting with real execution receipts.")}
                              </div>
                            </>
                          ) : (
                            <div>
                              {t("保存真实岗位并在顾问中心执行分析后，这里会关联对应岗位的材料快照数量。", "Save a real opportunity and analyze it in Advisor to track archived material snapshots here.")}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Node 10: 企业来源与原始链接核对 */}
                    {activeNode.id === 10 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b gap-2 flex-wrap ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <ShieldCheck className="w-4 h-4 text-cyan-500" />
                            <span>
                              {activeJob
                                ? `${activeJob.company} · ${t("来源与原始记录核对", "Source and provenance check")}`
                                : t("企业来源与原始记录核对", "Source and provenance check")}
                            </span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-emerald-700" : "text-emerald-400"
                          }`}>
                            {t("以已保存记录与原链接为准", "Grounded in saved record & source URL")}
                          </span>
                        </div>

                        {activeJob ? (
                          <>
                            <div className="grid grid-cols-2 gap-3 text-[11px]">
                              <div className={`p-3 rounded-xl border ${
                                theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                              }`}>
                                <span className={theme === "light" ? "text-slate-500" : "text-slate-400"}>{t("采集来源平台：", "Source platform: ")}</span>
                                <div className={`font-bold mt-1 ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                  {activeJob.sourcePlatform}
                                </div>
                              </div>
                              <div className={`p-3 rounded-xl border ${
                                theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                              }`}>
                                <span className={theme === "light" ? "text-slate-500" : "text-slate-400"}>{t("地点 / 披露薪资：", "Location / disclosed salary: ")}</span>
                                <div className={`font-bold mt-1 ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                  {activeJob.city} · {activeJob.salary}
                                </div>
                              </div>
                            </div>

                            <div className={`p-3 rounded-xl border text-[11px] ${
                              theme === "light"
                                ? "bg-cyan-50 border-cyan-200 text-cyan-950"
                                : "bg-cyan-950/25 border-cyan-500/30 text-cyan-200"
                            }`}>
                              <div className={`font-bold mb-1 ${theme === "light" ? "text-cyan-800" : "text-cyan-400"}`}>
                                {t("原始发布链接：", "Original posting URL: ")}
                              </div>
                              {activeJob.sourceUrl ? (
                                <a href={activeJob.sourceUrl} target="_blank" rel="noreferrer" className="underline break-all">
                                  {activeJob.sourceUrl}
                                </a>
                              ) : (
                                <p>{t("未附带原始链接；工商信息、劳动仲裁与真伪验证需打开原站点或由用户自行补录。", "No source URL saved yet; verify company registration and original posting manually or link its URL.")}</p>
                              )}
                            </div>

                            <div className={`p-3 rounded-xl border text-[11px] space-y-2 ${
                              theme === "light"
                                ? "bg-slate-50 border-slate-200 text-slate-700"
                                : "bg-black/40 border-white/10 text-slate-300"
                            }`}>
                              <div className="font-bold">
                                {t(`沟通记录 (${activeJob.communicationsCount}) · 下一步跟进：`, `Communications (${activeJob.communicationsCount}) · Next action:`)}
                              </div>
                              <p>{activeJob.nextAction}</p>
                            </div>
                          </>
                        ) : (
                          <div className={`p-3.5 rounded-xl border text-[11px] ${
                            theme === "light" ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-black/40 border-white/10 text-slate-400"
                          }`}>
                            {t("保存真实岗位后，此处会展示其采集来源、发布链接与沟通记录。", "Save a real opportunity to inspect its source platform, original link, and follow-up records here.")}
                          </div>
                        )}
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
                            <span>{t("假设模拟：按税前总包的 88%、每年工作 50 周折算", "Simulated assumption: 88% of the pre-tax package, 50 working weeks a year")}</span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-amber-800" : "text-amber-300"
                          }`}>
                            {t("纯本地假设计算器", "Local hypothetical calculator")}
                          </span>
                        </div>

                        {activeJob && (
                          <div className={`p-2.5 rounded-xl border text-[11px] flex items-center justify-between gap-2 ${
                            theme === "light" ? "bg-slate-50 border-slate-200 text-slate-700" : "bg-black/35 border-white/10 text-slate-300"
                          }`}>
                            <span>{t(`参考岗位 (${activeJob.company}) 披露薪资：`, `Disclosed salary for ${activeJob.company}: `)}</span>
                            <strong>{activeJob.salary}</strong>
                          </div>
                        )}

                        <div
                          style={{
                            backgroundColor: "var(--ap-tone-38)",
                            borderColor: "var(--ap-tone-39)",
                          }}
                          className="p-4 rounded-xl border flex items-center justify-between"
                        >
                          <div>
                            <div className={`text-[10px] ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("折算假设净时薪 (滑块参数 / 每年 50 周)", "Assumed net hourly rate (slider inputs / 50 weeks)")}
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
                              {t(`按每周 ${simWeeklyHours}h 折算`, `Based on ${simWeeklyHours} h/week`)}
                            </span>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("非实际到手收入或岗位待遇承诺", "Not actual take-home pay or a promise of job benefits")}
                            </div>
                          </div>
                        </div>

                        {/* 滑块调节 */}
                        <div className="space-y-3 font-mono text-[11px]">
                          <div>
                            <div className={`flex justify-between mb-1 ${
                              theme === "light" ? "text-slate-700 font-bold" : "text-slate-300"
                            }`}>
                              <span>{t(`月薪 Base: ${simBaseK}k`, `Monthly base: ${simBaseK}k`)}</span>
                              <span className={theme === "light" ? "text-cyan-800" : "text-cyan-400"}>
                                {t(`年总包: ¥${simBaseK * simMonths}k`, `Annual package: ¥${simBaseK * simMonths}k`)}
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
                              <span>{t(`年终月数: ${simMonths} 薪`, `Bonus months: ${simMonths}`)}</span>
                              <span className={theme === "light" ? "text-cyan-800" : "text-cyan-400"}>
                                {simMonths >= 15 ? t("含年终假设", "Includes bonus assumption") : t("基准", "Baseline")}
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
                              <span>{t(`每周假设工作时长: ${simWeeklyHours} 小时/周`, `Assumed weekly hours: ${simWeeklyHours} h/week`)}</span>
                              <span className={theme === "light" ? "text-emerald-700" : "text-emerald-400"}>
                                {t("按滑块假设工时测算", "Calculated from slider hours")}
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
                              <span>{t("内置微应用 · 手工选择预设", "Built-in micro-apps · pick a preset manually")}</span>
                            </h3>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              theme === "light"
                                ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                                : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                            }`}>
                              {t("不调用模型", "No model call")}
                            </span>
                          </div>

                          {/* 3层隔离说明胶囊 */}
                          <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-slate-100 text-slate-700 border-slate-300" : "bg-white/5 text-slate-300 border-white/10"
                            }`}>
                              {t("① 核对内置模板", "1. Check the built-in template")}
                            </span>
                            <span className="text-slate-400">➔</span>
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-cyan-50 text-cyan-800 border-cyan-300" : "bg-cyan-950/40 text-cyan-300 border-cyan-500/30"
                            }`}>
                              {t("② 宿主编译与回执", "2. Host compiles and returns a receipt")}
                            </span>
                            <span className="text-slate-400">➔</span>
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-amber-50 text-amber-800 border-amber-300" : "bg-amber-950/40 text-amber-300 border-amber-500/30"
                            }`}>
                              {t("③ 你批准后打开", "3. Opens after you approve")}
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
                              <div className="font-bold">{t("正在等待内置预设构建回执", "Waiting for the built-in preset build receipt")}</div>
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
                                            {installedApp?.pinnedToDock ? t("已固定到 Dock", "Pinned to Dock") : t("已安装", "Installed")}
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
                                          <span>{t("唤起沙箱", "Launch sandbox")} ➔</span>
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
                                          title={t("请宿主重新核对并编译内置模板", "Ask the host to re-check and compile the built-in template")}
                                        >
                                          {t("重新构建", "Rebuild")}
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
                                            <span>{t("等待宿主回执…", "Waiting for the host receipt…")}</span>
                                          </>
                                        ) : (
                                          <>
                                            <Zap size={12} />
                                            <span>{t("编译并审阅权限", "Compile and review permissions")} ➔</span>
                                          </>
                                        )}
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* 权限范围标签 */}
                                <div className="mt-2 pt-2 border-t flex items-center gap-1.5 flex-wrap text-[10px] font-mono opacity-80 border-black/5 dark:border-white/5">
                                  <Lock size={10} className="text-cyan-500" />
                                  <span className="text-slate-500 dark:text-slate-400">{t("授权边界:", "Authorization boundary:")}</span>
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
                                    {t("运行于隔离 iframe", "Runs in an isolated iframe")}
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
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className={`font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                            #{activeNode.code} {activeNode.name} {t("运行时状态", "runtime status")}
                          </span>
                          <span className={`px-2 py-0.5 rounded text-[10px] ${
                            theme === "light"
                              ? "bg-cyan-100 text-cyan-900 border border-cyan-300 font-bold"
                              : "bg-cyan-400/20 text-cyan-300"
                          }`}>
                            {activeNode.latency} • {activeNode.tokens === "—" ? t("按需触发", "On demand") : activeNode.tokens}
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
                          payload: {JSON.stringify({ skill: activeNode.cmdTitle, target: activeJob?.company ?? null, savedJobs: jobs.length, factBaseClaims: claimCount }, null, 2)}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 控制台底部状态栏 */}
              <div
                style={{
                  backgroundColor: "var(--ap-tone-35)",
                  borderColor: "var(--ap-tone-36)",
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
                  <span>{jobs.length}{t(" 岗位", " jobs")} · FactBase {claimCount}</span>
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
            <div className={`flex items-center justify-between pb-3 border-b gap-2 flex-wrap ${
              theme === "light" ? "border-slate-200" : "border-white/10"
            }`}>
              <div className="font-mono">
                <h2 className={`text-base font-bold flex items-center gap-2 ${
                  theme === "light" ? "text-slate-900" : "text-white"
                }`}>
                  <Orbit className="w-4 h-4 text-cyan-500" />
                  <span>{t(`3D 机会金库 · 立体背调卡册 (${collected3DJobs.length})`, `3D opportunity vault · research card album (${collected3DJobs.length})`)}</span>
                </h2>
                <p className={`text-[11px] ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                  {t("仅展示本地机会库已保存的真实岗位；支持 3D 悬停光影、180° 翻转查看跟进与材料快照，并一键送入顾问。", "Displays only real saved opportunities; hover for 3D lighting, flip 180° for follow-up & materials, or send directly to Advisor.")}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSpace3DLayout(space3DLayout === "grid" ? "carousel" : "grid")}
                  className={`px-3 py-1 rounded-lg text-xs font-mono border transition ${
                    theme === "light"
                      ? "bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200"
                      : "bg-white/[0.05] border-white/10 text-slate-300 hover:text-white"
                  }`}
                >
                  {space3DLayout === "grid" ? t("切换 3D 环视轮播", "Switch to 3D carousel") : t("切换 2x2 网格", "Switch to 2x2 grid")}
                </button>
                <button
                  type="button"
                  onClick={() => setWorkspaceMode("studio")}
                  className="px-3 py-1 rounded-lg text-xs font-mono font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 shadow"
                >
                  {t("返回 20-Node 工坊", "Back to the 20-Node studio")}
                </button>
              </div>
            </div>

            {/* 3D 卡片网格或真实空状态 */}
            {collected3DJobs.length > 0 ? (
              <div className={`grid gap-4 my-auto py-4 ${
                space3DLayout === "carousel"
                  ? "grid-cols-1 md:grid-cols-2 max-w-[920px] mx-auto w-full"
                  : "grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
              }`}>
                {collected3DJobs.map((j) => (
                  <CyberJobCard3D
                    key={j.id}
                    job={j}
                    agent={currentAgent}
                    isFlipped={Boolean(flipped3DMap[j.id])}
                    onToggleFlip={() => setFlipped3DMap((p) => ({ ...p, [j.id]: !p[j.id] }))}
                    onAnalyze={onAnalyzeOpportunity}
                    onOpenRecord={onOpenOpportunity}
                    onInspectInStudio={(id) => {
                      setActiveJobId(id);
                      setWorkspaceMode("studio");
                      triggerToast(t(`✦ 载入工坊：${j.company}`, `Studio loaded: ${j.company}`), t("已载入该真实岗位与执行节点", "Loaded saved opportunity into studio"));
                    }}
                    theme={theme}
                  />
                ))}
              </div>
            ) : (
              <div className={`my-auto mx-auto max-w-lg p-6 rounded-2xl border text-center space-y-3 ${
                theme === "light" ? "bg-white border-slate-200 shadow-sm text-slate-700" : "bg-[#0B121D] border-[#1E2E42] text-slate-300"
              }`}>
                <div className={`text-base font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                  {t("3D 机会金库暂无真实收藏岗位", "No real saved opportunities in the 3D vault yet")}
                </div>
                <p className="text-xs leading-relaxed opacity-85">
                  {t("接入并保存任意真实招聘岗位后，系统会在这里生成对应 3D 机会立体卡，零虚构公司与薪资。", "Save any real job opportunity to see its 3D opportunity card here—no demo companies or fabricated pay are injected.")}
                </p>
                <div className="flex items-center justify-center gap-2 pt-1">
                  {onOpenOpportunitySources && (
                    <button
                      type="button"
                      onClick={onOpenOpportunitySources}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                    >
                      {t("接入真实岗位", "Connect real opportunities")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setWorkspaceMode("studio")}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-bold border transition ${
                      theme === "light" ? "bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200" : "bg-white/10 border-white/15 text-slate-200 hover:bg-white/15"
                    }`}
                  >
                    {t("返回 20-Node 工坊", "Back to the 20-Node studio")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ====================================================================
          3. 底部 CONTROL TRAY & DOCK 栏
         ==================================================================== */}
      <footer
        aria-label={t("工坊控制 Dock", "Studio control Dock")}
        className="studio-dock relative z-30 px-4 pt-1 pb-2 flex items-center justify-between gap-3 shrink-0 font-mono text-xs select-none"
      >
        {/* 左侧：当前循环节点信息 */}
        <div className="studio-dock__panel studio-dock__status flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-bold" style={{ color: currentAgent.primaryHex }}>
            <span>✦</span>
            <span>{currentAgent.shortName}: The loop</span>
          </div>
          <span className={theme === "light" ? "text-slate-600 font-medium" : "text-slate-400"}>
            - #{activeNode.code} {activeNode.name} ({activeNode.tag})
          </span>
        </div>

        {/* 中间：ASCII 进度条与模式切换 */}
        <div className="studio-dock__panel studio-dock__modes hidden md:flex items-center gap-3">
          <div className={`hidden xl:flex items-center gap-2 text-[11px] ${
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
              {t("20-Node 工坊", "20-Node studio")}
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
              {t(`3D 机会金库 (${collected3DJobs.length})`, `3D opportunity vault (${collected3DJobs.length})`)}
            </button>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined" && (window as any).desktopApi?.toggleStarPrompterHud) {
                  (window as any).desktopApi.toggleStarPrompterHud();
                } else {
                  triggerToast(t("🎙 STAR 提词 HUD", "STAR prompter HUD"), t("桌面端专享：全局置顶、毛玻璃半透明、多屏跟随悬浮提词窗 (快捷键 ⌘+Shift+H)", "Desktop only: an always-on-top, frosted translucent prompter window that follows you across screens (shortcut ⌘+Shift+H)"));
                }
              }}
              className={`px-2.5 py-1 rounded text-[10.5px] font-bold flex items-center gap-1.5 transition ${
                theme === "light"
                  ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20"
                  : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
              }`}
              title={t("切换/呼出 STAR 面试全局置顶提词 HUD 悬浮窗 (桌面端快捷键 ⌘+Shift+H)", "Toggle the always-on-top STAR interview prompter HUD (desktop shortcut ⌘+Shift+H)")}
            >
              <Mic className="w-3 h-3 text-emerald-500" />
              <span>{t("STAR 提词 HUD", "STAR prompter HUD")}</span>
            </button>
          </div>
        </div>

        {/* 右侧：步进控制器与 Dock 入口 */}
        <div className="studio-dock__panel studio-dock__controls flex items-center gap-2">
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
              title={t("上一步", "Previous")}
            >
              <SkipBack className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => setAutoLoopPlaying((p) => !p)}
              disabled={!runtimeReady}
              title={runtimeReady ? t("仅预览工序，不执行真实任务", "Preview the process only; no real task is run") : t("请先在系统设置中配置可用 Agent", "Configure an available Agent in System settings first")}
              className={`px-3 py-1 rounded-lg font-bold flex items-center gap-1.5 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                autoLoopPlaying
                  ? "bg-amber-400 text-slate-950 shadow"
                  : theme === "light"
                    ? "bg-slate-200 text-slate-900 border border-slate-300 hover:bg-slate-300"
                    : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {autoLoopPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{!runtimeReady ? t("Agent 未就绪", "Agent not ready") : autoLoopPlaying ? t("预览中", "Previewing") : t("播放工序", "Play process")}</span>
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
              title={t("下一步", "Next")}
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
            {t("履带旋转: ", "Conveyor rotation: ")}{conveyorShiftMode ? "ON" : "OFF"}
          </button>

          {/* 沙箱微应用挂载提示 */}
          <div className={`hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10.5px] ${
            theme === "light"
              ? "bg-slate-100 border-slate-300 text-slate-800"
              : "bg-[#0E1724] border-[#1E2E42] text-slate-300"
          }`}>
            <Layers className="w-3 h-3 text-cyan-500" />
            <span>{t(`已安装微应用 (${installedMicroApps.length})`, `Installed micro-apps (${installedMicroApps.length})`)}</span>
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
