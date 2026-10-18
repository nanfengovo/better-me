import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import type { LlmConfig, ProjectedResume } from "@better-me/core";

const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "http://ui-modal-fixture.invalid" });
const React = await import("react");
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement, Element: dom.Element,
  React, IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider, useUiPreferences } = await import("../src/lib/ui-preferences.tsx");
const { AiConfigModal } = await import("../src/components/AiConfigModal.tsx");
const { JdMatchModal } = await import("../src/components/JdMatchModal.tsx");
const { ResumeImportModal } = await import("../src/components/ResumeImportModal.tsx");
const originalFetch = globalThis.fetch;
const config: LlmConfig = { provider: "openai-compatible", baseUrl: "https://ai-fixture.invalid/v1", apiKey: "synthetic-key", model: "synthetic-model", temperature: 0.3 };
const originalClaim = "为合成设备告警接口编写输入校验与自动化回归测试。";
const resume: ProjectedResume = {
  locale: "zh", templateId: "zh-classic", profile: { displayName: "合成候选人", links: [], targetRoles: [], traits: [] },
  experiences: [{ id: "synthetic-experience", type: "work", org: "合成设备团队", title: "软件工程师", start: "2025-01", end: null, techStack: ["C#"], claims: [{ id: "synthetic-claim", kind: "action", text: originalClaim, tags: [] }] }],
};
const jd = "岗位职责：开发设备告警接口。任职要求：熟悉输入校验与自动化测试。";
let root: ReturnType<typeof createRoot> | undefined;

function Languages() {
  const { setLocale } = useUiPreferences();
  return <><button onClick={() => setLocale("en")}>fixture-en</button><button onClick={() => setLocale("zh")}>fixture-zh</button></>;
}
async function flush(action: () => void | Promise<void> = () => {}) {
  await act(async () => { await action(); await nextTurn(); await nextTurn(); });
}
async function mount(content: React.ReactNode) {
  const host = dom.document.createElement("main"); dom.document.body.append(host); root = createRoot(host);
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale: "en", theme: "light" } }, h(Languages), content)));
}
function button(label: string) {
  const target = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(target, `Missing button: ${label}`); return target;
}
async function click(label: string) { await flush(() => button(label).click()); }
async function editInput(id: string, value: string) {
  const input = dom.document.getElementById(id); assert.ok(input instanceof dom.HTMLInputElement);
  await flush(() => { Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.Event("input", { bubbles: true })); });
}
afterEach(async () => {
  if (root) await flush(() => root!.unmount()); root = undefined;
  dom.document.body.replaceChildren(); dom.localStorage.clear();
  globalThis.fetch = originalFetch;
});
after(() => {
  css.deregister();
  dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test("English AI configuration preserves unsaved model/key and exact saved values across UI language switches", async () => {
  const saved: LlmConfig[] = []; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("No requests expected"); };
  await mount(h(AiConfigModal, { isOpen: true, config, onClose() {}, onSave(value) { saved.push(value); } }));
  assert.match(dom.document.body.textContent ?? "", /AI model configuration/);
  await click("Enter manually");
  await editInput("ai-model", "private-custom-model");
  await editInput("ai-api-key", "private-unsaved-fixture");
  await click("fixture-zh");
  assert.equal((dom.document.getElementById("ai-model") as HTMLInputElement).value, "private-custom-model");
  await click("fixture-en");
  assert.equal((dom.document.getElementById("ai-api-key") as HTMLInputElement).value, "private-unsaved-fixture");
  assert.equal((dom.document.getElementById("ai-api-key") as HTMLInputElement).type, "password");
  await click("Save configuration");
  assert.deepEqual(saved, [{ ...config, model: "private-custom-model", apiKey: "private-unsaved-fixture" }]);
  assert.equal(requests, 0);
});

test("English matching UI sends the original Chinese resume/JD and keeps a pending report through language switching", async () => {
  const snapshot = structuredClone(resume); const bodies: Record<string, unknown>[] = [];
  let finish!: (value: Response) => void;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://ai-fixture.invalid/v1/chat/completions");
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Promise<Response>(resolve => { finish = resolve; });
  };
  await mount(h(JdMatchModal, { isOpen: true, resume, llmConfig: config, initialText: jd, onClose() {}, onOpenConfig() {}, onOpenNetworkSettings() {} }));
  assert.equal((dom.document.getElementById("jd-text") as HTMLTextAreaElement).value, jd);
  await click("Start AI match analysis");
  assert.equal(bodies.length, 1);
  const messages = bodies[0]!.messages as { role: string; content: string }[];
  const user = messages.find(message => message.role === "user")!.content;
  assert.ok(user.includes(JSON.stringify(resume, null, 2)));
  assert.ok(user.endsWith(jd));
  await click("fixture-zh"); await click("fixture-en");
  assert.equal(bodies.length, 1, "UI translation must not restart analysis");
  await flush(() => finish(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ matchScore: 60, scoreSummary: "合成中文报告原文，保持原样。", matchingStrengths: ["合成匹配依据"], missingGaps: [], tailoredSuggestions: [], interviewDefenseTips: ["合成中文追问"] }) } }] }), { headers: { "Content-Type": "application/json" } })));
  assert.match(dom.document.body.textContent ?? "", /AI text reference score/);
  assert.match(dom.document.body.textContent ?? "", /合成中文报告原文，保持原样。/);
  assert.match(dom.document.body.textContent ?? "", /合成中文追问/);
  assert.deepEqual(resume, snapshot);
});

test("English import UI opens without a network request or changing resume/config data", async () => {
  let requests = 0; let imported = false;
  globalThis.fetch = async () => { requests++; throw new Error("No requests expected"); };
  await mount(h(ResumeImportModal, { isOpen: true, llmConfig: config, onClose() {}, onImportSuccess() { imported = true; }, onOpenAiConfig() {} }));
  const content = dom.document.body.textContent ?? "";
  assert.match(content, /Import and structure a resume/);
  assert.match(content, /Browse or drop a resume file here/);
  await click("fixture-zh");
  assert.match(dom.document.body.textContent ?? "", /导入简历与自动结构化/);
  await click("fixture-en");
  assert.equal(requests, 0); assert.equal(imported, false);
});
