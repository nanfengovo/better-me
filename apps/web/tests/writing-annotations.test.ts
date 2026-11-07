import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window, type HTMLElement as TestElement } from "happy-dom";
import { inspectWriting, newWritingNote, type WritingSource } from "../src/lib/resume-copilot";
import { WRITING_ANNOTATION_TONES, writingAnnotations, writingPreviewAnchor } from "../src/lib/writing-annotations";
import { measureWritingGeometry, revealWritingPreview } from "../src/lib/resume-writing-observer";
import { quoteWritingText } from "../src/lib/writing-anchor";

function source(index: number): WritingSource {
  return { targetRef: { kind: "claim_text", experienceId: "synthetic", claimId: `claim-${index}`, locale: "zh" },
    text: `负责接口开发，参与系统维护。测试要点 ${index}`, label: `虚构经历 · 要点 ${index}` };
}
function notes(sources: WritingSource[]) {
  return sources.map(item => newWritingNote(item, inspectWriting(item, sources)!));
}

test("Agent annotations do not override the editor-follow highlight", () => {
  const annotations = readFileSync(new URL("../src/components/writing-annotations.css", import.meta.url), "utf8");
  const preview = readFileSync(new URL("../src/components/resume-design.css", import.meta.url), "utf8");
  assert.doesNotMatch(annotations, /\[data-preview-followed[\s\S]*?\{[^}]*(?:outline:\s*none|background:\s*transparent|display:\s*none)/);
  assert.match(preview, /\[data-preview-followed="true"\][\s\S]*?outline:\s*2\.5px solid/);
});

test("annotation identity follows document order, not generated IDs, selection or dismissed notes", () => {
  const sources = Array.from({ length: 10 }, (_, index) => source(index));
  const initial = notes(sources), annotations = writingAnnotations(initial, sources);
  assert.equal(new Set(annotations.map(item => item.tone)).size, 6);
  assert.deepEqual(annotations.map(item => item.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(writingAnnotations(notes(sources), sources).map(item => item.tone), annotations.map(item => item.tone));
  assert.equal(writingAnnotations(initial.slice(1), sources)[0]!.tone, annotations[1]!.tone);
  const quoted = { ...sources[0]!, quote: quoteWritingText(sources[0]!.text, 0, 6)! };
  const pair = writingAnnotations(notes([sources[0]!, quoted]), sources);
  assert.equal(pair[0]!.tone, pair[1]!.tone, "quotes from the same field retain their field color");
  assert.notEqual(pair[0]!.number, pair[1]!.number, "numbers disambiguate shared colors");
});

test("every numbered color has readable white text and annotation motion is finite and optional", () => {
  const css = readFileSync(new URL("../src/components/writing-annotations.css", import.meta.url), "utf8");
  for (const tone of WRITING_ANNOTATION_TONES) {
    const hex = css.match(new RegExp(`\\[data-annotation-tone="${tone}"\\]\\{--annotation-color:#([0-9a-f]{6})`))?.[1];
    assert.ok(hex, `${tone} has an explicit categorical color`);
    const rgb = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const luminance = rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
    assert.ok(1.05 / (luminance + .05) >= 4.5, `${tone} badge meets 4.5:1 white text contrast`);
  }
  assert.doesNotMatch(css, /\binfinite\b/);
  assert.match(css, /\.writing-note\[data-keyboard="true"\]\{animation:none\}/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /@media print\{\.writing-note-index\{display:none!important\}\}/);
});

/** Layout is synthetic and deterministic; no real browser data or network. */
function fixture(run: (value: ReturnType<typeof makeFixture>) => void) {
  const value = makeFixture(), original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: value.dom });
  try { run(value); } finally {
    value.dom.happyDOM.abort();
    if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window");
  }
}
function makeFixture() {
  const dom = new Window({ width: 1200, height: 800 }), document = dom.document;
  const root = document.createElement("main");
  root.innerHTML = '<div class="clip"><div class="resume-preview-canvas"><div class="resume-preview-scale"><div class="resume-preview-stage"></div></div></div></div><aside></aside>';
  document.body.append(root);
  const clip = root.querySelector<TestElement>(".clip")!, canvas = root.querySelector<TestElement>(".resume-preview-canvas")!;
  const paper = root.querySelector<TestElement>(".resume-preview-stage")!, card = root.querySelector<TestElement>("aside")!;
  const rect = (x: number, y: number, width: number, height: number) => new dom.DOMRect(x, y, width, height);
  const bounds = (element: TestElement, x: number, y: number, width: number, height: number) => { element.getBoundingClientRect = () => rect(x, y, width, height); };
  bounds(canvas, 100, 100, 600, 500); bounds(card, 800, 120, 300, 400);
  bounds(root.querySelector<TestElement>(".resume-preview-scale")!, 140, 100, 500, 1800);
  Object.defineProperties(canvas, { clientHeight: { value: 500 }, scrollHeight: { value: 1800 }, clientTop: { value: 0 } });
  const sources = [source(1), source(2)];
  const anchors = sources.map((item, index) => {
    const anchor = document.createElement("p"); anchor.dataset.previewAnchor = writingPreviewAnchor(item);
    anchor.textContent = item.text; bounds(anchor, 150, 160 + index * 50, 400, 18); paper.append(anchor); return anchor;
  });
  let ranges = [[rect(150, 160, 400, 18)], [rect(150, 210, 400, 18)]];
  // happy-dom has no browser layout. Only the Range's geometry is stubbed.
  dom.Range.prototype.getClientRects = function () {
    const parent = this.startContainer.nodeType === 1 ? this.startContainer : this.startContainer.parentElement;
    const index = anchors.findIndex(anchor => parent && (anchor === parent || anchor.contains(parent)));
    return (ranges[index] ?? []) as unknown as ReturnType<InstanceType<typeof dom.Range>["getClientRects"]>;
  };
  const annotations = writingAnnotations(notes(sources), sources);
  const measure = (activeIndex = 0) => measureWritingGeometry(root as unknown as HTMLElement, card as unknown as HTMLElement,
    sources[activeIndex]!, annotations, annotations[activeIndex]!.id);
  return { dom, root, card, clip, canvas, anchors, sources, annotations, rect, bounds, measure,
    setRanges: (value: ReturnType<typeof rect>[][]) => { ranges = value; } };
}

test("visible notes share viewport coordinates and only the active note has a connector", () => fixture(f => {
  const html = f.root.innerHTML, geometry = f.measure()!;
  assert.equal(geometry.visibility, "visible"); assert.equal(geometry.annotations.length, 2);
  assert.deepEqual(geometry.annotations.map(item => item.active), [true, false]);
  assert.match(geometry.path!, /^M 555 169 L 650 169 L 650 144 L 797 144$/);
  assert.deepEqual(geometry.annotations[0]!.lines[0], { x: 150, y: 160, width: 400, height: 18 });
  assert.equal(f.measure(1)!.annotations.filter(item => item.active).length, 1);
  assert.equal(f.root.innerHTML, html, "measuring must never modify printable resume content");
}));

test("highlights clip to scrolling ancestors and report offscreen or hidden sources", () => fixture(f => {
  f.clip.style.overflowY = "hidden"; f.bounds(f.clip, 100, 180, 600, 300);
  assert.equal(f.measure()!.visibility, "above"); assert.equal(f.measure()!.annotations.length, 1);
  f.setRanges([[f.rect(150, 550, 400, 18)], [f.rect(150, 210, 400, 18)]]);
  assert.equal(f.measure()!.visibility, "below");
  f.setRanges([[f.rect(90, 175, 400, 18)], [f.rect(150, 210, 400, 18)]]);
  assert.deepEqual(f.measure()!.annotations[0]!.lines[0], { x: 100, y: 180, width: 390, height: 13 });
  f.clip.hidden = true;
  assert.equal(f.measure()!.visibility, "unavailable"); assert.equal(f.measure()!.annotations.length, 0);
  f.clip.hidden = false; f.card.hidden = true;
  // Browsers return a zero rect for display:none; model that layout result explicitly.
  f.bounds(f.card, 0, 0, 0, 0); assert.equal(f.measure(), null);
}));

test("stale or ambiguous quotes never attach to unrelated text", () => fixture(f => {
  f.anchors[0]!.textContent = "已修改的原文";
  assert.equal(f.measure()!.visibility, "unavailable"); assert.equal(f.measure()!.annotations.length, 1);
  const repeated = "维护系统；维护系统";
  f.sources[0]!.text = repeated; f.anchors[0]!.textContent = repeated;
  f.sources[0]!.quote = { exact: "维护系统", prefix: "", suffix: "", start: 0, end: 4 };
  assert.equal(f.measure()!.visibility, "unavailable"); assert.equal(f.measure()!.path, undefined);
}));

test("inline formatting rects merge and overlapping drawers do not get crossing connectors", () => fixture(f => {
  f.setRanges([[f.rect(150, 160, 180, 18), f.rect(300, 160, 180, 18), f.rect(150, 184, 240, 18)], []]);
  assert.deepEqual(f.measure()!.annotations[0]!.lines, [{ x: 150, y: 160, width: 330, height: 18 }, { x: 150, y: 184, width: 240, height: 18 }]);
  f.bounds(f.card, 500, 120, 300, 400);
  assert.equal(f.measure()!.path, undefined); assert.equal(f.measure()!.annotations.length, 1);
}));

test("explicit note navigation scrolls only the preview and rejects stale targets", () => fixture(f => {
  f.bounds(f.anchors[1]!, 150, 900, 400, 18);
  f.dom.localStorage.setItem("synthetic-follow", "off");
  assert.equal(revealWritingPreview(f.root as unknown as HTMLElement, f.sources[1]!), true);
  assert.equal(f.canvas.scrollTop, 752); assert.equal(f.root.scrollTop, 0); assert.equal(f.dom.scrollY, 0);
  assert.equal(f.dom.localStorage.getItem("synthetic-follow"), "off", "explicit navigation must not change follow preferences");
  f.anchors[1]!.textContent = "已修改";
  assert.equal(revealWritingPreview(f.root as unknown as HTMLElement, f.sources[1]!), false);
  assert.equal(f.canvas.scrollTop, 752);
}));
