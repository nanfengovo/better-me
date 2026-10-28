import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { Window, type HTMLButtonElement } from "happy-dom";
import type { LiveHarvestCard, LiveHarvestView } from "../src/components/atlas/live-harvest-view";

const dom = new Window({ url: "http://live-harvest-fixture.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { AtlasLiveHarvestResults } = await import("../src/components/atlas/AtlasLiveHarvestResults");
let root: ReturnType<typeof createRoot> | undefined;

function card(index: number): LiveHarvestCard {
  return {
    provider: "51job", platform: "51JOB",
    card: { url: `https://jobs.51job.com/shanghai/${100000000 + index}.html`, platform: "51JOB", title: `Synthetic job ${index}`, company: "Synthetic company", cardText: `Synthetic job ${index}`, evidence: { pageUrl: "https://we.51job.com/pc/search?keyword=Java", cardSelector: ".job", fields: [{ field: "title", selector: ".title", text: `Synthetic job ${index}` }] } },
  };
}

function view(cards: LiveHarvestCard[]): LiveHarvestView {
  return { capturedAt: "2026-10-27T12:00:00.000Z", query: { keyword: "Java" }, cards, totalCards: cards.length, providers: [{ provider: "51job", platform: "51JOB", status: "running", cardCount: cards.length, progressCardsCaptured: cards.length, pagesVisited: 2, scrollSteps: 0, warnings: [], coverage: { pagesVisited: 2, pageLimit: 15, scrollSteps: 0, scrollLimit: 0, cardLimit: 1_500, stopReason: "page_limit", partial: true } }] };
}

async function render(value: LiveHarvestView) {
  if (!root) { dom.document.body.innerHTML = "<main></main>"; root = createRoot(dom.document.querySelector("main")! as unknown as Element); }
  await act(async () => root!.render(h(AtlasLiveHarvestResults, { view: value, busy: true })));
}

function button(label: string) {
  const result = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(entry => entry.textContent?.trim() === label);
  assert.ok(result, `Missing button: ${label}`);
  return result;
}

afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; dom.document.body.replaceChildren(); });
after(() => { dom.happyDOM.abort(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("new cards append without changing the reader's page, existing card nodes or focus", async () => {
  const cards = Array.from({ length: 100 }, (_, index) => card(index + 1));
  await render(view(cards));
  await act(async () => button("下一页").click());
  const firstCard = dom.document.querySelector(".atlas-live-harvest-card");
  const focusedButton = button("上一页");
  focusedButton.focus();
  assert.equal(firstCard?.querySelector("h4")?.textContent, "Synthetic job 51");

  await render(view([...cards, ...Array.from({ length: 20 }, (_, index) => card(index + 101))]));
  assert.equal(dom.document.querySelector(".atlas-live-harvest-card") === firstCard, true, "existing cards retain their DOM nodes");
  assert.equal(dom.document.activeElement === focusedButton, true, "incoming cards do not move keyboard focus");
  assert.match(dom.document.querySelector('[aria-label="实时岗位分页"]')?.textContent ?? "", /51–100 \/ 120/);
  assert.equal(dom.document.querySelector(".atlas-live-harvest-sources")?.hasAttribute("open"), false);
  await act(async () => button("查看新增 20").click());
  assert.equal(dom.document.querySelector(".atlas-live-harvest-card h4")?.textContent, "Synthetic job 101");
  assert.equal(dom.document.querySelectorAll(".atlas-live-harvest-card").length, 20);
  assert.doesNotMatch(dom.document.body.textContent ?? "", /查看新增/);
});

test("metadata updates do not rerender card content while the card reference stays unchanged", async () => {
  let urlReads = 0;
  const cards = Array.from({ length: 50 }, (_, index) => {
    const entry = card(index + 1);
    const url = entry.card.url;
    Object.defineProperty(entry.card, "url", { enumerable: true, get() { urlReads++; return url; } });
    return entry;
  });
  await render(view(cards));
  urlReads = 0;
  for (let index = 0; index < 10; index++) await render(view(cards));
  assert.equal(urlReads, 0, "provider metadata must not reread visible card URLs during rendering");
});
