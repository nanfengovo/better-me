import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import { queryJobs } from "@better-me/opportunities";
import { createAtlasDemo } from "../src/components/atlas/demo";
import { createAtlasListingPresenter } from "../src/components/atlas/presentation";
import type { AtlasJobCardContentProps } from "../src/components/atlas/AtlasJobCardContent";

const dom = new Window({ url: "http://synthetic-atlas-card-content.invalid" });
const React = await import("react");
const globals = { React, window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { source: "export {};", format: "module", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createRoot } = await import("react-dom/client");
const { AtlasJobCardContent } = await import("../src/components/atlas/AtlasJobCardContent");
let root: ReturnType<typeof createRoot> | undefined;
async function fixture() {
  const data = createAtlasDemo();
  const job = data.jobs[0]!;
  job.title = { ...job.title, value: "软件开发工程师" };
  job.description = "任职要求：熟练掌握 C# 和 ASP.NET Core，负责业务系统开发。";
  const item = (await queryJobs(data, { jobIds: [job.id] }, { now: "2026-10-28T00:00:00Z" })).items[0]!;
  return { item, data, hasAnchor: false, keyword: "", countryName: (code: string) => code } satisfies AtlasJobCardContentProps;
}
async function render(props: AtlasJobCardContentProps, controls = { selected: false, filtersOpen: false, originalCurrency: false }) {
  if (!root) {
    dom.document.body.innerHTML = "<main></main>";
    root = createRoot(dom.document.querySelector("main")! as unknown as HTMLElement);
  }
  await React.act(async () => {
    root!.render(<section data-filters-open={controls.filtersOpen} data-original-currency={controls.originalCurrency}>
      <button className={`atlas-job-card ${controls.selected ? "selected" : ""}`} aria-expanded={controls.selected}>
        <AtlasJobCardContent {...props} />
      </button>
    </section>);
  });
  return dom.document.querySelector(".atlas-job-card")!;
}
afterEach(async () => { if (root) await React.act(async () => root!.unmount()); root = undefined; dom.document.body.innerHTML = ""; });
after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("card reading content stays cached for parent selection, filters and currency-control changes", async () => {
  const props: AtlasJobCardContentProps = await fixture();
  const present = createAtlasListingPresenter(props.data!, { now: "2026-10-28T00:00:00Z" });
  let presentations = 0, countries = 0;
  props.presentListing = item => { presentations++; return present(item); };
  props.countryName = code => { countries++; return `来源国家 ${code}`; };
  const card = await render(props);
  const before = card.innerHTML;
  assert.equal(presentations, 1);
  assert.equal(countries, 1);
  for (let index = 0; index < 10; index++) {
    await render(props, { selected: index % 2 === 1, filtersOpen: index % 2 === 0, originalCurrency: index % 2 === 1 });
  }
  assert.equal(card.getAttribute("aria-expanded"), "true", "the parent still updates selection immediately");
  assert.equal(card.innerHTML, before, "reading content and RMB card salary preserve their established semantics");
  assert.equal(presentations, 1, "parent-only state never calls the real listing presenter again");
  assert.equal(countries, 1, "parent-only state never rebuilds static country labels");
  assert.equal(dom.document.querySelectorAll("button").length, 1, "the content seam adds no nested button or interaction owner");
});

test("raw keyword changes update the AI match fragment without rebuilding heading, salary and disclosures", async () => {
  const props: AtlasJobCardContentProps = await fixture();
  const present = createAtlasListingPresenter(props.data!);
  let presentations = 0, countries = 0;
  props.presentListing = item => { presentations++; return present(item); };
  props.countryName = code => { countries++; return code; };
  const card = await render(props);
  const title = card.querySelector("strong");
  const salary = card.querySelector(".atlas-job-salary");
  const disclosure = card.querySelector(".job-source-badges");
  assert.equal(card.querySelector(".atlas-ai-penetration-tag"), null);
  await render({ ...props, keyword: "C#" });
  assert.match(card.querySelector(".atlas-ai-penetration-tag")?.textContent ?? "", /AI 穿透命中/);
  await render({ ...props, keyword: "Java" });
  assert.equal(card.querySelector(".atlas-ai-penetration-tag"), null, "keywords are never debounced or held stale by the presentation cache");
  assert.equal(card.querySelector("strong"), title);
  assert.equal(card.querySelector(".atlas-job-salary"), salary);
  assert.equal(card.querySelector(".job-source-badges"), disclosure);
  assert.equal(presentations, 1);
  assert.equal(countries, 1);
});

test("a source city-only location retains its more specific published text without claiming an office address", async () => {
  const props = await fixture();
  const item = { ...props.item, locations: props.item.locations.map(location => ({ ...location, city: "上海", raw: "上海·浦东新区", streetAddress: undefined })) };
  const card = await render({ ...props, item });
  assert.match(card.querySelector(".atlas-job-meta")!.textContent!, /上海·浦东新区/);
  assert.doesNotMatch(card.querySelector(".atlas-job-meta")!.textContent!, /办公地址/);
});

test("immutable item, data, anchor, presenter and country formatter changes remain visible", async () => {
  let props: AtlasJobCardContentProps = await fixture();
  const card = await render(props);
  assert.match(card.querySelector(".atlas-badge-distance")!.textContent, /未设家坐标/);
  props = { ...props, hasAnchor: true };
  await render(props);
  assert.match(card.querySelector(".atlas-badge-distance")!.textContent, /距家 待定位/);
  props = { ...props, item: { ...props.item,
    job: { ...props.item.job, title: { ...props.item.job.title, value: "更新后的岗位" } },
    company: { ...props.item.company, names: ["更新后的公司"] },
    locations: props.item.locations.map(location => ({ ...location, streetAddress: "合成测试路 66 号" })),
    salary: { ...props.item.salary!, cnyAnnual: { min: 860_000, max: 960_000 } },
  } };
  await render(props);
  assert.equal(card.querySelector("strong")!.textContent, "更新后的岗位");
  assert.match(card.querySelector(".atlas-company-line")!.textContent, /更新后的公司/);
  assert.match(card.querySelector(".atlas-job-meta")!.textContent, /合成测试路 66 号/);
  assert.equal(card.querySelector(".atlas-job-salary")!.textContent, "¥86–96万/年");
  props = { ...props, data: { ...props.data!, observations: props.data!.observations.map(observation => ({ ...observation, sourcePublishedAt: "2025-01-12T00:00:00Z" })) } };
  await render(props);
  assert.equal(card.querySelector(".atlas-badge-publication")!.textContent, "2025-01-12");
  const present = createAtlasListingPresenter(props.data!);
  props = { ...props, presentListing: item => present(item).map(presentation => ({ ...presentation, label: "已更新来源披露" })), countryName: () => "更新后的国家名称" };
  await render(props);
  assert.match(card.querySelector(".job-source-badges")!.textContent, /已更新来源披露/);
  assert.match(card.querySelector(".atlas-job-classification")!.textContent, /更新后的国家名称/);
});
