import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RESUME_LAYOUT, type ResumeView } from "@better-me/core";
import {
  applyDocumentFieldChange, createInitialDocument, exportDocumentJson, getDocumentFieldChanges,
  LocalDocumentHistory, LocalJsonStore, parseDocumentJson,
  type DocumentFieldTarget, type DocumentVersion, type VersionRepository,
} from "../src/index.ts";

const NOW = "2026-10-18T00:00:00.000Z";
function fixture() {
  const document = createInitialDocument(NOW);
  document.factBase.profile.displayName = { zh: "合成主题测试", en: "Synthetic Theme Test" };
  const view = document.resumeViews[0]!;
  view.themeId = "editorial-warm";
  view.themeOverrides = { colors: { accent: "#112233", paper: "#fffdf8" }, typography: { nameFamily: "mono" }, decoration: { dividerStyle: "dashed" } };
  view.layout = { pageMargin: 18, bodyFontSize: 11 };
  return document;
}
function selected(current: ReturnType<typeof fixture>, historical: ReturnType<typeof fixture>, target: DocumentFieldTarget) {
  const change = getDocumentFieldChanges(current, historical).find((entry) => JSON.stringify(entry.target) === JSON.stringify(target));
  assert.ok(change, `Missing field ${JSON.stringify(target)}`);
  return change;
}
function restored(current: ReturnType<typeof fixture>, change: ReturnType<typeof selected>) {
  const result = applyDocumentFieldChange(current, change, NOW);
  assert.ok(result.ok, result.ok ? undefined : result.message);
  if (!result.ok) throw new Error(result.message);
  return result.document;
}

test("official save, load and JSON backup retain theme identity, independent overrides and unknown IDs", async (t) => {
  const data = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, "localStorage", previous) : Reflect.deleteProperty(globalThis, "localStorage"));
  const document = fixture(), store = new LocalJsonStore("synthetic-theme-document");
  for (const themeId of ["editorial-warm", "future-theme-v2"]) {
    document.resumeViews[0]!.themeId = themeId;
    await store.save(document);
    assert.deepEqual(await store.load(), document);
    assert.deepEqual(parseDocumentJson(exportDocumentJson(document)), document);
  }
  const legacy = createInitialDocument(NOW);
  assert.deepEqual(parseDocumentJson(exportDocumentJson(legacy)), legacy);
  assert.equal(parseDocumentJson(exportDocumentJson(legacy)).resumeViews[0]!.themeId, undefined);
});

test("document validation rejects executable or unsupported theme values without replacing saved data", async (t) => {
  let raw = "";
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => raw || null, setItem: (_key: string, value: string) => { raw = value; } } });
  t.after(() => previous ? Object.defineProperty(globalThis, "localStorage", previous) : Reflect.deleteProperty(globalThis, "localStorage"));
  const document = fixture(), store = new LocalJsonStore("synthetic-theme-validation");
  await store.save(document);
  const invalidValues = [
    { colors: { paper: "url(https://unsafe.invalid)" } },
    { typography: { bodyFamily: "Arial; background: red" } },
    { decoration: { sectionHeading: "arbitrary-css" } },
    { colors: { accent: "#123456", unexpected: "#ffffff" } },
    { bodyFontSize: 14 },
  ];
  for (const invalid of invalidValues) {
    const candidate = structuredClone(document);
    candidate.resumeViews[0]!.themeOverrides = invalid as ResumeView["themeOverrides"];
    assert.throws(() => parseDocumentJson(JSON.stringify(candidate)));
    await assert.rejects(store.save(candidate));
    assert.deepEqual(await store.load(), document);
  }
  const invalidId = structuredClone(document);
  invalidId.resumeViews[0]!.themeId = '<script>alert("theme")</script>';
  assert.throws(() => parseDocumentJson(JSON.stringify(invalidId)));
});

test("version snapshots clone themes and continue to load legacy snapshots", async () => {
  let versions: DocumentVersion[] = [];
  const repository: VersionRepository = {
    async list() { return structuredClone(versions); },
    async putAndPrune(version, limit) { versions = [structuredClone(version), ...versions.filter((item) => item.id !== version.id)].slice(0, limit); },
    async delete(id) { versions = versions.filter((item) => item.id !== id); },
  };
  const history = new LocalDocumentHistory(repository), document = fixture();
  await history.append(createInitialDocument(NOW), "旧版无主题", "checkpoint");
  await history.append(document, "主题快照", "checkpoint");
  document.resumeViews[0]!.themeId = "mono-minimal";
  document.resumeViews[0]!.themeOverrides!.colors!.accent = "#abcdef";
  const loaded = await history.list();
  const themed = loaded.find((item) => item.label === "主题快照")!.document;
  assert.equal(themed.resumeViews[0]!.themeId, "editorial-warm");
  assert.equal(themed.resumeViews[0]!.themeOverrides!.colors!.accent, "#112233");
  assert.equal(loaded.find((item) => item.label === "旧版无主题")!.document.resumeViews[0]!.themeId, undefined);
});

test("theme identity history is readable and restores only identity into the latest document", () => {
  const current = fixture(), historical = structuredClone(current), viewId = current.activeResumeId;
  historical.resumeViews[0]!.themeId = "corporate-navy";
  const changes = getDocumentFieldChanges(current, historical);
  assert.equal(changes.length, 1);
  const change = changes[0]!;
  assert.match(change.label, /简历主题/);
  assert.equal(change.before, "暖调编辑部");
  assert.equal(change.after, "商务藏蓝");
  assert.deepEqual(change.target, { scope: "view", viewId, field: "themeId" });
  const latest = structuredClone(current);
  latest.factBase.profile.phone = "latest-unrelated-contact";
  latest.resumeViews[0]!.templateId = "sidebar";
  latest.resumeViews[0]!.layout!.bodyFontSize = 12;
  latest.resumeViews[0]!.themeOverrides!.colors!.accent = "#445566";
  const expected = structuredClone(latest);
  expected.resumeViews[0]!.themeId = "corporate-navy";
  assert.deepEqual(restored(latest, change), expected);
  assert.equal(latest.resumeViews[0]!.themeId, "editorial-warm");
});

test("theme token restore preserves newer sibling tokens, factual data and layout", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.resumeViews[0]!.themeOverrides!.colors!.accent = "#aabbcc";
  historical.resumeViews[0]!.themeOverrides!.typography!.nameFamily = "serif";
  historical.resumeViews[0]!.themeOverrides!.decoration!.dividerStyle = "none";
  const changes = getDocumentFieldChanges(current, historical);
  assert.equal(changes.length, 3);
  assert.ok(changes.every((change) => change.target.scope === "theme-token"));
  const change = selected(current, historical, { scope: "theme-token", viewId: current.activeResumeId, group: "colors", field: "accent" });
  assert.match(change.before, /#112233/);
  assert.match(change.after, /#aabbcc/);
  assert.ok(changes.some((entry) => entry.after === "衬线字体"));
  assert.ok(changes.some((entry) => entry.after === "无分隔线"));
  const latest = structuredClone(current);
  latest.resumeViews[0]!.themeOverrides!.colors!.paper = "#f0f0f0";
  latest.resumeViews[0]!.layout!.pageMargin = 22;
  latest.factBase.profile.displayName.en = "New unrelated name";
  const expected = structuredClone(latest);
  expected.resumeViews[0]!.themeOverrides!.colors!.accent = "#aabbcc";
  assert.deepEqual(restored(latest, change), expected);
  latest.resumeViews[0]!.themeOverrides!.colors!.accent = "#778899";
  const stale = applyDocumentFieldChange(latest, change);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "stale");
});

test("restoring inherited theme settings removes only that override and unknown IDs remain readable", () => {
  const current = fixture(), historical = structuredClone(current);
  delete historical.resumeViews[0]!.themeOverrides!.typography;
  const change = selected(current, historical, { scope: "theme-token", viewId: current.activeResumeId, group: "typography", field: "nameFamily" });
  assert.equal(change.after, "沿用主题");
  const result = restored(current, change);
  assert.equal(result.resumeViews[0]!.themeOverrides!.typography, undefined);
  assert.deepEqual(result.resumeViews[0]!.themeOverrides!.colors, current.resumeViews[0]!.themeOverrides!.colors);
  const unknown = structuredClone(current);
  unknown.resumeViews[0]!.themeId = "future-theme-v2";
  const identity = selected(current, unknown, { scope: "view", viewId: current.activeResumeId, field: "themeId" });
  assert.equal(identity.after, "未知主题（future-theme-v2）");
  assert.equal(restored(current, identity).resumeViews[0]!.themeId, "future-theme-v2");
  delete unknown.resumeViews[0]!.themeId;
  const legacy = selected(current, unknown, { scope: "view", viewId: current.activeResumeId, field: "themeId" });
  assert.equal(legacy.after, "模板原始样式");
  assert.equal(restored(current, legacy).resumeViews[0]!.themeId, undefined);
});

test("theme layout history distinguishes explicit default overrides from theme inheritance", () => {
  const current = fixture(), historical = structuredClone(current);
  historical.resumeViews[0]!.layout!.accentColor = DEFAULT_RESUME_LAYOUT.accentColor;
  historical.resumeViews[0]!.layout!.fontFamily = DEFAULT_RESUME_LAYOUT.fontFamily;
  const changes = getDocumentFieldChanges(current, historical);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((change) => change.before === "沿用主题" && change.target.scope === "layout"));
  const explicit = selected(current, historical, { scope: "layout", viewId: current.activeResumeId, field: "accentColor" });
  assert.equal(restored(current, explicit).resumeViews[0]!.layout!.accentColor, DEFAULT_RESUME_LAYOUT.accentColor);
  const inherited = selected(historical, current, { scope: "layout", viewId: current.activeResumeId, field: "accentColor" });
  const removed = restored(historical, inherited);
  assert.equal(removed.resumeViews[0]!.layout!.accentColor, undefined);
  assert.equal(removed.resumeViews[0]!.layout!.fontFamily, DEFAULT_RESUME_LAYOUT.fontFamily);
});

test("invalid historical theme tokens cannot be restored even through an unvalidated draft comparison", () => {
  const current = fixture(), invalid = structuredClone(current);
  invalid.resumeViews[0]!.themeOverrides!.colors!.accent = "url(https://unsafe.invalid)";
  const change = selected(current, invalid, { scope: "theme-token", viewId: current.activeResumeId, group: "colors", field: "accent" });
  assert.equal(change.restore.available, false);
  assert.match(change.restore.reason!, /主题设置/);
  assert.equal(applyDocumentFieldChange(current, change).ok, false);
  assert.equal(current.resumeViews[0]!.themeOverrides!.colors!.accent, "#112233");
});
