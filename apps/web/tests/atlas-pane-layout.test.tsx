import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://atlas-pane-layout-fixture.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { useAtlasPaneLayout } = await import("../src/components/atlas/use-atlas-pane-layout.ts");
let root: ReturnType<typeof createRoot> | undefined;
let width = 0, observers: FixtureObserver[] = [];
const originalRect = dom.HTMLElement.prototype.getBoundingClientRect;
const originalObserver = dom.ResizeObserver;
class FixtureObserver {
  disconnected = false;
  element?: Element;
  constructor(private readonly callback: () => void) { observers.push(this); }
  observe(element: Element) { this.element = element; }
  disconnect() { this.disconnected = true; }
  unobserve() {}
  notify() { this.callback(); }
}
Object.defineProperty(dom.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value() {
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 700, width, height: 700, toJSON() {} };
} });
function Probe({ active }: { active: boolean }) {
  const { workspace, layout } = useAtlasPaneLayout(active);
  return h("section", { ref: workspace, "data-layout": layout });
}
async function render(active = true) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(Probe, { active })));
}
const layout = () => dom.document.querySelector("section")!.getAttribute("data-layout");

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; width = 0; observers = []; dom.ResizeObserver = originalObserver;
});
after(() => {
  Object.defineProperty(dom.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value: originalRect });
  void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("embedded workspace width chooses desktop columns even below the former 1200px viewport breakpoint", async () => {
  dom.ResizeObserver = FixtureObserver as unknown as typeof dom.ResizeObserver;
  dom.innerWidth = 1000; width = 950;
  await render(); assert.equal(layout(), "wide");
  assert.equal(observers[0]!.element, dom.document.querySelector("section"));
  // Closing another app panel changes the container without a window resize event.
  width = 899; await act(async () => observers[0]!.notify()); assert.equal(layout(), "medium");
  width = 600; await act(async () => observers[0]!.notify()); assert.equal(layout(), "medium");
  width = 599; await act(async () => observers[0]!.notify()); assert.equal(layout(), "narrow");
  dom.innerWidth = 1600; width = 390;
  await act(async () => observers[0]!.notify()); assert.equal(layout(), "narrow", "a wide browser does not turn a phone-sized embedded panel into a desktop");
  width = 900; await act(async () => observers[0]!.notify()); assert.equal(layout(), "wide");
});

test("hidden workspaces preserve layout, reactivation remeasures, and stale observer delivery is ignored", async () => {
  dom.ResizeObserver = FixtureObserver as unknown as typeof dom.ResizeObserver;
  width = 1000; await render(); assert.equal(layout(), "wide");
  const previous = observers[0]!;
  width = 0; await act(async () => previous.notify()); assert.equal(layout(), "wide");
  await render(false); assert.equal(previous.disconnected, true);
  width = 390; await act(async () => previous.notify()); assert.equal(layout(), "wide", "disposed callbacks cannot reclassify an inactive pane");
  await render(true); assert.equal(layout(), "narrow"); assert.equal(observers.length, 2);
  await act(async () => root!.unmount()); root = undefined;
  assert.equal(observers[1]!.disconnected, true);
  await act(async () => observers[1]!.notify());
});

test("without ResizeObserver, resize uses the actual container and an initially hidden pane stays in normal flow", async () => {
  dom.ResizeObserver = undefined as unknown as typeof dom.ResizeObserver;
  dom.innerWidth = 1500; width = 0; await render(); assert.equal(layout(), "medium");
  width = 1000; await act(async () => dom.dispatchEvent(new dom.Event("resize"))); assert.equal(layout(), "wide");
  width = 390; await act(async () => dom.dispatchEvent(new dom.Event("resize"))); assert.equal(layout(), "narrow");
});
