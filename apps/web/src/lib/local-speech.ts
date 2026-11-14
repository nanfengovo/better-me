import type { ChatMessage } from "../services/agent-client";

export type SpeechPhase = "idle" | "starting" | "speaking";
export type SpeechIssue = "unavailable" | "voice_missing" | "failed" | "empty" | "access_revoked";
export type SpeechSnapshot = { phase: SpeechPhase; key?: string; issue?: SpeechIssue };
export type SpeechEnvironment = {
  engine(): SpeechSynthesis | undefined;
  utterance(text: string): SpeechSynthesisUtterance;
};

/** Only successful final visible replies are eligible; role alone also includes errors. */
export function canReadReply(message: ChatMessage): boolean {
  return message.role === "assistant" && message.meta?.status === "ready" &&
    message.meta.completeness !== "empty" && message.meta.completeness !== "truncated" && !!speechText(message.content);
}

/** Keep visible prose, not fenced code, link destinations, markup or reasoning. */
export function speechText(content: string): string {
  const text = content.replace(/<(think|thinking|analysis)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, "")
    .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\1[^\n]*(?:\n|$)|$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~|]/g, "").replace(/\s+/g, " ").trim();
  try { if (typeof JSON.parse(text) === "object") return ""; } catch { /* Prose is expected. */ }
  return text;
}

export function speechChunks(content: string): Array<{ text: string; lang: "zh-CN" | "en-US" }> {
  const sentences = speechText(content).match(/[^。！？.!?\n]+[。！？.!?]?/gu) ?? [];
  return sentences.flatMap(sentence => {
    const points = Array.from(sentence.trim()), chunks = [];
    while (points.length) {
      const text = points.splice(0, 180).join("").trim();
      if (text) chunks.push({ text, lang: /\p{Script=Han}/u.test(text) ? "zh-CN" as const : "en-US" as const });
    }
    return chunks;
  });
}

/** Memory-only, single queue per window. Restoring chat never restores permission to speak. */
export class LocalSpeech {
  private state: SpeechSnapshot = { phase: "idle" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private current?: SpeechSynthesisUtterance;
  private startupTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly environment: SpeechEnvironment) {}
  snapshot = (): SpeechSnapshot => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: SpeechSnapshot) { this.state = state; for (const listener of this.listeners) listener(); }
  stop = (scope?: string): void => {
    if (scope && !this.state.key?.startsWith(`${scope}\0`)) return;
    this.generation++;
    clearTimeout(this.startupTimer);
    this.current = undefined;
    if (this.state.phase !== "idle") this.environment.engine()?.cancel();
    this.publish({ phase: "idle" });
  };
  read = (scope: string, message: ChatMessage): void => {
    if (!canReadReply(message)) return;
    this.readText(scope, message.id, message.content);
  };
  /** Explicit prose reading is also used by selected learning passages/questions.
   * A material grant is checked afresh before each chunk, never persisted. */
  readText = (scope: string, id: string, content: string, authorize?: () => Promise<boolean>): void => {
    const key = `${scope}\0${id}`;
    if (this.state.key === key && this.state.phase !== "idle") { this.stop(); return; }
    this.stop();
    const engine = this.environment.engine();
    if (!engine) { this.publish({ phase: "idle", key, issue: "unavailable" }); return; }
    const chunks = speechChunks(content);
    let voices: SpeechSynthesisVoice[];
    try { voices = engine.getVoices().filter(voice => voice.localService === true); }
    catch { this.publish({ phase: "idle", key, issue: "unavailable" }); return; }
    const planned = chunks.map(chunk => ({ ...chunk, voice: voices.find(voice => voice.lang.toLowerCase() === chunk.lang.toLowerCase()) ??
      voices.find(voice => voice.lang.split(/[-_]/)[0]?.toLowerCase() === chunk.lang.slice(0, 2)) }));
    if (!planned.length || planned.some(chunk => !chunk.voice)) {
      this.publish({ phase: "idle", key, issue: planned.length ? "voice_missing" : "empty" }); return;
    }
    const generation = this.generation;
    const failed = () => {
      if (generation !== this.generation) return;
      this.stop(); this.publish({ phase: "idle", key, issue: "failed" });
    };
    const next = (index: number, authorized = false) => {
      if (generation !== this.generation) return;
      clearTimeout(this.startupTimer);
      const chunk = planned[index];
      if (!chunk) { this.current = undefined; this.publish({ phase: "idle" }); return; }
      if (authorize && !authorized) {
        this.publish({ phase: "starting", key });
        this.startupTimer = setTimeout(failed, 10_000);
        void authorize().then(allowed => {
          if (generation !== this.generation) return;
          if (allowed) next(index, true);
          else { this.stop(); this.publish({ phase: "idle", key, issue: "access_revoked" }); }
        }, () => { if (generation === this.generation) { this.stop(); this.publish({ phase: "idle", key, issue: "access_revoked" }); } });
        return;
      }
      try {
        const utterance = this.environment.utterance(chunk.text);
        utterance.voice = chunk.voice!; utterance.lang = chunk.voice!.lang; utterance.rate = 1;
        utterance.onstart = () => {
          if (generation !== this.generation) return;
          clearTimeout(this.startupTimer); this.publish({ phase: "speaking", key });
        };
        utterance.onend = () => { if (this.current === utterance) next(index + 1); };
        utterance.onerror = failed;
        this.current = utterance; this.publish({ phase: "starting", key });
        this.startupTimer = setTimeout(failed, 10_000);
        engine.speak(utterance);
      } catch { failed(); }
    };
    next(0);
  };
}
