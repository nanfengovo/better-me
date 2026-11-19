import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Square, Volume2, VolumeX } from "lucide-react";
import type { ChatMessage } from "../services/agent-client";
import { canReadReply, LocalSpeech, type SpeechIssue } from "../lib/local-speech";
import { useUiPreferences } from "../lib/ui-preferences";
import "./agent-speech-control.css";

const controllers = new WeakMap<Window, LocalSpeech>();
function controller() {
  let value = controllers.get(window);
  if (!value) {
    value = new LocalSpeech({ engine: () => window.speechSynthesis,
      utterance: text => new window.SpeechSynthesisUtterance(text) });
    controllers.set(window, value);
  }
  return value;
}

export function useAgentSpeech(scope: string, active: boolean) {
  const speech = useMemo(controller, []);
  const state = useSyncExternalStore(speech.subscribe, speech.snapshot, speech.snapshot);
  useEffect(() => {
    if (!active) { speech.stop(scope); return; }
    const stop = () => speech.stop(scope);
    const visibility = () => { if (document.visibilityState === "hidden") stop(); };
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("pagehide", stop); document.removeEventListener("visibilitychange", visibility); stop(); };
  }, [speech, scope, active]);
  const read = useCallback((message: ChatMessage) => {
    if (active && document.visibilityState !== "hidden") speech.read(scope, message);
  }, [active, scope, speech]);
  const stop = useCallback(() => speech.stop(scope), [scope, speech]);
  return { state, read,
    readText: (id: string, text: string, authorize?: () => Promise<boolean>) => {
      if (active && document.visibilityState !== "hidden") speech.readText(scope, id, text, authorize);
    },
    stop, scope };
}

/** Opt-in per-session auto-read toggle; never persisted and never replays restored history. */
export function useSessionAutoSpeech(
  messages: readonly ChatMessage[],
  speech: ReturnType<typeof useAgentSpeech>,
  active: boolean,
  sessionKey = "",
) {
  const [optedInSession, setOptedInSession] = useState<string | null>(null);
  const enabled = active && optedInSession === sessionKey;
  const seenIdsRef = useRef<Set<string>>(new Set());
  const { read, stop } = speech;

  useEffect(() => {
    setOptedInSession(null);
    if (!active) return;
    const revoke = () => { setOptedInSession(null); stop(); };
    const visibility = () => { if (document.visibilityState === "hidden") revoke(); };
    window.addEventListener("pagehide", revoke);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", revoke);
      document.removeEventListener("visibilitychange", visibility);
      stop();
    };
  }, [active, sessionKey, stop]);

  const toggle = useCallback(() => {
    if (enabled) {
      setOptedInSession(null);
      stop();
    } else if (active && document.visibilityState !== "hidden") {
      seenIdsRef.current = new Set(messages.map((message) => message.id));
      setOptedInSession(sessionKey);
    }
  }, [active, enabled, messages, sessionKey, stop]);

  useEffect(() => {
    if (!enabled || document.visibilityState === "hidden") return;
    let newestPlayable: ChatMessage | undefined;
    for (const message of messages) {
      if (seenIdsRef.current.has(message.id)) continue;
      if (message.role !== "assistant" || message.meta?.status === "error" || message.content.startsWith("⚠️")) {
        seenIdsRef.current.add(message.id);
        continue;
      }
      if (canReadReply(message)) {
        seenIdsRef.current.add(message.id);
        newestPlayable = message;
      }
    }
    if (newestPlayable) read(newestPlayable);
  }, [enabled, messages, read]);

  return { enabled, toggle };
}

export function AgentAutoSpeechToggle({ enabled, onToggle, className = "" }: {
  enabled: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useUiPreferences();
  const label = enabled
    ? t("自动朗读新回复已开", "Auto-read new replies on")
    : t("自动朗读新回复", "Auto-read new replies");
  return (
    <button
      type="button"
      data-testid="agent-auto-speech-toggle"
      className={`agent-auto-speech-toggle ${enabled ? "is-enabled" : ""} ${className}`.trim()}
      aria-label={label}
      aria-pressed={enabled}
      title={t(
        "使用本机音色朗读新到达的完整回复。关闭会话或切到后台后，需重新开启。",
        "Read new, complete replies using a local voice. Turn this on again after closing the conversation or switching away.",
      )}
      onClick={onToggle}
    >
      {enabled ? <Volume2 size={11} aria-hidden="true" /> : <VolumeX size={11} aria-hidden="true" />}
      <span>{enabled ? t("自动朗读: 开", "Auto-read: On") : t("自动朗读", "Auto-read")}</span>
    </button>
  );
}

const issues: Record<SpeechIssue, [string, string]> = {
  unavailable: ["当前环境不支持本机朗读，文字仍可阅读。", "Local speech is unavailable; the text is still here."],
  voice_missing: ["本机音色尚未就绪，或缺少对应语言。请稍后重试或在系统中安装音色；未改用云端。", "Local voices are not ready or this language is missing. Try again shortly or install a local voice. No cloud fallback was used."],
  failed: ["本机朗读未能完成，请重试；未改用云端。", "Local speech could not finish. Try again; no cloud fallback was used."],
  empty: ["这条回复没有可朗读的正文。", "This reply has no readable prose."],
  access_revoked: ["资料权限已撤回或无法核对，朗读已停止。", "Material access was revoked or could not be checked; reading stopped."],
};
export function AgentSpeechControl({ message, speech }: { message: ChatMessage; speech: ReturnType<typeof useAgentSpeech> }) {
  const { t } = useUiPreferences();
  if (!canReadReply(message)) return null;
  const selected = speech.state.key === `${speech.scope}\0${message.id}`;
  const playing = selected && speech.state.phase !== "idle";
  const label = playing ? t("停止朗读", "Stop reading") : t("本机朗读", "Read aloud locally");
  const issue = selected && speech.state.issue;
  return <span className="agent-speech-control">
    <button type="button" className="agent-speech-button" aria-label={label} aria-pressed={playing}
      title={playing ? label : t("只用本机音色朗读这条回复，不发送到云端", "Read this reply using local voices only; nothing is sent to the cloud")}
      onClick={() => speech.read(message)}>
      {playing ? <Square size={12} aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}<span>{label}</span>
    </button>
    {issue && <span className="agent-speech-issue" role="status">{t(...issues[issue])}</span>}
  </span>;
}
