import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { setImmediate as next } from "node:timers/promises";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import type { AtlasSkillConstellationProps } from "../src/components/AtlasSkillConstellation";
import type { SkillConstellationBinding, SkillConstellationModel, SkillConstellationSceneCallbacks, SkillConstellationSceneFactory, SkillConstellationSceneHandle, VerifiedSkillJobLink } from "../src/lib/skill-constellation";

const cssHook = registerHooks({ load(url, context, step) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : step(url, context); } });
const win = new Window({ url: "https://skill-constellation-fixture.invalid" });
const React = await import("react"), originals = new Map<string, PropertyDescriptor | undefined>();
let network = 0;
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement, Element: win.Element, Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => { network++; throw new Error("Network is forbidden in this synthetic UI fixture"); } })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { default: Constellation } = await import("../src/components/AtlasSkillConstellation");
const binding: SkillConstellationBinding = { ownerId: "synthetic-owner", sessionGeneration: 1, contextId: "synthetic-context", revision: "1" };
let current = binding, root: ReturnType<typeof createRoot> | undefined;
const digest = "a".repeat(64);
function link(jobId = "job-a", overrides: Partial<VerifiedSkillJobLink> = {}): VerifiedSkillJobLink {
  return { id: `badge-a:${jobId}`, badgeId: "badge-a", jobId, sourceHash: "b".repeat(64), skillIds: ["sqlite"], longitude: 121, latitude: 31,
    strength: .5, meaning: "explicit_skill_evidence_overlap_not_hiring_probability", ...overrides };
}
const scene = () => {
  const value = { mounts: 0, disposals: 0, callbacks: undefined as SkillConstellationSceneCallbacks | undefined,
    updates: [] as { model: SkillConstellationModel; selectedJobId?: string }[], focused: [] as string[], navigation: [] as string[], signals: [] as AbortSignal[] };
  const factory: SkillConstellationSceneFactory = (_host, _model, callbacks, options) => {
    value.mounts++; value.callbacks = callbacks; value.signals.push(options.signal);
    callbacks.status({ phase: "loading", renderedFrame: false });
    const handle: SkillConstellationSceneHandle = { update(model, selectedJobId) { value.updates.push({ model, selectedJobId }); },
      focus(id) { value.focused.push(id); }, navigate(action) { value.navigation.push(action); }, dispose() { value.disposals++; } };
    return handle;
  };
  return { ...value, factory, value };
};
function props(factory: SkillConstellationSceneFactory): AtlasSkillConstellationProps {
  return { binding, getCurrentBinding: () => current, badge: { id: "badge-a", label: "合成技能徽章", verificationReceiptId: "receipt-a", sourceHash: digest, skillIds: ["sqlite", "typescript"] },
    links: [link(), link("job-b", { skillIds: ["typescript"], longitude: -122, latitude: 37 })],
    jobMetadata: [{ jobId: "job-a", label: "合成平台工程师", company: "合成甲公司", officeLabel: "甲来源办公室" }, { jobId: "job-b", label: "合成前端工程师", company: "合成乙公司" }],
    sceneFactory: factory, excludedJobs: 3 };
}
async function settle(action = () => {}) { await React.act(async () => { action(); await next(); await next(); }); }
async function mount(value: AtlasSkillConstellationProps) {
  if (!root) { const host = win.document.createElement("div"); win.document.body.append(host); root = createRoot(host as unknown as HTMLElement); }
  await settle(() => root!.render(React.createElement(Constellation, value)));
}
function button(pattern: RegExp) { const result = [...win.document.querySelectorAll("button")].find(item => pattern.test(item.textContent ?? "")); assert.ok(result, `Missing button ${pattern}`); return result; }
async function click(pattern: RegExp) { await settle(() => button(pattern).click()); }
async function query(value: string) { const input = win.document.querySelector('input[type="search"]')!; await settle(() => {
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new win.Event("input", { bubbles: true }));
}); }
afterEach(async () => { await settle(() => { root?.unmount(); root = undefined; }); win.document.body.replaceChildren(); current = binding; assert.equal(network, 0); });
after(async () => { cssHook.deregister(); await win.happyDOM.abort(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("empty or invalid sources do not request a scene or manufacture office positions", async () => {
  const fixture = scene(); await mount({ ...props(fixture.factory), links: [] });
  assert.equal(fixture.value.mounts, 0); assert.match(win.document.body.textContent!, /未请求三维引擎/); assert.match(win.document.body.textContent!, /未知信息不会补成坐标/);
  await mount({ ...props(fixture.factory), badge: { ...props(fixture.factory).badge, sourceHash: "unknown" } });
  assert.equal(fixture.value.mounts, 0); assert.match(win.document.body.textContent!, /没有创建三维场景/);
});

test("a constructed renderer is not called ready until a frame is observed; list selection works without WebGL", async () => {
  const fixture = scene(), selected: string[] = []; await mount({ ...props(fixture.factory), onSelectJob: id => selected.push(id) });
  assert.equal(fixture.value.mounts, 1); assert.match(win.document.body.textContent!, /尚未观察到渲染帧/);
  await click(/^合成平台工程师/); assert.deepEqual(selected, ["job-a"]); assert.match(win.document.querySelector(".asc-selected")!.textContent!, /121, 31/);
  await settle(() => fixture.value.callbacks!.status({ phase: "error", renderedFrame: false, failure: { kind: "gpu", title: "三维图形环境暂不可用", detail: "保留列表" } }));
  assert.match(win.document.body.textContent!, /三维不可用，已保留完整岗位列表/); assert.equal(fixture.value.signals[0]!.aborted, true);
  await settle(() => fixture.value.callbacks!.status({ phase: "ready", renderedFrame: true }));
  assert.equal(win.document.querySelector(".atlas-skill-constellation")!.getAttribute("data-scene-phase"), "error");
  await click(/^重新初始化三维场景$/); assert.equal(fixture.value.mounts, 2); assert.equal(fixture.value.signals[1]!.aborted, false);
});

test("a claimed ready state without postRender evidence fails closed instead of faking a 3D success", async () => {
  const fixture = scene(); await mount(props(fixture.factory));
  await settle(() => fixture.value.callbacks!.status({ phase: "ready", renderedFrame: false }));
  assert.equal(win.document.querySelector(".atlas-skill-constellation")!.getAttribute("data-scene-phase"), "error");
  assert.equal(win.document.querySelector('[aria-label="放大技能星图"]')!.hasAttribute("disabled"), true);
});

test("normal search clear-and-type, skill filters and empty results update the real scene model without rebuilding its Viewer", async () => {
  const fixture = scene(); await mount(props(fixture.factory)); await settle(() => fixture.value.callbacks!.status({ phase: "ready", renderedFrame: true }));
  await query("前端"); assert.equal(win.document.querySelectorAll(".asc-job-list li").length, 1); assert.deepEqual(fixture.value.updates.at(-1)!.model.entries.map(item => item.jobId), ["job-b"]);
  assert.equal(fixture.value.updates.at(-1)!.model.entries[0]!.longitude, -122); assert.equal(fixture.value.mounts, 1);
  await query(""); assert.equal(win.document.querySelectorAll(".asc-job-list li").length, 2);
  const select = win.document.querySelector("select")!; await settle(() => { select.value = "sqlite"; select.dispatchEvent(new win.Event("change", { bubbles: true })); });
  assert.deepEqual(fixture.value.updates.at(-1)!.model.entries.map(item => item.jobId), ["job-a"]);
  await query("missing"); assert.equal(fixture.value.updates.at(-1)!.model.status, "empty"); assert.equal(fixture.value.updates.at(-1)!.model.entries.length, 0); assert.match(win.document.body.textContent!, /不会据此判断岗位关闭/);
  await click(/^清空筛选$/); assert.equal(win.document.querySelectorAll(".asc-job-list li").length, 2); assert.equal(fixture.value.mounts, 1);
});

test("overlapping picks require a specific job and ignore unauthorized ids; keyboard-equivalent buttons drive actual camera commands", async () => {
  const fixture = scene(), selected: string[] = []; await mount({ ...props(fixture.factory), onSelectJob: id => selected.push(id) });
  await settle(() => { fixture.value.callbacks!.status({ phase: "ready", renderedFrame: true }); fixture.value.callbacks!.pick(["job-a", "job-b", "foreign-job"]); });
  assert.deepEqual(selected, []); assert.ok(win.document.querySelector('[aria-label="选择重叠岗位"]'));
  const candidate = win.document.querySelector('[aria-label="选择重叠岗位"] > button')!;
  await settle(() => (candidate as unknown as HTMLButtonElement).click()); assert.deepEqual(selected, ["job-a"]);
  await click(/^在地球定位所选岗位$/); assert.deepEqual(fixture.value.focused, ["job-a"]);
  await settle(() => (win.document.querySelector('[aria-label="放大技能星图"]') as unknown as HTMLButtonElement).click());
  await click(/^总览$/); assert.deepEqual(fixture.value.navigation, ["in", "reset"]);
});

test("badge inspection shows the exact independent receipt and source version without treating the map symbol as Vork output", async () => {
  const fixture = scene(), inspections: string[] = []; await mount({ ...props(fixture.factory), onInspectBadge: id => inspections.push(id) });
  await click(/^查看版本与证据回执$/); assert.deepEqual(inspections, ["badge-a"]);
  const receipt = win.document.querySelector('[aria-label="徽章来源版本与回执"]')!; assert.equal(receipt.hasAttribute("hidden"), false);
  assert.match(receipt.textContent!, /receipt-a/); assert.match(receipt.textContent!, new RegExp(digest)); assert.match(receipt.textContent!, /不独立证明作者身份/);
  assert.match(win.document.body.textContent!, /非光追渲染/); await click(/^收起回执$/); assert.equal(receipt.hasAttribute("hidden"), true);
});

test("owner/session changes hide prior locations, block late picks and dispose a delayed renderer even when it ignores cancellation", async () => {
  let resolveScene: ((handle: SkillConstellationSceneHandle) => void) | undefined, disposed = 0, callbacks: SkillConstellationSceneCallbacks | undefined;
  const selected: string[] = [], factory: SkillConstellationSceneFactory = (_host, _model, nextCallbacks) => { callbacks = nextCallbacks; return new Promise(resolve => { resolveScene = resolve; }); };
  const source = { ...props(factory), onSelectJob: (id: string) => selected.push(id) }; await mount(source);
  current = { ...binding, ownerId: "another-owner", sessionGeneration: 2 }; await mount(source);
  assert.equal(win.document.querySelector(".asc-job-list"), null); assert.match(win.document.body.textContent!, /旧徽章、坐标和连线已隐藏/);
  await settle(() => { callbacks!.pick(["job-a"]); resolveScene!({ update() {}, focus() {}, navigate() {}, dispose() { disposed++; } }); });
  assert.deepEqual(selected, []); assert.equal(disposed, 1);
});

test("pagination is explicit and metadata changes reuse the scene while source changes clear previous authority state", async () => {
  const fixture = scene(), source = props(fixture.factory); await mount({ ...source, links: Array.from({ length: 30 }, (_, index) => link(`job-${index}`)) });
  assert.equal(win.document.querySelectorAll(".asc-job-list li").length, 25); assert.match(win.document.body.textContent!, /显示前25条/);
  await click(/^再显示25条$/); assert.equal(win.document.querySelectorAll(".asc-job-list li").length, 30);
  current = { ...binding, revision: "2" }; await mount({ ...source, binding: current });
  assert.equal(fixture.value.mounts, 2); assert.equal(fixture.value.signals[0]!.aborted, true); assert.equal(win.document.querySelector(".asc-selected"), null);
});

test("narrow, reduced-motion, visible-focus and print/list contracts exist (not actual browser or GPU acceptance)", () => {
  const css = readFileSync(new URL("../src/components/AtlasSkillConstellation.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 960px\)/); assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /prefers-reduced-motion/); assert.match(css, /:focus-visible/); assert.match(css, /@media print/);
  assert.equal(/display:\s*none/.test(/\.asc-job-list\s*\{([^}]+)/.exec(css)?.[1] ?? ""), false);
});
