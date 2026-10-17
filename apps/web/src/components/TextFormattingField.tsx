import { useRef, useState, type KeyboardEvent } from "react";
import type { TextStyleRange } from "@better-me/core";
import { Bold, Italic, Underline, Highlighter, RemoveFormatting, Type } from "lucide-react";
import { formatSelection, type TextStylePatch } from "../lib/text-formatting";

type Props = {
  value: string;
  onChange: (value: string) => void;
  ranges?: TextStyleRange[];
  onStylesChange?: (ranges: TextStyleRange[]) => void;
  label: string;
  placeholder?: string;
  rows?: number;
};

export function TextFormattingField({ value, onChange, ranges = [], onStylesChange, label, placeholder, rows = 2 }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const hasSelection = selection.end > selection.start;
  const selectionStyle = (key: keyof TextStylePatch) => {
    const matching = ranges.filter((range) => range.start < selection.end && range.end > selection.start);
    return hasSelection && matching.length > 0 && matching.every((range) => Boolean(range[key])) && matching.reduce((length, range) => length + Math.max(0, Math.min(range.end, selection.end) - Math.max(range.start, selection.start)), 0) >= selection.end - selection.start;
  };
  function apply(patch: TextStylePatch | "clear") {
    if (!hasSelection || !onStylesChange) return;
    onStylesChange(formatSelection(value, ranges, selection.start, selection.end, patch));
    ref.current?.focus();
    ref.current?.setSelectionRange(selection.start, selection.end);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(event.ctrlKey || event.metaKey) || !hasSelection || !onStylesChange) return;
    const key = event.key.toLowerCase();
    const style = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
    if (style) { event.preventDefault(); apply({ [style]: !selectionStyle(style) }); }
  }
  return (
    <div className="formatted-field">
      {onStylesChange && <div className="text-format-toolbar" role="toolbar" aria-label={`${label}文字格式`}>
        {[
          { key: "bold" as const, name: "加粗", Icon: Bold },
          { key: "italic" as const, name: "斜体", Icon: Italic },
          { key: "underline" as const, name: "下划线", Icon: Underline },
          { key: "highlight" as const, name: "高亮", Icon: Highlighter },
        ].map(({ key, name, Icon }) => <button key={key} type="button" aria-label={`${label}${name}`} aria-pressed={selectionStyle(key)} disabled={!hasSelection} title={`${name}选中文字`} onMouseDown={(event) => event.preventDefault()} onClick={() => apply({ [key]: !selectionStyle(key) })}><Icon size={13} /></button>)}
        <span className="format-divider" />
        <Type size={12} aria-hidden="true" />
        <select aria-label={`${label}选中文字大小`} disabled={!hasSelection} value="" onChange={(event) => apply({ fontScale: Number(event.target.value) })}>
          <option value="" disabled>字号</option><option value="0.9">小号 · 90%</option><option value="1">正文 · 100%</option><option value="1.15">放大 · 115%</option><option value="1.3">强调 · 130%</option>
        </select>
        <button type="button" aria-label={`${label}清除格式`} disabled={!hasSelection} title="清除选中文字格式" onMouseDown={(event) => event.preventDefault()} onClick={() => apply("clear")}><RemoveFormatting size={13} /></button>
        <span className="format-selection-hint">{hasSelection ? `已选 ${selection.end - selection.start} 字` : "选中文字设置格式"}</span>
      </div>}
      <textarea ref={ref} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} onKeyDown={handleKeyDown} rows={rows} placeholder={placeholder} />
    </div>
  );
}
