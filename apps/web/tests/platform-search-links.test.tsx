import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach, mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

const hooks = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const { PlatformSearchLinks } = await import("../src/components/atlas/PlatformSearchLinks.tsx");
const dom = new Window({ url: "https://platform-search-fixture.invalid" });
type Props = Parameters<typeof PlatformSearchLinks>[0];
function render(patch: Partial<Props> = {}) {
  const html = renderToStaticMarkup(createElement(PlatformSearchLinks, {
    keyword: "C#", regionText: "上海", countryCode: "CN", ...patch,
  }));
  dom.document.body.innerHTML = html;
  return dom.document;
}
afterEach(() => { mock.restoreAll(); dom.document.body.replaceChildren(); });
after(() => { hooks.deregister(); dom.happyDOM.abort(); });

test("collapsed original-site search renders four encoded links and no collection or network effect", () => {
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("Rendering cannot fetch jobs"); });
  let reads = 0;
  const document = render({ onOpenSingleJob: () => { reads++; } });
  assert.equal(document.querySelector("details")!.hasAttribute("open"), false);
  assert.equal(document.querySelectorAll("a").length, 4);
  assert.match(document.body.textContent!, /打开原站搜索；尚未采集到地图/);
  assert.match(document.body.textContent!, /BOSS 当前仅核对搜索参数/);
  assert.match(document.body.textContent!, /读取 \/ 收藏单个岗位/);
  for (const anchor of document.querySelectorAll("a")) {
    const url = new URL(anchor.href);
    assert.ok([...url.searchParams.values()].includes("C#"));
    assert.equal(url.hash, "");
    assert.equal(anchor.target, "_blank");
    assert.equal(anchor.rel, "noopener noreferrer");
  }
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal(reads, 0);
});

test("an unmapped city blocks every platform instead of falling back to the selected country", () => {
  const document = render({ regionText: "未配置的城市" });
  assert.equal(document.querySelectorAll("a").length, 0);
  assert.equal(document.querySelectorAll('[aria-disabled="true"]').length, 4);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /未配置的城市.*尚无明确的平台映射/);
  assert.equal(document.body.textContent!.includes("平台默认地区"), false);
});

test("conflicting country and resolved city cannot quietly lose the country constraint", () => {
  const document = render({ countryCode: "US", regionText: "上海市" });
  assert.equal(document.querySelectorAll("a").length, 0);
  assert.match(document.querySelector('[role="status"]')!.textContent!, /上海.*US.*不一致/);
});

test("an overseas country enables LinkedIn while unmapped domestic providers remain disabled", () => {
  const document = render({ regionText: "", countryCode: "US" });
  const links = document.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(new URL(links[0]!.href).hostname, "www.linkedin.com");
  assert.equal(new URL(links[0]!.href).searchParams.get("location"), "United States");
  assert.equal(document.querySelectorAll('[aria-disabled="true"]').length, 3);
  assert.equal(document.querySelectorAll(".atlas-platform-search-grid .atlas-platform-search-error").length, 3);
});

test("country-only CN retains nationwide platform mappings and empty scope discloses defaults", () => {
  let document = render({ regionText: "", countryCode: "CN" });
  const liepin = document.querySelector('[data-platform-search="liepin"] a')!;
  assert.equal(new URL(liepin.getAttribute("href")!).searchParams.get("dq"), "410");
  document = render({ regionText: "", countryCode: "" });
  assert.equal(document.querySelectorAll("a").length, 4);
  assert.match(document.body.textContent!, /不代表全国或全球搜索/);
  assert.equal(new URL(document.querySelector('[data-platform-search="boss"] a')!.getAttribute("href")!).searchParams.has("city"), false);
});

test("empty keywords allow browsing the selected region and invalid keywords remain rejected", () => {
  for (const keyword of ["", "  "]) {
    const document = render({ keyword });
    assert.equal(document.querySelectorAll("a").length, 4);
    assert.match(document.body.textContent!, /按所选地区浏览岗位/);
  }
  for (const keyword of ["C#\n开发", "x".repeat(301)]) {
    const document = render({ keyword });
    assert.equal(document.querySelectorAll("a").length, 0);
    assert.equal(document.querySelectorAll('[aria-disabled="true"]').length, 4);
  }
});

test("untrusted keyword is escaped in the scope and stays text in the fixed platform query", () => {
  const keyword = '<img src=x onerror=alert(1)> & city=010#evil';
  const document = render({ keyword });
  assert.equal(document.querySelector("img"), null);
  assert.match(document.querySelector(".atlas-platform-search-scope")!.textContent!, /<img src=x/);
  const url = new URL(document.querySelector('[data-platform-search="boss"] a')!.getAttribute("href")!);
  assert.equal(url.origin, "https://www.zhipin.com");
  assert.equal(url.searchParams.get("query"), keyword);
  assert.equal(url.searchParams.get("city"), "101020100");
  assert.equal(url.hash, "");
});
