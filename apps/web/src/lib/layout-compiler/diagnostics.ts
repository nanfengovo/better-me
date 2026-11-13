import {
  printGeometry, unavailableLayout,
  type LayoutBlock, type LayoutDiagnosticOptions, type LayoutIssue, type LayoutLine,
  type LayoutMeasurement, type LayoutPageSummary, type LayoutRect, type LayoutReport, type MeasuredLayout,
} from "./types";

const right = (rect: LayoutRect) => rect.x + rect.width;
const bottom = (rect: LayoutRect) => rect.y + rect.height;
const validRect = (rect: LayoutRect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
  && rect.width >= 0 && rect.height >= 0;
const sha256 = (value: string | undefined) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

function invalidMeasurement(measurement: MeasuredLayout): string | undefined {
  if (!Number.isSafeInteger(measurement.pageCount) || measurement.pageCount < 1 || measurement.pageCount > 1000) {
    return "The measured page count is invalid or exceeds the bounded report size";
  }
  if (!measurement.blocks.length || measurement.blocks.length > 2000) return "No bounded set of content blocks was measured";
  let lineCount = 0;
  for (const block of measurement.blocks) {
    lineCount += block.lines.length;
    if (!block.id || !Number.isFinite(block.order) || !validRect(block.rect)
      || block.lines.some(line => !validRect(line.rect) || (line.flowRect !== undefined && (!validRect(line.flowRect)
        || measurement.source !== "dom-estimate" || block.lines.length !== 1 || Math.abs(line.flowRect.x - line.rect.x) > .01
        || Math.abs(line.flowRect.width - line.rect.width) > .01 || Math.abs(line.flowRect.y - block.rect.y) > .01
        || Math.abs(line.flowRect.height - block.rect.height) > .01)) || (line.start !== undefined
        && (!Number.isInteger(line.start) || !Number.isInteger(line.end) || line.start < 0
          || (line.end ?? -1) < line.start || (line.end ?? Infinity) > block.text.length)))) {
      return "A content block has invalid geometry or text offsets";
    }
  }
  if (lineCount > 50000) return "The line measurement budget was exceeded";
  return undefined;
}

function invalidFinalEvidence(measurement: MeasuredLayout): string | undefined {
  if (measurement.source === "dom-estimate") return undefined;
  const evidence = measurement.finalEvidence;
  const expectedFormat = measurement.source === "pdf-final" ? "pdf" : "docx";
  if (!evidence || evidence.format !== expectedFormat || !sha256(evidence.artifactSha256)
    || (evidence.format === "docx" && !sha256(evidence.renderedArtifactSha256))
    || evidence.inputContentHash !== measurement.scope.contentHash
    || evidence.pageCount !== measurement.pageCount || !evidence.renderer.name.trim()
    || !evidence.renderer.version.trim() || !Number.isFinite(Date.parse(evidence.renderedAt))
    || !evidence.bodyTextCheck.method.trim()) {
    return "Final-file geometry requires a version-bound file hash, renderer/version, pagination and body-text check";
  }
  if (measurement.blocks.some(block => !Number.isSafeInteger(block.pageNumber)
    || (block.pageNumber ?? 0) < 1 || (block.pageNumber ?? Infinity) > measurement.pageCount)) {
    return "Every final-file block must identify its actual rendered page";
  }
  return undefined;
}

function pageAt(y: number, height: number, atBottom = false) {
  return Math.floor(Math.max(0, y - (atBottom ? 0.001 : 0)) / height) + 1;
}

interface Placement { page: number; rect: LayoutRect; line?: LayoutLine; block: LayoutBlock }

function placementsFor(block: LayoutBlock, measurement: MeasuredLayout, height: number): Placement[] {
  const rects = block.lines.length ? block.lines.map(line => ({ rect: measurement.source === "dom-estimate" ? line.flowRect ?? line.rect : line.rect, line })) : [{ rect: block.rect, line: undefined }];
  return rects.map(({ rect, line }) => {
    const page = measurement.source === "dom-estimate" ? pageAt(rect.y, height) : block.pageNumber!;
    return { page, block, line, rect: { ...rect, y: measurement.source === "dom-estimate" ? rect.y - (page - 1) * height : rect.y } };
  });
}

function countVisibleUnits(text: string) {
  const trimmed = text.trim();
  const cjk = trimmed.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];
  const words = trimmed.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ")
    .match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? [];
  return { cjk: cjk.length, words: words.length, nonPunctuation: /[\p{L}\p{N}]/u.test(trimmed) };
}

/** Pure diagnostics. No rendering, rewriting, file access or business-state mutation. */
export function diagnoseLayout(measurement: LayoutMeasurement, options: LayoutDiagnosticOptions = {}): LayoutReport {
  if (measurement.status === "unavailable") return measurement;
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value < 0 || (key.includes("Ratio") && value > 1)) {
      return unavailableLayout(measurement.scope, "invalid-measurement", "Diagnostic thresholds must be finite nonnegative values and ratios cannot exceed one");
    }
  }
  let geometry: ReturnType<typeof printGeometry>;
  try { geometry = printGeometry(measurement.page); }
  catch { return unavailableLayout(measurement.scope, "invalid-measurement", "Invalid print dimensions"); }
  const invalid = invalidMeasurement(measurement);
  if (invalid) return unavailableLayout(measurement.scope, "invalid-measurement", invalid);
  const invalidEvidence = invalidFinalEvidence(measurement);
  if (invalidEvidence) return unavailableLayout(measurement.scope, "invalid-final-evidence", invalidEvidence);

  const tolerance = Math.max(0, options.tolerancePx ?? 1);
  const whitespaceLimit = Math.min(1, Math.max(0, options.trailingWhitespaceRatio ?? 0.25));
  const shortWidthRatio = Math.min(1, Math.max(0, options.shortLineWidthRatio ?? 0.2));
  const all = measurement.blocks.flatMap(block => placementsFor(block, measurement, geometry.height));
  const actualMaxPage = Math.max(...all.map(placement => placement.page));
  if (actualMaxPage > measurement.pageCount) {
    return unavailableLayout(measurement.scope, "invalid-measurement", "Content geometry exceeds the declared page count");
  }
  const pages: LayoutPageSummary[] = Array.from({ length: measurement.pageCount }, (_, index) => {
    const placements = all.filter(placement => placement.page === index + 1);
    // Count visual baselines, not inline runs or two overlapping ranges of one glyph.
    const baselines: { y: number; x: number; right: number; height: number }[] = [];
    for (const placement of placements.filter(item => item.line)) {
      const match = baselines.find(line => Math.abs(line.y - placement.rect.y) <= tolerance
        && placement.rect.x <= line.right + tolerance && right(placement.rect) >= line.x - tolerance);
      if (match) { match.x = Math.min(match.x, placement.rect.x); match.right = Math.max(match.right, right(placement.rect)); }
      else baselines.push({ y: placement.rect.y, x: placement.rect.x, right: right(placement.rect), height: placement.rect.height });
    }
    const occupiedBottom = Math.max(0, ...placements.map(placement => bottom(placement.rect)));
    return {
      pageNumber: index + 1, lineCount: baselines.length, occupiedBottom,
      trailingWhitespaceRatio: Math.max(0, Math.min(1, (geometry.height - occupiedBottom) / geometry.height)),
      hasImage: placements.some(placement => placement.block.kind === "image"),
    };
  });
  const issues: LayoutIssue[] = [];
  const add = (issue: Omit<LayoutIssue, "id">) => issues.push({ ...issue, id: `${issue.kind}:${issue.pageNumber}:${issue.blockId ?? "page"}` });
  for (const page of pages) {
    if (page.trailingWhitespaceRatio > whitespaceLimit) {
      add({ kind: "trailing-whitespace", severity: "notice", pageNumber: page.pageNumber,
        detail: "The measured page has substantial trailing whitespace; this can also be an intentional layout choice.",
        metrics: { ratio: page.trailingWhitespaceRatio, threshold: whitespaceLimit } });
    }
  }
  const lastPage = pages.at(-1)!;
  if (pages.length > 1 && lastPage.lineCount <= (options.orphanPageMaxLines ?? 3) && !lastPage.hasImage) {
    const firstOnPage = all.find(placement => placement.page === lastPage.pageNumber);
    add({ kind: "orphan-page", severity: "warning", pageNumber: lastPage.pageNumber,
      blockId: firstOnPage?.block.id, anchor: firstOnPage?.block.anchor,
      detail: "The final measured page contains very few text lines and no measured image.",
      metrics: { lines: lastPage.lineCount, maximum: options.orphanPageMaxLines ?? 3 } });
  }

  const ordered = [...measurement.blocks].sort((a, b) => a.order - b.order);
  for (const [index, block] of ordered.entries()) {
    const own = placementsFor(block, measurement, geometry.height);
    const first = own[0]!;
    const last = own.at(-1)!;
    const endPage = measurement.source === "dom-estimate" ? pageAt(bottom(block.rect), geometry.height, true) : block.pageNumber!;
    const next = ordered.slice(index + 1).find(candidate => Math.min(right(candidate.rect), right(block.rect))
      - Math.max(candidate.rect.x, block.rect.x) > 0);
    const nextFirst = next ? placementsFor(next, measurement, geometry.height)[0] : undefined;
    const nextInColumn = next && Math.min(right(next.rect), right(block.rect)) - Math.max(next.rect.x, block.rect.x) > 0;
    if ((block.kind === "heading" || block.keepWithNext) && (endPage !== first.page
      || bottom(last.rect) > geometry.height + tolerance || (nextFirst && nextInColumn && nextFirst.page > last.page))) {
      add({ kind: "stranded-heading", severity: "warning", pageNumber: first.page, blockId: block.id, anchor: block.anchor,
        detail: "A heading crosses a page boundary or is separated from the following same-column content.",
        metrics: { firstPage: first.page, endPage, nextPage: nextFirst?.page ?? endPage } });
    }

    if (block.lines.length > 1 && (block.kind === "claim" || block.kind === "text")) {
      const finalLine = block.lines.at(-1)!;
      const units = countVisibleUnits(finalLine.text);
      const priorWidth = Math.max(...block.lines.slice(0, -1).map(line => line.rect.width));
      const ratio = priorWidth > 0 ? finalLine.rect.width / priorWidth : 1;
      const fewUnits = units.cjk > 0
        ? units.cjk <= (options.shortLineMaxCjkCharacters ?? 2) && units.words === 0
        : units.words <= (options.shortLineMaxWords ?? 1);
      if (units.nonPunctuation && fewUnits && ratio <= shortWidthRatio) {
        add({ kind: "short-last-line", severity: "notice", pageNumber: last.page, blockId: block.id, anchor: block.anchor,
          detail: "The last visual line contains very little text relative to the preceding line.",
          metrics: { widthRatio: ratio, cjkCharacters: units.cjk, words: units.words } });
      }
    }
    const bad = own.find(placement => placement.rect.x < -tolerance || right(placement.rect) > geometry.width + tolerance
      || placement.rect.y < -tolerance || bottom(placement.rect) > geometry.height + tolerance);
    const horizontalBlockOverflow = block.rect.x < -tolerance || right(block.rect) > geometry.width + tolerance;
    const tooTall = block.keepTogether && block.rect.height > geometry.height + tolerance;
    if (bad || horizontalBlockOverflow || tooTall || block.clipped) {
      add({ kind: "overflow", severity: "error", pageNumber: bad?.page ?? first.page, blockId: block.id, anchor: block.anchor,
        detail: block.clipped ? "The block is clipped by a measured overflow container." : "Measured content extends beyond the printable content area.",
        metrics: { x: bad?.rect.x ?? block.rect.x, right: right(bad?.rect ?? block.rect),
          bottom: bottom(bad?.rect ?? first.rect), contentWidth: geometry.width, contentHeight: geometry.height } });
    }
  }

  const weights = { "trailing-whitespace": 1, "orphan-page": 8, "stranded-heading": 10, "short-last-line": 2, overflow: 20 };
  const finalFileCheck = measurement.source === "dom-estimate" ? "not-performed"
    : measurement.finalEvidence?.bodyTextCheck.status === "verified" ? "body-text-verified" : "geometry-only";
  return {
    status: "diagnosed", scope: measurement.scope, source: measurement.source, issues, pages,
    penalty: issues.reduce((sum, issue) => sum + weights[issue.kind], 0), finalFileCheck,
    limitations: [...measurement.limitations,
      "Diagnostics do not certify factual equivalence, link integrity, visual quality or authorization to adopt a change.",
      ...(measurement.finalEvidence?.bodyTextCheck.status === "mismatch" ? ["The final file failed its body-text integrity check."] : [])],
  };
}
