import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { Window, type HTMLButtonElement, type HTMLAnchorElement } from "happy-dom";
import { queryJobs } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo.ts";
import { createMapReferenceFixture } from "./fixtures/atlas-map-references.ts";
import { buildAtlasListingPresentations } from "../src/components/atlas/presentation.ts";
import type { AtlasJobDetailProps } from "../src/components/atlas/AtlasJobDetail.tsx";
import { officeConfirmed } from "./fixtures/atlas-office-address.ts";

const dom = new Window({ url: "http://atlas-job-detail-fixture.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { source: "export {};", format: "module", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createRoot } = await import("react-dom/client");
const { AtlasJobDetail } = await import("../src/components/atlas/AtlasJobDetail.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const noAction = () => {};

async function fixture(): Promise<AtlasJobDetailProps> {
  const data = createAtlasDemo();
  data.observations[0]!.sourcePublishedRaw = "2026-10-10";
  const item = (await queryJobs(data, { jobIds: [data.jobs[0]!.id] }, { now: "2026-10-19T00:00:00Z" })).items[0]!;
  return { item, data, demo: false, originalCurrency: false,
    presentations: buildAtlasListingPresentations(data, item, { now: "2026-10-19T00:00:00Z" }),
    onClose: noAction, onLocate: noAction, onSave: noAction, onAnalyze: noAction };
}
async function render(props: AtlasJobDetailProps) {
  if (!root) {
    dom.document.body.innerHTML = '<button id="job-card">A job card</button><main></main>';
    dom.document.getElementById("job-card")!.focus();
    root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  }
  await act(async () => { root!.render(h(AtlasJobDetail, props)); });
  return dom.document.querySelector(".atlas-job-detail")!;
}
function button(label: string) {
  const node = [...dom.document.querySelectorAll<HTMLButtonElement>(".atlas-job-detail button")].find((entry) => entry.textContent?.trim() === label);
  assert.ok(node, `Missing button: ${label}`); return node;
}
function descriptionFixture(props: AtlasJobDetailProps, completeness: "detail" | "excerpt") {
  const observation = props.data.observations.find((entry) => entry.listingId === props.item.sources[0]!.listingId)!;
  props.item.job.selectedSnapshotId = "snapshot.synthetic";
  observation.snapshotId = "snapshot.synthetic"; observation.completeness = completeness;
  props.data.snapshots.push({ id: "snapshot.synthetic", listingId: observation.listingId, observationId: observation.id,
    text: props.item.job.description, contentHash: "a".repeat(64), createdAt: "2026-10-19T00:00:00Z", extractionMethod: "manual", completeness });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; dom.document.body.innerHTML = "";
});
after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("the non-modal pane leaves card focus intact and closes by its visible button or Escape", async () => {
  const props = await fixture(); let closes = 0; props.onClose = () => { closes++; };
  const pane = await render(props);
  assert.equal(pane.id, "atlas-job-detail"); assert.equal(pane.tagName, "ASIDE");
  assert.equal(pane.getAttribute("aria-modal"), null);
  assert.equal(dom.document.activeElement?.id, "job-card", "mounting must not steal the second click/double-click focus");
  assert.equal(pane.querySelector("h2")?.textContent, props.item.job.title.value);
  const close = pane.querySelector<HTMLButtonElement>('[aria-label="关闭岗位详情"]')!;
  assert.ok(close); await act(async () => close.click()); assert.equal(closes, 1);
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" }))); assert.equal(closes, 2);
  const handled = new dom.KeyboardEvent("keydown", { key: "Escape", cancelable: true }); handled.preventDefault();
  await act(async () => dom.dispatchEvent(handled)); assert.equal(closes, 2);
  await act(async () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", isComposing: true }))); assert.equal(closes, 2);
  await act(async () => root!.unmount()); root = undefined;
  dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" })); assert.equal(closes, 2, "unmount removes the listener");
});

test("a city distribution reference is labelled separately, links its place source and never supplies an office or home distance", async () => {
  const props = await fixture(), location = props.data.locations[0]!; delete location.coordinates; location.precision = "unknown";
  const before = structuredClone(props.data), batch = await createMapReferenceFixture(props.data);
  props.item = (await queryJobs(props.data, { jobIds: [props.data.jobs[0]!.id] }, { now: "2026-10-19T00:00:00Z", mapReferences: batch })).items[0]!;
  let located: string | undefined; props.onLocate = id => { located = id; };
  const pane = await render(props); assert.match(pane.textContent!, /城市分布参考.*城市估算，非办公地址；不用于离家距离/);
  const link = [...pane.querySelectorAll<HTMLAnchorElement>("a")].find(entry => entry.textContent?.includes("地名数据出处")); assert.ok(link);
  assert.equal(link.getAttribute("href"), "https://places.example.invalid/0"); assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  await act(async () => button("定位城市参考").click()); assert.equal(located, location.id);
  assert.equal(props.item.distance, undefined); assert.equal(props.item.locations[0]!.coordinates, undefined); assert.deepEqual(props.data, before);
  props.item.mapReferences![0]!.sourceRecordUrl = "javascript:syntheticUnsafe()"; await render(props);
  assert.equal([...pane.querySelectorAll("a")].some(entry => entry.textContent?.includes("地名数据出处")), false);
  props.item.locations[0]!.coordinates = { latitude: 40, longitude: 116, coordinateSystem: "WGS84" }; props.item.locations[0]!.precision = "address";
  await render(props); assert.equal([...pane.querySelectorAll("button")].some(entry => entry.textContent?.includes("定位城市参考")), false);
  assert.ok(button("地图定位"));
});

test("published streets with only a coarse point label the next action as address review; precise points keep locate", async () => {
  const props = await fixture(), location = props.item.locations[0]!;
  location.kind = "office"; location.streetAddress = "Synthetic Source Road 10"; location.precision = "city";
  location.coordinates = {latitude: 31.2, longitude: 121.4, coordinateSystem: "WGS84"};
  props.onConfirmOffice = noAction;
  let located: string | undefined; props.onLocate = id => { located = id; };
  await render(props); await act(async () => button("核对地址后定位").click()); assert.equal(located, location.id);
  location.precision = "address"; await render(props); assert.ok(button("地图定位"));
  location.precision = "city"; props.onConfirmOffice = undefined;
  await render(props); assert.ok(button("地图定位"), "a disconnected reading pane does not promise the local review flow");
});

test("manual office addresses retain source text, structured street/postal fields, unverified labels and their own evidence link", async () => {
  const props = await fixture();
  props.item.locations = [structuredClone(officeConfirmed)];
  let chosen: typeof officeConfirmed | undefined; props.onConfirmOffice = location => { chosen = location; };
  const pane = await render(props), location = props.item.locations[0]!;
  assert.match(pane.textContent!, /办公楼.*本人核对的办公位置.*待核实.*非来源认证/);
  assert.match(pane.textContent!, /本人核对的街道／门牌.*Synthetic Example Road 10/); assert.match(pane.textContent!, /本人核对的邮政编码.*200000/);
  assert.doesNotMatch(pane.textContent!, /来源披露的街道／门牌|来源披露的邮政编码/);
  assert.match(pane.textContent!, /本人核对的地址.*手工核对，仍待核实/);
  assert.ok(pane.textContent!.includes(location.raw), "the publisher location remains visible next to the local address");
  const evidence = [...pane.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent?.includes("地址核对出处"))!;
  assert.equal(evidence.href, location.officeResolution!.evidenceUrl); assert.equal(evidence.target, "_blank"); assert.match(evidence.rel, /noopener/);
  await act(async () => button("核对办公地址").click()); assert.equal(chosen, location);
  location.officeResolution!.evidenceUrl = "javascript:syntheticUnsafe()";
  await render(props); assert.equal([...pane.querySelectorAll("a")].some(link => link.getAttribute("href")?.startsWith("javascript:")), false);
});

test("publisher-disclosed street and postal fields retain their source label without a local office decision", async () => {
  const props = await fixture();
  props.item.locations = [{ ...props.item.locations[0]!, streetAddress: "Synthetic published street 20", postalCode: "100000" }];
  const pane = await render(props);
  assert.match(pane.textContent!, /来源披露的街道／门牌.*Synthetic published street 20/);
  assert.match(pane.textContent!, /来源披露的邮政编码.*100000/);
  assert.doesNotMatch(pane.textContent!, /本人核对的街道／门牌|本人核对的邮政编码/);
  const maps = [...pane.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent?.includes("Google"))!;
  assert.ok(new URL(maps.href).searchParams.get("query")!.startsWith("Synthetic published street 20"), "a disclosed street takes priority over a coarse city point in the external maps query");
});

test("office review is offered only for real office locations with source evidence", async () => {
  const props = await fixture(); props.onConfirmOffice = () => {};
  for (const value of [{ ...officeConfirmed, kind: "remote-region" as const }, { ...officeConfirmed, kind: "unknown" as const }, { ...officeConfirmed, evidence: [] }]) {
    props.item.locations = [value]; const pane = await render(props);
    assert.equal([...pane.querySelectorAll("button")].some(node => node.textContent === "核对办公地址"), false);
  }
  props.item.locations = [structuredClone(officeConfirmed)]; props.demo = true;
  const pane = await render(props); assert.equal([...pane.querySelectorAll("button")].some(node => node.textContent === "核对办公地址"), false);
});

test("the prominent original link is bound to this listing, safe and accompanied by source/date badges", async () => {
  const props = await fixture(); const pane = await render(props);
  const original = pane.querySelector<HTMLAnchorElement>(".atlas-job-detail-original")!;
  assert.ok(original); assert.match(original.textContent!, /打开岗位原文/);
  assert.equal(original.href, props.presentations[0]!.url); assert.equal(original.target, "_blank");
  assert.equal(original.rel, "noopener noreferrer");
  assert.equal(pane.querySelector(".job-source-badge")?.textContent, props.presentations[0]!.label);
  assert.equal(pane.querySelector(".job-publication-badge")?.getAttribute("data-publication-precision"), "date");
  assert.equal(pane.querySelector<HTMLAnchorElement>(".job-source-badge")?.href, original.href);
});

test("unsafe or unrelated original URLs never become anchors", async () => {
  const props = await fixture();
  for (const url of ["javascript:alert(1)", "https://user:password@example.invalid/job", "https://unrelated.example.invalid/job"]) {
    props.presentations = [{ ...props.presentations[0]!, url }];
    const pane = await render(props);
    assert.equal(pane.querySelector(".atlas-job-detail-original"), null);
    assert.equal(pane.querySelector("a.job-source-badge"), null);
    assert.match(pane.textContent!, /尚未提供可核对的岗位原文链接/);
  }
  props.presentations = [{ ...props.presentations[0]!, listingId: "another-job-listing", url: "https://example.invalid/another-job" }];
  const pane = await render(props); assert.equal(pane.querySelector(".job-source-badge"), null);
});

test("locations use existing coordinates or original text and missing coordinates remain actionable", async () => {
  const props = await fixture(); const calls: Array<string | undefined> = []; props.onLocate = (id) => calls.push(id);
  let pane = await render(props);
  let maps = pane.querySelector<HTMLAnchorElement>('.atlas-job-detail-location a')!;
  assert.equal(new URL(maps.href).searchParams.get("query"), "31.23,121.47");
  assert.match(pane.querySelector(".atlas-job-detail-location small")!.textContent!, /城市估算.*非办公地址/);
  assert.doesNotMatch(pane.textContent!, /办公楼/);
  await act(async () => button("地图定位").click()); assert.deepEqual(calls, [props.item.locations[0]!.id]);
  delete props.item.locations[0]!.coordinates;
  pane = await render(props); maps = pane.querySelector<HTMLAnchorElement>('.atlas-job-detail-location a')!;
  assert.equal(new URL(maps.href).searchParams.get("query"), props.item.locations[0]!.raw);
  await act(async () => button("查找城市位置").click()); assert.equal(calls[1], props.item.locations[0]!.id);
  props.item.locations = []; await render(props);
  await act(async () => button("查找岗位位置").click()); assert.equal(calls[2], undefined);
});

test("remote eligibility is not offered as an office coordinate or city candidate", async () => {
  const props = await fixture(); props.item.locations[0]!.kind = "remote-region";
  const pane = await render(props);
  assert.match(pane.querySelector(".atlas-job-detail-location small")!.textContent!, /远程资格范围.*非办公地点/);
  assert.equal(pane.querySelector(".atlas-job-detail-location button"), null);
  const maps = pane.querySelector<HTMLAnchorElement>(".atlas-job-detail-location a")!;
  assert.equal(new URL(maps.href).searchParams.get("query"), props.item.locations[0]!.raw);
});

test("source excerpts stay labelled and untrusted description text never becomes markup", async () => {
  const props = await fixture(); props.item.job.description = '<script>bad()</script>\nResponsibilities from a synthetic source.';
  descriptionFixture(props, "excerpt");
  let pane = await render(props);
  assert.match(pane.querySelector(".atlas-job-detail-section-heading")!.textContent!, /来源摘录/);
  assert.match(pane.querySelector(".atlas-job-detail-excerpt")!.textContent!, /可能缺少任职要求/);
  assert.equal(pane.querySelector("script"), null); assert.match(pane.querySelector(".atlas-job-detail-copy")!.textContent!, /<script>/);
  props.data.snapshots[0]!.text = "An unrelated snapshot body";
  pane = await render(props); assert.match(pane.querySelector(".atlas-job-detail-section-heading")!.textContent!, /完整性未核实/);
});

test("a matching full snapshot, actions and the root-owned candidate slot retain their business behavior", async () => {
  const props = await fixture(); descriptionFixture(props, "detail");
  let saves = 0; let analyses = 0; let candidates = 0;
  props.onSave = () => { saves++; }; props.onAnalyze = () => { analyses++; };
  props.children = h("div", { "data-root-candidate-state": true }, h("button", { onClick: () => { candidates++; } }, "选择测试城市候选"));
  const pane = await render(props);
  assert.equal(pane.querySelector(".atlas-job-detail-excerpt"), null);
  assert.match(pane.querySelector(".atlas-job-detail-section-heading")!.textContent!, /来源正文/);
  await act(async () => { button("收藏到机会与投递").click(); button("用这份 JD 分析简历").click(); button("选择测试城市候选").click(); });
  assert.equal(saves, 1); assert.equal(analyses, 1); assert.equal(candidates, 1);
  assert.ok(pane.querySelector(".atlas-job-detail-locations [data-root-candidate-state]"));
});

test("demo records and empty descriptions cannot invoke live career actions", async () => {
  const props = await fixture(); let writes = 0; props.demo = true; props.onSave = props.onAnalyze = () => { writes++; };
  let pane = await render(props);
  assert.equal(pane.querySelector(".atlas-job-detail-original"), null); assert.equal(pane.querySelector("a.job-source-badge"), null);
  assert.equal(button("收藏到机会与投递").disabled, true); assert.equal(button("用这份 JD 分析简历").disabled, true);
  await act(async () => { button("收藏到机会与投递").click(); button("用这份 JD 分析简历").click(); }); assert.equal(writes, 0);
  props.demo = false; props.item.job.description = "   "; pane = await render(props);
  assert.equal(button("收藏到机会与投递").disabled, false); assert.equal(button("用这份 JD 分析简历").disabled, true);
  assert.match(pane.querySelector(".atlas-job-detail-copy")!.textContent!, /未提供岗位正文/);
});

test("switching to another job resets only the pane scroll and preserves outside focus", async () => {
  const props = await fixture(); await render(props);
  const body = dom.document.querySelector<HTMLDivElement>(".atlas-job-detail-body")!;
  body.scrollTop = 260;
  const other = (await queryJobs(props.data, { jobIds: [props.data.jobs[1]!.id] }, { now: "2026-10-19T00:00:00Z" })).items[0]!;
  props.item = other; props.presentations = buildAtlasListingPresentations(props.data, other);
  await render(props);
  assert.equal(body.scrollTop, 0); assert.equal(dom.document.activeElement?.id, "job-card");
  assert.equal(dom.document.querySelector(".atlas-job-detail")!.getAttribute("data-job-id"), other.job.id);
});
