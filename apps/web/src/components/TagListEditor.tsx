import { useState, useRef, useEffect } from "react";
import { Plus, Check, X } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";

export interface DopaminePalette {
  bg: string;
  text: string;
  border: string;
  hoverBorder: string;
  dot: string;
}

export const DOPAMINE_PALETTES: DopaminePalette[] = [
  // 1. 蜜桃粉 (Peach Pink)
  {
    bg: "bg-rose-50 dark:bg-rose-500/15",
    text: "text-rose-700 dark:text-rose-300",
    border: "border-rose-200 dark:border-rose-500/35",
    hoverBorder: "hover:border-rose-400 dark:hover:border-rose-400",
    dot: "bg-rose-400 dark:bg-rose-300",
  },
  // 2. 薄荷绿 (Mint Emerald)
  {
    bg: "bg-emerald-50 dark:bg-emerald-500/15",
    text: "text-emerald-700 dark:text-emerald-300",
    border: "border-emerald-200 dark:border-emerald-500/35",
    hoverBorder: "hover:border-emerald-400 dark:hover:border-emerald-400",
    dot: "bg-emerald-400 dark:bg-emerald-300",
  },
  // 3. 晴空蓝 (Sky Azure)
  {
    bg: "bg-sky-50 dark:bg-sky-500/15",
    text: "text-sky-700 dark:text-sky-300",
    border: "border-sky-200 dark:border-sky-500/35",
    hoverBorder: "hover:border-sky-400 dark:hover:border-sky-400",
    dot: "bg-sky-400 dark:bg-sky-300",
  },
  // 4. 香芋紫 (Taro Lavender)
  {
    bg: "bg-purple-50 dark:bg-purple-500/15",
    text: "text-purple-700 dark:text-purple-300",
    border: "border-purple-200 dark:border-purple-500/35",
    hoverBorder: "hover:border-purple-400 dark:hover:border-purple-400",
    dot: "bg-purple-400 dark:bg-purple-300",
  },
  // 5. 暖阳金 (Sunny Marigold)
  {
    bg: "bg-amber-50 dark:bg-amber-500/15",
    text: "text-amber-800 dark:text-amber-300",
    border: "border-amber-200 dark:border-amber-500/35",
    hoverBorder: "hover:border-amber-400 dark:hover:border-amber-400",
    dot: "bg-amber-400 dark:bg-amber-300",
  },
  // 6. 蒂芙尼青 (Tiffany Teal)
  {
    bg: "bg-teal-50 dark:bg-teal-500/15",
    text: "text-teal-700 dark:text-teal-300",
    border: "border-teal-200 dark:border-teal-500/35",
    hoverBorder: "hover:border-teal-400 dark:hover:border-teal-400",
    dot: "bg-teal-400 dark:bg-teal-300",
  },
  // 7. 珊瑚暖橘 (Coral Orange)
  {
    bg: "bg-orange-50 dark:bg-orange-500/15",
    text: "text-orange-700 dark:text-orange-300",
    border: "border-orange-200 dark:border-orange-500/35",
    hoverBorder: "hover:border-orange-400 dark:hover:border-orange-400",
    dot: "bg-orange-400 dark:bg-orange-300",
  },
  // 8. 樱花品红 (Cherry Fuchsia)
  {
    bg: "bg-fuchsia-50 dark:bg-fuchsia-500/15",
    text: "text-fuchsia-700 dark:text-fuchsia-300",
    border: "border-fuchsia-200 dark:border-fuchsia-500/35",
    hoverBorder: "hover:border-fuchsia-400 dark:hover:border-fuchsia-400",
    dot: "bg-fuchsia-400 dark:bg-fuchsia-300",
  },
  // 9. 电光青柠 (Electric Lime)
  {
    bg: "bg-lime-50 dark:bg-lime-500/15",
    text: "text-lime-800 dark:text-lime-300",
    border: "border-lime-200 dark:border-lime-500/35",
    hoverBorder: "hover:border-lime-400 dark:hover:border-lime-400",
    dot: "bg-lime-400 dark:bg-lime-300",
  },
  // 10. 极光靛蓝 (Aurora Indigo)
  {
    bg: "bg-indigo-50 dark:bg-indigo-500/15",
    text: "text-indigo-700 dark:text-indigo-300",
    border: "border-indigo-200 dark:border-indigo-500/35",
    hoverBorder: "hover:border-indigo-400 dark:hover:border-indigo-400",
    dot: "bg-indigo-400 dark:bg-indigo-300",
  },
  // 11. 鸢尾紫罗兰 (Iris Violet)
  {
    bg: "bg-violet-50 dark:bg-violet-500/15",
    text: "text-violet-700 dark:text-violet-300",
    border: "border-violet-200 dark:border-violet-500/35",
    hoverBorder: "hover:border-violet-400 dark:hover:border-violet-400",
    dot: "bg-violet-400 dark:bg-violet-300",
  },
  // 12. 翠湖绿 (Lake Cyan)
  {
    bg: "bg-cyan-50 dark:bg-cyan-500/15",
    text: "text-cyan-700 dark:text-cyan-300",
    border: "border-cyan-200 dark:border-cyan-500/35",
    hoverBorder: "hover:border-cyan-400 dark:hover:border-cyan-400",
    dot: "bg-cyan-400 dark:bg-cyan-300",
  },
];

export function getDopaminePalette(tag: string, index: number): DopaminePalette {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash << 5) - hash + tag.charCodeAt(i);
    hash |= 0;
  }
  const paletteIndex = Math.abs(hash + index * 5) % DOPAMINE_PALETTES.length;
  return DOPAMINE_PALETTES[paletteIndex] ?? DOPAMINE_PALETTES[0]!;
}

export interface TagListEditorProps {
  tags?: string[];
  onChange: (nextTags: string[]) => void;
  addLabel?: string;
  placeholder?: string;
  variant?: "accent" | "warning" | "dopamine";
  pillShape?: "rounded" | "pill";
  ariaLabel?: string;
  inputAriaLabel?: string;
}

export function TagListEditor({
  tags = [],
  onChange,
  addLabel,
  placeholder,
  variant = "dopamine",
  pillShape = "rounded",
  ariaLabel,
  inputAriaLabel,
}: TagListEditorProps) {
  const { t } = useUiPreferences();
  const [isAdding, setIsAdding] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAdding) {
      addInputRef.current?.focus();
    }
  }, [isAdding]);

  useEffect(() => {
    if (editingIndex !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingIndex]);

  const commitAdd = () => {
    const trimmed = addValue.trim();
    if (!trimmed) {
      setIsAdding(false);
      setAddValue("");
      return;
    }
    // Support comma, semicolon, ideographic comma and newline separation
    const newItems = trimmed
      .split(/[,，、;\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (newItems.length > 0) {
      const existingSet = new Set(tags);
      const filtered = newItems.filter((item) => !existingSet.has(item));
      if (filtered.length > 0) {
        onChange([...tags, ...filtered]);
      }
    }
    setIsAdding(false);
    setAddValue("");
  };

  const cancelAdd = () => {
    setIsAdding(false);
    setAddValue("");
  };

  const commitEdit = (idx: number) => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      onChange(tags.filter((_, i) => i !== idx));
    } else if (trimmed !== tags[idx]) {
      onChange(tags.map((t, i) => (i === idx ? trimmed : t)));
    }
    setEditingIndex(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValue("");
  };

  const removeTag = (idx: number) => {
    onChange(tags.filter((_, i) => i !== idx));
  };

  const isWarning = variant === "warning";
  const isDopamine = variant === "dopamine";
  const isPill = pillShape === "pill";

  const rawAddLabel = addLabel ?? t("添加标签", "Add tag");
  const displayAddLabel = rawAddLabel.replace(/^\+\s*/, "");

  const pillClass = isWarning
    ? `inline-flex items-center gap-1.5 ${isPill ? "rounded-full px-2.5 py-1" : "rounded-md px-2 py-0.5"} text-xs font-medium bg-[var(--color-warn-soft)] text-[var(--color-warn)] border border-[color-mix(in_srgb,var(--color-warn)_25%,transparent)] transition-all select-none hover:border-[var(--color-warn)]`
    : `inline-flex items-center gap-1.5 ${isPill ? "rounded-full px-2.5 py-1" : "rounded-md px-2 py-0.5"} text-xs font-medium bg-[var(--color-accent-soft)] text-[var(--color-accent)] border border-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] transition-all select-none hover:border-[var(--color-accent)]`;

  const addButtonClass = isDopamine
    ? `inline-flex items-center gap-1.5 ${isPill ? "rounded-full px-2.5 py-0.8" : "rounded-md px-2.5 py-0.8"} border border-dashed border-slate-300 dark:border-slate-600 bg-slate-50/70 dark:bg-white/5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-emerald-500 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50/70 dark:hover:bg-emerald-500/10 transition-all cursor-pointer shadow-2xs hover:shadow-xs hover:scale-[1.02]`
    : isWarning
    ? `inline-flex items-center gap-1.5 ${isPill ? "rounded-full px-2.5 py-1" : "rounded-md px-2.5 py-0.8"} border border-dashed border-[var(--color-line-strong)] bg-transparent text-xs font-medium text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors cursor-pointer`
    : `inline-flex items-center gap-1.5 ${isPill ? "rounded-full px-2.5 py-1" : "rounded-md px-2.5 py-0.8"} border border-dashed border-[var(--color-line-strong)] bg-transparent text-xs font-medium text-[var(--color-ink-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors cursor-pointer`;

  return (
    <div
      role="group"
      aria-label={ariaLabel ?? t("标签列表", "Tag list")}
      className="flex flex-wrap items-center gap-1.5"
    >
      {tags.map((tag, idx) => {
        const palette = isDopamine ? getDopaminePalette(tag, idx) : null;
        const currentPillClass = isDopamine && palette
          ? `inline-flex items-center gap-1.5 ${isPill ? "rounded-full px-2.5 py-0.8" : "rounded-md px-2 py-0.5"} text-xs font-semibold ${palette.bg} ${palette.text} border ${palette.border} ${palette.hoverBorder} shadow-2xs transition-all select-none hover:shadow-xs hover:scale-[1.02]`
          : pillClass;

        if (editingIndex === idx) {
          const editContainerClass = isDopamine && palette
            ? `inline-flex items-center gap-1.5 ${isPill ? "rounded-full px-2.5 py-0.5" : "rounded-md px-2 py-0.5"} text-xs font-semibold ${palette.bg} ${palette.text} border-2 border-emerald-500 dark:border-emerald-400 ring-2 ring-emerald-500/20 shadow-xs transition-all`
            : `inline-flex items-center gap-1.5 ${isPill ? "rounded-full px-2.5 py-0.5" : "rounded-md px-2 py-0.5"} text-xs font-semibold bg-white dark:bg-slate-800 border-2 border-emerald-500 dark:border-emerald-400 ring-2 ring-emerald-500/20 shadow-xs text-slate-800 dark:text-slate-100 transition-all`;

          return (
            <div key={idx} className={editContainerClass}>
              {isDopamine && palette && (
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${palette.dot} animate-pulse`} />
              )}
              <input
                ref={editInputRef}
                type="text"
                value={editValue}
                aria-label={inputAriaLabel ?? t(`编辑标签 ${tag}`, `Edit tag ${tag}`)}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitEdit(idx);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                onBlur={() => commitEdit(idx)}
                style={{
                  width: `${Math.max(editValue.length + 1, 4)}ch`,
                  minWidth: "3.5rem",
                  maxWidth: "14rem",
                  border: "none",
                  outline: "none",
                  boxShadow: "none",
                  background: "transparent",
                }}
                className="bm-tag-input text-xs font-semibold text-slate-800 dark:text-slate-100 placeholder:text-slate-400 p-0 m-0"
              />
              <span className="h-3 w-px bg-slate-300/80 dark:bg-slate-600/80 mx-0.5 shrink-0" />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commitEdit(idx)}
                title={t("保存修改", "Save change")}
                aria-label={t("保存修改", "Save change")}
                className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500 hover:bg-emerald-600 active:scale-90 text-white shadow-2xs transition-all cursor-pointer shrink-0"
              >
                <Check className="w-2.5 h-2.5 stroke-[2.5]" />
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={cancelEdit}
                title={t("取消", "Cancel")}
                aria-label={t("取消修改", "Cancel edit")}
                className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700/80 hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-900/50 dark:hover:text-rose-300 active:scale-90 text-slate-500 dark:text-slate-300 shadow-2xs transition-all cursor-pointer shrink-0"
              >
                <X className="w-2.5 h-2.5 stroke-[2.5]" />
              </button>
            </div>
          );
        }

        return (
          <span key={idx} className={currentPillClass}>
            {isDopamine && palette && (
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${palette.dot}`} />
            )}
            <span
              onClick={() => {
                setEditingIndex(idx);
                setEditValue(tag);
              }}
              className="cursor-pointer hover:underline transition-opacity font-medium tracking-tight"
              title={t("点击编辑此标签", "Click to edit this tag")}
            >
              {tag}
            </span>
            <button
              type="button"
              onClick={() => removeTag(idx)}
              aria-label={t(`删除标签 ${tag}`, `Delete tag ${tag}`)}
              className="text-inherit opacity-60 hover:opacity-100 hover:text-rose-500 hover:scale-120 transition-all px-0.5 leading-none text-sm font-bold cursor-pointer"
            >
              ×
            </button>
          </span>
        );
      })}

      {isAdding ? (
        <div
          className={`inline-flex items-center gap-1.5 ${
            isPill ? "rounded-full px-2.5 py-0.8" : "rounded-md px-2 py-0.8"
          } text-xs bg-white dark:bg-slate-800 border-2 border-emerald-500 dark:border-emerald-400 ring-2 ring-emerald-500/20 shadow-xs transition-all`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <input
            ref={addInputRef}
            type="text"
            value={addValue}
            aria-label={inputAriaLabel ?? t("新标签名称", "New tag name")}
            onChange={(e) => setAddValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitAdd();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelAdd();
              }
            }}
            onBlur={() => commitAdd()}
            placeholder={
              placeholder ??
              t("输入标签，回车保存 (支持逗号隔开)", "Enter tag, press Enter (comma-separated supported)")
            }
            style={{
              minWidth: "6rem",
              width: `${Math.max(addValue.length + 1, 8)}ch`,
              maxWidth: "16rem",
              border: "none",
              outline: "none",
              boxShadow: "none",
              background: "transparent",
            }}
            className="bm-tag-input text-xs font-medium text-slate-800 dark:text-slate-100 placeholder:text-slate-400 p-0 m-0"
          />
          <span className="h-3 w-px bg-slate-300/80 dark:bg-slate-600/80 mx-0.5 shrink-0" />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commitAdd}
            title={t("确认保存", "Confirm")}
            aria-label={t("确认保存", "Confirm")}
            className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500 hover:bg-emerald-600 active:scale-90 text-white shadow-2xs transition-all cursor-pointer shrink-0"
          >
            <Check className="w-2.5 h-2.5 stroke-[2.5]" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancelAdd}
            title={t("取消", "Cancel")}
            aria-label={t("取消添加", "Cancel add")}
            className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700/80 hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-900/50 dark:hover:text-rose-300 active:scale-90 text-slate-500 dark:text-slate-300 shadow-2xs transition-all cursor-pointer shrink-0"
          >
            <X className="w-2.5 h-2.5 stroke-[2.5]" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setIsAdding(true);
            setAddValue("");
          }}
          className={addButtonClass}
        >
          <Plus className="h-3 w-3 stroke-[2.5] text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>{displayAddLabel}</span>
        </button>
      )}
    </div>
  );
}
