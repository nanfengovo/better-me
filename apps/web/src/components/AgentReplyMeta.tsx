/** @jsxRuntime automatic */
import { AlertTriangle, CheckCircle2, CircleSlash2, Cloud, Cpu, HardDrive, Radio, XCircle } from "lucide-react";
import type { AgentMessageMeta } from "../services/agent-client";
import { useUiPreferences } from "../lib/ui-preferences";
import "./agent-reply-meta.css";

export interface AgentReplyMetaProps {
  meta?: AgentMessageMeta;
  /** Keeps the provenance row readable inside narrow drawers. */
  compact?: boolean;
  isDark?: boolean;
}
function providerTone(provider: AgentMessageMeta["provider"]): string {
  if (provider === "ollama") return "ollama";
  if (provider === "gemini") return "gemini";
  if (provider === "openai-compatible") return "openai";
  return "custom";
}

function sourceLabel(source: AgentMessageMeta["source"], t: (zh: string, en: string) => string): string {
  return source === "agent-host"
    ? t("Agent Host", "Agent Host")
    : t("浏览器直连", "Browser direct");
}

function statusLabel(status: AgentMessageMeta["status"], t: (zh: string, en: string) => string): string {
  if (status === "ready") return t("已完成", "Complete");
  if (status === "fallback") return t("已回退", "Fallback");
  if (status === "truncated") return t("回复不完整", "Incomplete reply");
  return t("失败", "Failed");
}

/**
 * A shared, non-colour-only provenance header for model replies.
 * Provider identity, model, execution source and completion state stay separate
 * so a fallback or a partial response cannot look like a successful model run.
 */
export function AgentReplyMeta({ meta, compact = false, isDark = false }: AgentReplyMetaProps) {
  const { t } = useUiPreferences();
  const safeMeta: AgentMessageMeta = meta ?? {
    provider: "custom",
    providerLabel: t("未记录 Provider", "Provider not recorded"),
    model: t("未记录模型", "Model not recorded"),
    source: "browser-direct",
    status: "error",
    observedAt: "",
    warning: t("这条回复没有可验证的模型来源信息。", "This reply has no verifiable model provenance."),
  };
  const statusIcon = safeMeta.status === "ready"
    ? <CheckCircle2 aria-hidden="true" />
    : safeMeta.status === "fallback"
      ? <CircleSlash2 aria-hidden="true" />
      : safeMeta.status === "truncated"
        ? <AlertTriangle aria-hidden="true" />
        : <XCircle aria-hidden="true" />;
  const observed = safeMeta.observedAt ? new Date(safeMeta.observedAt) : undefined;
  const observedLabel = observed && !Number.isNaN(observed.valueOf())
    ? observed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : undefined;

  return (
    <div className={`agent-reply-meta ${compact ? "is-compact" : ""} ${isDark ? "is-dark" : ""}`} aria-label={t("回复来源与状态", "Reply provenance and status")}>
      <span className={`agent-reply-badge agent-reply-provider tone-${providerTone(safeMeta.provider)}`} title={safeMeta.providerLabel}>
        <Cpu aria-hidden="true" />
        <span className="agent-reply-badge-label">{safeMeta.providerLabel}</span>
      </span>
      <span className="agent-reply-badge agent-reply-model" title={safeMeta.model}>
        <span className="agent-reply-badge-kicker">{t("模型", "Model")}</span>
        <span className="agent-reply-badge-label">{safeMeta.model}</span>
      </span>
      <span className="agent-reply-badge agent-reply-source" title={sourceLabel(safeMeta.source, t)}>
        {safeMeta.source === "agent-host" ? <HardDrive aria-hidden="true" /> : <Cloud aria-hidden="true" />}
        <span className="agent-reply-badge-label">{sourceLabel(safeMeta.source, t)}</span>
      </span>
      <span className={`agent-reply-badge agent-reply-status status-${safeMeta.status}`} title={safeMeta.warning || statusLabel(safeMeta.status, t)}>
        {statusIcon}
        <span className="agent-reply-badge-label">{statusLabel(safeMeta.status, t)}</span>
      </span>
      {observedLabel && <time className="agent-reply-observed" dateTime={safeMeta.observedAt}>{observedLabel}</time>}
      {safeMeta.warning && (
        <span className="agent-reply-warning" role="status" title={safeMeta.warning}>
          <AlertTriangle aria-hidden="true" />
          <span>{safeMeta.warning}</span>
        </span>
      )}
      <Radio className="agent-reply-live-mark" aria-hidden="true" />
    </div>
  );
}
