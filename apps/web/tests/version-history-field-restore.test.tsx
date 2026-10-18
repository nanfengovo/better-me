import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import {
  applyDocumentFieldChange, createInitialDocument, getDocumentFieldChanges,
  LocalDocumentHistory, type BetterMeDocument, type DocumentFieldChange,
  type DocumentVersion, type VersionRepository, type PersistenceStatus,
} from "@better-me/storage";

// Render the real panel, confirmation provider, diff engine and pure restore.
// History uses a synthetic in-memory repository; no browser storage or network.
const dom = new Window({ url: "http://fixture.invalid" });
const React = await import("react");
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement, act } = React;
const { createRoot } = await import("react-dom/client");
const { VersionHistoryPanel } = await import("../src/components/VersionHistoryPanel.tsx");
const { ConfirmationProvider } = await import("../src/components/ConfirmationDialog.tsx");
const originalFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | undefined;
const clone = <T,>(value: T): T => structuredClone(value);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

function fixtures() {
  const current = createInitialDocument("2026-10-18T00:00:00.000Z");
  current.factBase.profile.email = "current@fixture.invalid";
  current.factBase.profile.phone = "+86 138-0000-0001";
  const selected = clone(current);
  selected.factBase.profile.email = "selected@fixture.invalid";
  selected.factBase.profile.phone = "+86 138-0000-0002";
  return { current, selected };
}
class MemoryVersions implements VersionRepository {
  listCalls = 0;
  constructor(public versions: DocumentVersion[]) {}
  async list() { this.listCalls += 1; return clone(this.versions); }
  async putAndPrune(version: DocumentVersion, limit: number) {
    this.versions = [clone(version), ...this.versions.filter(item => item.id !== version.id)].slice(0, limit);
  }
  async delete(id: string) { this.versions = this.versions.filter(item => item.id !== id); }
}
async function flush(action: () => void | Promise<void> = () => undefined) {
  await act(async () => { await action(); await nextTurn(); await nextTurn(); });
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(found, `missing button: ${label}`);
  return found;
}
async function click(label: string) {
  assert.equal(button(label).disabled, false, `disabled button: ${label}`);
  await flush(() => button(label).click());
}
const panel = () => dom.document.querySelector('[role="dialog"][aria-labelledby="history-title"]');
const alertText = () => dom.document.querySelector('[role="alert"]')?.textContent ?? "";
const statusText = () => dom.document.querySelector('[role="status"][aria-label="单项恢复状态"]')?.textContent ?? "";
const diffRegion = () => dom.document.querySelector('[role="region"][aria-label="逐项版本差异"]');
const row = (label: string) => button(`恢复此项：${label}`).closest("li")!;

type FieldPolicy = (version: DocumentVersion, change: DocumentFieldChange) => Promise<boolean>;
async function mount(options: { current?: BetterMeDocument; selected?: BetterMeDocument; fieldPolicy?: FieldPolicy; nextPersistenceStatus?: PersistenceStatus } = {}) {
  const defaults = fixtures();
  let current = clone(options.current ?? defaults.current);
  let visible = true;
  let persistenceStatus: PersistenceStatus | undefined;
  const version: DocumentVersion = {
    id: "fixture-history-selected", createdAt: "2026-10-17T12:00:00.000Z", label: "所选合成旧版本", kind: "checkpoint",
    document: clone(options.selected ?? defaults.selected),
  };
  const repository = new MemoryVersions([version, { ...clone(version), id: "fixture-history-older", label: "另一个合成版本", createdAt: "2026-10-16T12:00:00.000Z" }]);
  const history = new LocalDocumentHistory(repository);
  const restoredFields: { version: DocumentVersion; change: DocumentFieldChange }[] = [];
  const restoredWhole: DocumentVersion[] = [];
  let closes = 0;
  globalThis.fetch = async () => { assert.fail("history UI fixture must never access the network"); };
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")! as unknown as Element);
  const renderCurrent = () => root!.render(createElement(ConfirmationProvider, null, visible ? createElement(VersionHistoryPanel, {
    history, currentDocument: current, persistenceStatus,
    async onRestoreField(selectedVersion, change) {
      restoredFields.push({ version: selectedVersion, change });
      if (options.fieldPolicy && !(await options.fieldPolicy(selectedVersion, change))) return false;
      const applied = applyDocumentFieldChange(current, change, "2026-10-18T02:00:00.000Z");
      assert.equal(applied.ok, true, "synthetic field restore must apply");
      if (!applied.ok) throw new Error(applied.message);
      current = applied.document;
      persistenceStatus = options.nextPersistenceStatus;
      if (persistenceStatus?.kind !== "draft" && !persistenceStatus?.historyError) await history.append(current, "恢复合成单项", "restore");
      renderCurrent();
      return true;
    },
    async onRestore(selectedVersion) { restoredWhole.push(selectedVersion); current = clone(selectedVersion.document); return true; },
    async onCheckpoint(label) { await history.append(current, label, "checkpoint"); return true; },
    onClose() { closes += 1; visible = false; renderCurrent(); },
  }) : null));
  await flush(renderCurrent);
  const summary = dom.document.querySelector("details summary");
  if (summary) await flush(() => (summary as unknown as HTMLElement).click());
  return { repository, history, version, restoredFields, restoredWhole, current: () => current, closes: () => closes };
}

afterEach(async () => {
  await flush(() => { root?.unmount(); root = undefined; });
  globalThis.fetch = originalFetch;
});
after(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("逐项差异标明当前和历史方向，每行恢复按钮包含字段名且传递 typed change", async () => {
  const { current, selected } = fixtures();
  selected.factBase.experiences.pop();
  const extra = clone(current.factBase.experiences[0]!);
  extra.id = "exp-fixture-history-added";
  extra.org = { zh: "合成历史单位" };
  extra.claims = [];
  selected.factBase.experiences.push(extra);
  const harness = await mount({ current, selected });
  assert.ok(diffRegion());
  assert.match(diffRegion()!.textContent ?? "", /当前正在编辑/);
  assert.match(diffRegion()!.textContent ?? "", /所选历史版本/);
  assert.equal(row("邮箱").querySelector('[aria-label="当前值"]')?.textContent, current.factBase.profile.email);
  assert.equal(row("邮箱").querySelector('[aria-label="所选版本值"]')?.textContent, selected.factBase.profile.email);
  assert.match(diffRegion()!.textContent ?? "", /恢复将新增/);
  assert.match(diffRegion()!.textContent ?? "", /恢复将移除/);
  const expected = getDocumentFieldChanges(current, selected).find(change => change.label === "邮箱")!;
  await click("恢复此项：邮箱");
  assert.equal(harness.restoredFields.length, 1);
  assert.equal(harness.restoredFields[0]!.version.id, harness.version.id);
  assert.deepEqual(harness.restoredFields[0]!.change, expected);
});

test("成功只恢复目标字段并保留其他编辑，刷新历史后仍选旧版本且面板保持打开", async () => {
  const { current, selected } = fixtures();
  const harness = await mount({ current, selected });
  const initialReads = harness.repository.listCalls;
  await click("恢复此项：邮箱");
  assert.ok(panel());
  assert.equal(harness.closes(), 0);
  assert.equal(harness.current().factBase.profile.email, selected.factBase.profile.email);
  assert.equal(harness.current().factBase.profile.phone, current.factBase.profile.phone);
  assert.equal(harness.restoredWhole.length, 0);
  assert.ok(harness.repository.listCalls > initialReads);
  assert.ok(harness.repository.versions.some(item => item.kind === "restore"));
  const selectedButton = dom.document.querySelector('[aria-label="历史版本列表"] button[aria-pressed="true"]');
  assert.match(selectedButton?.textContent ?? "", /所选合成旧版本/);
  assert.match(statusText(), /已恢复.*邮箱.*其他编辑保留/);
  assert.equal([...dom.document.querySelectorAll("button")].some(item => item.getAttribute("aria-label") === "恢复此项：邮箱"), false);
  assert.equal(button("恢复此项：电话").disabled, false);
  assert.equal(alertText(), "");
});

test("单项恢复 pending 时同步防重复，并锁住切换版本、关闭和其他写操作", async () => {
  const pending = deferred<boolean>();
  const harness = await mount({ fieldPolicy: () => pending.promise });
  const restore = button("恢复此项：邮箱");
  await flush(() => { restore.click(); restore.click(); });
  assert.equal(harness.restoredFields.length, 1);
  assert.equal(button("恢复此项：电话").disabled, true);
  assert.equal(button("关闭版本历史").disabled, true);
  assert.equal(button("恢复为新版本").disabled, true);
  assert.equal(button("删除快照").disabled, true);
  assert.equal((dom.document.getElementById("checkpoint-name") as unknown as HTMLInputElement).disabled, true);
  const versions = [...dom.document.querySelectorAll('[aria-label="历史版本列表"] button')];
  assert.ok(versions.every(item => (item as unknown as HTMLButtonElement).disabled));
  await flush(() => {
    (versions[1] as unknown as HTMLButtonElement).click();
    button("关闭版本历史").click();
    dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(harness.closes(), 0);
  assert.match(dom.document.querySelector('[aria-pressed="true"]')?.textContent ?? "", /所选合成旧版本/);
  await flush(() => pending.resolve(true));
  assert.match(statusText(), /已恢复.*邮箱/);
  assert.equal(button("关闭版本历史").disabled, false);
  assert.equal(button("恢复此项：电话").disabled, false);
});

test("保存返回 false 时保留面板、差异和编辑，显示错误后允许重试", async () => {
  let attempts = 0;
  const harness = await mount({ fieldPolicy: async () => ++attempts > 1 });
  const before = clone(harness.current());
  await click("恢复此项：邮箱");
  assert.deepEqual(harness.current(), before);
  assert.ok(panel());
  assert.equal(harness.closes(), 0);
  assert.match(alertText(), /此项恢复未完成/);
  assert.equal(statusText(), "");
  assert.equal(button("恢复此项：邮箱").disabled, false);
  await click("恢复此项：邮箱");
  assert.equal(harness.restoredFields.length, 2);
  assert.equal(alertText(), "");
  assert.match(statusText(), /已恢复.*邮箱/);
});

test("恢复异常显示实际失败原因，其他字段不会被替换且全量恢复入口仍可用", async () => {
  const harness = await mount({ fieldPolicy: async () => { throw new Error("合成存储空间不足，未写入。"); } });
  const before = clone(harness.current());
  await click("恢复此项：邮箱");
  assert.deepEqual(harness.current(), before);
  assert.match(alertText(), /合成存储空间不足/);
  assert.ok(panel());
  assert.equal(button("恢复为新版本").disabled, false);
  await click("恢复为新版本");
  assert.equal(harness.restoredWhole.length, 1);
  assert.equal(harness.restoredWhole[0]!.id, harness.version.id);
  assert.equal(harness.closes(), 1);
  assert.equal(panel(), null);
});

test("对应文字不同的样式项说明依赖并禁止单独恢复，不发送恢复回调", async () => {
  const current = createInitialDocument("2026-10-18T00:00:00.000Z");
  const selected = clone(current);
  selected.factBase.profile.displayName.zh = "更长的合成历史名称";
  selected.resumeViews[0]!.textStyles = { "profile:displayName:zh": [{ start: 0, end: 2, bold: true }] };
  const unavailable = getDocumentFieldChanges(current, selected).find(change => !change.restore.available && change.label.includes("文字格式"));
  assert.ok(unavailable, "fixture must expose a real dependent-format restriction");
  const harness = await mount({ current, selected });
  const target = button(`恢复此项：${unavailable.label}`);
  assert.equal(target.disabled, true);
  assert.match(target.closest("li")?.textContent ?? "", /文字.*不同|先恢复对应文字/);
  await flush(() => target.click());
  assert.equal(harness.restoredFields.length, 0);
  assert.equal(button("恢复此项：姓名（中文）").disabled, false);
  assert.equal(button("恢复为新版本").disabled, false);
  await click("恢复此项：姓名（中文）");
  assert.equal(button(`恢复此项：${unavailable.label}`).disabled, false, "matching source text must make this dependency restorable after diff recomputes");
  await click(`恢复此项：${unavailable.label}`);
  assert.deepEqual(harness.current().resumeViews[0]!.textStyles, selected.resumeViews[0]!.textStyles);
});

test("单项结果仅有草稿保护时明确尚无完整版本，不将操作成功等同版本保存", async () => {
  const harness = await mount({ nextPersistenceStatus: {
    kind: "draft", message: "合成草稿已保护；请补齐日期后保存。", hasPendingChanges: true,
  } });
  await click("恢复此项：邮箱");
  assert.ok(panel());
  assert.match(statusText(), /已恢复.*邮箱/);
  assert.match(dom.document.querySelector('[aria-label="恢复保存状态"]')?.textContent ?? "", /合成草稿已保护/);
  assert.match(dom.document.body.textContent ?? "", /当前仅保护为本地草稿，尚未生成恢复后的完整版本/);
  assert.equal(harness.repository.versions.some(item => item.kind === "restore"), false);
});

test("恢复结果已生效但历史追加失败时同时展示保存状态和历史警告", async () => {
  const harness = await mount({ nextPersistenceStatus: {
    kind: "saved", message: "合成当前内容已保存。", hasPendingChanges: false,
    historyError: "合成历史追加失败；恢复前快照已保护，请下载备份。",
  } });
  await click("恢复此项：邮箱");
  assert.ok(panel());
  assert.match(statusText(), /已恢复.*邮箱/);
  assert.match(alertText(), /历史记录未完整保存.*合成历史追加失败/);
  assert.match(alertText(), /恢复前快照已保护/);
  assert.match(dom.document.querySelector('[aria-label="恢复保存状态"]')?.textContent ?? "", /合成当前内容已保存/);
  assert.equal(harness.repository.versions.some(item => item.kind === "restore"), false);
});
