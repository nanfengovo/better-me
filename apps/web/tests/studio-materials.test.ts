import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const css = readFileSync(new URL("../src/components/studio-materials.css", import.meta.url), "utf8");

test("studio material CSS parses and never targets paper or editing highlights", () => {
  const window = new Window();
  const sheet = new window.CSSStyleSheet();
  sheet.replaceSync(css);
  assert.ok(sheet.cssRules.length >= 5);
  assert.doesNotMatch(css, /\.resume-sheet|\.resume-paper|data-preview-followed|data-annotation/);
  assert.doesNotMatch(css, /!important|animation:|transition:/);
  window.happyDOM.abort();
});

test("material rules affect screen chrome only and unsupported blur only changes tokens", () => {
  const window = new Window();
  const sheet = new window.CSSStyleSheet();
  sheet.replaceSync(css);
  for (const rule of sheet.cssRules) {
    assert.match(rule.cssText, /^@(?:media screen|supports not)/);
    if (rule.cssText.startsWith("@supports")) assert.doesNotMatch(rule.cssText.slice(rule.cssText.indexOf("{")), /(?<!-)background:|border-radius:|backdrop-filter:/);
  }
  window.happyDOM.abort();
});

test("materials honor accessibility fallbacks, dark tokens and compact edge-to-edge sidebar", () => {
  for (const preference of ["prefers-reduced-transparency:reduce", "prefers-contrast:more", "forced-colors:active"]) assert.ok(css.includes(preference));
  assert.ok(css.includes(":root[data-theme=dark]"));
  assert.ok(css.includes("backdrop-filter:none"));
  assert.match(css, /max-width:840px[\s\S]*?\.agent-sidebar \{ border-radius:0; \}/);
  const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.ok(entry.indexOf("studio-materials.css") > entry.indexOf("studio-workbench.css"));
});
