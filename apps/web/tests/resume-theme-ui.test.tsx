import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import { createDemoFactBase, createDefaultResumeView, projectResume, RESUME_THEMES, getResumeTheme, type ResumeView } from "@better-me/core";

const dom = new Window({ url: "http://theme-fixture.invalid" });
const React = await import("react");
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ResumeDesignPanel } = await import("../src/components/ResumeDesignPanel");
const { ResumeThemePanel } = await import("../src/components/ResumeThemePanel");
const { ResumeTemplate, RESUME_TEMPLATES } = await import("../src/components/ResumeTemplate");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
let root: ReturnType<typeof createRoot> | undefined;
async function flush(action: () => void = () => {}) { await act(async () => { action(); await nextTurn(); }); }
afterEach(async () => { if (root) await flush(() => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); });
after(async () => { await dom.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
const base = createDemoFactBase("2026-10-18T00:00:00.000Z");
async function mount(view: ResumeView, full = false, locale: "zh" | "en" = "zh") {
  let current = structuredClone(view);
  const host = dom.document.createElement("main"); dom.document.body.append(host); root = createRoot(host);
  function Harness() {
    const [value, setValue] = React.useState(current);
    const change = (next: ResumeView) => { current = next; setValue(next); };
    return full ? h(ResumeDesignPanel, { view: value, factBase: base, onChange: change }) : h(ResumeThemePanel, { view: value, onChange: patch => change({ ...value, ...patch }) });
  }
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale, theme: "dark", workspaceThemeId: "navy" } }, h(Harness))));
  return () => current;
}
async function click(selector: string) { const node = dom.document.querySelector(selector) as HTMLButtonElement | null; assert.ok(node, selector); await flush(() => node.click()); }
async function clickText(text: string) { const node = [...dom.document.querySelectorAll("button")].find(node => node.textContent === text); assert.ok(node, text); await flush(() => node.click()); }

test("all registered layouts render every theme using the same independent theme contract", () => {
  const view = createDefaultResumeView(base);
  const before = structuredClone(base);
  for (const template of RESUME_TEMPLATES) for (const theme of RESUME_THEMES) {
    const resume = projectResume(base, { ...view, templateId: template.id, themeId: theme.id });
    const html = renderToStaticMarkup(h(ResumeTemplate, { resume, templateId: template.id }));
    assert.ok(html.includes(`data-resume-theme="${theme.id}"`), `${template.id}/${theme.id}`);
    assert.ok(html.includes(`--resume-paper:${theme.tokens.colors.paper}`));
    assert.ok(html.includes(`--resume-accent:${theme.tokens.colors.accent}`));
    assert.ok(html.includes(resume.profile.displayName));
    for (const experience of resume.experiences) for (const claim of experience.claims) assert.ok(html.includes(claim.text), `${template.id} lost factual text`);
  }
  assert.deepEqual(base, before);
});

test("switching themes preserves custom layout, visibility, selection and factual data", async () => {
  const view: ResumeView = { ...createDefaultResumeView(base), themeId: "forest-professional", layout: { accentColor: "#123456", fontFamily: "mono", bodyFontSize: 11.5, pageMargin: 21 }, sectionVisibility: { education: false }, profileVisibility: { email: false }, includedClaimIds: ["retained-claim"], claimSelection: "selected" };
  const before = structuredClone(view); const get = await mount(view);
  await click('[data-resume-theme-choice="editorial-warm"]');
  assert.deepEqual({ ...get(), themeId: before.themeId }, before);
  assert.equal(get().themeId, "editorial-warm");
  assert.equal(dom.document.documentElement.dataset.workspaceTheme, "navy");
  await clickText("采用主题原始配色与字形");
  assert.deepEqual(get().layout, { bodyFontSize: 11.5, pageMargin: 21 });
  assert.deepEqual(get().sectionVisibility, before.sectionVisibility);
  assert.equal(projectResume(base, get()).layout?.accentColor, undefined);
});

test("legacy styling is opt-in and unavailable saved theme IDs are retained", async () => {
  const view = createDefaultResumeView(base);
  const html = renderToStaticMarkup(h(ResumeTemplate, { resume: projectResume(base, view), templateId: "zh-classic" }));
  assert.ok(!html.includes("data-resume-theme="));
  const get = await mount({ ...view, themeId: "future-theme" });
  assert.match(dom.document.body.textContent!, /原选择仍保留/);
  assert.equal(get().themeId, "future-theme");
  await clickText("沿用模板风格");
  assert.equal(get().themeId, undefined);
});

test("template and accent changes keep the selected theme and sparse overrides", async () => {
  const view = { ...createDefaultResumeView(base), themeId: "editorial-warm" };
  const get = await mount(view, true);
  await click('[data-template-choice="en-ats"]');
  assert.equal(get().themeId, "editorial-warm");
  assert.equal(get().templateId, "en-ats");
  await click('[aria-label="主题色 #293c58"]');
  assert.deepEqual(get().layout, { accentColor: "#293c58" });
  assert.equal(get().layout?.fontFamily, undefined);
  await click('[data-resume-theme-choice="corporate-navy"]');
  assert.equal(get().themeId, "corporate-navy");
  assert.deepEqual(get().layout, { accentColor: "#293c58" });
  await clickText("采用主题原始配色与字形");
  const projected = projectResume(base, get());
  const html = renderToStaticMarkup(h(ResumeTemplate, { resume: projected, templateId: "en-ats" }));
  assert.ok(html.includes(`--resume-accent:${getResumeTheme("corporate-navy").tokens.colors.accent}`));
});

test("theme names and capabilities follow UI language independently of output language", async () => {
  const view = { ...createDefaultResumeView(base), templateId: "rendercv-classic", locale: "zh" as const, themeId: "mono-minimal" };
  const get = await mount(view, false, "en");
  assert.match(dom.document.body.textContent!, /Resume themes/);
  assert.match(dom.document.body.textContent!, /retaining its own heading/);
  assert.equal(get().locale, "zh");
});
