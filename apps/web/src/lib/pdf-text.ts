/** The geometry supplied by PDF.js; kept independent of its browser renderer. */
export interface PdfTextItem {
  str?: string;
  transform?: readonly number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

interface TextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  spaceAfterIndex: number | null;
}

interface TextLine {
  runs: TextRun[];
  y: number;
  height: number;
  firstIndex: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 10;
}

function normalizeRuns(items: readonly PdfTextItem[]): TextRun[] {
  const runs: TextRun[] = [];
  let previousTextIndex: number | null = null;
  let pendingSpace = false;
  items.forEach((item, index) => {
    if (typeof item.str !== "string") return;
    if (!item.str.trim()) {
      if (item.hasEOL) {
        pendingSpace = false;
        previousTextIndex = null;
      } else if (item.str.length) {
        pendingSpace = true;
      }
      return;
    }
    const transform = item.transform ?? [];
    const height = Math.abs(item.height ?? Math.hypot(transform[2] ?? 0, transform[3] ?? 10)) || 10;
    const text = item.str.trim();
    runs.push({
      text,
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      width: Math.abs(item.width ?? text.length * height * 0.5),
      height,
      index,
      spaceAfterIndex: pendingSpace || /^\s/u.test(item.str) ? previousTextIndex : null,
    });
    pendingSpace = /\s$/u.test(item.str);
    previousTextIndex = index;
  });
  return runs;
}

/**
 * A persistent empty vertical gutter separates actual columns. Short, sparse
 * contact rows do not qualify; a full-width body also closes their gutter.
 * Whitespace-only PDF items are excluded because their widths can cross columns.
 */
function splitColumns(runs: TextRun[]): TextRun[][] {
  if (runs.length < 16) return [runs];
  const left = Math.min(...runs.map((run) => run.x));
  const right = Math.max(...runs.map((run) => run.x + run.width));
  const fontHeight = median(runs.map((run) => run.height));
  const intervals = runs
    .map((run) => ({ left: run.x, right: run.x + run.width }))
    .sort((a, b) => a.left - b.left);
  let coveredRight = intervals[0]!.right;
  const gutters: Array<{ x: number; width: number }> = [];
  for (const interval of intervals.slice(1)) {
    const width = interval.left - coveredRight;
    if (width >= Math.max(8, fontHeight * 0.7)) {
      const x = (coveredRight + interval.left) / 2;
      if (x - left >= (right - left) * 0.2 && right - x >= (right - left) * 0.2) {
        gutters.push({ x, width });
      }
    }
    coveredRight = Math.max(coveredRight, interval.right);
  }
  for (const gutter of gutters.sort((a, b) => b.width - a.width)) {
    const columns = [runs.filter((run) => run.x < gutter.x), runs.filter((run) => run.x >= gutter.x)];
    if (columns.some((column) => column.length < 8)) continue;
    const bounds = columns.map((column) => ({
      top: Math.max(...column.map((run) => run.y)),
      bottom: Math.min(...column.map((run) => run.y)),
    }));
    const sharedHeight = Math.min(bounds[0]!.top, bounds[1]!.top) - Math.max(bounds[0]!.bottom, bounds[1]!.bottom);
    if (sharedHeight >= fontHeight * 8) return columns.flatMap(splitColumns);
  }
  return [runs];
}

function sameBaseline(line: TextLine, run: TextRun): boolean {
  return Math.abs(line.y - run.y) <= Math.max(1, Math.min(line.height, run.height) * 0.24);
}

function conflictsWithLine(line: TextLine, run: TextRun): boolean {
  return line.runs.some((other) => {
    const overlap = Math.min(other.x + other.width, run.x + run.width) - Math.max(other.x, run.x);
    // PDF font boxes often overlap slightly around punctuation/kerning. Large
    // overlaps are separate text blocks, including an overlaid section heading.
    return overlap > Math.min(other.width, run.width) * 0.65;
  });
}

function joinLine(runs: TextRun[]): string {
  const sorted = [...runs].sort((a, b) => a.x - b.x || a.index - b.index);
  let text = "";
  let previous: TextRun | undefined;
  for (const run of sorted) {
    if (previous) {
      const gap = run.x - previous.x - previous.width;
      const fontHeight = Math.min(previous.height, run.height);
      const explicitSpace = run.spaceAfterIndex === previous.index;
      // Join adjacent glyph fragments (dates, Chinese headings, ligatures).
      // A visible gap or a source space still separates words and contact fields.
      if (explicitSpace || gap > Math.max(0.8, fontHeight * 0.13)) text += " ";
    }
    text += run.text;
    previous = run;
  }
  return text;
}

function columnText(runs: TextRun[]): string {
  const lines: TextLine[] = [];
  // Keep source ordering while assigning lines so overlapping text blocks retain
  // their document order rather than being fused by a loose Y-only threshold.
  for (const run of runs) {
    const line = lines.find((candidate) => sameBaseline(candidate, run) && !conflictsWithLine(candidate, run));
    if (line) {
      line.runs.push(run);
      line.height = Math.min(line.height, run.height);
    } else {
      lines.push({ runs: [run], y: run.y, height: run.height, firstIndex: run.index });
    }
  }
  const ordered = lines.sort((a, b) => b.y - a.y || a.firstIndex - b.firstIndex);
  // Sort each set of coincident, conflicting lines by source order. Sorting via
  // a pairwise Y tolerance alone is non-transitive and can shuffle text.
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && Math.abs(ordered[start]!.y - ordered[end]!.y) <= Math.max(1, Math.min(ordered[start]!.height, ordered[end]!.height) * 0.24)) end++;
    if (end - start > 1) {
      ordered.splice(start, end - start, ...ordered.slice(start, end).sort((a, b) => a.firstIndex - b.firstIndex));
    }
    start = end;
  }
  return ordered.map((line) => joinLine(line.runs)).join("\n");
}

/** Rebuild a full page without discarding text or inventing spaces per PDF item. */
export function reflowPdfText(items: readonly PdfTextItem[]): string {
  return splitColumns(normalizeRuns(items)).map(columnText).filter(Boolean).join("\n\n");
}
