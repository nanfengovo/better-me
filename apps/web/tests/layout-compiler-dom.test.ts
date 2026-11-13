import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { A4_PAGE, diagnoseLayout, measureDomLayout, mmToCssPx, type LayoutMeasurement, type LayoutScope } from "../src/lib/layout-compiler/index";

const windows: Window[] = [];
after(async () => { await Promise.all(windows.map(window => window.happyDOM.abort())); });
const scope: LayoutScope = { ownerId: "synthetic-owner", sessionGeneration: 1, documentId: "synthetic-resume", revision: "1", contentHash: "synthetic-content" };

/** happy-dom has no layout engine. These unit fixtures supply observed box/Range
 * geometry to exercise the Adapter, not evidence that a real browser paginates it. */
function fixture(zoom = 0.8, text = "实现可靠并发机制") {
  const window = new Window({ url: "http://synthetic.invalid" });
  windows.push(window);
  const document = window.document;
  const root = document.createElement("article");
  root.style.width = "210mm";
  const claim = document.createElement("li");
  claim.setAttribute("data-preview-anchor", "claim:synthetic");
  claim.textContent = text;
  root.append(claim);
  document.body.append(root);
  const offset = { x: 100, y: 40 };
  const width = Math.round(mmToCssPx(210)), height = 1200;
  const margin = mmToCssPx(16);
  const box = (x: number, y: number, boxWidth: number, boxHeight: number) => new window.DOMRect(offset.x + x * zoom, offset.y + y * zoom, boxWidth * zoom, boxHeight * zoom);
  Object.defineProperties(root, { offsetWidth: { configurable: true, value: width }, offsetHeight: { configurable: true, value: height } });
  root.getBoundingClientRect = () => box(0, 0, width, height);
  claim.getBoundingClientRect = () => box(margin, margin + 10, 90, 20);
  const rangePrototype = window.Range.prototype as unknown as { getClientRects(): DOMRectList };
  rangePrototype.getClientRects = function () {
    const range = this as unknown as { startOffset: number; endOffset: number; startContainer: { textContent: string } };
    const index = range.startOffset;
    // Eight characters: six on line one, two on line two.
    const line = Math.floor(index / 6), column = index % 6;
    return [box(margin + column * 10, margin + 10 + line * 10, 10, 10)] as unknown as DOMRectList;
  };
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve(), check: () => true } });
  return { window, root: root as unknown as HTMLElement, claim: claim as unknown as HTMLElement, box, margin };
}

function measured(result: LayoutMeasurement) {
  assert.equal(result.status, "measured");
  if (result.status !== "measured") assert.fail(result.detail);
  return result;
}

test("real Range boxes are normalized from preview zoom into print-content coordinates with Claim anchors", async () => {
  for (const zoom of [0.5, 0.8, 1.5]) {
    const { root, window } = fixture(zoom);
    Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
    const result = measured(await measureDomLayout(root, { scope, settleFrames: 0 }));
    assert.deepEqual(result.scale, { x: zoom, y: zoom });
    const claim = result.blocks[0]!;
    assert.equal(claim.kind, "claim");
    assert.equal(claim.anchor, "claim:synthetic");
    assert.ok(Math.abs(claim.rect.x) < 0.001);
    assert.ok(Math.abs(claim.rect.y - 10) < 0.001);
    assert.equal(claim.lines.length, 2);
    assert.equal(claim.lines[0]?.text, "实现可靠并发");
    assert.equal(claim.lines[1]?.text, "机制");
    assert.ok(Math.abs(claim.lines[0]!.rect.width - 60) < 0.001);
    assert.equal(result.source, "dom-estimate");
    assert.equal(result.finalEvidence, undefined);
    assert.equal(result.limitations.some(detail => detail.includes("PDF and DOCX")), true);
  }
});

test("a genuine single-line CSS heading box is not overflow merely because its font Range em box extends above the line box", async () => {
  const { root, claim, window, box, margin } = fixture(1, "候选人");
  const heading = window.document.createElement("h1"); heading.textContent = claim.textContent; heading.dataset.previewAnchor = "profile:displayName";
  heading.style.lineHeight = "44.8px"; heading.style.fontSize = "37.3333px"; claim.replaceWith(heading as unknown as Node);
  heading.getBoundingClientRect = () => box(margin, margin, 672.75, 44.8);
  const prototype = window.Range.prototype as unknown as { getClientRects(): DOMRectList };
  prototype.getClientRects = function () { const range = this as unknown as { startOffset: number }; return [box(margin + 240 + range.startOffset * 20, margin - 4, 20, 52)] as unknown as DOMRectList; };
  const result = measured(await measureDomLayout(root, { scope, settleFrames: 0 })), block = result.blocks[0]!;
  assert.ok(Math.abs(block.lines[0]!.rect.y + 4) < .01, "original measured font Range remains intact");
  const report = diagnoseLayout(result); assert.equal(report.status, "diagnosed");
  if (report.status === "diagnosed") assert.equal(report.issues.some(issue => issue.kind === "overflow"), false);
  assert.ok(result.limitations.some(detail => /single-line.*CSS line box/i.test(detail)));
  heading.style.overflowY = "hidden";
  const clipped = diagnoseLayout(await measureDomLayout(root, { scope, settleFrames: 0 }));
  assert.ok(clipped.status === "diagnosed" && clipped.issues.some(issue => issue.kind === "overflow"), "real clipping is not relaxed by the line-box rule");
  heading.style.overflowY = "visible"; heading.getBoundingClientRect = () => box(margin, margin, 672.75, 30);
  const fixedHeight = diagnoseLayout(await measureDomLayout(root, { scope, settleFrames: 0 }));
  assert.ok(fixedHeight.status === "diagnosed" && fixedHeight.issues.some(issue => issue.kind === "overflow"), "a smaller fixed-height box is not a measured CSS line box");
});

test("print margins are omitted only for an explicitly print-content-sized root", async () => {
  const { root, box, margin } = fixture(1);
  Object.defineProperty(root, "offsetWidth", { configurable: true, value: Math.round(mmToCssPx(210 - 32)) });
  root.getBoundingClientRect = () => box(0, 0, root.offsetWidth, root.offsetHeight);
  const result = measured(await measureDomLayout(root, { scope, coordinateSpace: "content", settleFrames: 0 }));
  assert.ok(Math.abs(result.blocks[0]!.rect.x - margin) < 0.001);
  const wrong = await measureDomLayout(root, { scope, coordinateSpace: "paper", settleFrames: 0 });
  assert.equal(wrong.status, "unavailable");
  if (wrong.status === "unavailable") assert.equal(wrong.reason, "print-width-mismatch");
});

test("hidden, detached and zero-size print roots are unavailable, never clean layouts", async () => {
  const hidden = fixture();
  hidden.root.style.display = "none";
  const result = await measureDomLayout(hidden.root, { scope, settleFrames: 0 });
  if (result.status === "unavailable") assert.equal(result.reason, "hidden"); else assert.fail("hidden root was measured");
  const detached = fixture();
  detached.root.remove();
  const detachedResult = await measureDomLayout(detached.root, { scope, settleFrames: 0 });
  if (detachedResult.status === "unavailable") assert.equal(detachedResult.reason, "detached"); else assert.fail("detached root was measured");
  const zero = fixture();
  Object.defineProperty(zero.root, "offsetWidth", { configurable: true, value: 0 });
  const zeroResult = await measureDomLayout(zero.root, { scope, settleFrames: 0 });
  if (zeroResult.status === "unavailable") assert.equal(zeroResult.reason, "zero-size"); else assert.fail("zero root was measured");
});

test("font readiness and image decode finish before geometry is observed; missing expected fonts are explicit", async () => {
  const { root, window, box } = fixture();
  let resolveFonts!: () => void;
  let fontsReady = false, imageReady = false, geometryReads = 0;
  Object.defineProperty(root.ownerDocument, "fonts", { configurable: true, value: {
    ready: new Promise<void>(resolve => { resolveFonts = () => { fontsReady = true; resolve(); }; }), check: () => false,
  } });
  const image = window.document.createElement("img");
  Object.defineProperties(image, { complete: { value: false }, naturalWidth: { get: () => imageReady ? 100 : 0 } });
  image.decode = async () => { assert.equal(fontsReady, true); imageReady = true; };
  image.getBoundingClientRect = () => { assert.equal(imageReady, true); geometryReads++; return box(65, 100, 50, 50); };
  root.append(image as unknown as Node);
  const pending = measureDomLayout(root, { scope, settleFrames: 0, expectedFonts: ['12px "Synthetic Missing Font"'] });
  assert.equal(geometryReads, 0);
  resolveFonts();
  const result = measured(await pending);
  assert.equal(result.blocks.some(block => block.kind === "image"), true);
  assert.equal(result.fontChecks?.[0]?.available, false);
  assert.equal(result.limitations.some(detail => detail.includes("fallback font")), true);
});

test("unready assets time out, failed images fail closed, and cancellation interrupts font waits", async () => {
  const unready = fixture();
  Object.defineProperty(unready.root.ownerDocument, "fonts", { configurable: true, value: { ready: new Promise(() => {}), check: () => true } });
  const timed = await measureDomLayout(unready.root, { scope, settleFrames: 0, timeoutMs: 10 });
  if (timed.status === "unavailable") assert.equal(timed.reason, "timeout"); else assert.fail("unready fonts were measured");
  const controller = new AbortController();
  const pending = measureDomLayout(unready.root, { scope, signal: controller.signal, timeoutMs: 1000, settleFrames: 0 });
  controller.abort();
  const cancelled = await pending;
  if (cancelled.status === "unavailable") assert.equal(cancelled.reason, "cancelled"); else assert.fail("cancelled measurement completed");
  const failed = fixture();
  const image = failed.window.document.createElement("img");
  Object.defineProperties(image, { complete: { value: false }, naturalWidth: { value: 0 } });
  image.decode = async () => { throw new Error("synthetic decode failure"); };
  failed.root.append(image as unknown as Node);
  const imageResult = await measureDomLayout(failed.root, { scope, settleFrames: 0 });
  if (imageResult.status === "unavailable") assert.equal(imageResult.reason, "image-unavailable"); else assert.fail("failed image was measured");
});

test("a session/version change while fonts settle invalidates the result", async () => {
  const { root } = fixture();
  let resolveFonts!: () => void;
  let current = true;
  Object.defineProperty(root.ownerDocument, "fonts", { configurable: true, value: { ready: new Promise<void>(resolve => { resolveFonts = resolve; }), check: () => true } });
  const pending = measureDomLayout(root, { scope, settleFrames: 0, isCurrent: () => current });
  current = false;
  resolveFonts();
  const result = await pending;
  if (result.status === "unavailable") assert.equal(result.reason, "stale"); else assert.fail("stale version was measured");
});

test("responsive wrapping, skew and reflected transforms are not normalized into invented print evidence", async () => {
  const responsive = fixture();
  Object.defineProperty(responsive.root, "offsetWidth", { configurable: true, value: 600 });
  const result = await measureDomLayout(responsive.root, { scope, settleFrames: 0 });
  if (result.status === "unavailable") assert.equal(result.reason, "print-width-mismatch"); else assert.fail("responsive root was accepted");
  for (const transform of ["matrix(1, 0.2, 0, 1, 0, 0)", "matrix(-1, 0, 0, 1, 0, 0)"]) {
    const rotated = fixture();
    rotated.claim.style.transform = transform;
    const rotatedResult = await measureDomLayout(rotated.root, { scope, settleFrames: 0 });
    if (rotatedResult.status === "unavailable") assert.equal(rotatedResult.reason, "unsupported-transform"); else assert.fail("unsupported transform was accepted");
  }
});

test("visible text without Range geometry and measurement-budget overflow return unavailable", async () => {
  const missing = fixture();
  (missing.window.Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
  const result = await measureDomLayout(missing.root, { scope, settleFrames: 0 });
  if (result.status === "unavailable") assert.equal(result.reason, "range-unavailable"); else assert.fail("missing text geometry was accepted");
  const bounded = fixture();
  const budget = await measureDomLayout(bounded.root, { scope, settleFrames: 0, maxTextCharacters: 2 });
  if (budget.status === "unavailable") assert.equal(budget.reason, "measurement-budget"); else assert.fail("over-budget measurement completed");
});

test("custom block selection cannot escape the authorized root and hidden descendants do not create evidence", async () => {
  const selected = fixture();
  const outside = selected.window.document.createElement("p");
  selected.window.document.body.append(outside);
  const result = await measureDomLayout(selected.root, { scope, settleFrames: 0, selectBlocks: () => [outside as unknown as Element] });
  if (result.status === "unavailable") assert.equal(result.reason, "invalid-measurement"); else assert.fail("escaped selector accepted");
  selected.claim.style.visibility = "hidden";
  const hidden = await measureDomLayout(selected.root, { scope, settleFrames: 0 });
  if (hidden.status === "unavailable") assert.equal(hidden.reason, "empty"); else assert.fail("hidden claim produced evidence");
});

test("an explicitly different paper specification must actually match the laid-out width", async () => {
  const { root } = fixture();
  const result = await measureDomLayout(root, { scope, settleFrames: 0, page: { ...A4_PAGE, widthMm: 216 } });
  if (result.status === "unavailable") assert.equal(result.reason, "print-width-mismatch"); else assert.fail("wrong paper accepted");
});

test("missing font-readiness APIs are unavailable and compiler render bindings survive measurement", async () => {
  const missing = fixture();
  Object.defineProperty(missing.root.ownerDocument, "fonts", { configurable: true, value: undefined });
  const result = await measureDomLayout(missing.root, { scope, settleFrames: 0 });
  if (result.status === "unavailable") assert.equal(result.reason, "fonts-unavailable"); else assert.fail("unobserved font readiness was accepted");
  const ready = fixture();
  const binding = { candidateId: "synthetic-candidate", fingerprint: "synthetic-payload-key" };
  const observed = measured(await measureDomLayout(ready.root, { scope, renderBinding: binding, settleFrames: 0 }));
  assert.deepEqual(observed.renderBinding, binding);
  assert.notEqual(observed.renderBinding, binding);
});
