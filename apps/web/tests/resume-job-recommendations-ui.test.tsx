import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
import { fixtureResume, recommendationDataset } from "./fixtures/resume-recommendations";
import type { RecommendationSource } from "../src/lib/resume-job-source";
import type { DrawerJobContext } from "../src/components/JdMatchDrawer";
import type { ResumeJobRecommendationsProps } from "../src/components/ResumeJobRecommendations";

const dom = new Window({ url: "http://recommendations-fixture.invalid" });
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Recommendations } = await import("../src/components/ResumeJobRecommendations.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const source: RecommendationSource = { dataset: recommendationDataset(), kind: "index", bounded: true };
const noAction = () => {};
async function flush(action: () => void | Promise<void> = noAction) { await act(async () => { await action(); await nextTurn(); await nextTurn(); }); }
function button(name: string) {
  const result = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent) === name);
  assert.ok(result, `missing button ${name}`); return result;
}
async function mount(loadSource: NonNullable<ResumeJobRecommendationsProps["loadSource"]> = async () => source) {
  dom.document.body.innerHTML = "<main></main>";
  root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  const analyzed: DrawerJobContext[] = [];
  let closed = 0;
  let refreshed = 0;
  let edited = 0;
  const render = (requestId = 1, isStale = false) => root!.render(h(Recommendations, { factBase: fixtureResume, requestId, isStale, loadSource,
    onAnalyze: job => analyzed.push(job), onOpenAtlas: noAction, onRefresh: () => { refreshed++; }, onClose: () => { closed++; }, onEditResume: () => { edited++; } }));
  await flush(() => render());
  return { analyzed, render, closed: () => closed, refreshed: () => refreshed, edited: () => edited };
}
afterEach(async () => { await flush(() => root?.unmount()); root = undefined; });
after(async () => { hooks.deregister(); await dom.happyDOM.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("renders three real component cards with evidence and safe source links, hands selected job to existing Agent", async () => {
  const { analyzed, closed } = await mount();
  assert.equal(dom.document.querySelectorAll(".rjr-card").length, 3);
  assert.match(dom.document.body.textContent!, /Redis/);
  assert.match(dom.document.body.textContent!, /在招状态待核实/);
  assert.equal(dom.document.querySelectorAll(".rjr-match").length, 3);
  assert.match(dom.document.querySelector(".rjr-match")!.textContent!, /匹配度.*\d+%/);
  assert.match(dom.document.body.textContent!, /不是录用概率/);
  assert.equal(dom.document.querySelectorAll(".rjr-card details[open]").length, 0);
  for (const anchor of dom.document.querySelectorAll(".rjr-card a")) assert.equal(anchor.getAttribute("rel"), "noopener noreferrer");
  await flush(() => dom.document.querySelector<HTMLButtonElement>(".rjr-card-actions button")!.click());
  assert.equal(analyzed.length, 1);
  assert.equal(analyzed[0]!.title, "RCS 软件工程师");
  assert.equal(analyzed[0]!.description, "RCS 物流 Docker");
  await flush(() => button("关闭岗位推荐").click()); assert.equal(closed(), 1);
});

test("continue editing collapses recommendations and hands focus back without changing facts", async () => {
  const before = JSON.stringify(fixtureResume);
  const { edited } = await mount();
  await flush(() => button("继续编辑简历").click());
  assert.equal(dom.document.querySelector("#resume-job-recommendations-1-body")!.hasAttribute("hidden"), true);
  assert.equal(edited(), 1);
  assert.equal(JSON.stringify(fixtureResume), before);
});

test("progressive results remain usable while reading; stopping preserves them and refresh explicitly bypasses cache", async () => {
  const pending = deferred<RecommendationSource>();
  let publish: ((value: RecommendationSource) => void) | undefined;
  let observed: AbortSignal | undefined;
  const refreshes: boolean[] = [];
  await mount((signal, _profile, options) => { observed = signal; publish = options?.onUpdate; refreshes.push(Boolean(options?.forceRefresh)); return pending.promise; });
  await flush(() => publish?.({ ...source, progress: { completed: 1, total: 3 } }));
  assert.equal(dom.document.querySelectorAll(".rjr-card").length, 3);
  assert.match(dom.document.body.textContent!, /已返回 1\/3 路候选/);
  await flush(() => button("停止").click());
  assert.equal(observed?.aborted, true);
  assert.match(dom.document.body.textContent!, /已停止补全，保留已返回的推荐/);
  assert.equal(dom.document.querySelectorAll(".rjr-card").length, 3);
  await flush(() => button("重新读取岗位").click());
  assert.deepEqual(refreshes, [false, true]);
  pending.resolve(source);
  await flush();
  assert.equal(dom.document.querySelectorAll(".rjr-card").length, 3);
  assert.ok(!dom.document.body.textContent!.includes("继续读取中"));
});

test("stop aborts the real source seam and late results cannot resurrect cancelled output", async () => {
  const pending = deferred<RecommendationSource>(); let observed: AbortSignal | undefined;
  await mount(signal => { observed = signal; return pending.promise; });
  assert.match(dom.document.body.textContent!, /正在读取真实岗位索引/);
  await flush(() => button("停止").click());
  assert.equal(observed?.aborted, true);
  pending.resolve(source); await flush();
  assert.match(dom.document.body.textContent!, /已停止，简历保持不变/);
  assert.equal(dom.document.querySelectorAll(".rjr-card").length, 0);
});

test("new request wins over old source results; collapse removes controls from the accessible body", async () => {
  const old = deferred<RecommendationSource>(); let calls = 0;
  const { render } = await mount(() => ++calls === 1 ? old.promise : Promise.resolve({ ...source, dataset: recommendationDataset([{ id: "new", title: "新的 C# 岗位", description: "C#", city: "上海" }]) }));
  await flush(() => render(2)); old.resolve(source); await flush();
  assert.equal(dom.document.querySelectorAll(".rjr-card").length, 1);
  assert.match(dom.document.querySelector(".rjr-card h3")!.textContent!, /新的 C#/);
  await flush(() => button("收起岗位推荐").click());
  assert.equal(dom.document.querySelector("#resume-job-recommendations-2-body")!.hasAttribute("hidden"), true);
  await flush(() => button("展开岗位推荐").click());
  assert.equal(dom.document.querySelector("#resume-job-recommendations-2-body")!.hasAttribute("hidden"), false);
});

test("location filter reranks cached candidates without rereading service; stale profile requires explicit refresh", async () => {
  let calls = 0; const { render, refreshed } = await mount(async () => { calls++; return source; });
  await flush(() => { const checkbox = dom.document.querySelector<HTMLInputElement>('.rjr-controls input')!; checkbox.click(); });
  assert.equal(dom.document.querySelectorAll(".rjr-card").length, 2);
  assert.equal(calls, 1);
  await flush(() => render(1, true));
  assert.match(dom.document.body.textContent!, /简历已更新/);
  await flush(() => button("按最新简历重选").click()); assert.equal(refreshed(), 1);
});

test("unavailable source and empty match have distinct, actionable states", async () => {
  await mount(async () => { throw new Error("secret diagnostic must not leak"); });
  assert.match(dom.document.body.textContent!, /岗位数据暂时读不到/);
  assert.ok(!dom.document.body.textContent!.includes("secret diagnostic"));
  await flush(() => root?.unmount()); root = undefined;
  await mount(async () => ({ dataset: recommendationDataset([]), kind: "library", notice: "index-unavailable" }));
  assert.match(dom.document.body.textContent!, /索引暂未连上/);
  assert.match(dom.document.body.textContent!, /暂时没有足够相关/);
  assert.equal(dom.document.querySelectorAll(".rjr-card").length, 0);
});

test("persistence clones and save timestamps do not look stale; changed matching evidence does", async () => {
  await mount();
  const saved = structuredClone(fixtureResume);
  saved.updatedAt = "2026-11-01T00:00:00Z";
  const loadSource = async () => source;
  const render = () => root!.render(h(Recommendations, { factBase: fixtureResume, currentFactBase: structuredClone(saved), requestId: 1, loadSource,
    onAnalyze: noAction, onOpenAtlas: noAction, onRefresh: noAction, onClose: noAction }));
  await flush(render);
  assert.ok(!dom.document.body.textContent!.includes("简历已更新"));
  saved.experiences[0]!.techStack.push("Python");
  await flush(render);
  assert.match(dom.document.body.textContent!, /简历已更新/);
  // Current edits must not silently replace the snapshot being used to explain existing results.
  assert.ok(!dom.document.querySelector(".rjr-profile")!.textContent!.includes("Python"));
});
