import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { z } from "zod";
import { activateStorageOwner } from "../src/lib/private-storage";

const dom = new Window({ url: "http://workspace-recovery.invalid" });
const React = await import("react");
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { useWorkspaceRecovery } = await import("../src/lib/use-workspace-recovery");
const { useWorkspaceNavigation } = await import("../src/lib/workspace-navigation");
const schema = z.object({ text: z.string(), turns: z.array(z.string()) }).strict();
const fresh = () => ({ text: "", turns: [] as string[] });
let root: ReturnType<typeof createRoot> | undefined;
let recovery: ReturnType<typeof useWorkspaceRecovery<z.infer<typeof schema>>>;
function Probe({ scope }: { scope: string }) { recovery = useWorkspaceRecovery(scope, schema, fresh); return React.createElement("output", null, recovery.error || recovery.value.text); }
async function mount(scope = "workspace-a") {
  await React.act(async () => {
    root?.unmount();
    dom.document.body.replaceChildren();
    const container = dom.document.createElement("main"); dom.document.body.append(container);
    root = createRoot(container as unknown as Element); root.render(React.createElement(Probe, { scope }));
  });
}
test.afterEach(async () => { await React.act(async () => { root?.unmount(); root = undefined; }); dom.localStorage.clear(); activateStorageOwner(undefined); });
test.after(() => dom.happyDOM.abort());

test("accepted input is saved synchronously before an immediate unmount and restores with a fresh mount", async () => {
  await mount();
  await React.act(async () => {
    recovery.field("text", "来不及等自动保存的草稿");
    recovery.field("turns", turns => [...turns, "第一轮", "第二轮"]);
    assert.match(dom.localStorage.getItem("betterme.recovery.v1:workspace-a")!, /来不及等自动保存/);
    root!.unmount(); root = undefined;
  });
  await mount(); assert.equal(recovery.restored, true);
  assert.deepEqual(recovery.value, { text: "来不及等自动保存的草稿", turns: ["第一轮", "第二轮"] });
});

test("recovery isolates owners and workspaces without claiming legacy data", async () => {
  await mount(); await React.act(async () => recovery.field("text", "旧无主数据"));
  activateStorageOwner("synthetic-owner-a"); await mount(); assert.equal(recovery.value.text, "");
  await React.act(async () => recovery.field("text", "甲的私人草稿"));
  await mount("workspace-b"); assert.equal(recovery.value.text, "");
  activateStorageOwner("synthetic-owner-b"); await mount(); assert.equal(recovery.value.text, "");
  activateStorageOwner("synthetic-owner-a"); await mount(); assert.equal(recovery.value.text, "甲的私人草稿");
});

test("an old controller keeps its captured owner after account switching", async () => {
  activateStorageOwner("synthetic-owner-a"); await mount(); const old = recovery;
  activateStorageOwner("synthetic-owner-b");
  await React.act(async () => old.field("text", "迟到的甲保存"));
  await mount(); assert.equal(recovery.value.text, "");
  activateStorageOwner("synthetic-owner-a"); await mount(); assert.equal(recovery.value.text, "迟到的甲保存");
});

test("corrupt records are preserved and an unsaved-page warning protects the fallback draft", async () => {
  const scope = "corrupt-workspace";
  const key = `betterme.recovery.v1:${scope}`, raw = '{"version":99,"precious":"旧原始内容"}';
  dom.localStorage.setItem(key, raw); await mount(scope);
  await React.act(async () => recovery.field("text", "本页新草稿"));
  assert.match(recovery.error, /无法读取/); assert.equal(dom.localStorage.getItem(key), raw);
  const event = new dom.Event("beforeunload", { cancelable: true }); dom.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(recovery.value.text, "本页新草稿");
  await mount(scope);
  assert.equal(recovery.value.text, "本页新草稿", "in-app navigation must retain the fallback draft too");
  assert.equal(dom.localStorage.getItem(key), raw);
});

test("a changed record cannot be overwritten by a stale window", async () => {
  await mount("conflict-workspace"); await React.act(async () => recovery.field("text", "本窗原内容"));
  const key = "betterme.recovery.v1:conflict-workspace", other = JSON.stringify({ version: 1, value: { text: "另一窗口新内容", turns: [] } });
  dom.localStorage.setItem(key, other);
  await React.act(async () => recovery.field("text", "本窗未保存内容"));
  assert.match(recovery.error, /另一窗口/); assert.equal(recovery.value.text, "本窗未保存内容"); assert.equal(dom.localStorage.getItem(key), other);
  await mount("conflict-workspace");
  assert.equal(recovery.value.text, "本窗未保存内容"); assert.match(recovery.error, /另一窗口/);
});

test("quota failure retains the whole draft, warns on unload, and does not truncate saved history", async () => {
  await mount("quota-workspace"); await React.act(async () => recovery.field("turns", ["已保存的历史"]));
  const previous = dom.localStorage.getItem("betterme.recovery.v1:quota-workspace");
  const limited = new Proxy(dom.localStorage, { get(target, property) {
    if (property === "setItem") return () => { throw new Error("synthetic quota"); };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: limited });
  try {
    await React.act(async () => recovery.field("text", "空间不足时仍可下载的完整草稿"));
    assert.match(recovery.error, /空间不足/); assert.equal(recovery.value.text, "空间不足时仍可下载的完整草稿");
    assert.deepEqual(recovery.value.turns, ["已保存的历史"]);
    assert.equal(dom.localStorage.getItem("betterme.recovery.v1:quota-workspace"), previous);
    const event = new dom.Event("beforeunload", { cancelable: true }); dom.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    await mount("workspace-b");
    const leaving = new dom.Event("beforeunload", { cancelable: true }); dom.dispatchEvent(leaving);
    assert.equal(leaving.defaultPrevented, true, "leaving another page must still protect an unsaved draft");
    activateStorageOwner("separate-synthetic-owner"); await mount("quota-workspace");
    assert.equal(recovery.value.text, "", "another owner must never receive the retained unsaved draft");
    const otherOwnerLeaving = new dom.Event("beforeunload", { cancelable: true }); dom.dispatchEvent(otherOwnerLeaving);
    assert.equal(otherOwnerLeaving.defaultPrevented, false, "another owner's private draft cannot block this account");
    activateStorageOwner(undefined);
    await mount("quota-workspace"); assert.equal(recovery.value.text, "空间不足时仍可下载的完整草稿");
  } finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: dom.localStorage }); }
  await React.act(async () => recovery.field("text", "空间恢复后重试保存"));
  assert.equal(recovery.error, "");
});

test("workspace navigation restores subtabs and browser back/forward selects the URL workspace", async () => {
  let navigation!: ReturnType<typeof useWorkspaceNavigation>;
  function NavigationProbe() { navigation = useWorkspaceNavigation(); return React.createElement("output", null, navigation.page); }
  dom.history.replaceState(null, "", "/");
  await mount();
  await React.act(async () => root!.render(React.createElement(NavigationProbe)));
  await React.act(async () => { navigation.setPage("agent"); navigation.setWorkspaceTab("design"); navigation.setAgentMode("growth"); });
  assert.equal(new URLSearchParams(dom.location.search).get("workspace"), "agent");
  await React.act(async () => {
    dom.history.replaceState(null, "", "/?workspace=resume"); dom.dispatchEvent(new dom.PopStateEvent("popstate"));
  });
  assert.equal(navigation.page, "resume");
  await React.act(async () => {
    dom.history.replaceState(null, "", "/?workspace=agent"); dom.dispatchEvent(new dom.PopStateEvent("popstate"));
  });
  assert.equal(navigation.page, "agent");
  await mount();
  await React.act(async () => root!.render(React.createElement(NavigationProbe)));
  assert.equal(navigation.page, "agent"); assert.equal(navigation.workspaceTab, "design"); assert.equal(navigation.agentMode, "growth");
});
