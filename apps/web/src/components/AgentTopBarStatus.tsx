/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  ChevronDown,
  Settings2,
  RefreshCw,
  ExternalLink,
  Bot,
  Zap,
} from "lucide-react";
import type { LlmConfig } from "@better-me/core";
import { testLlmConnection } from "@better-me/core";
import { useUiPreferences } from "../lib/ui-preferences";
import "./agent-top-bar-status.css";

export type AgentTopBarStatusProps = {
  config: LlmConfig | null;
  active: boolean;
  onNavigateToAgent: () => void;
  onOpenAiConfig: () => void;
};

export type AgentLiveStatus = "ready" | "unconfigured" | "offline" | "probing";

function getShortModelName(model: string = "", provider: string = ""): string {
  const m = model.toLowerCase();
  if (m.includes("deepseek-reasoner")) return "DeepSeek R1";
  if (m.includes("deepseek")) return "DeepSeek";
  if (m.includes("qwen")) return "Qwen 2.5";
  if (m.includes("gemini")) return "Gemini";
  if (m.includes("gpt-4o")) return "GPT-4o";
  if (m.includes("claude")) return "Claude";
  if (m.includes("llama")) return "Llama 3";
  if (provider === "ollama") return "Ollama 本地";
  return model.slice(0, 12) || "大模型";
}

export function AgentTopBarStatus({
  config,
  active,
  onNavigateToAgent,
  onOpenAiConfig,
}: AgentTopBarStatusProps) {
  const { t } = useUiPreferences();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const isConfigured = Boolean(
    config &&
      ((config.provider === "ollama" && config.baseUrl) ||
        (config.apiKey && config.apiKey.trim().length > 0)),
  );

  const [probeStatus, setProbeStatus] = useState<AgentLiveStatus>(
    isConfigured ? "probing" : "unconfigured",
  );
  const [probeMessage, setProbeMessage] = useState<string>("");
  const [lastProbeTime, setLastProbeTime] = useState<string>("");

  const probe = async (currentConfig: LlmConfig | null) => {
    if (!currentConfig || (!currentConfig.apiKey?.trim() && currentConfig.provider !== "ollama")) {
      setProbeStatus("unconfigured");
      setProbeMessage(t("尚未配置大模型 API Key", "API key not configured"));
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProbeStatus("probing");
    setProbeMessage(t("正在探测大模型服务连通性…", "Probing AI service connection…"));

    try {
      const res = await testLlmConnection(currentConfig, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (res.success) {
        setProbeStatus("ready");
        setProbeMessage(res.message || t("服务正常，已就绪", "Service online and ready"));
      } else {
        setProbeStatus("offline");
        setProbeMessage(res.message || t("服务连通失败", "Connection failed"));
      }
      setLastProbeTime(new Date().toLocaleTimeString());
    } catch (err) {
      if (controller.signal.aborted) return;
      setProbeStatus("offline");
      setProbeMessage(err instanceof Error ? err.message : t("网络超时或配置无效", "Timeout or invalid config"));
      setLastProbeTime(new Date().toLocaleTimeString());
    }
  };

  useEffect(() => {
    if (!isConfigured) {
      setProbeStatus("unconfigured");
      setProbeMessage(t("尚未配置大模型 API Key", "API key not configured"));
      return;
    }
    void probe(config);
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [config?.baseUrl, config?.apiKey, config?.model, config?.provider, isConfigured]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [dropdownOpen]);

  const shortModel = getShortModelName(config?.model, config?.provider);

  const statusLabel =
    probeStatus === "ready"
      ? t(`在线 · ${shortModel}`, `Online · ${shortModel}`)
      : probeStatus === "probing"
        ? t("探测中…", "Probing…")
        : probeStatus === "unconfigured"
          ? t("待配置 Key", "Setup Key")
          : t("连接异常", "Offline");

  const statusDotClass =
    probeStatus === "ready"
      ? "dot-ready"
      : probeStatus === "probing"
        ? "dot-probing"
        : probeStatus === "unconfigured"
          ? "dot-unconfigured"
          : "dot-offline";

  const badgeClass =
    probeStatus === "ready"
      ? "badge-ready"
      : probeStatus === "probing"
        ? "badge-probing"
        : probeStatus === "unconfigured"
          ? "badge-unconfigured"
          : "badge-offline";

  const handleMainClick = () => {
    if (probeStatus === "unconfigured") {
      onOpenAiConfig();
    } else {
      onNavigateToAgent();
    }
  };

  return (
    <div className="agent-top-bar-status-container" ref={containerRef}>
      <div
        className={`agent-top-bar-btn-group status-${probeStatus} ${active ? "is-active" : ""}`}
        role="group"
        aria-label={t("AI Agent 助手状态与导航", "AI Agent Status & Navigation")}
      >
        <button
          type="button"
          className="agent-top-bar-main-btn"
          onClick={handleMainClick}
          title={
            probeStatus === "ready"
              ? t(`AI Agent 已就绪（模型: ${config?.model}）· 点击进入工作台`, `AI Agent ready (${config?.model}) · Click to open`)
              : probeStatus === "unconfigured"
                ? t("尚未配置大模型 API Key · 点击立即配置", "API Key unconfigured · Click to setup")
                : t(`AI 连接异常: ${probeMessage} · 点击检查`, `AI offline: ${probeMessage} · Click to check`)
          }
        >
          <div className="agent-status-dot-wrapper">
            <span className={`agent-status-dot ${statusDotClass}`} />
          </div>
          <Sparkles
            size={14}
            className={
              probeStatus === "ready"
                ? "text-emerald-500 animate-pulse"
                : probeStatus === "unconfigured"
                  ? "text-amber-500"
                  : "text-rose-500"
            }
          />
          <span>{t("AI Agent 助手", "AI Agent")}</span>
          <span className={`agent-pill-badge ${badgeClass}`}>{statusLabel}</span>
        </button>

        <button
          type="button"
          className="agent-top-bar-toggle-btn"
          aria-expanded={dropdownOpen}
          aria-label={t("展开 AI Agent 状态与操作", "Toggle AI Agent status & actions")}
          onClick={() => setDropdownOpen((prev) => !prev)}
        >
          <ChevronDown
            size={13}
            style={{
              transform: dropdownOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          />
        </button>
      </div>

      {dropdownOpen && (
        <div className="agent-status-dropdown" role="menu">
          <div className="agent-dropdown-header">
            <div className="agent-dropdown-title">
              <Bot size={15} />
              <span>{t("AI 顾问状态看板", "AI Agent Status Hub")}</span>
            </div>
            <span className={`agent-pill-badge ${badgeClass}`}>
              {probeStatus === "ready"
                ? "🟢 正常"
                : probeStatus === "probing"
                  ? "🔵 探测中"
                  : probeStatus === "unconfigured"
                    ? "🟡 待配置"
                    : "🔴 异常"}
            </span>
          </div>

          <div className="agent-dropdown-info-card">
            <div className="agent-info-row">
              <span>{t("服务提供商", "Provider")}</span>
              <span className="agent-info-val">
                {config?.provider === "ollama"
                  ? "Ollama (本地私有)"
                  : config?.provider === "gemini"
                    ? "Google Gemini"
                    : config?.provider === "openai-compatible"
                      ? "DeepSeek / OpenAI兼容"
                      : "自定义接口"}
              </span>
            </div>
            <div className="agent-info-row">
              <span>{t("驱动模型", "Model")}</span>
              <span className="agent-info-val">{config?.model || "未指定"}</span>
            </div>
            <div className="agent-info-row">
              <span>{t("连通状态", "Health")}</span>
              <span
                className="agent-info-val"
                style={{
                  color:
                    probeStatus === "ready"
                      ? "#10b981"
                      : probeStatus === "unconfigured"
                        ? "#f59e0b"
                        : "#ef4444",
                }}
              >
                {probeMessage || (probeStatus === "ready" ? "连通正常" : "待处理")}
              </span>
            </div>
            {lastProbeTime && (
              <div className="agent-info-row">
                <span>{t("最近探测", "Last Checked")}</span>
                <span className="agent-info-val">{lastProbeTime}</span>
              </div>
            )}
          </div>

          <div className="agent-dropdown-actions">
            <button
              type="button"
              className={`agent-dropdown-btn ${probeStatus === "unconfigured" ? "warning" : "primary"}`}
              onClick={() => {
                setDropdownOpen(false);
                if (probeStatus === "unconfigured") {
                  onOpenAiConfig();
                } else {
                  onNavigateToAgent();
                }
              }}
            >
              {probeStatus === "unconfigured" ? <Zap size={14} /> : <ExternalLink size={14} />}
              <span>
                {probeStatus === "unconfigured"
                  ? t("立即配置 API Key", "Setup API Key Now")
                  : t("进入 AI 顾问多智能体工作台", "Open Agent Workspace")}
              </span>
            </button>

            <button
              type="button"
              className="agent-dropdown-btn"
              onClick={() => {
                setDropdownOpen(false);
                onOpenAiConfig();
              }}
            >
              <Settings2 size={14} />
              <span>{t("修改大模型与 API 配置", "Change AI Settings & Model")}</span>
            </button>

            <button
              type="button"
              className="agent-dropdown-btn"
              disabled={probeStatus === "probing"}
              onClick={() => {
                void probe(config);
              }}
            >
              <RefreshCw
                size={14}
                className={probeStatus === "probing" ? "animate-spin" : ""}
              />
              <span>{t("重新探测服务连通状态", "Re-probe Connection")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
