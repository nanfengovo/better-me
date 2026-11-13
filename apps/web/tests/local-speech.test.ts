import assert from "node:assert/strict";
import test from "node:test";
import { canReadReply, LocalSpeech, speechChunks, speechText } from "../src/lib/local-speech";
import type { ChatMessage } from "../src/services/agent-client";

function reply(provider = "DeepSeek", content = "先确认目标。 Save your checkpoint."): ChatMessage {
  return { id: provider, role: "assistant", content, meta: { provider: provider === "Ollama" ? "ollama" : provider === "Google" ? "gemini" : "openai-compatible",
    providerLabel: provider, model: "synthetic", source: "agent-host", status: "ready", completeness: "complete", observedAt: "2026-11-13T00:00:00Z" } };
}
function fixture(langs: string[] = ["zh-CN", "en-US"]) {
  const utterances: SpeechSynthesisUtterance[] = [];
  let cancels = 0;
  const voices = langs.map(lang => ({ lang, localService: true, name: `synthetic-${lang}` } as SpeechSynthesisVoice));
  // A tempting remote default must never be used, including when local voices are missing.
  voices.unshift({ lang: "zh-CN", localService: false, default: true } as SpeechSynthesisVoice);
  const engine = { getVoices: () => voices, cancel: () => { cancels++; },
    speak: (utterance: SpeechSynthesisUtterance) => { utterances.push(utterance); utterance.onstart?.call(utterance, {} as SpeechSynthesisEvent); } } as unknown as SpeechSynthesis;
  const speech = new LocalSpeech({ engine: () => engine, utterance: text => ({ text } as SpeechSynthesisUtterance) });
  return { speech, utterances, voices, cancels: () => cancels,
    finish: (index: number) => { const item = utterances[index]!; item.onend?.call(item, {} as SpeechSynthesisEvent); } };
}

for (const provider of ["DeepSeek", "Ollama", "OpenAI", "Google"]) {
  test(`${provider} final prose uses local Chinese/English voices only and stops without replay`, () => {
    const f = fixture(), message = reply(provider);
    assert.equal(f.utterances.length, 0, "mount/history restoration cannot speak");
    f.speech.read("owner-A", message);
    assert.equal(f.speech.snapshot().phase, "speaking"); assert.equal(f.utterances[0]!.text, "先确认目标。");
    assert.equal(f.utterances[0]!.voice?.localService, true); assert.equal(f.utterances[0]!.lang, "zh-CN");
    f.finish(0); assert.equal(f.utterances[1]!.text, "Save your checkpoint."); assert.equal(f.utterances[1]!.lang, "en-US");
    f.speech.read("owner-A", message); assert.equal(f.speech.snapshot().phase, "idle"); assert.equal(f.cancels(), 1);
    f.finish(1); assert.equal(f.utterances.length, 2, "late end cannot restart after stop");
  });
}
test("successful provenance is required: errors, fallback, users, truncated and historical unknown replies stay text-only", () => {
  const message = reply();
  for (const invalid of [{ ...message, meta: undefined }, { ...message, role: "user" as const },
    ...(["error", "fallback", "truncated"] as const).map(status => ({ ...message, meta: { ...message.meta!, status } })),
    { ...message, content: '```json\n{"tool":"private"}\n```' }, { ...message, content: '{"tool":"private"}' }]) {
    assert.equal(canReadReply(invalid), false); const f = fixture(); f.speech.read("owner", invalid); assert.equal(f.utterances.length, 0);
  }
});
test("reading excludes reasoning, code, image text, link URLs and markup; Unicode chunks stay bounded", () => {
  assert.equal(speechText('<think>PRIVATE_REASONING</think>\n# **Hello** [guide](https://secret.invalid)\n```ts\nPRIVATE_CODE\n```\n![PRIVATE_IMAGE](x)\nNext.'), "Hello guide Next.");
  assert.equal(speechText("<analysis>PRIVATE_UNFINISHED"), "");
  assert.ok(speechChunks("学".repeat(1000)).every(chunk => Array.from(chunk.text).length <= 180));
});
test("missing local language/unsupported environment fails closed and never starts remotely", () => {
  const f = fixture(["en-US"]); f.speech.read("owner", reply());
  assert.equal(f.utterances.length, 0); assert.equal(f.speech.snapshot().issue, "voice_missing");
  const unsupported = new LocalSpeech({ engine: () => undefined, utterance: () => { throw new Error("must not construct"); } });
  unsupported.read("owner", reply()); assert.equal(unsupported.snapshot().issue, "unavailable");
  f.voices.push({ lang: "zh-CN", localService: true } as SpeechSynthesisVoice);
  assert.equal(f.utterances.length, 0, "voices arriving never grant autoplay");
  f.speech.read("owner", reply()); assert.equal(f.utterances.length, 1); f.speech.stop();
});
test("switching replies or owner invalidates old callbacks and only the current owner may stop playback", () => {
  const f = fixture(); f.speech.read("owner-A", reply("DeepSeek")); f.speech.read("owner-B", reply("Google"));
  f.finish(0); assert.equal(f.utterances.length, 2);
  f.speech.stop("owner-A"); assert.equal(f.speech.snapshot().phase, "speaking");
  f.speech.stop("owner-B"); assert.equal(f.speech.snapshot().phase, "idle"); f.finish(1); assert.equal(f.utterances.length, 2);
});
test("engine error stops the queue, returns text and cannot automatically retry", () => {
  const f = fixture(); f.speech.read("owner", reply()); const item = f.utterances[0]!;
  item.onerror?.call(item, {} as SpeechSynthesisErrorEvent); f.finish(0);
  assert.equal(f.speech.snapshot().issue, "failed"); assert.equal(f.speech.snapshot().phase, "idle"); assert.equal(f.utterances.length, 1);
});
test("silent engine startup times out without queuing retries", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const engine = { getVoices: () => f.voices, speak() {}, cancel() {} } as unknown as SpeechSynthesis;
  const speech = new LocalSpeech({ engine: () => engine, utterance: text => ({ text } as SpeechSynthesisUtterance) });
  speech.read("owner", reply()); assert.equal(speech.snapshot().phase, "starting");
  t.mock.timers.tick(10_000); assert.equal(speech.snapshot().issue, "failed"); assert.equal(speech.snapshot().phase, "idle");
});
