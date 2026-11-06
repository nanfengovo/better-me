import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window, type HTMLElement } from "happy-dom";
import type { WritingSource } from "../src/lib/resume-copilot";

registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "http://workspace-fixture.invalid" });
const React = await import("react");
let width = 560;
const resize = new Set<() => void>();
class Observer {
  constructor(private callback: () => void) { resize.add(callback); }
  observe() {}
  disconnect() { resize.delete(this.callback); }
}
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return width; } });
dom.document.head.innerHTML = "<style>main{padding:0}</style>";
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, ResizeObserver: Observer,
  getComputedStyle: dom.getComputedStyle.bind(dom), React, IS_REACT_ACT_ENVIRONMENT: true,
  CustomEvent: dom.CustomEvent, requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
})) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
const { createRoot } = await import("react-dom/client");
const { ResizableWorkspace } = await import("../src/components/ResizableWorkspace");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const { focusWritingSource } = await import("../src/lib/resume-writing-observer");
const { writingTargetKey } = await import("../src/lib/resume-copilot");
const source: WritingSource = { label: "合成原文", text: "未发送的合成草稿", targetRef: { kind: "profile_headline", locale: "zh" } };
let root: ReturnType<typeof createRoot> | undefined;
async function render() {
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host as unknown as Element);
  await React.act(async () => root!.render(<UiPreferencesProvider><ResizableWorkspace>
    <div id="resume-editor-panel"><textarea data-writing-key={writingTargetKey(source.targetRef)} aria-label="合成经历草稿" defaultValue="未发送的合成草稿" /></div>
    <div id="resume-preview-panel">合成纸张</div>
  </ResizableWorkspace></UiPreferencesProvider>));
}
afterEach(async () => { await React.act(async () => root?.unmount()); root = undefined; dom.document.body.replaceChildren(); width = 560; dom.localStorage.clear(); });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

test("insufficient workspace width switches editor and preview without replacing the draft DOM", async () => {
  await render();
  const input = dom.document.querySelector("textarea")!;
  const preview = [...dom.document.querySelectorAll("button")].find(button => button.textContent?.includes("预览简历"));
  assert.ok(preview, "a narrow workspace exposes a preview switch instead of squeezing both panes");
  assert.equal(dom.document.querySelector<HTMLElement>("#resume-preview-panel")?.hidden, true);
  await React.act(async () => preview.click());
  assert.equal(dom.document.querySelector<HTMLElement>("#resume-editor-panel")?.hidden, true);
  assert.equal(dom.document.querySelector<HTMLElement>("#resume-preview-panel")?.hidden, false);
  assert.ok(dom.document.querySelector("textarea") === input);
  assert.equal(input.value, "未发送的合成草稿");
  await React.act(async () => { width = 1260; for (const callback of resize) callback(); });
  assert.equal(dom.document.querySelector<HTMLElement>("#resume-editor-panel")?.hidden, false);
  assert.equal(dom.document.querySelector<HTMLElement>("#resume-preview-panel")?.hidden, false);
  assert.ok(dom.document.querySelector("textarea") === input);
  await React.act(async () => { width = 560; for (const callback of resize) callback(); });
  assert.equal(dom.document.querySelector<HTMLElement>("#resume-preview-panel")?.hidden, false, "returning to narrow width retains the chosen view");
});

test("tablet viewport remains single-pane even when both panes could fit", async () => {
  const originalWidth = dom.innerWidth;
  try {
    Object.defineProperty(dom, "innerWidth", { configurable: true, value: 900 });
    width = 868;
    await render();
    const input = dom.document.querySelector("textarea");
    assert.equal(dom.document.querySelector("main")?.getAttribute("data-workspace-layout"), "single");
    await React.act(async () => {
      Object.defineProperty(dom, "innerWidth", { configurable: true, value: 1440 });
      width = 1260;
      for (const callback of resize) callback();
    });
    assert.equal(dom.document.querySelector("main")?.getAttribute("data-workspace-layout"), "split");
    assert.equal(dom.document.querySelector("textarea"), input);
  } finally {
    Object.defineProperty(dom, "innerWidth", { configurable: true, value: originalWidth });
  }
});

test("locating an Agent source leaves preview-only mode and keeps the same unsent editor draft", async () => {
  await render();
  const input = dom.document.querySelector("textarea")!;
  const preview = [...dom.document.querySelectorAll("button")].find(button => button.textContent?.includes("预览简历"))!;
  await React.act(async () => preview.click());
  await React.act(async () => { assert.equal(focusWritingSource(source), true); });
  assert.equal(dom.document.querySelector<HTMLElement>("#resume-editor-panel")?.hidden, false);
  assert.ok(dom.document.querySelector("textarea") === input);
  assert.equal(input.value, "未发送的合成草稿");
});
