import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { A4_PAGE, captureFinalLayoutExpectedDocument } from "../src/lib/layout-compiler";

test("the authorized Template text baseline includes complete source text and hrefs, excluding hidden DOM rather than guessing a PDF", async () => {
  const win = new Window({ url: "https://final-source-fixture.invalid" });
  try {
    const root = win.document.createElement("article"); root.lang = "en"; root.style.opacity = "0";
    root.innerHTML = '<h1 style="text-transform:uppercase" data-preview-anchor="profile:displayName">Sample Engineer</h1><h2>Work</h2><ul><li data-preview-anchor="claim:c1">Built <strong>10ms</strong> checks, not production.</li><li style="display:none">hidden private source</li></ul><footer><a href="https://example.invalid/evidence">Evidence</a></footer>';
    win.document.body.append(root);
    const expected = captureFinalLayoutExpectedDocument(root as unknown as HTMLElement, A4_PAGE);
    assert.match(expected.bodyText, /SAMPLE ENGINEER/); assert.match(expected.bodyText, /10ms/); assert.equal(expected.bodyText.includes("hidden private source"), false);
    assert.deepEqual(expected.links, ["https://example.invalid/evidence"]); assert.equal(expected.blocks.find(block => block.anchor === "claim:c1")!.kind, "claim");
    assert.equal(expected.blocks.find(block => block.text === "Work")!.keepWithNext, true); assert.equal("pageCount" in expected, false);
    root.style.display = "none"; assert.throws(() => captureFinalLayoutExpectedDocument(root as unknown as HTMLElement, A4_PAGE), /不可观测/);
  } finally { await win.happyDOM.abort(); }
});

test("detached or empty roots cannot establish an all-body integrity baseline", async () => {
  const win = new Window();
  try {
    const root = win.document.createElement("article"); root.textContent = "detached";
    assert.throws(() => captureFinalLayoutExpectedDocument(root as unknown as HTMLElement, A4_PAGE), /尚未挂载/);
    root.textContent = ""; win.document.body.append(root); assert.throws(() => captureFinalLayoutExpectedDocument(root as unknown as HTMLElement, A4_PAGE), /正文为空/);
  } finally { await win.happyDOM.abort(); }
});
