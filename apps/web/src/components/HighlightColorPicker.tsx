/** @jsxRuntime automatic */
import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, X } from "lucide-react";
import { DEFAULT_HIGHLIGHT_COLOR } from "@better-me/core";
import { useUiPreferences } from "../lib/ui-preferences";

type Props = {
  id: string;
  anchorRef: RefObject<HTMLButtonElement | null>;
  color: string;
  activeColor?: string;
  mixed: boolean;
  selectedText: string;
  onApply: (color: string) => void;
  onClose: (restoreFocus: boolean) => void;
};
const validHex = (value: string) => /^#[\da-f]{6}$/i.test(value);

/** Preview is local to this panel. Only choosing a swatch or Apply changes the resume. */
export function HighlightColorPicker({ id, anchorRef, color, activeColor, mixed, selectedText, onApply, onClose }: Props) {
  const { t } = useUiPreferences();
  const panelRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(color);
  const [hoverColor, setHoverColor] = useState<string | null>(null);
  const draftValid = validHex(draft);
  const previewColor = hoverColor ?? (draftValid ? draft.toLowerCase() : color);
  const colors = [
    { value: DEFAULT_HIGHLIGHT_COLOR, name: t("黄色", "Yellow") },
    { value: "#c7ebcf", name: t("绿色", "Green") },
    { value: "#cce5ff", name: t("蓝色", "Blue") },
    { value: "#f8cddd", name: t("粉色", "Pink") },
    { value: "#e2d5f5", name: t("紫色", "Purple") },
    { value: "#ffdab9", name: t("橙色", "Orange") },
  ];
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) onClose(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [anchorRef, onClose]);
  return <div ref={panelRef} id={id} className="highlight-color-picker" role="dialog" aria-label={t("高亮颜色", "Highlight color")} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); }
  }}>
    <div className="highlight-color-heading"><strong>{t("高亮颜色", "Highlight color")}</strong><button type="button" className="highlight-color-close" aria-label={t("关闭颜色面板", "Close color picker")} onClick={() => onClose(true)}><X size={14} /></button></div>
    <div className="highlight-color-swatches" role="group" aria-label={t("预设高亮颜色", "Preset highlight colors")}>
      {colors.map((item) => <button key={item.value} type="button" className="highlight-color-swatch" aria-label={item.name} aria-pressed={activeColor === item.value} title={`${item.name} ${item.value}`} onMouseEnter={() => setHoverColor(item.value)} onMouseLeave={() => setHoverColor(null)} onFocus={() => setHoverColor(item.value)} onBlur={() => setHoverColor(null)} onClick={() => { setDraft(item.value); setHoverColor(null); onApply(item.value); }}>
        <span className="highlight-color-chip" style={{ backgroundColor: item.value }}>{activeColor === item.value && <Check size={15} />}</span><span>{item.name}</span>
      </button>)}
    </div>
    {mixed && <p className="highlight-color-note">{t("已选文字包含多种颜色，选择新颜色可统一。", "The selection has mixed colors. Choose a color to make it uniform.")}</p>}
    <div className="highlight-color-preview" data-testid="highlight-color-preview"><span className="highlight-color-preview-label">{t("简历效果预览", "Resume preview")}</span><div><mark style={{ backgroundColor: previewColor }}>{selectedText || t("高亮文字示例", "Highlighted text")}</mark></div></div>
    <p className="highlight-color-note">{t("悬停色块可预览，点击后应用到选中文字。", "Hover over a swatch to preview; click to apply it to the selected text.")}</p>
    <div className="highlight-color-custom">
      <label className="highlight-color-native"><span>{t("自定义", "Custom")}</span><input type="color" aria-label={t("拾取高亮颜色", "Pick highlight color")} value={draftValid ? draft.toLowerCase() : color} onChange={(event) => { setDraft(event.target.value); setHoverColor(null); }} /></label>
      <label className="highlight-color-hex"><span>{t("颜色值", "Hex color")}</span><input type="text" aria-label={t("自定义高亮颜色", "Custom highlight color")} value={draft} spellCheck={false} maxLength={7} aria-invalid={!draftValid} aria-describedby={!draftValid ? `${id}-error` : undefined} onChange={(event) => { setDraft(event.target.value); setHoverColor(null); }} onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); if (draftValid) onApply(draft.toLowerCase()); }
      }} /></label>
      <button type="button" className="highlight-color-apply" disabled={!draftValid} onClick={() => onApply(draft.toLowerCase())}>{t("应用颜色", "Apply color")}</button>
    </div>
    {!draftValid && <p id={`${id}-error`} className="highlight-color-error" role="status">{t("请输入 # 加 6 位十六进制颜色，如 #A8D8FF。", "Enter # followed by 6 hexadecimal digits, for example #A8D8FF.")}</p>}
  </div>;
}
