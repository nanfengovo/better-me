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
