import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import test, { after, afterEach } from "node:test";
import { Window, type HTMLButtonElement } from "happy-dom";
import { formatAtlasPublication, getAtlasSourceBadge, getDefaultAtlasPresentationConfig, type AtlasListingPresentation } from "../src/components/atlas/presentation.ts";
import { addOpportunity, emptyOpportunityLibrary, exportOpportunityJson, OPPORTUNITY_STORAGE_KEY, readOpportunityLibrary, type OpportunityInput } from "../src/lib/opportunities.ts";
import type { JdProvenance } from "../src/lib/jd-source.ts";

const hooks = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "http://source-badges-fixture.invalid" });
const React = await import("react");
const { createElement: h, act } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
const { ConfirmationProvider } = await import("../src/components/ConfirmationDialog.tsx");
const { SourcePublicationBadges, AtlasListingBadges } = await import("../src/components/atlas/JobSourceBadges.tsx");
const { OpportunityWorkspace } = await import("../src/components/OpportunityWorkspace.tsx");
const { JdMatchModal } = await import("../src/components/JdMatchModal.tsx");
let root: ReturnType<typeof createRoot> | undefined;
const NOW = "2026-10-18T12:00:00.000Z";
async function mount(child: React.ReactNode, locale: "zh" | "en" = "zh") {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => { root!.render(h(UiPreferencesProvider, { initialPreferences: { locale, theme: "light" }, children: h(ConfirmationProvider, { children: child }) })); });
}
const noAction = () => {};
function workspace(seed?: Parameters<typeof OpportunityWorkspace>[0]["seed"]) {
  return h(OpportunityWorkspace, { seed, onSeedConsumed: noAction, onOpenJd: noAction, onOpenNetworkSettings: noAction,
    onAnalyze: noAction, onCreateResume: noAction, linkedResumeNames: {}, getCurrentResumeMaterial: () => { throw new Error("Not part of this fixture"); } });
}
function fixture(inputs: OpportunityInput[]) {
  let library = emptyOpportunityLibrary();
  for (const input of inputs) library = addOpportunity(library, input, NOW).library;
  dom.localStorage.setItem(OPPORTUNITY_STORAGE_KEY, exportOpportunityJson(library));
}
function listing(id: string, publishedAt?: string): AtlasListingPresentation {
  return { listingId: `listing-${id}`, sourceId: id, label: id, url: `https://jobs.example.invalid/${id}`,
    badge: getAtlasSourceBadge({ sourceId: id }), publication: formatAtlasPublication({ publishedAt }, { now: NOW }) };
}
function label(name: string) {
  const result = [...dom.document.querySelectorAll("label")].find((node) => node.firstChild?.textContent === name);
  assert.ok(result, `Missing form label ${name}`); return result;
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; dom.localStorage.clear(); });
after(() => {
  hooks.deregister(); dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test("source and publication badges apply separately configured colors and semantic exact times", async () => {
  const config = getDefaultAtlasPresentationConfig();
  config.sourceRules.unshift({ id: "custom", sourceIds: ["my-board"], colors: { foreground: "#112233", background: "#EEDDCC", border: "#AABBCC" } });
  config.publicationColors.fresh = { foreground: "#334455", background: "#DDEEFF", border: "#BBCCDD" };
  await mount(h(SourcePublicationBadges, { sourceLabel: "My board", sourceId: "my-board", publishedAt: "2026-10-18T10:00:00Z", now: NOW, config }));
  const source = dom.document.querySelector(".job-source-badge")!, publication = dom.document.querySelector(".job-publication-badge")!;
  assert.ok(source.getAttribute("style")!.includes("#112233"));
  assert.ok(source.getAttribute("style")!.toLowerCase().includes("#eeddcc"));
  assert.ok(publication.getAttribute("style")!.includes("#334455"));
  assert.equal(publication.tagName, "TIME"); assert.equal(publication.getAttribute("datetime"), "2026-10-18T10:00:00Z");
  assert.equal(publication.textContent, "2 小时前发布"); assert.ok(publication.getAttribute("title")!.includes("Asia/Shanghai"));
  assert.equal(dom.document.querySelector("a"), null);
});

test("unknown, raw, old and future publication facts stay distinct, and text is escaped", async () => {
  await mount(h("div", null,
    h(SourcePublicationBadges, { sourceLabel: "Unknown", now: NOW }),
    h(SourcePublicationBadges, { sourceLabel: "Raw", publishedRaw: "<b>3天前</b>", now: NOW }),
    h(SourcePublicationBadges, { sourceLabel: "Old", publishedAt: "2026-09-18T12:00:00Z", now: NOW }),
    h(SourcePublicationBadges, { sourceLabel: "Future", publishedRaw: "2026-10-19", now: NOW })));
  const badges = [...dom.document.querySelectorAll(".job-publication-badge")];
  assert.deepEqual(badges.map((badge) => badge.getAttribute("data-publication-status")), ["unknown", "unknown", "older", "review"]);
  assert.equal(badges[0]!.textContent, "发布时间未知"); assert.equal(badges[0]!.tagName, "SPAN");
  assert.equal(badges[1]!.textContent, "发布时间原文：<b>3天前</b>"); assert.equal(badges[1]!.querySelector("b"), null);
  assert.equal(badges[2]!.textContent, "2026-09-18 发布"); assert.ok(badges[3]!.textContent!.includes("未来日期"));
  assert.equal(badges[3]!.getAttribute("datetime"), "2026-10-19");
});

test("linked source badges allow HTTP URLs without credentials and reject executable or credential URLs", async () => {
  const urls = ["https://jobs.example.invalid/42", "javascript:alert(1)", "https://user:secret@example.invalid/jobs", "data:text/html,bad"];
  await mount(h("div", null, ...urls.map((sourceUrl, index) => h(SourcePublicationBadges, { key: sourceUrl, sourceLabel: `Source ${index}`, sourceUrl, link: true, now: NOW }))));
  const anchors = dom.document.querySelectorAll("a");
  assert.equal(anchors.length, 1); assert.equal(anchors[0]!.getAttribute("href"), urls[0]);
  assert.equal(anchors[0]!.getAttribute("target"), "_blank"); assert.equal(anchors[0]!.getAttribute("rel"), "noopener noreferrer");
});

test("multiple listings retain separate colors, publication dates and links, with finite style values", async () => {
  const presentations = [listing("boss", "2026-10-18T10:00:00Z"), listing("linkedin", "2026-08-01T00:00:00Z")];
  presentations.push({ ...listing("unknown"), label: "Untrusted", badge: { ...getAtlasSourceBadge({ sourceId: "unknown" }), foreground: "url(https://example.invalid/pixel)" } });
  await mount(h(AtlasListingBadges, { presentations, link: true }));
  const rows = [...dom.document.querySelectorAll(".job-source-publication")];
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.querySelector("time")!.textContent, "2 小时前发布");
  assert.equal(rows[1]!.querySelector("time")!.textContent, "2026-08-01 发布");
  assert.equal(rows[2]!.querySelector(".job-publication-badge")!.textContent, "发布时间未知");
  assert.notEqual(rows[0]!.querySelector("a")!.getAttribute("style"), rows[1]!.querySelector("a")!.getAttribute("style"));
  assert.ok(!rows[2]!.querySelector("a")!.getAttribute("style")!.includes("url("));
});

test("English workspace preferences also localize publication uncertainty and dates", async () => {
  await mount(h("div", null, h(SourcePublicationBadges, { sourceLabel: "Company careers", now: NOW }),
    h(SourcePublicationBadges, { sourceLabel: "Company careers", publishedAt: "2026-08-01T00:00:00Z", now: NOW })), "en");
  assert.equal(dom.document.querySelector(".job-publication-badge")!.textContent, "Publication time unknown");
  assert.ok(dom.document.body.textContent.includes("Published 2026-08-01"));
});

test("legacy workspace list, board and details share source badges while collection/update/verification stay separate", async () => {
  fixture([{ company: "Synthetic employer", title: "Synthetic engineer", sourcePlatform: "BOSS直聘", sourceUrl: "https://www.zhipin.com/job_detail/42.html", sourcePublishedAt: "2000-01-01T00:00:00Z", sourceUpdatedAt: "2026-10-17T00:00:00Z", lastVerifiedAt: "2026-10-18T10:00:00Z", lastVerificationMethod: "manual" },
    { company: "Unknown date employer", title: "No publication disclosed", sourcePlatform: "猎聘", sourceUpdatedAt: NOW, lastVerifiedAt: NOW }]);
  await mount(workspace());
  assert.equal(dom.document.querySelectorAll(".opportunity-list .job-source-badge").length, 2);
  const rows = [...dom.document.querySelectorAll(".opportunity-row")];
  const known = rows.find((row) => row.textContent!.includes("Synthetic engineer"))!;
  const unknown = rows.find((row) => row.textContent!.includes("No publication disclosed"))!;
  assert.equal(known.querySelector(".job-publication-badge")!.textContent, "2000-01-01 发布");
  assert.equal(unknown.querySelector(".job-publication-badge")!.textContent, "发布时间未知");
  assert.equal(known.querySelector("button a"), null);
  await act(async () => { known.querySelector("button")!.click(); });
  assert.equal(dom.document.querySelector(".opportunity-detail .job-source-badge")!.tagName, "A");
  const facts = dom.document.querySelector(".opportunity-provenance")!.textContent!;
  for (const text of ["平台刷新时间", "首次发现时间", "本次采集时间", "最近核验时间与方式", "2026-10-17", "人工记录"]) assert.ok(facts.includes(text), text);
  await act(async () => { dom.document.querySelector<HTMLButtonElement>('[aria-label="关闭岗位详情"]')!.click(); dom.document.querySelector<HTMLButtonElement>('[aria-label="投递看板"]')!.click(); });
  assert.equal(dom.document.querySelectorAll(".opportunity-board .job-source-badge").length, 2);
});

test("map-to-opportunity seed preserves source publication precision and never substitutes collection time", async () => {
  const published = "2026-09-01T12:34:56.789Z";
  await mount(workspace({ token: "synthetic-seed", title: "Seed engineer", description: "Synthetic JD", sourcePlatform: "LinkedIn", sourcePublishedAt: published, sourcePublishedText: "Sep 1, 2026", collectedAt: NOW }));
  const company = label("公司名称").querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(company, "Synthetic employer");
    company.dispatchEvent(new dom.Event("input", { bubbles: true }));
    company.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
  await act(async () => { dom.document.querySelector("form.opportunity-form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })); });
  const saved = readOpportunityLibrary().library.jobs[0];
  assert.ok(saved, dom.document.body.textContent);
  assert.equal(saved.sourcePublishedAt, published); assert.equal(saved.sourcePublishedText, "Sep 1, 2026"); assert.equal(saved.collectedAt, NOW);
});

test("date-only publication seeds retain raw precision without inventing a midnight timestamp", async () => {
  await mount(workspace({ token: "synthetic-date-seed", title: "Date-only engineer", description: "Synthetic JD", sourcePlatform: "Company careers", sourcePublishedText: "2026-10-18", collectedAt: NOW }));
  assert.equal(label("原始发布时间").querySelector("input")!.value, "");
  const company = label("公司名称").querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(company, "Synthetic employer");
    company.dispatchEvent(new dom.Event("input", { bubbles: true }));
    company.dispatchEvent(new dom.Event("change", { bubbles: true }));
  });
  await act(async () => { dom.document.querySelector("form.opportunity-form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })); });
  const saved = readOpportunityLibrary().library.jobs[0]!;
  assert.equal(saved.sourcePublishedAt, undefined); assert.equal(saved.sourcePublishedText, "2026-10-18"); assert.equal(saved.collectedAt, NOW);
});

test("JD extraction review, confirmed text and save callback all retain original source publication", async () => {
  const sourcePublishedAt = "2000-01-01T12:34:56.789Z", sourceUrl = "https://www.linkedin.com/jobs/view/123";
  const originalFetch = globalThis.fetch;
  let saved: { text: string; provenance: JdProvenance | null } | undefined;
  const description = "Synthetic current job description with responsibilities and explicit requirements.";
  globalThis.fetch = async (url) => {
    assert.equal(url, "/api/jd/extract");
    return new Response(JSON.stringify({ text: description, method: "Synthetic JobPosting", provenance: { kind: "link", platform: "LinkedIn", url: sourceUrl, observedAt: NOW, sourcePublishedAt, sourcePublishedText: sourcePublishedAt } }), { headers: { "content-type": "application/json" } });
  };
  const button = (name: string) => {
    const found = [...dom.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);
    assert.ok(found, `Missing button ${name}`); return found;
  };
  const flush = async (action: () => void) => { await act(async () => { action(); await nextTurn(); await nextTurn(); }); };
  try {
    await mount(h(JdMatchModal, { isOpen: true, onClose: noAction, onOpenConfig: noAction, onOpenNetworkSettings: noAction,
      resume: { locale: "zh", templateId: "zh-classic", profile: { displayName: "Synthetic candidate", links: [], targetRoles: [], traits: [] }, experiences: [] },
      llmConfig: { provider: "openai-compatible", baseUrl: "https://unused.example.invalid", apiKey: "", model: "fixture", temperature: 0.3 },
      onSaveOpportunity: (draft) => { saved = draft; } }));
    await flush(() => button("分享链接").click());
    await flush(() => {
      const field = dom.document.getElementById("jd-share")!;
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(field, sourceUrl);
      field.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await flush(() => button("提取岗位正文").click());
    assert.equal(dom.document.querySelector(".job-publication-badge")!.getAttribute("datetime"), sourcePublishedAt);
    assert.equal(dom.document.querySelector(".job-source-badge")!.getAttribute("href"), sourceUrl);
    await flush(() => button("确认并使用正文").click());
    assert.equal(dom.document.querySelector(".job-publication-badge")!.getAttribute("datetime"), sourcePublishedAt);
    await flush(() => button("收藏到机会库").click());
    assert.ok(saved); assert.equal(saved.text, description); assert.equal(saved.provenance?.sourcePublishedAt, sourcePublishedAt);
    assert.equal(saved.provenance?.sourcePublishedText, sourcePublishedAt); assert.equal(saved.provenance?.observedAt, NOW);
  } finally { globalThis.fetch = originalFetch; }
});

test("opening JD analysis shows the selected initial source publication rather than an unrelated saved draft", async () => {
  dom.localStorage.setItem("betterme.jd-draft.v1", JSON.stringify({ text: "An unrelated old draft", shareInput: "", provenance: { kind: "link", platform: "BOSS直聘", url: "https://www.zhipin.com/job_detail/old.html", observedAt: NOW, sourcePublishedAt: "1999-01-01T00:00:00Z" } }));
  await mount(h(JdMatchModal, { isOpen: true, onClose: noAction, onOpenConfig: noAction, onOpenNetworkSettings: noAction,
    initialText: "The selected synthetic current job description with responsibilities and requirements.",
    initialSource: { title: "Selected engineer", platform: "Company careers", url: "https://careers.example.invalid/selected", observedAt: NOW, sourcePublishedText: "2000-01-01" },
    resume: { locale: "zh", templateId: "zh-classic", profile: { displayName: "Synthetic candidate", links: [], targetRoles: [], traits: [] }, experiences: [] },
    llmConfig: { provider: "openai-compatible", baseUrl: "https://unused.example.invalid", apiKey: "", model: "fixture", temperature: 0.3 } }));
  const badges = dom.document.querySelectorAll(".job-source-badges");
  assert.equal(badges.length, 1); assert.equal(badges[0]!.querySelector(".job-source-badge")!.textContent, "Company careers");
  assert.equal(badges[0]!.querySelector("time")!.getAttribute("datetime"), "2000-01-01");
  assert.equal(badges[0]!.querySelector("time")!.textContent, "2000-01-01 发布（仅日期）");
  assert.ok(!dom.document.body.textContent.includes("1999-01-01"));
});
