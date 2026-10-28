import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { AgentMessageMeta } from "../src/services/agent-client";

registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
  },
});

const dom = new Window({ url: "http://agent-reply-meta-fixture.invalid" });
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
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { AgentReplyMeta } = await import("../src/components/AgentReplyMeta.tsx");

test("AgentReplyMeta exposes provider, model, source, status and fallback reason in readable text", async () => {
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const meta: AgentMessageMeta = {
    provider: "ollama",
    providerLabel: "Ollama · 本地",
    model: "gemma4:31b-cloud",
    source: "browser-direct",
    status: "fallback",
    observedAt: "2026-10-27T20:15:00.000Z",
    warning: "Agent Host 不可用，已由浏览器直连模型服务。",
  };
  await act(async () => {
    root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "dark" } }, h(AgentReplyMeta, { meta })));
  });
  const content = dom.document.getElementById("fixture")?.textContent ?? "";
  assert.match(content, /Ollama · 本地/);
  assert.match(content, /gemma4:31b-cloud/);
  assert.match(content, /浏览器直连/);
  assert.match(content, /已回退/);
  assert.match(content, /Agent Host 不可用/);
  assert.ok(dom.document.querySelector('[aria-label="回复来源与状态"]'));
  await act(async () => root.unmount());
});

test("AgentReplyMeta marks a missing provenance record as unverifiable instead of implying success", async () => {
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  await act(async () => {
    root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "light" } }, h(AgentReplyMeta, {})));
  });
  const content = dom.document.getElementById("fixture")?.textContent ?? "";
  assert.match(content, /未记录 Provider/);
  assert.match(content, /未记录模型/);
  assert.match(content, /失败/);
  assert.match(content, /没有可验证的模型来源/);
  await act(async () => root.unmount());
});

test("AgentReplyMeta visibly marks a length-limited model answer as incomplete", async () => {
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  const root = createRoot(dom.document.getElementById("fixture")!);
  const meta: AgentMessageMeta = {
    provider: "gemini",
    providerLabel: "Google Gemini",
    model: "gemini-2.5-pro",
    source: "agent-host",
    status: "truncated",
    completeness: "truncated",
    finishReason: "length",
    observedAt: "2026-10-27T20:15:00.000Z",
    warning: "模型输出仍触及长度上限，回复可能不完整；可让 Agent 继续补完。",
  };
  await act(async () => {
    root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "zh", theme: "dark" } }, h(AgentReplyMeta, { meta })));
  });
  const content = dom.document.getElementById("fixture")?.textContent ?? "";
  assert.match(content, /Google Gemini/);
  assert.match(content, /gemini-2.5-pro/);
  assert.match(content, /回复不完整/);
  assert.match(content, /可能不完整/);
  await act(async () => root.unmount());
});
