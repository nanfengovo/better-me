export const WORKSPACE_SPLIT_KEY = "better-me:workspace-split:v1";
export const DEFAULT_EDITOR_PERCENT = 38;
export const SPLIT_HANDLE_WIDTH = 20;

/** Both panes retain enough width for their controls at the smallest desktop size. */
export function getWorkspaceSplitBounds(availableWidth: number) {
  const width = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 1000;
  return {
    min: Math.max(22, Math.min(45, 300 / width * 100)),
    max: Math.min(70, Math.max(55, (1 - 340 / width) * 100)),
  };
}

export function clampWorkspaceSplit(percent: number, availableWidth: number) {
  const { min, max } = getWorkspaceSplitBounds(availableWidth);
  return Math.max(min, Math.min(max, Number.isFinite(percent) ? percent : DEFAULT_EDITOR_PERCENT));
}

export function workspaceSplitFromPointer(clientX: number, contentLeft: number, availableWidth: number) {
  if (!(availableWidth > 0)) return DEFAULT_EDITOR_PERCENT;
  return clampWorkspaceSplit((clientX - contentLeft - SPLIT_HANDLE_WIDTH / 2) / availableWidth * 100, availableWidth);
}

export function parseWorkspaceSplit(saved: string | null) {
  if (!saved?.trim()) return DEFAULT_EDITOR_PERCENT;
  const percent = Number(saved);
  return Number.isFinite(percent) && percent >= 22 && percent <= 70 ? percent : DEFAULT_EDITOR_PERCENT;
}
