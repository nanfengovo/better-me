import assert from "node:assert/strict";
import test, { after } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
const dom = new Window();
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : next(url, context); } });
const React = await import("react");
Object.defineProperty(globalThis, "React", { configurable: true, value: React });
const { createRoot } = await import("react-dom/client");
const { RecoverableModule } = await import("../src/components/atlas/RecoverableModule");
after(() => { hooks.deregister(); void dom.happyDOM.abort(); Reflect.deleteProperty(globalThis, "React"); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("rejected map module stays isolated; explicit retry creates a fresh lazy loader and preserves other UI", async () => {
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement, { onCaughtError() {} });
  let calls = 0, exits = 0;
  const load = async () => { if (++calls === 1) throw new Error("synthetic unavailable chunk"); return { default: ({ title }: { title: string }) => React.createElement("p", null, title) }; };
  const flush = async (action: () => void) => { await React.act(async () => { action(); for (let i = 0; i < 6; i++) await nextTurn(); }); };
  try {
    await flush(() => root.render(React.createElement("main", null, React.createElement("input", { defaultValue: "保留草稿" }), React.createElement(RecoverableModule, { load, componentProps: { title: "地图加载成功" }, label: "岗位地图", onExit: () => exits++ }))));
    assert.match(host.textContent!, /暂时无法打开/);
    await flush(() => [...host.querySelectorAll("button")].find(button => button.textContent === "返回机会列表")!.click());
    assert.equal(exits, 1);
    await flush(() => [...host.querySelectorAll("button")].find(button => button.textContent === "重新加载")!.click());
    assert.equal(calls, 2); assert.match(host.textContent!, /地图加载成功/);
    assert.equal(host.querySelector("input")!.value, "保留草稿");
    assert.equal(host.querySelector('[role="alert"]'), null);
  } finally { await flush(() => root.unmount()); host.remove(); }
});

test("every page navigation initializes atlas, and reset remounts the failed renderer", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /function setPage\(next: typeof page\)\s*\{\s*if \(next === "atlas"\) setAtlasInitialized\(true\);\s*updatePage\(next\)/);
  assert.match(app, /onOpenAtlas=\{\(\) => setPage\("atlas"\)\}/);
  const workspace = readFileSync(new URL("../src/components/AtlasWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /<AtlasMap key=\{mapKey\} resetRevision=\{mapKey\}/);
});
