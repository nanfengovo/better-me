export const WORKBENCH_LAYOUT_KEY = "better-me:atlas-workbench:v1";
export const PANE_IDS = ["map", "jobs", "detail"] as const;
export type WorkbenchPaneId = typeof PANE_IDS[number];
export type PaneValues = Record<WorkbenchPaneId, number>;
export type WorkbenchLayout = {
  version: 1;
  order: WorkbenchPaneId[];
  weights: PaneValues;
  rowHeights: PaneValues;
  height: number | null;
  arrangement: "auto" | "rows";
};
export const SPLITTER_SIZE = 14;
export const PANE_MIN_WIDTH: PaneValues = { map: 300, jobs: 280, detail: 320 };
export const PANE_MIN_HEIGHT: PaneValues = { map: 500, jobs: 340, detail: 380 };
export const WORKBENCH_PRESETS: Record<"balanced" | "map" | "reading", PaneValues> = {
  balanced: { map: 44, jobs: 26, detail: 30 },
  map: { map: 64, jobs: 18, detail: 18 },
  reading: { map: 24, jobs: 20, detail: 56 },
};
export const clampPaneHeight = (value: number, pane?: WorkbenchPaneId) => Math.max(pane ? PANE_MIN_HEIGHT[pane] : 340, Math.min(1400, Math.round(value)));
export const clampWorkbenchHeight = (value: number) => Math.max(520, Math.min(1400, Math.round(value)));
export function defaultWorkbenchLayout(): WorkbenchLayout {
  return { version: 1, order: [...PANE_IDS], weights: { ...WORKBENCH_PRESETS.balanced },
    rowHeights: { map: 560, jobs: 600, detail: 640 }, height: null, arrangement: "auto" };
}
const isPane = (value: unknown): value is WorkbenchPaneId => PANE_IDS.includes(value as WorkbenchPaneId);
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** A small UI-only preference, deliberately unrelated to jobs, queries or resume storage. */
export function parseWorkbenchLayout(raw: string | null): WorkbenchLayout {
  const fallback = defaultWorkbenchLayout();
  if (!raw) return fallback;
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.order) || data.order.length !== 3
      || !data.order.every(isPane) || new Set(data.order).size !== 3) return fallback;
    const weights = PANE_IDS.every(id => finitePositive(data.weights?.[id])) && Number.isFinite(PANE_IDS.reduce((n,key)=>n+data.weights[key],0))
      ? Object.fromEntries(PANE_IDS.map(id => [id, data.weights[id] / PANE_IDS.reduce((n,key)=>n+data.weights[key],0) * 100])) as PaneValues
      : fallback.weights;
    return { version: 1, order: [...data.order], weights,
      rowHeights: Object.fromEntries(PANE_IDS.map(id => [id, finitePositive(data.rowHeights?.[id])
        ? clampPaneHeight(data.rowHeights[id],id) : fallback.rowHeights[id]])) as PaneValues,
      height: finitePositive(data.height) ? clampWorkbenchHeight(data.height) : null,
      arrangement: data.arrangement === "rows" ? "rows" : "auto" };
  } catch { return fallback; }
}

/** Constrained weighted allocation; below the sum of minimums, the UI switches to rows. */
export function allocatePaneSizes(ids: WorkbenchPaneId[], weights: PaneValues, width: number): number[] {
  const available = Math.max(0, width - SPLITTER_SIZE * Math.max(0, ids.length - 1));
  const sizes = new Array<number>(ids.length).fill(0);
  const pending = new Set(ids.map((_,index)=>index));
  let remaining = available;
  while (pending.size) {
    const mass = [...pending].reduce((n,index)=>n+weights[ids[index]!],0);
    const constrained = [...pending].filter(index => remaining * weights[ids[index]!] / mass < PANE_MIN_WIDTH[ids[index]!]);
    if (!constrained.length) {
      for (const index of pending) sizes[index] = remaining * weights[ids[index]!] / mass;
      break;
    }
    for (const index of constrained) {
      sizes[index] = PANE_MIN_WIDTH[ids[index]!];
      remaining -= sizes[index]!;
      pending.delete(index);
    }
  }
  return sizes;
}

export function resizePanePair(sizes: number[], ids: WorkbenchPaneId[], index: number, delta: number): number[] {
  if (!ids[index] || !ids[index+1] || !Number.isFinite(delta)) return [...sizes];
  const left = sizes[index]!, right = sizes[index+1]!;
  const bounded = Math.max(PANE_MIN_WIDTH[ids[index]!] - left, Math.min(right - PANE_MIN_WIDTH[ids[index+1]!], delta));
  return sizes.map((size,i)=>i===index ? size+bounded : i===index+1 ? size-bounded : size);
}

/** Preserve hidden-pane mass, so opening/closing a JD cannot erase the user's preference. */
export function weightsFromSizes(ids: WorkbenchPaneId[], sizes: number[], previous: PaneValues): PaneValues {
  const mass = ids.reduce((n,id)=>n+previous[id],0);
  const total = sizes.reduce((n,size)=>n+size,0);
  if (total <= 0 || sizes.length !== ids.length) return { ...previous };
  return { ...previous, ...Object.fromEntries(ids.map((id,index)=>[id,sizes[index]! / total * mass])) };
}

export function moveWorkbenchPane(order: WorkbenchPaneId[], from: WorkbenchPaneId, to: WorkbenchPaneId): WorkbenchPaneId[] {
  const result = [...order], start = result.indexOf(from), end = result.indexOf(to);
  if (start < 0 || end < 0 || start === end) return result;
  result.splice(start,1);
  result.splice(end,0,from);
  return result;
}

export function paneGridTemplate(sizes: number[]): string {
  return sizes.map(size => Math.max(0,size).toFixed(2) + "px").join(" " + SPLITTER_SIZE + "px ");
}
