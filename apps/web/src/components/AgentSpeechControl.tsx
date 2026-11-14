import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Square, Volume2 } from "lucide-react";
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
  return { state, read: (message: ChatMessage) => { if (active) speech.read(scope, message); },
    readText: (id: string, text: string, authorize?: () => Promise<boolean>) => { if (active) speech.readText(scope, id, text, authorize); },
    stop: () => speech.stop(scope), scope };
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
