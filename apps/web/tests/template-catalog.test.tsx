import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import { createDemoFactBase, createDefaultResumeView, projectResume, type FactBase, type ResumeView } from "@better-me/core";
import { RESUME_TEMPLATES, TEMPLATE_SOURCES, getResumeTemplate, getTemplateUiMetadata } from "../src/components/template-catalog.ts";

const dom = new Window({ url: "http://template-catalog-fixture.invalid" });
const React = await import("react");
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element,
  Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement: h, act } = React;
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { ResumeDesignPanel } = await import("../src/components/ResumeDesignPanel.tsx");
let root: ReturnType<typeof createRoot> | undefined;

async function flush(action: () => void = () => {}) {
  await act(async () => { action(); await nextTurn(); });
}
function fixture() {
  const factBase = createDemoFactBase("2000-01-01T00:00:00.000Z");
  factBase.profile.displayName = { zh: "合成模板测试", en: "Synthetic template fixture" };
  const view: ResumeView = {
    ...createDefaultResumeView(factBase, "2000-01-01T00:00:00.000Z"),
    locale: "zh", name: "Synthetic custom view", targetJdId: "fixture-jd",
    sectionOrder: ["education", "experience", "projects", "skills", "summary"],
    sectionVisibility: { projects: false }, profileVisibility: { phone: false, photo: false },
    layout: { accentColor: "#69424c", fontFamily: "mono", bodyFontSize: 12, nameFontSize: 35, headingFontSize: 15, lineHeight: 1.85, sectionSpacing: 31, pageMargin: 23 },
    textStyles: { "profile:displayName:zh": [{ start: 0, end: 2, bold: true, highlight: true, highlightColor: "#86d5ec" }] },
  };
  return { factBase, view };
}
async function renderPanel(factBase: FactBase, view: ResumeView, changes: ResumeView[]) {
  if (!root) {
    dom.document.body.innerHTML = '<main id="fixture"></main>';
    root = createRoot(dom.document.getElementById("fixture")!);
  }
  await flush(() => root!.render(h(UiPreferencesProvider, { initialPreferences: { locale: "en", theme: "dark" } }, h(ResumeDesignPanel, { factBase, view, onChange: next => changes.push(next) }))));
}
function cards() { return [...dom.document.querySelectorAll<HTMLButtonElement>(".template-gallery .template-card")]; }
function byText(selector: string, text: string) {
  const found = [...dom.document.querySelectorAll<HTMLButtonElement>(selector)].find(button => button.textContent?.trim().startsWith(text));
  assert.ok(found, `missing button ${text}`);
  return found;
}
function withoutUpdateTime(view: ResumeView) {
  const copy: Partial<ResumeView> = { ...view };
  delete copy.updatedAt;
  return copy;
}
function factualProjection(factBase: FactBase, view: ResumeView) {
  const copy = { ...projectResume(factBase, view) };
  delete (copy as Partial<typeof copy>).templateId;
  delete copy.layout;
  return copy;
}

afterEach(async () => {
  if (root) await flush(() => root!.unmount());
  root = undefined;
  dom.document.body.replaceChildren(); dom.localStorage.clear();
});
after(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("catalog identifiers and source labels are unique and every external adaptation ships its own permission notice", () => {
  assert.equal(new Set(RESUME_TEMPLATES.map(template => template.id)).size, RESUME_TEMPLATES.length);
  assert.equal(new Set(TEMPLATE_SOURCES.map(source => source.id)).size, TEMPLATE_SOURCES.length);
  for (const template of RESUME_TEMPLATES) {
    const definition = getResumeTemplate(template.id);
    assert.ok(TEMPLATE_SOURCES.some(source => source.id === template.source), template.id);
    for (const locale of ["zh", "en"] as const) {
      const metadata = getTemplateUiMetadata(template.id, locale);
      assert.ok(metadata.name.trim() && metadata.description.trim() && metadata.tag.trim(), `${template.id}/${locale}`);
    }
    assert.match(template.recommended.accentColor, /^#[\da-f]{6}$/i);
    assert.ok(["sans", "serif", "mono"].includes(template.recommended.fontFamily));
    if (template.source === "original") continue;
    assert.match(definition.upstreamUrl!, /^https:\/\/(?:github\.com|gitee\.com)\//);
    assert.match(definition.licensePath!, /^[a-z0-9-]+$/);
    const base = new URL(`../../../templates/licenses/${definition.licensePath}/`, import.meta.url);
    for (const filename of ["LICENSE", "NOTICE.md"]) assert.ok(existsSync(new URL(filename, base)), `${template.id} is missing ${filename}`);
    const permission = readFileSync(new URL("LICENSE", base), "utf8");
    assert.match(permission, /Permission is hereby granted|Permission to use, copy|LaTeX Project Public License|Creative Commons|Attribution-ShareAlike|Apache License/i, `${template.id} must ship the actual license terms`);
    const notice = readFileSync(new URL("NOTICE.md", base), "utf8");
    assert.match(notice, /[\da-f]{40}/i, `${template.id} must retain a pinned source revision`);
  }
});

test("native theme styles do not load external stylesheets, fonts or remote assets", () => {
  const directory = new URL("../src/components/templates/", import.meta.url);
  const names = readdirSync(directory).filter(name => name.endsWith(".css"));
  assert.ok(names.length > 0);
  for (const name of names) {
    const css = readFileSync(new URL(name, directory), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /@import\b|url\s*\(\s*["']?\s*(?:https?:)?\/\//i, name);
    assert.doesNotMatch(css, /@font-face\b/i, `${name} must keep the selected local/system font`);
  }
});

test("the native registry covers the complete pinned JSON Resume catalog and every implemented awesome entry", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../../../templates/jsonresume-catalog-source.json", import.meta.url), "utf8")) as { entries: { slug: string }[] };
  assert.equal(snapshot.entries.length, 65);
  assert.deepEqual(RESUME_TEMPLATES.filter(template => template.source === "jsonresume").map(template => template.id).sort(), snapshot.entries.map(entry => `jsonresume-${entry.slug}`).sort());
  const inventory = JSON.parse(readFileSync(new URL("../../../docs/reports/sources/awesome-template-inventory.json", import.meta.url), "utf8")) as { entryCount: number; entries: { entry: string; status: string; templateIds: string[]; reason: string }[] };
  assert.equal(inventory.entryCount, 31);
  assert.equal(inventory.entries.length, inventory.entryCount);
  for (const entry of inventory.entries) {
    assert.ok(entry.reason.trim(), entry.entry);
    if (entry.status !== "native-adaptation-implemented") continue;
    assert.ok(entry.templateIds.length, entry.entry);
    for (const id of entry.templateIds) assert.ok(RESUME_TEMPLATES.some(template => template.id === id), `${entry.entry}: ${id} is missing`);
  }
});

test("restricted theme license is visible on its card and selected details", async () => {
  const { factBase, view } = fixture();
  view.templateId = "jsonresume-rickosborne";
  await renderPanel(factBase, view, []);
  const details = dom.document.querySelector('[aria-label="Selected template"]')!;
  assert.match(details.textContent!, /Noncommercial use only/);
  assert.match(details.textContent!, /CC BY-NC-SA 4\.0/);
  await flush(() => byText(".template-source-filters button", "JSON Resume").click());
  for (let page = 0; page < 5; page++) await flush(() => byText(".template-pagination button", "Next").click());
  const card = dom.document.querySelector('[data-template-choice="jsonresume-rickosborne"]')!;
  assert.ok(card);
  assert.match(card.querySelector('.template-license-restriction')!.textContent!, /Noncommercial use only/);
  assert.match(card.textContent!, /CC BY-NC-SA 4\.0/);
});

test("all catalog choices and recommended typography leave the projected facts and source objects intact", () => {
  const { factBase, view } = fixture();
  const before = structuredClone({ factBase, view });
  const expected = factualProjection(factBase, view);
  for (const template of RESUME_TEMPLATES) {
    const candidate = { ...view, templateId: template.id, layout: { ...view.layout, ...template.recommended } };
    assert.deepEqual(factualProjection(factBase, candidate), expected, `${template.id} changed factual content`);
  }
  assert.deepEqual({ factBase, view }, before);
});

test("source filters only change catalog visibility and keep the current template and output language", async () => {
  const { factBase, view } = fixture();
  const before = structuredClone({ factBase, view });
  const changes: ResumeView[] = [];
  await renderPanel(factBase, view, changes);
  assert.equal(cards().length, Math.min(12, RESUME_TEMPLATES.length));
  for (const source of TEMPLATE_SOURCES) {
    await flush(() => byText(".template-source-filters button", source.en).click());
    const expected = RESUME_TEMPLATES.filter(template => template.source === source.id);
    const found = new Set<string>();
    for (let page = 0; page < Math.ceil(expected.length / 12); page++) {
      assert.ok(cards().length <= 12);
      for (const card of cards()) found.add(card.getAttribute("data-template-choice")!);
      if (page + 1 < Math.ceil(expected.length / 12)) await flush(() => byText(".template-pagination button", "Next").click());
    }
    assert.deepEqual([...found].sort(), expected.map(template => template.id).sort(), source.id);
    assert.equal(byText(".template-source-filters button", source.en).getAttribute("aria-pressed"), "true");
    assert.match(dom.document.querySelector('[aria-label="Selected template"]')!.textContent!, /Classic/);
  }
  await flush(() => byText(".template-source-filters button", "All").click());
  assert.equal(cards().length, Math.min(12, RESUME_TEMPLATES.length));
  assert.equal(changes.length, 0, "browsing sources must not write a resume view");
  assert.deepEqual({ factBase, view }, before);
});

test("selecting any template only patches its identifier and update timestamp", async () => {
  const { factBase, view } = fixture();
  const before = structuredClone({ factBase, view });
  const changes: ResumeView[] = [];
  await renderPanel(factBase, view, changes);
  for (const template of RESUME_TEMPLATES) {
    let card = cards().find(item => item.getAttribute("data-template-choice") === template.id);
    if (!card) {
      await flush(() => byText(".template-pagination button", "Next").click());
      card = cards().find(item => item.getAttribute("data-template-choice") === template.id);
    }
    assert.ok(card, template.id);
    const count = changes.length;
    await flush(() => card.click());
    assert.equal(changes.length, count + 1);
    const next = changes.at(-1)!;
    assert.deepEqual(withoutUpdateTime(next), withoutUpdateTime({ ...view, templateId: template.id }));
    assert.ok(Number.isFinite(Date.parse(next.updatedAt)));
  }
  assert.deepEqual({ factBase, view }, before);
});

test("recommended color and type require explicit action and preserve the other layout and view settings", async () => {
  const { factBase, view } = fixture();
  const before = structuredClone({ factBase, view });
  for (const template of RESUME_TEMPLATES) {
    const selected = { ...view, templateId: template.id };
    const changes: ResumeView[] = [];
    await renderPanel(factBase, selected, changes);
    assert.equal(changes.length, 0, "opening a template must not automatically apply its recommendation");
    await flush(() => byText(".template-selection-actions button", "Use recommended color & type").click());
    assert.equal(changes.length, 1);
    assert.deepEqual(withoutUpdateTime(changes[0]!), withoutUpdateTime({ ...selected, layout: { ...selected.layout, ...template.recommended } }));
    assert.deepEqual(factualProjection(factBase, changes[0]!), factualProjection(factBase, view));
  }
  assert.deepEqual({ factBase, view }, before);
});
