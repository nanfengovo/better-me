import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
  },
});

const dom = new Window({ url: "http://session-auto-speech-fixture.invalid" });
const React = await import("react");
for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  React,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const { AgentAutoSpeechToggle, useAgentSpeech, useSessionAutoSpeech } = await import("../src/components/AgentSpeechControl");
import type { ChatMessage } from "../src/services/agent-client";

async function flush(fn: () => void | Promise<void>) {
  await act(async () => {
    await fn();
    await nextTurn();
    await nextTurn();
  });
}

function Harness({ messages, active, sessionKey }: {
  messages: ChatMessage[];
  active: boolean;
  sessionKey: string;
}) {
  const speech = useAgentSpeech(`harness:${sessionKey}`, active);
  const autoSpeech = useSessionAutoSpeech(messages, speech, active, sessionKey);
  return h(AgentAutoSpeechToggle, { enabled: autoSpeech.enabled, onToggle: autoSpeech.toggle });
}

test("useSessionAutoSpeech defaults off, skips history on enable, plays only new ready replies once, and stops cleanly", async () => {
  const spoken: Array<{ text: string; onstart?: () => void; onend?: () => void }> = [];
  let cancels = 0;
  const engine = {
    getVoices: () => [{ lang: "zh-CN", localService: true }, { lang: "en-US", localService: true }],
    speak: (utterance: typeof spoken[number]) => { spoken.push(utterance); utterance.onstart?.(); },
    cancel: () => { cancels++; },
  };
  Object.defineProperty(dom, "speechSynthesis", { configurable: true, value: engine });
  Object.defineProperty(dom, "SpeechSynthesisUtterance", {
    configurable: true,
    value: class { constructor(readonly text: string) {} },
  });

  dom.document.body.innerHTML = '<main id="root"></main>';
  const root = createRoot(dom.document.getElementById("root")!);
  const history: ChatMessage[] = [
    { id: "h-user", role: "user", content: "Old question" },
    { id: "h-reply", role: "assistant", content: "History reply must never auto-play." },
  ];

  const renderWith = (messages: ChatMessage[], active = true, sessionKey = "resume-1") =>
    flush(() => root.render(h(UiPreferencesProvider, null, h(Harness, { messages, active, sessionKey }))));

  const button = () => dom.document.querySelector<HTMLButtonElement>('[data-testid="agent-auto-speech-toggle"]')!;

  try {
    await renderWith(history);
    assert.equal(button().getAttribute("aria-pressed"), "false");
    assert.equal(spoken.length, 0);

    // Enabling auto-read never replays existing history
    await flush(() => button().click());
    assert.equal(button().getAttribute("aria-pressed"), "true");
    assert.equal(spoken.length, 0);

    // New error reply must not auto-play
    const withError: ChatMessage[] = [...history, { id: "err-1", role: "assistant", content: "⚠️ 请求失败" }];
    await renderWith(withError);
    assert.equal(spoken.length, 0);

    // New complete reply auto-plays once
    const withReady: ChatMessage[] = [
      ...withError,
      {
        id: "new-1",
        role: "assistant",
        content: "这是新的建议回复。",
        meta: {
          provider: "ollama",
          providerLabel: "Ollama",
          model: "fixture",
          source: "agent-host",
          status: "ready",
          completeness: "complete",
          observedAt: "2026-11-18T00:00:00Z",
        },
      },
    ];
    await renderWith(withReady);
    assert.equal(spoken.length, 1);
    assert.match(spoken[0]!.text, /这是新的建议回复/);

    // Re-rendering without new messages never replays
    await renderWith(withReady);
    assert.equal(spoken.length, 1);

    // Switching session resets toggle to OFF and cancels playback
    const cancelsBeforeSwitch = cancels;
    await renderWith(history, true, "resume-2");
    assert.equal(button().getAttribute("aria-pressed"), "false");
    assert.ok(cancels > cancelsBeforeSwitch);

    // Re-enable then disable cancels active reading
    await flush(() => button().click());
    await renderWith([
      ...history,
      {
        id: "new-2",
        role: "assistant",
        content: "第二条回复。",
        meta: {
          provider: "ollama",
          providerLabel: "Ollama",
          model: "fixture",
          source: "agent-host",
          status: "ready",
          completeness: "complete",
          observedAt: "2026-11-18T00:01:00Z",
        },
      },
    ], true, "resume-2");
    assert.equal(spoken.length, 2);
    // Leaving the surface revokes consent, even when it stays mounted.
    await renderWith(history, false, "resume-2");
    const replyMeta = withReady.at(-1)!.meta;
    const awayReply: ChatMessage = { id: "away", role: "assistant", content: "Reply while the panel was closed.", meta: replyMeta };
    await renderWith([...history, awayReply], true, "resume-2");
    assert.equal(button().getAttribute("aria-pressed"), "false");
    assert.equal(spoken.length, 2);
    await flush(() => button().click());
    assert.equal(spoken.length, 2, "no replay on renewed consent");

    Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: "hidden" });
    await flush(() => { dom.document.dispatchEvent(new dom.Event("visibilitychange")); });
    const backgroundReply: ChatMessage = { id: "background", role: "assistant", content: "Reply in a background tab.", meta: replyMeta };
    await renderWith([...history, awayReply, backgroundReply], true, "resume-2");
    assert.equal(button().getAttribute("aria-pressed"), "false");
    assert.equal(spoken.length, 2);
    Reflect.deleteProperty(dom.document, "visibilityState");
    await renderWith([...history, awayReply, backgroundReply], true, "resume-2");
    assert.equal(spoken.length, 2, "no replay on return to the foreground");

    await flush(() => button().click());
    await renderWith([...history, awayReply, backgroundReply, { id: "new-3", role: "assistant", content: "New foreground reply.", meta: replyMeta }], true, "resume-2");
    assert.equal(spoken.length, 3);
    const cancelsBeforeOff = cancels;
    await flush(() => button().click());
    assert.equal(button().getAttribute("aria-pressed"), "false");
    assert.ok(cancels > cancelsBeforeOff);
  } finally {
    Reflect.deleteProperty(dom.document, "visibilityState");
    await flush(() => root.unmount());
    Reflect.deleteProperty(dom, "speechSynthesis");
    Reflect.deleteProperty(dom, "SpeechSynthesisUtterance");
  }
});
