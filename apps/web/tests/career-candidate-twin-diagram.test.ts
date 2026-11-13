import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { renderTwinDiagramHtml } from "../../agent-host/src/candidate-twin/diagram-html.js";

test("approved diagrams produce actual static accessible SVG and exact textual labels, not raw JSON only", () => {
  const html = renderTwinDiagramHtml({ nodes: [{ id: "private-1", label: "Synthetic API" }, { id: "private-2", label: "SQLite" }], edges: [{ from: "private-1", to: "private-2", label: "" }] }, "publication-1");
  const window = new Window(); window.document.body.innerHTML = html;
  assert.equal(window.document.querySelectorAll("svg[role=img]").length, 1);
  assert.equal(window.document.querySelectorAll("rect").length, 2); assert.equal(window.document.querySelectorAll("path[marker-end]").length, 1);
  assert.match(window.document.body.textContent!, /not proof of implementation or authorship/); assert.match(window.document.body.textContent!, /Synthetic API → SQLite/);
  assert.equal(html.includes("private-1"), false); assert.equal(html.includes("private-2"), false);
  window.happyDOM.abort();
});

test("diagram labels remain escaped text without executable markup, URLs, coordinates or attributes", () => {
  const canary = '<script>alert("synthetic")</script><image href="https://synthetic.invalid/x" onload="evil()">';
  const html = renderTwinDiagramHtml({ nodes: [{ id: 'private-"node', label: canary }], edges: [{ from: 'private-"node', to: 'private-"node', label: '<foreignObject onload="synthetic()">' }] }, 'publication-"canary');
  const window = new Window(); window.document.body.innerHTML = html;
  assert.equal(window.document.querySelectorAll("script,image,foreignObject,a,[onload],[href]").length, 0);
  assert.match(window.document.body.textContent!, /<script>alert\("synthetic"\)<\/script>/);
  assert.equal(html.includes('private-"node'), false); assert.equal(html.includes("NaN"), false); assert.equal(html.includes("Infinity"), false);
  window.happyDOM.abort();
});

test("bounded diagrams reject duplicate IDs, missing endpoints and excessive content without partial render", () => {
  for (const diagram of [
    { nodes: [{ id: "one", label: "One" }, { id: "one", label: "Duplicate" }], edges: [] },
    { nodes: [{ id: "one", label: "One" }], edges: [{ from: "one", to: "missing", label: "" }] },
    { nodes: Array.from({ length: 101 }, (_, index) => ({ id: String(index), label: "Node" })), edges: [] },
    { nodes: [{ id: "one", label: "x".repeat(201) }], edges: [] },
  ]) assert.throws(() => renderTwinDiagramHtml(diagram, "publication-1"), /invalid_twin_diagram/);
});

test("large labels retain exact text while visible layout and generated identifiers stay deterministic", () => {
  const diagram = { nodes: [{ id: "n", label: "合成边界说明".repeat(30) }], edges: [] };
  const first = renderTwinDiagramHtml(diagram, "publication-1"), second = renderTwinDiagramHtml(diagram, "publication-1");
  assert.equal(first, second); assert.ok(first.includes(diagram.nodes[0]!.label)); assert.match(first, /…/);
  assert.notEqual(first, renderTwinDiagramHtml(diagram, "publication-2"));
});
