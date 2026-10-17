/** A new object represents a new interaction in the editor, including repeat focus. */
export type PreviewFollowTarget = {
  anchor: string;
  fallbackAnchors?: string[];
  progress?: number;
  source: "focus" | "scroll";
};

/** Compare values instead of interpolating fact IDs into a CSS selector. */
export function resolvePreviewAnchor<T extends { getAttribute(name: string): string | null }>(
  elements: Iterable<T>,
  target: PreviewFollowTarget,
): T | undefined {
  const candidates = [...elements];
  for (const anchor of [target.anchor, ...(target.fallbackAnchors ?? [])]) {
    const match = candidates.find((element) => element.getAttribute("data-preview-anchor") === anchor);
    if (match) return match;
  }
  return undefined;
}

type PreviewScrollMetrics = {
  /** Bounding rectangles use visual pixels, including the sheet's CSS zoom. */
  anchorTop: number;
  anchorHeight: number;
  canvasTop: number;
  canvasBorderTop?: number;
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
};

/** Return a position for the preview canvas only; never scroll the outer page. */
export function getPreviewScrollTop(metrics: PreviewScrollMetrics, target: PreviewFollowTarget): number {
  const { anchorTop, anchorHeight, canvasTop, scrollTop, viewportHeight, scrollHeight } = metrics;
  if (![anchorTop, anchorHeight, canvasTop, scrollTop, viewportHeight, scrollHeight].every(Number.isFinite) || viewportHeight <= 0) return scrollTop;
  const inset = Math.min(48, viewportHeight * .12);
  const relativeTop = anchorTop - canvasTop - (metrics.canvasBorderTop ?? 0);
  const availableHeight = Math.max(1, viewportHeight - inset * 2);
  // Typing in a fully visible short field must not continually move the paper.
  if (target.source === "focus" && anchorHeight <= availableHeight && relativeTop >= inset && relativeTop + anchorHeight <= viewportHeight - inset) return scrollTop;
  const progress = Number.isFinite(target.progress) ? Math.max(0, Math.min(1, target.progress!)) : 0;
  const withinAnchor = Math.max(0, anchorHeight - availableHeight) * progress;
  const desired = scrollTop + relativeTop + withinAnchor - inset;
  return Math.max(0, Math.min(Math.max(0, scrollHeight - viewportHeight), desired));
}

/** Fit uses actual canvas gutters; preview zoom is bounded to 20–130%. */
export function getFitPreviewZoom(canvasWidth: number, horizontalPadding: number, sheetWidth = 210 * 96 / 25.4): number {
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0 || !Number.isFinite(horizontalPadding) || !Number.isFinite(sheetWidth) || sheetWidth <= 0) return 80;
  return Math.max(20, Math.min(130, Math.floor(Math.max(1, canvasWidth - horizontalPadding) / sheetWidth * 100)));
}
