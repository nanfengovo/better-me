import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://agent-guide-fixture.invalid" });
Object.defineProperty(dom.HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  writable: true,
  value: () => {},
});

for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const { executeAgentGuide } = await import("../src/lib/agent-guide.ts");

test("executeAgentGuide renders untrusted label text safely without injecting HTML elements", () => {
  dom.document.body.innerHTML = '<div data-editor-anchor="profile:headline">Summary</div>';
  const payload = '<img src="x" onerror="alert(1)"> & <b>bold</b>';

  const ok = executeAgentGuide({ anchor: "profile:headline", label: payload });
  assert.equal(ok, true);

  const beacon = dom.document.querySelector(".agent-guide-beacon");
  assert.ok(beacon, "renders guide beacon");
  assert.equal(beacon.querySelector("img"), null);
  assert.equal(beacon.querySelector("b"), null);
  const spans = beacon.querySelectorAll("span");
  assert.equal(spans.length, 2);
  assert.equal(spans[0]!.textContent, "✨");
  assert.equal(spans[1]!.textContent, payload);
});
