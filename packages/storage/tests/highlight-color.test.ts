import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDocumentFieldChange, createInitialDocument, exportDocumentJson, getDocumentFieldChanges,
  LocalDocumentHistory, LocalJsonStore, parseDocumentJson,
  type DocumentVersion, type VersionRepository,
} from "../src/index.ts";

const KEY = "profile:displayName:zh";
function fixture(color = "#A1B2C3") {
  const document = createInitialDocument("2000-01-01T00:00:00.000Z");
  document.factBase.profile.displayName = { zh: "合成姓名" };
  document.resumeViews[0]!.textStyles = { [KEY]: [{ start: 0, end: 2, highlight: true, highlightColor: color, bold: true }] };
  return document;
}

test("official JSON save/load and backups retain exact highlight color without altering facts", async t => {
  const data = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
  const document = fixture(), originalFacts = structuredClone(document.factBase);
  const store = new LocalJsonStore("synthetic-highlight-document");
  await store.save(document);
  assert.deepEqual((await store.load())!.resumeViews[0]!.textStyles, document.resumeViews[0]!.textStyles);
  const roundtrip = parseDocumentJson(exportDocumentJson(document));
  assert.deepEqual(roundtrip.resumeViews[0]!.textStyles, document.resumeViews[0]!.textStyles);
  assert.deepEqual(roundtrip.factBase, originalFacts);
  const invalid = fixture("url(https://invalid.test)");
  await assert.rejects(store.save(invalid));
  assert.throws(() => parseDocumentJson(JSON.stringify(invalid)));
  assert.deepEqual((await store.load())!.resumeViews[0]!.textStyles, document.resumeViews[0]!.textStyles);
});

test("version history validation and cloning retain colored formatting", async () => {
  let versions: DocumentVersion[] = [];
  const repository: VersionRepository = {
    async list() { return structuredClone(versions); },
    async putAndPrune(version, limit) { versions = [structuredClone(version), ...versions.filter(item => item.id !== version.id)].slice(0, limit); },
    async delete(id) { versions = versions.filter(item => item.id !== id); },
  };
  const history = new LocalDocumentHistory(repository), document = fixture();
  await history.append(document, "合成颜色快照", "checkpoint");
  document.resumeViews[0]!.textStyles![KEY]![0]!.highlightColor = "#112233";
  const [version] = await history.list();
  assert.equal(version!.document.resumeViews[0]!.textStyles![KEY]![0]!.highlightColor, "#A1B2C3");
  assert.equal(version!.document.factBase.profile.displayName.zh, "合成姓名");
});

test("color-only history diff exposes both colors and restores only formatting into latest document", () => {
  const current = fixture("#112233"), historical = fixture("#AABBCC");
  const changes = getDocumentFieldChanges(current, historical);
  assert.equal(changes.length, 1);
  const selected = changes[0]!;
  assert.equal(selected.target.scope, "text-style");
  assert.match(selected.before, /高亮颜色 #112233/);
  assert.match(selected.after, /高亮颜色 #aabbcc/);
  const latest = structuredClone(current);
  latest.factBase.profile.phone = "new unrelated phone";
  const result = applyDocumentFieldChange(latest, selected);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.message);
  assert.equal(result.document.resumeViews[0]!.textStyles![KEY]![0]!.highlightColor, "#AABBCC");
  assert.equal(result.document.factBase.profile.phone, "new unrelated phone");
  assert.equal(result.document.factBase.profile.displayName.zh, current.factBase.profile.displayName.zh);
  assert.deepEqual(result.document.factBase.experiences, current.factBase.experiences);
  assert.equal(latest.resumeViews[0]!.textStyles![KEY]![0]!.highlightColor, "#112233");
  latest.resumeViews[0]!.textStyles![KEY]![0]!.highlightColor = "#445566";
  assert.equal(applyDocumentFieldChange(latest, selected).ok, false);
});

test("text restoration keeps highlight colors only on surviving original text ranges", () => {
  const current = fixture("#ABCDEF"), historical = structuredClone(current);
  current.factBase.profile.displayName.zh = "合成旧名";
  historical.factBase.profile.displayName.zh = "合成新名";
  current.resumeViews[0]!.textStyles![KEY] = [{ start: 0, end: 4, highlight: true, highlightColor: "#ABCDEF" }];
  const selected = getDocumentFieldChanges(current, historical).find(change => change.target.scope === "profile" && change.target.field === "displayName" && change.target.locale === "zh")!;
  const result = applyDocumentFieldChange(current, selected);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.message);
  assert.equal(result.document.factBase.profile.displayName.zh, "合成新名");
  assert.deepEqual(result.document.resumeViews[0]!.textStyles![KEY], [{ start: 0, end: 2, highlight: true, highlightColor: "#ABCDEF" }, { start: 3, end: 4, highlight: true, highlightColor: "#ABCDEF" }]);
});
