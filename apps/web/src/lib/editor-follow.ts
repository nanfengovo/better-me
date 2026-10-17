import type { PreviewFollowTarget } from "./preview-follow";

export type EditorFollowCandidate = {
  anchor: string;
  fallbackAnchors?: string[];
  top: number;
  bottom: number;
  depth: number;
};

/** Find the editor block being read, rather than the input that last held focus. */
export function selectEditorFollowTarget(
  viewport: { top: number; height: number },
  candidates: EditorFollowCandidate[],
): PreviewFollowTarget | undefined {
  if (!Number.isFinite(viewport.top) || !Number.isFinite(viewport.height) || viewport.height <= 0) return;
  const bottom = viewport.top + viewport.height;
  const readingLine = viewport.top + viewport.height * 0.25;
  const visible = candidates.filter((candidate) =>
    Number.isFinite(candidate.top) && Number.isFinite(candidate.bottom)
    && candidate.bottom > candidate.top
    && candidate.bottom > viewport.top && candidate.top < bottom,
  );
  const containing = visible.filter((candidate) => candidate.top <= readingLine && candidate.bottom > readingLine);
  // A claim or individual profile field wins over its enclosing experience/profile.
  const target = containing.length
    ? containing.sort((a, b) => b.depth - a.depth || (a.bottom - a.top) - (b.bottom - b.top))[0]
    : visible.sort((a, b) => {
      const distance = (candidate: EditorFollowCandidate) => Math.min(Math.abs(candidate.top - readingLine), Math.abs(candidate.bottom - readingLine));
      return distance(a) - distance(b) || b.depth - a.depth;
    })[0];
  if (!target) return;
  const height = target.bottom - target.top;
  return {
    anchor: target.anchor,
    ...(target.fallbackAnchors?.length ? { fallbackAnchors: target.fallbackAnchors } : {}),
    // Short inputs align as a block; long claims track the position inside the block.
    progress: height > viewport.height * 0.75
      ? Math.max(0, Math.min(1, (readingLine - target.top) / height))
      : 0,
    source: "scroll",
  };
}
