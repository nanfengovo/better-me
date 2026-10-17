import assert from "node:assert/strict";
import test from "node:test";
import { getFitPreviewZoom, getPreviewScrollTop, resolvePreviewAnchor } from "../src/lib/preview-follow";

function anchor(value: string) { return { getAttribute: (name: string) => name === "data-preview-anchor" ? value : null }; }

test("preview following resolves factual IDs exactly, then only explicit parent fallbacks", () => {
  const unrelated = anchor("claim:unrelated");
  const parent = anchor("experience:parent");
  const exact = anchor('claim:abc"]:not(*)');
  const elements = [unrelated, parent, exact];
  assert.equal(resolvePreviewAnchor(elements, { anchor: 'claim:abc"]:not(*)', fallbackAnchors: ["experience:parent"], source: "focus" }), exact);
  assert.equal(resolvePreviewAnchor(elements, { anchor: "claim:hidden", fallbackAnchors: ["experience:parent"], source: "focus" }), parent);
  assert.equal(resolvePreviewAnchor(elements, { anchor: "claim:hidden", source: "scroll" }), undefined);
  assert.equal(resolvePreviewAnchor(elements, { anchor: "claim:hidden", fallbackAnchors: ["experience:hidden"], source: "scroll" }), undefined);
});

test("visible focused text keeps its current position instead of jittering on every keystroke", () => {
  assert.equal(getPreviewScrollTop({ anchorTop: 200, anchorHeight: 40, canvasTop: 100, scrollTop: 280, viewportHeight: 500, scrollHeight: 1800 }, { anchor: "claim:a", source: "focus" }), 280);
});

test("follow uses zoomed visual coordinates relative to its own scroll canvas", () => {
  // At 80% zoom this anchor is already 160 visual pixels tall: do not apply zoom again.
  assert.equal(getPreviewScrollTop({ anchorTop: 900, anchorHeight: 160, canvasTop: 200, canvasBorderTop: 2, scrollTop: 100, viewportHeight: 500, scrollHeight: 2000 }, { anchor: "claim:a", source: "focus" }), 750);
});

test("long editor blocks map progress within the matching long preview block", () => {
  const metrics = { anchorTop: 150, anchorHeight: 1200, canvasTop: 100, scrollTop: 500, viewportHeight: 500, scrollHeight: 2500 };
  assert.equal(getPreviewScrollTop(metrics, { anchor: "experience:a", source: "scroll", progress: 0 }), 502);
  assert.equal(getPreviewScrollTop(metrics, { anchor: "experience:a", source: "scroll", progress: .5 }), 900);
  assert.equal(getPreviewScrollTop(metrics, { anchor: "experience:a", source: "scroll", progress: 1 }), 1298);
  assert.equal(getPreviewScrollTop(metrics, { anchor: "experience:a", source: "scroll", progress: 8 }), 1298);
});

test("preview following clamps to canvas boundaries and ignores unavailable layout", () => {
  const metrics = { anchorTop: 0, anchorHeight: 20, canvasTop: 100, scrollTop: 0, viewportHeight: 500, scrollHeight: 800 };
  assert.equal(getPreviewScrollTop(metrics, { anchor: "profile", source: "scroll" }), 0);
  assert.equal(getPreviewScrollTop({ ...metrics, anchorTop: 2000 }, { anchor: "claim:last", source: "scroll" }), 300);
  assert.equal(getPreviewScrollTop({ ...metrics, scrollTop: 37, viewportHeight: 0 }, { anchor: "profile", source: "scroll" }), 37);
  assert.equal(getPreviewScrollTop({ ...metrics, scrollTop: 37, anchorTop: NaN }, { anchor: "profile", source: "scroll" }), 37);
});

test("fit width accounts for actual gutters and can shrink below manual default for a narrow pane", () => {
  assert.equal(getFitPreviewZoom(850, 56, 794), 100);
  assert.equal(getFitPreviewZoom(390, 56, 794), 42);
  assert.equal(getFitPreviewZoom(1500, 56, 794), 130);
  assert.equal(getFitPreviewZoom(120, 56, 794), 20);
  assert.equal(getFitPreviewZoom(0, 56, 794), 80);
});
