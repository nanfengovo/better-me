import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";
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
dom.matchMedia = (() => ({ get matches() { return reduced; }, addEventListener(_type: string, listener: () => void) { mediaListeners.add(listener); }, removeEventListener(_type: string, listener: () => void) { mediaListeners.delete(listener); } })) as typeof dom.matchMedia;
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
  await click("把整个磁盘都交给 Agent"); assert.deepEqual(saved().practiced, []);
  assert.match(dom.document.querySelector('[role="status"]')?.textContent ?? "", /可以再试一次/);
  await click("只读示例项目说明"); assert.deepEqual(saved().practiced, ["evidence"]);
  await click("下一节"); assert.equal(saved().current, "dialogue"); assert.deepEqual(saved().practiced, ["evidence"]);
  await click("都不符合，我自己说明");
  assert.ok(dom.document.querySelector("textarea")); assert.match(dom.document.querySelector("label")?.textContent ?? "", /仅示例，不发送/);
  assert.equal(dom.document.querySelectorAll('button[type="submit"]').length, 0);
});
test("annotation exercise shows source/candidate/undo and never changes working content", async () => {
  initial = 4; dom.localStorage.setItem("resume-sentinel", "untouched"); await render();
  await click("查看示例候选"); assert.deepEqual(saved().practiced, []);
  assert.match(dom.document.querySelector(".agent-tutorial-annotation-demo")?.textContent ?? "", /接口重试/);
  await click("撤销示例修改"); assert.deepEqual(saved().practiced, ["annotation"]);
  assert.match(dom.document.querySelector(".agent-tutorial-annotation-demo")?.textContent ?? "", /参与接口开发/);
  assert.equal(dom.localStorage.getItem("resume-sentinel"), "untouched");
});
test("jumping chapters resets only tutorial scroll and focuses the new title", async () => {
  await render(); const article = dom.document.querySelector<HTMLElement>(".agent-tutorial-content")!;
  article.scrollTop = 300;
  await click("第 6 节：收起继续，重载先核对");
  assert.equal(article.scrollTop, 0); assert.equal(dom.document.activeElement?.id, "agent-tutorial-title");
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
  await click("下一节"); assert.equal(animations, 1); assert.ok(canceled > before);
  await act(async () => dom.document.querySelector(".agent-workflow-guide")!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true })));
  assert.ok(animations > 1);
  active = false; await render(); assert.equal(dom.document.querySelector(".agent-workflow-guide")?.getAttribute("data-effects"), "false");
  active = true; await render();
  await act(async () => dom.document.querySelector<HTMLInputElement>('footer input[type="checkbox"]')!.click());
  const count = animations; await click("下一节"); assert.equal(animations, count);
});
test("reduced motion wins initially and after a live system preference change", async () => {
  reduced = true; await render(); assert.equal(animations, 0);
  const effects = dom.document.querySelector<HTMLInputElement>('footer input[type="checkbox"]')!;
  assert.equal(effects.disabled, true); assert.equal(effects.checked, false);
  await act(async () => { reduced = false; for (const listener of mediaListeners) listener(); }); assert.equal(effects.disabled, false);
  const count = animations; await act(async () => { reduced = true; for (const listener of mediaListeners) listener(); });
  await click("下一节"); assert.equal(animations, count); assert.equal(effects.disabled, true);
});
