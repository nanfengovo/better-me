import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import { createDemoFactBase, createDefaultResumeView, projectResume, scanClaim } from "@better-me/core";
import { createInitialDocument, LocalDocumentHistory, type DocumentVersion, type DocumentFieldChange, type VersionRepository } from "@better-me/storage";

// Exercise real React components with synthetic facts only. CSS has no behavior
// in this DOM fixture; the normal browser build still loads the real stylesheet.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "http://editor-locale-fixture.invalid" });
const React = await import("react");
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element,
  HTMLTextAreaElement: dom.HTMLTextAreaElement, HTMLInputElement: dom.HTMLInputElement,
  Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider, useUiPreferences } = await import("../src/lib/ui-preferences.tsx");
const { ConfirmationProvider, useConfirm } = await import("../src/components/ConfirmationDialog.tsx");
const { FactEditor } = await import("../src/components/FactEditor.tsx");
const { ResumeDesignPanel } = await import("../src/components/ResumeDesignPanel.tsx");
const { ResumePreview } = await import("../src/components/ResumePreview.tsx");
const { IssuesPanel } = await import("../src/components/IssuesPanel.tsx");
const { ImportSourceReview } = await import("../src/components/ImportSourceReview.tsx");
const { formatVersionTime, VersionHistoryPanel } = await import("../src/components/VersionHistoryPanel.tsx");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Locale UI fixtures must never access the network"); };
let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void = () => {}) {
  await act(async () => { action(); await nextTurn(); await nextTurn(); });
}
async function mount(children: React.ReactNode, locale?: "zh" | "en") {
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")!);
  const content = h(ConfirmationProvider, null, children);
  await flush(() => root!.render(locale ? h(UiPreferencesProvider, { initialPreferences: { locale, theme: "light" } }, content) : content));
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(found, `missing button: ${label}`);
  return found;
}
async function click(label: string) { await flush(() => button(label).click()); }
function facts() {
  const factBase = createDemoFactBase("2000-01-01T00:00:00.000Z");
  factBase.profile.displayName = { zh: "合成姓名", en: "Fixture Name" };
  factBase.experiences[0]!.org = { zh: "合成单位", en: "Fixture Organization" };
  return factBase;
}
afterEach(async () => {
  if (root) await flush(() => root!.unmount());
  root = undefined;
  dom.document.body.replaceChildren(); dom.localStorage.clear();
});
after(async () => {
  globalThis.fetch = originalFetch; css.deregister(); await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("default editor remains Chinese and field filtering never writes facts", async () => {
  const factBase = facts(); const before = structuredClone(factBase); let changes = 0;
  await mount(h(FactEditor, { factBase, onChange: () => { changes += 1; } }));
  assert.match(dom.document.body.textContent!, /编辑字段：/);
  assert.match(dom.document.getElementById("editor-fields-help")!.textContent!, /不会翻译内容或更改简历输出语言/);
  await click("仅英文");
  const areas = [...dom.document.querySelectorAll("textarea")];
  assert.ok(areas.some(area => area.value === factBase.experiences[0]!.claims[0]!.text.en));
  assert.ok(areas.every(area => !area.getAttribute("aria-label")?.includes("中文要点")));
  assert.equal(changes, 0); assert.deepEqual(factBase, before);
});

test("selecting resume text offers a source-labelled quote for the Agent without changing facts", async () => {
  const factBase = facts(); let reference: { type: string; text: string; sourceLabel: string } | undefined;
  await mount(h(FactEditor, {
    factBase,
    onChange: () => assert.fail("quoting text must not mutate resume facts"),
    onAskAgentReference: (value: typeof reference) => { reference = value; },
  }));
  const textarea = [...dom.document.querySelectorAll<HTMLTextAreaElement>("textarea")]
    .find(item => item.getAttribute("aria-label")?.includes("中文要点 1"));
  assert.ok(textarea);
  await flush(() => {
    textarea!.focus();
    textarea!.setSelectionRange(0, 5);
    textarea!.dispatchEvent(new dom.Event("mouseup", { bubbles: true }));
  });
  assert.match(dom.document.body.textContent!, /在伴侣中提问/);
  await click("在伴侣中提问");
  assert.equal(reference?.type, "resume_text");
  assert.equal(reference?.text, textarea.value.slice(0, 5));
  assert.match(reference?.sourceLabel ?? "", /简历 ·/);
});

test("English UI translates guidance while preserving Chinese source text and metric state", async () => {
  const factBase = facts(); const experience = factBase.experiences[0]!;
  const claim = experience.claims.find(item => item.metric)!; claim.metric!.confirmed = false;
  const issue = scanClaim(claim, experience.id).find(item => item.code === "metric_unconfirmed")!;
  const before = structuredClone(factBase); let changes = 0;
  await mount(h(FactEditor, {
    factBase, onChange: () => { changes += 1; },
    issueNavigation: { issue, field: "confirmation", requestId: 1 },
  }), "en");
  assert.match(dom.document.body.textContent!, /Editor fields:/);
  assert.match(dom.document.body.textContent!, /Metric not yet verified/);
  assert.match(dom.document.body.textContent!, /Model extraction or field validation cannot replace your own verification/);
  assert.match(dom.document.querySelector(".issue-guide-context")!.textContent!, /合成单位 · Entry \d/);
  assert.ok([...dom.document.querySelectorAll("textarea")].some(area => area.value === claim.text.zh));
  assert.equal(dom.document.querySelector<HTMLInputElement>('input[data-issue-field="confirmation"]')?.checked, false);
  assert.equal(changes, 0); assert.deepEqual(factBase, before);
});

test("changing UI locale preserves the selected editor field language", async () => {
  const factBase = facts(); const before = structuredClone(factBase);
  function Harness() {
    const { setLocale } = useUiPreferences();
    return h(React.Fragment, null, h("button", { onClick: () => setLocale("zh") }, "Switch workspace"), h(FactEditor, { factBase, onChange: () => assert.fail("locale/filter must not write facts") }));
  }
  await mount(h(Harness), "en"); await click("English only");
  const values = [...dom.document.querySelectorAll("textarea")].map(area => area.value);
  await click("Switch workspace");
  assert.match(dom.document.body.textContent!, /编辑字段：/);
  assert.deepEqual([...dom.document.querySelectorAll("textarea")].map(area => area.value), values);
  assert.deepEqual(factBase, before);
});

test("English template gallery changes layout without changing resume output language or facts", async () => {
  const factBase = facts(); const view = createDefaultResumeView(factBase); view.locale = "zh";
  const before = structuredClone({ factBase, view }); const changed: typeof view[] = [];
  await mount(h(ResumeDesignPanel, { factBase, view, onChange: next => { changed.push(next); } }), "en");
  const cards = [...dom.document.querySelectorAll<HTMLButtonElement>(".template-card")];
  assert.equal(cards.length, 12);
  assert.match(cards[0]!.textContent!, /Classic.*Formal applications/);
  assert.match(cards[1]!.title, /Actual ATS parsing still needs verification/);
  assert.ok(cards.every(card => !/[\u3400-\u9fff]/.test(card.textContent! + card.title)));
  await flush(() => cards[2]!.click());
  assert.equal(changed[0]!.templateId, "clean-modern"); assert.equal(changed[0]!.locale, "zh");
  assert.deepEqual({ factBase, view }, before);
});

test("preview toolbar follows UI locale while resume paper keeps its own locale", async () => {
  const factBase = facts(); const view = createDefaultResumeView(factBase); view.locale = "zh";
  const resume = projectResume(factBase, view); const before = structuredClone(resume);
  function Harness() {
    const { setLocale } = useUiPreferences();
    return h(React.Fragment, null, h("button", { onClick: () => setLocale("zh") }, "Switch workspace"), h(ResumePreview, { resume, view }));
  }
  await mount(h(Harness), "en");
  assert.ok(button("Export PDF / Print"));
  assert.equal(dom.document.querySelector("#resume-template option")!.textContent, "Classic");
  const paper = dom.document.querySelector(".resume-document")!;
  assert.match(paper.textContent!, /合成姓名/); assert.match(paper.textContent!, /工作经历/);
  const paperBefore = paper.textContent;
  await click("Switch workspace");
  assert.ok(button("导出 PDF / 打印"));
  assert.equal(dom.document.querySelector(".resume-document")!.textContent, paperBefore);
  assert.deepEqual(resume, before);
});

test("English issue list keeps source claims and navigates using the original issue", async () => {
  const factBase = facts(); const experience = factBase.experiences[0]!;
  const claim = experience.claims.find(item => item.metric)!; claim.metric!.confirmed = false;
  const issue = scanClaim(claim, experience.id).find(item => item.code === "metric_unconfirmed")!;
  const before = structuredClone(factBase); const navigated: typeof issue[] = [];
  await mount(h(IssuesPanel, { factBase, issues: [issue], onNavigate: target => { navigated.push(target); } }), "en");
  await click("Show details");
  assert.match(dom.document.body.textContent!, /Metric not yet verified/);
  assert.match(dom.document.body.textContent!, /合成单位/);
  assert.equal(dom.document.querySelector("li p[title]")!.getAttribute("title"), claim.text.zh);
  await click("Locate and edit: 合成单位, Metric not yet verified");
  assert.equal(navigated[0], issue); assert.deepEqual(factBase, before);
});

test("source evidence and supplied confirmation text remain unchanged in English UI", async () => {
  const source = { fileName: "合成原文.pdf", importedAt: "2026-10-18T00:00:00.000Z", rawText: "合成原文，不翻译。", unparsedLines: ["待核对原句"], ocrText: "未核实转录" };
  const before = structuredClone(source);
  function Ask() {
    const confirm = useConfirm();
    return h("button", { onClick: () => { void confirm("合成操作提示，原样保留"); } }, "Ask");
  }
  await mount(h(React.Fragment, null, h(ImportSourceReview, { source }), h(Ask)), "en");
  assert.match(dom.document.body.textContent!, /Imported source & items to review · 1 section to review/);
  assert.deepEqual([...dom.document.querySelectorAll("pre")].map(node => node.textContent), ["待核对原句", "合成原文，不翻译。", "未核实转录"]);
  await click("Ask");
  assert.equal(dom.document.getElementById("confirmation-title")!.textContent, "Confirm action");
  assert.equal(dom.document.getElementById("confirmation-message")!.textContent, "合成操作提示，原样保留");
  await click("Cancel"); assert.deepEqual(source, before);
});

test("English history timestamps still use Beijing time", () => {
  assert.match(formatVersionTime("2026-10-17T20:10:30.000Z", "en"), /18\/10\/2026, 04:10:30/);
  assert.match(formatVersionTime("2026-10-17T20:10:30.000Z"), /2026\/10\/18 04:10:30/);
});

test("English history translates typed metadata while preserving values, names and restore targets", async () => {
  const current = createInitialDocument("2026-10-18T00:00:00.000Z");
  current.factBase.profile.email = "current@fixture.invalid";
  current.factBase.profile.displayName.zh = "当前姓名含邮箱文字";
  const selected = structuredClone(current);
  selected.factBase.profile.email = "selected@fixture.invalid";
  selected.factBase.profile.displayName.zh = "历史姓名含电话文字";
  const version: DocumentVersion = { id: "locale-fixture-version", kind: "checkpoint", label: "用户命名 · 邮箱与工作经历", createdAt: "2026-10-17T20:10:30.000Z", document: selected };
  const repository: VersionRepository = {
    async list() { return [version]; }, async delete() {}, async putAndPrune() {},
  };
  const received: DocumentFieldChange[] = [];
  const before = structuredClone({ current, selected });
  await mount(h(VersionHistoryPanel, {
    history: new LocalDocumentHistory(repository), currentDocument: current,
    async onRestore() { assert.fail("individual restore must not use full restore"); },
    async onRestoreField(_version, change) { received.push(change); return false; },
    async onCheckpoint() { return true; }, onClose() {},
  }), "en");
  assert.match(dom.document.body.textContent!, /用户命名 · 邮箱与工作经历/);
  assert.match(dom.document.body.textContent!, /18\/10\/2026, 04:10:30/);
  assert.match(dom.document.querySelector('[aria-label="Version differences"]')!.textContent!, /Name.*Email/);
  const details = dom.document.querySelector("details summary")!;
  await flush(() => (details as unknown as HTMLElement).click());
  const emailRow = button("Restore this item: Email").closest("li")!;
  assert.equal(emailRow.querySelector('[aria-label="Current value"]')!.textContent, "current@fixture.invalid");
  assert.equal(emailRow.querySelector('[aria-label="Selected version value"]')!.textContent, "selected@fixture.invalid");
  const nameRow = button("Restore this item: Name (Chinese)").closest("li")!;
  assert.equal(nameRow.querySelector('[aria-label="Current value"]')!.textContent, "当前姓名含邮箱文字");
  assert.equal(nameRow.querySelector('[aria-label="Selected version value"]')!.textContent, "历史姓名含电话文字");
  await click("Restore this item: Email");
  assert.equal(received[0]!.label, "邮箱");
  assert.deepEqual(received[0]!.target, { scope: "profile", field: "email" });
  assert.deepEqual({ current, selected }, before);
});
