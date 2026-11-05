import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window, type HTMLDetailsElement, type HTMLDialogElement, type HTMLElement, type HTMLInputElement } from "happy-dom";
import { AGENT_LESSONS, readTutorial, tutorialInstruction, tutorialKey, writeTutorial, type TutorialProgress } from "../src/lib/agent-tutorial";

registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
const dom = new Window({ url: "http://tutorial-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
let reduced = false;
const mediaListeners = new Set<() => void>();
const originalMatchMedia = dom.matchMedia;
dom.matchMedia = query => {
  const media = originalMatchMedia.call(dom, query);
  Object.defineProperties(media, {
    matches: { get: () => reduced },
    addEventListener: { value(_type: string, listener: () => void) { mediaListeners.add(listener); } },
    removeEventListener: { value(_type: string, listener: () => void) { mediaListeners.delete(listener); } },
  });
  return media;
};
let animations = 0, canceled = 0;
Object.defineProperty(dom.HTMLElement.prototype, "animate", { configurable: true, value() { animations++; return { cancel() { canceled++; }, finished: Promise.resolve() }; } });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { AgentWorkflowGuide } = await import("../src/components/AgentWorkflowGuide");
const key = tutorialKey("isolated-lessons");
let root: ReturnType<typeof createRoot> | undefined;
let initial = 0, active = true, closed = 0;
const actions: string[] = [];
function Harness() {
  const [step, setStep] = React.useState(initial);
  return <AgentWorkflowGuide step={step} active={active} storageKey={key} onStep={setStep} onClose={() => { closed++; }} onAction={(destination, lesson) => actions.push(`${destination}:${lesson}`)} />;
}
async function render() {
  if (!root) { const element = dom.document.createElement("div"); dom.document.body.append(element); root = createRoot(element as unknown as Element); }
  await act(async () => root!.render(<Harness />));
}
async function click(label: string) {
  const button = [...dom.document.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
  assert.ok(button, label); await act(async () => button.click());
}
async function practice() {
  const details = dom.document.querySelector<HTMLDetailsElement>(".agent-tutorial-practice")!;
  if (!details.open) await act(async () => details.querySelector("summary")!.click());
}
const saved = () => readTutorial(dom.localStorage, key);
afterEach(async () => {
  await act(async () => { root?.unmount(); root = undefined; }); dom.document.body.replaceChildren(); dom.localStorage.clear();
  initial = 0; active = true; closed = 0; actions.length = 0; reduced = false; animations = 0; canceled = 0;
  assert.equal(mediaListeners.size, 0, "motion listeners are released on unmount");
});
after(() => { dom.matchMedia = originalMatchMedia; dom.happyDOM.abort(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });

test("all eight contextual lessons have a safe exercise, real target and honest prerequisite", () => {
  assert.equal(AGENT_LESSONS.length, 8); assert.equal(new Set(AGENT_LESSONS.map(item => item.id)).size, 8);
  for (const lesson of AGENT_LESSONS) {
    assert.equal(lesson.steps.length, 3); assert.ok(lesson.targets.length > 0);
    assert.ok(lesson.result && lesson.instruction && lesson.prerequisite && lesson.caution && lesson.choices[lesson.correct]);
  }
});
test("progress rejects malformed/future records and filters duplicate or unknown lesson IDs", () => {
  dom.localStorage.setItem(key, "invalid json"); assert.equal(saved().current, "evidence");
  dom.localStorage.setItem(key, JSON.stringify({ version: 2, current: "tools", viewed: ["tools"] })); assert.deepEqual(saved().viewed, []);
  dom.localStorage.setItem(key, JSON.stringify({ version: 1, current: "tools", viewed: ["tools", "tools", "fake", 3], practiced: ["memory", null] }));
  assert.deepEqual(saved(), { version: 1, current: "tools", viewed: ["tools"], practiced: ["memory"] });
});
test("real-control fallback never says a visible note or project card is missing", () => {
  assert.match(tutorialInstruction("annotation", "writing-note"), /已找到当前旁批/);
  assert.doesNotMatch(tutorialInstruction("annotation", "writing-note"), /没有旁批/);
  assert.match(tutorialInstruction("contribution", "understanding-summary"), /已找到项目理解卡片/);
  assert.match(tutorialInstruction("evidence", "understanding-start"), /已找到当前经历/);
  assert.equal(tutorialInstruction("memory", ""), AGENT_LESSONS[5].prerequisite);
});
test("tutorial persistence is scoped and whitelisted, without answers, grants or model changes", () => {
  const progress: TutorialProgress & { answer: string } = { version: 1, current: "memory", viewed: ["memory"], practiced: [], answer: "must not persist" };
  dom.localStorage.setItem("autosave-sentinel", "off");
  assert.equal(writeTutorial(dom.localStorage, key, progress), true);
  assert.equal(dom.localStorage.getItem("autosave-sentinel"), "off");
  assert.deepEqual(Object.keys(JSON.parse(dom.localStorage.getItem(key)!)), ["version", "current", "viewed", "practiced"]);
  assert.equal(readTutorial(dom.localStorage, tutorialKey("another-workspace")).viewed.length, 0);
});
test("unavailable or quota-limited storage never blocks tutorial use", () => {
  assert.equal(readTutorial(null, key).current, "evidence"); assert.equal(writeTutorial(null, key, saved()), false);
  assert.equal(readTutorial({ getItem() { throw new Error("blocked"); } }, key).viewed.length, 0);
  assert.equal(writeTutorial({ setItem() { throw new Error("quota"); } }, key, saved()), false);
});
test("reading or advancing is not recorded as practice; a wrong choice is recoverable", async () => {
  await render(); assert.deepEqual(saved().viewed, ["evidence"]); assert.deepEqual(saved().practiced, []);
  await practice();
  await click("把整个磁盘都交给 Agent"); assert.deepEqual(saved().practiced, []);
  assert.match(dom.document.querySelector('[role="status"]')?.textContent ?? "", /可以再试一次/);
  await click("只读示例项目说明"); assert.deepEqual(saved().practiced, ["evidence"]);
  await click("下一步"); assert.equal(saved().current, "dialogue"); assert.deepEqual(saved().practiced, ["evidence"]);
  await practice();
  await click("都不符合，我自己说明");
  assert.ok(dom.document.querySelector("textarea")); assert.match(dom.document.querySelector("label")?.textContent ?? "", /仅示例，不发送/);
  assert.equal(dom.document.querySelectorAll('button[type="submit"]').length, 0);
});
test("annotation exercise shows source/candidate/undo and never changes working content", async () => {
  initial = 4; dom.localStorage.setItem("resume-sentinel", "untouched"); await render();
  await practice();
  await click("查看示例候选"); assert.deepEqual(saved().practiced, []);
  assert.match(dom.document.querySelector(".agent-tutorial-annotation-demo")?.textContent ?? "", /接口重试/);
  await click("撤销示例修改"); assert.deepEqual(saved().practiced, ["annotation"]);
  assert.match(dom.document.querySelector(".agent-tutorial-annotation-demo")?.textContent ?? "", /参与接口开发/);
  assert.equal(dom.localStorage.getItem("resume-sentinel"), "untouched");
});
test("jumping chapters resets only tutorial scroll and focuses the new title", async () => {
  await render(); const panel = dom.document.querySelector<HTMLElement>(".guide-panel")!;
  panel.scrollTop = 300;
  await click("第 6 节：收起继续，重载先核对");
  assert.equal(panel.scrollTop, 0); assert.equal(dom.document.activeElement?.id, "agent-tutorial-title");
  assert.equal(saved().current, "memory"); assert.deepEqual(saved().practiced, []);
  await click("找到备份与历史"); assert.deepEqual(actions, ["memory:memory"]);
  await click("返回工作"); assert.equal(closed, 1);
});
test("blocked localStorage accessor still allows closing and explains in-page-only progress", async () => {
  const original = Object.getOwnPropertyDescriptor(dom, "localStorage");
  Object.defineProperty(dom, "localStorage", { configurable: true, get() { throw new Error("blocked getter"); } });
  try { await render(); assert.match(dom.document.querySelector(".agent-tutorial-warning")?.textContent ?? "", /仅在本页保留/); await click("返回工作"); assert.equal(closed, 1); }
  finally { if (original) Object.defineProperty(dom, "localStorage", original); else Reflect.deleteProperty(dom, "localStorage"); }
});
test("motion is interruptible; keyboard navigation, hiding and effect toggle cancel it", async () => {
  await render(); assert.equal(animations, 1);
  const before = canceled;
  await act(async () => dom.document.querySelector(".agent-workflow-guide")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
  await click("下一步"); assert.equal(animations, 1); assert.ok(canceled > before);
  await act(async () => dom.document.querySelector(".agent-workflow-guide")!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })));
  assert.ok(animations > 1);
  active = false; await render(); assert.equal(dom.document.querySelector(".agent-workflow-guide"), null);
  active = true; await render();
  await act(async () => dom.document.querySelector<HTMLInputElement>('footer input[type="checkbox"]')!.click());
  const count = animations; await click("下一步"); assert.equal(animations, count);
});
test("reduced motion wins initially and after a live system preference change", async () => {
  reduced = true; await render(); assert.equal(animations, 0);
  const effects = dom.document.querySelector<HTMLInputElement>('footer input[type="checkbox"]')!;
  assert.equal(effects.disabled, true); assert.equal(effects.checked, false);
  await act(async () => { reduced = false; for (const listener of mediaListeners) listener(); }); assert.equal(effects.disabled, false);
  const count = animations; await act(async () => { reduced = true; for (const listener of mediaListeners) listener(); });
  await click("下一步"); assert.equal(animations, count); assert.equal(effects.disabled, true);
});

test("collaboration uses the same native spotlight shell, with optional examples instead of a sidebar directory", async () => {
  await render();
  const dialog = dom.document.querySelector<HTMLDialogElement>("dialog.first-run-guide.agent-workflow-guide")!;
  assert.equal(dialog.open, true); assert.equal(dialog.parentElement, dom.document.body);
  assert.equal(dialog.getAttribute("aria-labelledby"), "agent-tutorial-title");
  assert.ok(dialog.querySelector(".guide-shade")); assert.equal(dialog.querySelector(".agent-tutorial-directory"), null);
  assert.equal(dialog.querySelector<HTMLDetailsElement>(".agent-tutorial-practice")?.open, false);
  assert.equal(dialog.querySelectorAll('.guide-progress button').length, AGENT_LESSONS.length);
  await click("跳过本步"); assert.equal(saved().current, "dialogue"); assert.deepEqual(saved().practiced, []);
  await act(async () => dialog.dispatchEvent(new dom.Event("cancel", { cancelable: true })));
  assert.equal(closed, 1); assert.equal(dialog.open, false);
});

test("editing a synthetic answer never navigates on arrow keys or writes that answer to storage", async () => {
  initial = 1; await render(); await practice(); await click("都不符合，我自己说明");
  const field = dom.document.querySelector("textarea")!;
  await act(async () => {
    field.focus(); field.value = "仅用于示例的纠正";
    field.dispatchEvent(new dom.Event("input", { bubbles: true }));
    for (const key of ["ArrowRight", "ArrowLeft"]) {
      const event = new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      field.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
    }
  });
  assert.equal(saved().current, "dialogue"); assert.doesNotMatch(dom.localStorage.getItem(key)!, /仅用于示例/);
  await act(async () => dom.document.querySelector("dialog")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  assert.equal(saved().current, "consensus");
  assert.equal(dom.document.querySelector<HTMLDetailsElement>(".agent-tutorial-practice")?.open, false, "each chapter starts compact");
});

test("spotlight skips hidden anchors, clips the real control and describes the actual fallback", async () => {
  const hidden = dom.document.createElement("div"); hidden.hidden = true;
  hidden.innerHTML = '<button data-agent-guide="permissions">hidden grant</button>';
  const viewport = dom.document.createElement("div"); viewport.style.overflowX = "hidden"; viewport.style.overflowY = "auto";
  viewport.innerHTML = '<button data-agent-guide="understanding-start">project entry</button>';
  dom.document.body.append(hidden, viewport);
  const target = viewport.firstElementChild!;
  Object.defineProperty(viewport, "getBoundingClientRect", { value: () => new dom.DOMRect(90, 210, 150, 100) });
  Object.defineProperty(target, "getBoundingClientRect", { value: () => new dom.DOMRect(100, 200, 250, 30) });
  Object.defineProperty(hidden.firstElementChild!, "getBoundingClientRect", { value: () => new dom.DOMRect(1, 1, 40, 40) });
  await render();
  const ring = dom.document.querySelector<HTMLElement>(".guide-focus")!;
  assert.equal(ring.style.left, "94px"); assert.equal(ring.style.top, "210px"); assert.equal(ring.style.width, "146px"); assert.equal(ring.style.height, "26px");
  assert.match(dom.document.querySelector(".agent-tutorial-location")?.textContent ?? "", /已找到当前经历的项目理解入口/);
  assert.equal(viewport.querySelectorAll("button").length, 1);
  assert.deepEqual(saved().practiced, []);
});

test("phone and short-landscape cards reserve space for their highlighted control", async () => {
  const dimensions = ["innerWidth", "innerHeight"].map(name => [name, Object.getOwnPropertyDescriptor(dom, name)] as const);
  const target = dom.document.createElement("button"); target.dataset.agentGuide = "understanding-start"; dom.document.body.append(target);
  let rect = new dom.DOMRect(16, 395, 95, 27);
  Object.defineProperty(target, "getBoundingClientRect", { value: () => rect });
  try {
    Object.defineProperty(dom, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(dom, "innerHeight", { configurable: true, value: 844 });
    await render();
    let panel = dom.document.querySelector<HTMLElement>(".guide-panel")!;
    assert.equal(panel.style.maxHeight, "376px"); assert.equal(panel.style.top, "452px");
    assert.ok(dom.document.querySelector(".is-constrained"));
    await act(async () => { root!.unmount(); root = undefined; });
    rect = new dom.DOMRect(455, 350, 95, 27);
    Object.defineProperty(dom, "innerWidth", { configurable: true, value: 844 });
    Object.defineProperty(dom, "innerHeight", { configurable: true, value: 390 });
    await render(); panel = dom.document.querySelector<HTMLElement>(".guide-panel")!;
    assert.equal(panel.style.maxWidth, "409px"); assert.equal(panel.style.left, "16px");
  } finally {
    for (const [name, descriptor] of dimensions) { if (descriptor) Object.defineProperty(dom, name, descriptor); else Reflect.deleteProperty(dom, name); }
  }
});
