import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";
import { createInitialDocument, STORAGE_KEY } from "@better-me/storage";
import { syntheticPersistence } from "./fixtures/synthetic-persistence";
registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "http://chrome-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client"), { act } = React;
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences");
const { AutoSaveControls } = await import("../src/components/AutoSaveControls");
const { DocumentSaveStatus } = await import("../src/components/DocumentSaveStatus");
const { WorkspaceMenu } = await import("../src/components/WorkspaceMenu");
const { AgentExecutionLog, groupExecutionEntries } = await import("../src/components/AgentExecutionLog");
let root: ReturnType<typeof createRoot>;
async function render(node: React.ReactNode) { const el = dom.document.createElement("div"); dom.document.body.append(el); root = createRoot(el as unknown as Element); await act(async () => root.render(<UiPreferencesProvider>{node}</UiPreferencesProvider>)); }
async function click(label: string) { const el = [...dom.document.querySelectorAll("button")].find(e => e.getAttribute("aria-label") === label || e.textContent === label); assert.ok(el, label); await act(async () => el.click()); }
afterEach(async () => { await act(async () => root?.unmount()); dom.document.body.replaceChildren(); dom.localStorage.clear(); });
after(() => { dom.happyDOM.abort(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
test("compact save disclosure preserves the exact preference and manual-save action", async () => {
  const settings = { enabled: false, trigger: "idle" as const, delayMs: 17000, historyIntervalMs: 75000 }, changes: unknown[] = []; let saves = 0;
  await render(<AutoSaveControls settings={settings} onChange={value => changes.push(value)} onSave={() => saves++} compactStatus="已保存 · 自动保存关" />);
  assert.equal(dom.document.querySelector('[role="switch"]'), null);
  await click("保存状态与设置");
  assert.equal(dom.document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
  assert.equal(dom.document.querySelector('[aria-label="停止输入多久后保存"]')?.getAttribute("value"), "17");
  await click("立即保存"); assert.equal(saves, 1); assert.equal(changes.length, 0);
  await click("关闭自动保存设置"); await click("保存状态与设置"); assert.equal(changes.length, 0);
  await click("自动保存"); assert.deepEqual(changes, [{ ...settings, enabled: true }]);
});
test("save status distinguishes a protected draft, complete save, pending work and failed history", async () => {
  const status = { kind: "draft" as const, hasPendingChanges: true, draftSavedAt: "2026-11-04T00:00:00.000Z", message: "草稿已保护，完整版本未更新" };
  await render(<DocumentSaveStatus status={status} autoSaveEnabled={false} />);
  assert.match(dom.document.querySelector('[role="status"]')!.textContent!, /草稿已保护.*完整简历待保存.*自动保存关/);
  await act(async () => root.render(<UiPreferencesProvider><DocumentSaveStatus status={{ ...status, kind: "saved", hasPendingChanges: false, historyError: "版本库暂不可用" }} autoSaveEnabled={false} /></UiPreferencesProvider>));
  assert.match(dom.document.querySelector('[role="status"]')!.textContent!, /简历已保存.*历史备份需处理/);
  assert.match(dom.document.querySelector('[role="status"]')!.getAttribute("title")!, /版本库暂不可用/);
  await act(async () => root.render(<UiPreferencesProvider><DocumentSaveStatus status={{ ...status, kind: "pending" }} autoSaveEnabled /></UiPreferencesProvider>));
  assert.doesNotMatch(dom.document.querySelector('[role="status"]')!.textContent!, /已保存|已保护/);
  await act(async () => root.render(<UiPreferencesProvider><DocumentSaveStatus status={{ ...status, kind: "error", draftSavedAt: undefined, message: "浏览器拒绝保存" }} autoSaveEnabled /></UiPreferencesProvider>));
  assert.match(dom.document.querySelector('[role="status"]')!.textContent!, /保存需要处理/);
  assert.doesNotMatch(dom.document.querySelector('[role="status"]')!.textContent!, /已保存|已保护/);
  assert.deepEqual(status, { kind: "draft", hasPendingChanges: true, draftSavedAt: "2026-11-04T00:00:00.000Z", message: "草稿已保护，完整版本未更新" });
});
test("save labels follow the real controller through draft, failed complete save, saved content and history failure", async () => {
  const initial = createInitialDocument(); initial.factBase.profile.displayName = { zh: "合成保存测试" }; initial.factBase.profile.email = "save@example.invalid";
  const { controller, faults, values } = syntheticPersistence(initial);
  try {
    await controller.load();
    await render(<DocumentSaveStatus status={controller.getState().status} autoSaveEnabled={false} />);
    const unsubscribe = controller.subscribe(state => root.render(<UiPreferencesProvider><DocumentSaveStatus status={state.status} autoSaveEnabled={false} /></UiPreferencesProvider>));
    try {
      const next = structuredClone(initial); next.factBase.profile.headline = { zh: "仅合成的修改" };
      await act(async () => controller.update(next));
      assert.match(dom.document.querySelector('[role="status"]')!.textContent!, /草稿已保护.*完整简历待保存/);
      assert.equal(values.get(STORAGE_KEY), JSON.stringify(initial), "protecting a draft does not overwrite the complete save");
      faults.official = true;
      await act(async () => { assert.equal(await controller.flush(true), false); });
      assert.match(dom.document.querySelector('[role="status"]')!.textContent!, /保存需要处理/);
      assert.equal(values.get(STORAGE_KEY), JSON.stringify(initial));
      faults.official = false; faults.history = true;
      await act(async () => { assert.equal(await controller.flush(true), true); });
      assert.match(dom.document.querySelector('[role="status"]')!.textContent!, /简历已保存.*历史备份需处理/);
      assert.equal(JSON.parse(values.get(STORAGE_KEY)!).factBase.profile.headline.zh, "仅合成的修改");
    } finally { unsubscribe(); }
  } finally { controller.dispose(); }
});
test("workspace preferences remain discoverable but closed, Escape restores trigger focus", async () => {
  let tours = 0;
  await render(<WorkspaceMenu initial="隔" onGuide={() => tours++} onAiConfig={() => assert.fail("not requested")} />);
  assert.equal(dom.document.querySelector(".workspace-menu-panel")?.hasAttribute("hidden"), true);
  await click("工作台设置"); assert.equal(dom.document.querySelector(".workspace-menu-panel")?.hasAttribute("hidden"), false);
  assert.ok(dom.document.querySelector('[aria-label="工作台配色"]'));
  await click("新手引导"); assert.equal(tours, 1);
  assert.equal(dom.document.querySelector(".workspace-menu-panel")?.hasAttribute("hidden"), true);
  await click("工作台设置");
  await act(async () => dom.document.querySelector(".workspace-menu-panel")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(dom.document.activeElement?.getAttribute("aria-label"), "工作台设置");
});
test("execution aggregation folds only consecutive equal records and preserves boundaries/receipts", async () => {
  const entries = Array.from({ length: 6 }, (_, i) => ({ id: String(i), at: new Date(1000 * i).toISOString(), kind: "reading", label: "列出授权源码已完成。" }));
  entries.push({ id: "wait", at: new Date(7000).toISOString(), kind: "waiting", label: "等待确认" });
  entries.push({ ...entries[0]!, id: "next-round" });
  const before = JSON.stringify(entries), groups = groupExecutionEntries(entries);
  assert.deepEqual(groups.map(g => g.entries.length), [6, 1, 1]); assert.equal(JSON.stringify(entries), before);
  await render(<AgentExecutionLog entries={entries} />);
  assert.equal(dom.document.querySelector("details")?.hasAttribute("open"), false);
  assert.match(dom.document.querySelector("summary")?.textContent ?? "", /8 条记录 · 3 组/);
  assert.equal(dom.document.querySelectorAll("details ul li").length, 6);
});
