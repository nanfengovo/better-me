import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { EditorialFinding } from "../src/lib/resume-editorial-review";

test("manual edition review renders current findings, scrolls the paper and cannot send, store or apply them", async () => {
  const css = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
  const win = new Window({ url: "https://synthetic-writing-review.invalid" });
  const React = await import("react"), { act, createElement: h } = React;
  const originals = new Map<string, PropertyDescriptor | undefined>(); let network = 0, writes = 0, generations = 0;
  for (const [key, value] of Object.entries({
    window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: win.HTMLElement, HTMLTextAreaElement: win.HTMLTextAreaElement, Element: win.Element, Node: win.Node,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    fetch: async () => { network++; throw Error("No network in this isolated test"); },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import("react-dom/client");
  const { ResumeWritingCopilot } = await import("../src/components/ResumeWritingCopilot");
  const host = win.document.createElement("main"); win.document.body.append(host); const root = createRoot(host as unknown as Element);
  const secret = "SYNTHETIC-EPHEMERAL-ADVICE"; const key = "editorial-synthetic";
  const finding: EditorialFinding = { kind: "full-stack", title: "该角色的交付范围", advice: secret, previewAnchor: "experience:synthetic" };
  async function render(sessionKey: string, findings: EditorialFinding[]) {
    await act(async () => root.render(h(ResumeWritingCopilot, {
      sessionKey, editorialFindings: findings, active: true, sources: [],
      config: { provider: "ollama", model: "fixture", temperature: 0, baseUrl: "http://localhost:11434/v1", apiKey: "" },
      onFocus() {}, generate: async () => { generations++; return { rationale: "", questions: [], evidenceQuotes: [] }; },
      onApply: async () => { writes++; return { ok: true, message: "unused" }; },
      children: h("div", { className: "resume-preview-canvas" }, h("div", { "data-preview-anchor": "experience:synthetic" }, "synthetic work entry")),
    })));
  }
  try {
    await render(key, [finding]); assert.equal(host.querySelector("[data-edition-review]"), null);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-agent-guide="writing-check"]')!.click(); });
    const report = host.querySelector("[data-edition-review]")!;
    assert.match(report.textContent!, /全篇写作检查（1）/); assert.ok(report.textContent?.includes(secret));
    assert.equal(host.querySelector(".writing-note"), null, "not a writable annotation");
    const canvas = host.querySelector(".resume-preview-canvas")!;
    const anchor = canvas.querySelector("[data-preview-anchor]")!;
    // Synthetic geometry: exercise the explicit action, not layout fidelity.
    Object.defineProperty(canvas, "clientHeight", { value: 200 }); Object.defineProperty(canvas, "scrollHeight", { value: 900 });
    anchor.getBoundingClientRect = () => new win.DOMRect(0, 560, 200, 70);
    await act(async () => {
      report.querySelector<HTMLButtonElement>("button")!.click();
      await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
    });
    assert.ok(canvas.scrollTop > 400); assert.equal(win.scrollY, 0);
    await render(key, []); assert.match(host.querySelector("[data-edition-review]")!.textContent!, /没有触发/);
    assert.ok(!host.textContent?.includes(secret));
    await render("other-edition", [finding]); assert.equal(host.querySelector("[data-edition-review]"), null);
    const persisted = Array.from({ length: win.localStorage.length }, (_, i) => win.localStorage.getItem(win.localStorage.key(i)!)).join("");
    assert.ok(!persisted.includes(secret)); assert.deepEqual([generations, network, writes], [0, 0, 0]);
  } finally {
    await act(async () => root.unmount()); css.deregister(); await win.happyDOM.abort();
    for (const [key, old] of originals) { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); }
  }
});
