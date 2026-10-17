import type { FactBase, ResumeView, TextStyleRange } from "@better-me/core";

export type TextStylePatch = Partial<Omit<TextStyleRange, "start" | "end">>;
const STYLE_KEYS = ["bold", "italic", "underline", "highlight", "fontScale"] as const;

/** Store disjoint runs so toggling one selection never loses adjacent formatting. */
export function formatSelection(
  text: string,
  ranges: TextStyleRange[],
  start: number,
  end: number,
  patch: TextStylePatch | "clear",
): TextStyleRange[] {
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  if (start === end) return ranges;
  const boundaries = [...new Set([0, text.length, start, end, ...ranges.flatMap((run) => [Math.max(0, Math.min(text.length, run.start)), Math.max(0, Math.min(text.length, run.end))])])].sort((a, b) => a - b);
  const result: TextStyleRange[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]!;
    const to = boundaries[index + 1]!;
    if (from === to) continue;
    let style: TextStylePatch = {};
    for (const range of ranges) {
      if (range.start <= from && range.end >= to) {
        for (const key of STYLE_KEYS) if (range[key] !== undefined) Object.assign(style, { [key]: range[key] });
      }
    }
    if (from >= start && to <= end) style = patch === "clear" ? {} : { ...style, ...patch };
    for (const key of STYLE_KEYS) if (style[key] === false || (key === "fontScale" && style[key] === 1)) delete style[key];
    if (Object.keys(style).length === 0) continue;
    const previous = result[result.length - 1];
    const previousStyle = previous ? Object.fromEntries(STYLE_KEYS.filter((key) => previous[key] !== undefined).map((key) => [key, previous[key]])) : null;
    if (previous && previous.end === from && JSON.stringify(previousStyle) === JSON.stringify(style)) previous.end = to;
    else result.push({ start: from, end: to, ...style });
  }
  return result;
}

/** Surviving original text keeps its style; inserted/replaced text starts plain. */
export function rebaseTextStyles(previous: string, next: string, ranges: TextStyleRange[]): TextStyleRange[] {
  if (previous === next) return ranges;
  let prefix = 0;
  while (prefix < Math.min(previous.length, next.length) && previous[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const oldEnd = previous.length - suffix;
  const delta = next.length - previous.length;
  return ranges.flatMap((range) => {
    const runs: TextStyleRange[] = [];
    if (range.start < prefix) runs.push({ ...range, end: Math.min(range.end, prefix) });
    if (range.end > oldEnd) runs.push({ ...range, start: Math.max(range.start, oldEnd) + delta, end: range.end + delta });
    return runs.filter((run) => run.start < run.end);
  });
}

function formattedFields(base: FactBase): Map<string, string> {
  const fields = new Map<string, string>();
  for (const locale of ["zh", "en"] as const) {
    fields.set(`profile:displayName:${locale}`, base.profile.displayName[locale] ?? "");
    fields.set(`profile:headline:${locale}`, base.profile.headline?.[locale] ?? "");
    for (const experience of base.experiences) for (const claim of experience.claims) fields.set(`claim:${claim.id}:${locale}`, claim.text[locale] ?? "");
  }
  return fields;
}

export function rebaseViewTextStyles(previous: FactBase, next: FactBase, views: ResumeView[]): ResumeView[] {
  const before = formattedFields(previous);
  const after = formattedFields(next);
  return views.map((view) => {
    if (!view.textStyles) return view;
    const textStyles: Record<string, TextStyleRange[]> = {};
    for (const [key, ranges] of Object.entries(view.textStyles)) {
      const nextText = after.get(key);
      if (nextText === undefined) continue;
      const rebased = rebaseTextStyles(before.get(key) ?? "", nextText, ranges);
      if (rebased.length) textStyles[key] = rebased;
    }
    return { ...view, textStyles };
  });
}
