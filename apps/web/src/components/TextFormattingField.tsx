/** @jsxRuntime automatic */
import { useUiPreferences } from "../lib/ui-preferences";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { DEFAULT_HIGHLIGHT_COLOR, getHighlightColor, splitStyledText, type TextStyleRange } from "@better-me/core";
import { Bold, Italic, Underline, Highlighter, RemoveFormatting, Type, ChevronDown } from "lucide-react";
import { formatSelection, type TextStylePatch } from "../lib/text-formatting";
import { HighlightColorPicker } from "./HighlightColorPicker";

type Props = {
  value: string;
  onChange: (value: string) => void;
  ranges?: TextStyleRange[];
  onStylesChange?: (ranges: TextStyleRange[]) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  describedBy?: string;
  writingKey?: string;
};

export function TextFormattingField({ value, onChange, ranges = [], onStylesChange, label, placeholder, rows = 2, describedBy, writingKey }: Props) {
  const { t } = useUiPreferences();

  const ref = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [lastHighlightColor, setLastHighlightColor] = useState(DEFAULT_HIGHLIGHT_COLOR);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const colorPanelId = useId();
  const [colorSelection, setColorSelection] = useState<{ start: number; end: number; text: string } | null>(null);
  const hasSelection = selection.end > selection.start;
  const colorOpen = colorSelection !== null && colorSelection.text === value;
  // A changed document permanently invalidates the captured range, even after undo.
  if (colorSelection && colorSelection.text !== value) setColorSelection(null);
  let offset = 0;
  const selectedStyles = splitStyledText(value, ranges).flatMap((segment) => {
    const start = offset; offset += segment.text.length;
    return start < selection.end && offset > selection.start ? [segment.style] : [];
  });
  const selectionStyle = (key: keyof TextStylePatch) => hasSelection && selectedStyles.length > 0 && selectedStyles.every((style) => Boolean(style[key]));
  const selectedColors = [...new Set(selectedStyles.filter((style) => style.highlight).map((style) => getHighlightColor(style)))];
  const fullyHighlighted = selectionStyle("highlight");
  const colorValue = fullyHighlighted && selectedColors.length === 1 ? selectedColors[0]! : "";
  function closeColorPicker(restoreFocus: boolean) {
    if (restoreFocus && colorSelection?.text === value) {
      ref.current?.focus(); ref.current?.setSelectionRange(colorSelection.start, colorSelection.end);
    }
    setColorSelection(null);
  }
  function applyColor(color: string) {
    if (!colorSelection || colorSelection.text !== value || !onStylesChange) return;
    setLastHighlightColor(color);
    onStylesChange(formatSelection(value, ranges, colorSelection.start, colorSelection.end, { highlight: true, highlightColor: color }));
    ref.current?.setSelectionRange(colorSelection.start, colorSelection.end);
  }
  function apply(patch: TextStylePatch | "clear", restoreFocus = true) {
    if (!hasSelection || !onStylesChange) return;
    onStylesChange(formatSelection(value, ranges, selection.start, selection.end, patch));
    if (restoreFocus) ref.current?.focus();
    ref.current?.setSelectionRange(selection.start, selection.end);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!(event.ctrlKey || event.metaKey) || !hasSelection || !onStylesChange) return;
    const key = event.key.toLowerCase();
    const style = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
    if (style) { event.preventDefault(); apply({ [style]: !selectionStyle(style) }); }
  }
  return (
    <div className="formatted-field" onKeyDownCapture={(event) => {
      if (event.key === "Escape" && colorOpen) {
        event.preventDefault(); event.stopPropagation(); closeColorPicker(true);
      }
    }}>
      {onStylesChange && <div className="text-format-toolbar" role="toolbar" aria-label={t(`${label}文字格式`, `${label} formatting`)}>
        {[
          { key: "bold" as const, name: t("加粗", "Bold"), Icon: Bold },
          { key: "italic" as const, name: t("斜体", "Italic"), Icon: Italic },
          { key: "underline" as const, name: t("下划线", "Underline"), Icon: Underline },
        ].map(({ key, name, Icon }) => <button key={key} type="button" aria-label={t(`${label}${name}`, `${label} ${name}`)} aria-pressed={selectionStyle(key)} disabled={!hasSelection} title={t(`${name}选中文字`, `${name} selected text`)} onMouseDown={(event) => event.preventDefault()} onClick={() => apply({ [key]: !selectionStyle(key) })}><Icon size={13} /></button>)}
        <button type="button" className="format-highlight-button" aria-label={t(`${label}高亮`, `${label} Highlight`)} aria-pressed={fullyHighlighted} disabled={!hasSelection} title={t("高亮或取消高亮选中文字", "Highlight or remove highlighting from selected text")} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (fullyHighlighted && colorValue) setLastHighlightColor(colorValue); apply(fullyHighlighted ? { highlight: false } : { highlight: true, highlightColor: lastHighlightColor }); }}><Highlighter size={13} /><span className="format-highlight-indicator" style={{ backgroundColor: colorValue || lastHighlightColor }} /></button>
        <button ref={colorButtonRef} type="button" className="format-highlight-color" aria-label={t(`${label}高亮颜色`, `${label} highlight color`)} aria-expanded={colorOpen} aria-controls={colorOpen ? colorPanelId : undefined} aria-haspopup="dialog" disabled={!hasSelection} title={t("打开色板，预览或自定义高亮颜色", "Open the palette to preview or customize highlight colors")} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          if (colorOpen) closeColorPicker(true);
          else if (hasSelection) setColorSelection({ ...selection, text: value });
        }}><span className="format-highlight-sample" style={{ backgroundColor: colorValue || lastHighlightColor }}>A</span><ChevronDown size={10} /></button>
        <span className="format-divider" />
        <Type size={12} aria-hidden="true" />
        <select aria-label={t(`${label}选中文字大小`, `${label} selected text size`)} disabled={!hasSelection} value="" onChange={(event) => apply({ fontScale: Number(event.target.value) })}>
          <option value="" disabled>{t("字号", "Size")}</option><option value="0.9">{t("小号 · 90%", "Small · 90%")}</option><option value="1">{t("正文 · 100%", "Body · 100%")}</option><option value="1.15">{t("放大 · 115%", "Large · 115%")}</option><option value="1.3">{t("强调 · 130%", "Emphasis · 130%")}</option>
        </select>
        <button type="button" aria-label={t(`${label}清除格式`, `${label} clear formatting`)} disabled={!hasSelection} title={t("清除选中文字格式", "Clear selected text formatting")} onMouseDown={(event) => event.preventDefault()} onClick={() => apply("clear")}><RemoveFormatting size={13} /></button>
        <span className="format-selection-hint">{hasSelection ? t(`已选 ${selection.end - selection.start} 字`, `${selection.end - selection.start} characters selected`) : t("选中文字设置格式", "Select text to format")}</span>
      </div>}
      {colorOpen && onStylesChange && <HighlightColorPicker key={`${colorSelection.start}:${colorSelection.end}`} id={colorPanelId} anchorRef={colorButtonRef} color={colorValue || lastHighlightColor} activeColor={colorValue || undefined} mixed={fullyHighlighted && selectedColors.length > 1} selectedText={value.slice(colorSelection.start, colorSelection.end)} onApply={applyColor} onClose={closeColorPicker} />}
      <textarea ref={ref} data-writing-key={writingKey} aria-label={label} aria-describedby={describedBy} value={value} onChange={(event) => onChange(event.target.value)} onSelect={(event) => {
        const next = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
        setSelection(next);
        if (colorSelection && (next.start !== colorSelection.start || next.end !== colorSelection.end)) setColorSelection(null);
      }} onKeyDown={handleKeyDown} rows={rows} placeholder={placeholder} />
    </div>
  );
}
