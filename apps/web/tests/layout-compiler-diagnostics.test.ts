import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnoseLayout, mmToCssPx, printGeometry,
  type FinalOutputEvidence, type LayoutBlock, type LayoutScope, type MeasuredLayout, type PrintPageSpec,
} from "../src/lib/layout-compiler/index";

const scope: LayoutScope = { ownerId: "synthetic-owner", sessionGeneration: 1, documentId: "synthetic-resume", revision: "1", contentHash: "synthetic-content-1" };
const page: PrintPageSpec = { widthMm: 100 * 25.4 / 96, heightMm: 100 * 25.4 / 96, marginMm: { top: 0, right: 0, bottom: 0, left: 0 } };
function block(overrides: Partial<LayoutBlock> = {}): LayoutBlock {
  return { id: "claim:synthetic", anchor: "claim:synthetic", kind: "claim", order: 0, text: "一条完整描述",
    rect: { x: 0, y: 10, width: 90, height: 80 }, lines: [{ rect: { x: 0, y: 80, width: 90, height: 10 }, text: "一条完整描述" }], ...overrides };
}
function measured(blocks: LayoutBlock[], overrides: Partial<MeasuredLayout> = {}): MeasuredLayout {
  return { status: "measured", scope, source: "dom-estimate", page, pageCount: 1, blocks, measuredAt: "2026-11-09T00:00:00Z", limitations: [], ...overrides };
}
function evidence(format: "pdf" | "docx" = "pdf"): FinalOutputEvidence {
  return { format, artifactSha256: "a".repeat(64), inputContentHash: scope.contentHash,
    renderer: { name: "synthetic-final-renderer", version: "1" }, renderedAt: "2026-11-09T00:00:00Z", pageCount: 1,
    bodyTextCheck: { status: "verified", method: "synthetic-exact-text-comparison" },
    ...(format === "docx" ? { renderedArtifactSha256: "b".repeat(64) } : {}) };
}

test("print geometry uses absolute CSS pixels, validates margins, and never depends on screen DPI", () => {
  assert.ok(Math.abs(mmToCssPx(25.4) - 96) < 0.00001);
  assert.ok(Object.values(printGeometry(page)).every(value => Math.abs(value - 100) < 0.00001));
  assert.throws(() => printGeometry({ ...page, marginMm: { ...page.marginMm, left: 100 } }));
  assert.throws(() => printGeometry({ ...page, widthMm: NaN }));
});

test("diagnostics locate a short CJK last line and measured trailing whitespace at its Claim anchor", () => {
  const report = diagnoseLayout(measured([block({ text: "实现可靠并发机制", rect: { x: 0, y: 10, width: 90, height: 20 },
    lines: [{ rect: { x: 0, y: 10, width: 90, height: 10 }, text: "实现可靠并发" }, { rect: { x: 0, y: 20, width: 10, height: 10 }, text: "机制" }] })]));
  assert.equal(report.status, "diagnosed");
  if (report.status !== "diagnosed") return;
  assert.equal(report.pages[0]?.trailingWhitespaceRatio, 0.7);
  assert.deepEqual(report.issues.map(issue => issue.kind), ["trailing-whitespace", "short-last-line"]);
  assert.equal(report.issues[1]?.anchor, "claim:synthetic");
  assert.equal(report.finalFileCheck, "not-performed");
});

test("single-line bullets and punctuation-only continuation lines are not short-last-line defects", () => {
  const report = diagnoseLayout(measured([block({ lines: [{ rect: { x: 0, y: 80, width: 10, height: 10 }, text: "短句" }] }),
    block({ id: "punctuation", order: 1, lines: [{ rect: { x: 0, y: 60, width: 90, height: 10 }, text: "完整描述" }, { rect: { x: 0, y: 80, width: 2, height: 10 }, text: "。" }] })]));
  assert.equal(report.status, "diagnosed");
  if (report.status === "diagnosed") assert.equal(report.issues.filter(issue => issue.kind === "short-last-line").length, 0);
});

test("an English orphan word is detected from measured width rather than character count", () => {
  const report = diagnoseLayout(measured([block({ lines: [{ rect: { x: 0, y: 70, width: 90, height: 10 }, text: "Implemented a reliable" }, { rect: { x: 0, y: 80, width: 12, height: 10 }, text: "pipeline" }] })]));
  assert.equal(report.status, "diagnosed");
  if (report.status === "diagnosed") assert.equal(report.issues.find(issue => issue.kind === "short-last-line")?.metrics.words, 1);
});

test("a two-line final page produces an orphan-page warning; a real image prevents a text-only orphan assertion", () => {
  const second = block({ id: "second", order: 1, rect: { x: 0, y: 100, width: 90, height: 20 }, lines: [
    { rect: { x: 0, y: 100, width: 90, height: 10 }, text: "second-page first line" },
    { rect: { x: 0, y: 110, width: 90, height: 10 }, text: "second-page second line" },
  ] });
  const report = diagnoseLayout(measured([block(), second], { pageCount: 2 }));
  assert.equal(report.status, "diagnosed");
  if (report.status === "diagnosed") assert.equal(report.issues.find(issue => issue.kind === "orphan-page")?.pageNumber, 2);
  const image = block({ id: "image", order: 2, kind: "image", text: "", lines: [], rect: { x: 0, y: 130, width: 90, height: 50 } });
  const withImage = diagnoseLayout(measured([block(), second, image], { pageCount: 2 }));
  if (withImage.status === "diagnosed") assert.equal(withImage.issues.some(issue => issue.kind === "orphan-page"), false);
});

test("heading detection follows the next same-column block instead of an unrelated sidebar", () => {
  const heading = block({ id: "heading", anchor: "section:projects", kind: "heading", rect: { x: 0, y: 88, width: 45, height: 10 }, lines: [{ rect: { x: 0, y: 88, width: 45, height: 10 }, text: "项目经验" }] });
  const sidebar = block({ id: "sidebar", order: 1, rect: { x: 55, y: 90, width: 40, height: 10 }, lines: [{ rect: { x: 55, y: 90, width: 40, height: 10 }, text: "侧栏" }] });
  const next = block({ id: "next", order: 2, rect: { x: 0, y: 100, width: 45, height: 10 }, lines: [{ rect: { x: 0, y: 100, width: 45, height: 10 }, text: "项目正文" }] });
  const report = diagnoseLayout(measured([heading, sidebar, next], { pageCount: 2 }));
  assert.equal(report.status, "diagnosed");
  if (report.status === "diagnosed") assert.equal(report.issues.find(issue => issue.kind === "stranded-heading")?.anchor, "section:projects");
});

test("a crossing heading, horizontal long-link overflow and clipping are explicit issues", () => {
  const heading = block({ id: "heading", kind: "heading", rect: { x: 0, y: 95, width: 80, height: 10 }, lines: [{ rect: { x: 0, y: 95, width: 80, height: 10 }, text: "标题" }] });
  const link = block({ id: "link", order: 1, rect: { x: 0, y: 110, width: 160, height: 10 }, lines: [{ rect: { x: 0, y: 110, width: 160, height: 10 }, text: "https://synthetic.invalid/long-unbroken-path" }] });
  const clipped = block({ id: "clipped", order: 2, clipped: true, rect: { x: 0, y: 130, width: 80, height: 10 }, lines: [{ rect: { x: 0, y: 130, width: 80, height: 10 }, text: "被裁切" }] });
  const report = diagnoseLayout(measured([heading, link, clipped], { pageCount: 2 }));
  assert.equal(report.status, "diagnosed");
  if (report.status === "diagnosed") {
    assert.equal(report.issues.some(issue => issue.kind === "stranded-heading"), true);
    assert.equal(report.issues.filter(issue => issue.kind === "overflow").length, 3);
  }
});

test("overlapping inline runs share a baseline while two columns do not", () => {
  const report = diagnoseLayout(measured([
    block({ id: "left-a", rect: { x: 0, y: 80, width: 30, height: 10 }, lines: [{ rect: { x: 0, y: 80, width: 30, height: 10 }, text: "left" }] }),
    block({ id: "left-b", order: 1, rect: { x: 29, y: 80, width: 16, height: 10 }, lines: [{ rect: { x: 29, y: 80, width: 16, height: 10 }, text: "inline" }] }),
    block({ id: "right", order: 2, rect: { x: 55, y: 80, width: 40, height: 10 }, lines: [{ rect: { x: 55, y: 80, width: 40, height: 10 }, text: "right" }] }),
  ]));
  if (report.status === "diagnosed") assert.equal(report.pages[0]?.lineCount, 2);
  else assert.fail(report.detail);
});

test("DOM evidence cannot be relabelled as final PDF or DOCX geometry without a file-level receipt", () => {
  for (const source of ["pdf-final", "docx-final"] as const) {
    const report = diagnoseLayout(measured([block({ pageNumber: 1 })], { source }));
    assert.equal(report.status, "unavailable");
    if (report.status === "unavailable") assert.equal(report.reason, "invalid-final-evidence");
  }
});

test("DOM single-line flow boxes retain horizontal Range bounds and cannot override final-file geometry", () => {
  const line = { rect: { x: 0, y: -4, width: 90, height: 52 }, flowRect: { x: 0, y: 0, width: 90, height: 44.8 }, text: "单行标题" };
  const heading = block({ kind: "heading", rect: { x: 0, y: 0, width: 90, height: 44.8 }, lines: [line] });
  const valid = diagnoseLayout(measured([heading]));
  assert.ok(valid.status === "diagnosed" && !valid.issues.some(issue => issue.kind === "overflow"));
  const changedWidth = { ...heading, lines: [{ ...line, flowRect: { ...line.flowRect, width: 80 } }] };
  assert.equal(diagnoseLayout(measured([changedWidth])).status, "unavailable", "flow cannot conceal actual horizontal overflow");
  for (const format of ["pdf", "docx"] as const) {
    const final = diagnoseLayout(measured([{ ...heading, pageNumber: 1 }], { source: `${format}-final`, finalEvidence: evidence(format) }));
    assert.equal(final.status, "unavailable", "a DOM flow exception is never accepted as final-page evidence");
  }
});

test("valid PDF and rendered DOCX receipts remain separate, version-bound sources", () => {
  for (const format of ["pdf", "docx"] as const) {
    const report = diagnoseLayout(measured([block({ pageNumber: 1 })], { source: `${format}-final`, finalEvidence: evidence(format) }));
    assert.equal(report.status, "diagnosed");
    if (report.status === "diagnosed") assert.equal(report.finalFileCheck, "body-text-verified");
  }
  const missingPagination = evidence("docx");
  delete missingPagination.renderedArtifactSha256;
  const invalid = diagnoseLayout(measured([block({ pageNumber: 1 })], { source: "docx-final", finalEvidence: missingPagination }));
  assert.equal(invalid.status, "unavailable");
  const wrongVersion = evidence();
  wrongVersion.inputContentHash = "old-content";
  assert.equal(diagnoseLayout(measured([block({ pageNumber: 1 })], { source: "pdf-final", finalEvidence: wrongVersion })).status, "unavailable");
});

test("unknown/mismatched body text is never promoted to verified and malformed geometry fails closed", () => {
  const receipt = evidence();
  receipt.bodyTextCheck.status = "mismatch";
  const report = diagnoseLayout(measured([block({ pageNumber: 1 })], { source: "pdf-final", finalEvidence: receipt }));
  if (report.status === "diagnosed") {
    assert.equal(report.finalFileCheck, "geometry-only");
    assert.equal(report.limitations.some(detail => detail.includes("failed its body-text")), true);
  } else assert.fail(report.detail);
  assert.equal(diagnoseLayout(measured([block({ rect: { x: 0, y: 0, width: Infinity, height: 10 } })])).status, "unavailable");
  assert.equal(diagnoseLayout(measured([block({ lines: [{ rect: { x: 0, y: 200, width: 80, height: 10 }, text: "inconsistent page" }] })])).status, "unavailable");
});
