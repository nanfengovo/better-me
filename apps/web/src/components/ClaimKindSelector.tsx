import { useState, useRef, useEffect, useId } from "react";
import { ChevronDown, Plus, Check, X, Sparkles, Tag, Trash2 } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";

export interface ClaimKindSelectorProps {
  value: string;
  onChange: (nextKind: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

interface KindOption {
  id: string;
  label: string;
  enLabel: string;
  icon: string;
  isStandard?: boolean;
  isMetric?: boolean;
}

const STANDARD_KINDS: KindOption[] = [
  { id: "action", label: "行动 (Action)", enLabel: "Action", icon: "🚀", isStandard: true },
  { id: "metric", label: "量化指标 (Metric)", enLabel: "Metric", icon: "📊", isStandard: true, isMetric: true },
  { id: "note", label: "备忘 (Note)", enLabel: "Note", icon: "📝", isStandard: true },
  { id: "pitfall", label: "防坑/避雷 (Pitfall)", enLabel: "Pitfall", icon: "🛡️", isStandard: true },
  { id: "interview", label: "答辩考点 (Interview)", enLabel: "Interview notes", icon: "🎯", isStandard: true },
];

const PRESET_CUSTOM_KINDS: KindOption[] = [
  { id: "star_situation", label: "STAR · 情境 (Situation)", enLabel: "Situation", icon: "💡" },
  { id: "star_task", label: "STAR · 任务 (Task)", enLabel: "Task", icon: "🎯" },
  { id: "star_result", label: "STAR · 结果 (Result)", enLabel: "Result", icon: "🏆" },
  { id: "architecture", label: "架构攻坚 (Architecture)", enLabel: "Architecture", icon: "⚙️" },
  { id: "contribution", label: "核心贡献 (Contribution)", enLabel: "Contribution", icon: "🌟" },
  { id: "background", label: "项目背景 (Background)", enLabel: "Background", icon: "📌" },
  { id: "teamwork", label: "团队协作 (Teamwork)", enLabel: "Teamwork", icon: "👥" },
];

const STORAGE_KEY = "betterme_custom_claim_kinds";

function loadSavedCustomKinds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string" && s.trim());
    }
  } catch {}
  return [];
}

function saveCustomKinds(kinds: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kinds));
  } catch {}
}

export function ClaimKindSelector({
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: ClaimKindSelectorProps) {
  const { t } = useUiPreferences();
  const [isOpen, setIsOpen] = useState(false);
  const [userCustomKinds, setUserCustomKinds] = useState<string[]>(loadSavedCustomKinds);
  const [newKindInput, setNewKindInput] = useState("");
  const [isAddingCustom, setIsAddingCustom] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsAddingCustom(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("touchstart", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("touchstart", handleOutsideClick);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isAddingCustom) {
      inputRef.current?.focus();
    }
  }, [isAddingCustom]);

  // Find active label & icon
  const currentOption =
    STANDARD_KINDS.find((k) => k.id === value) ||
    PRESET_CUSTOM_KINDS.find((k) => k.id === value || k.label === value) || {
      id: value,
      label: value,
      enLabel: value,
      icon: "✨",
    };

  const handleSelect = (kindId: string) => {
    onChange(kindId);
    setIsOpen(false);
    setIsAddingCustom(false);
  };

  const handleAddCustomKind = () => {
    const trimmed = newKindInput.trim();
    if (!trimmed) return;
    if (!userCustomKinds.includes(trimmed)) {
      const next = [...userCustomKinds, trimmed];
      setUserCustomKinds(next);
      saveCustomKinds(next);
    }
    setNewKindInput("");
    setIsAddingCustom(false);
    onChange(trimmed);
    setIsOpen(false);
  };

  const handleDeleteCustomKind = (kindToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = userCustomKinds.filter((k) => k !== kindToDelete);
    setUserCustomKinds(next);
    saveCustomKinds(next);
    if (value === kindToDelete) {
      onChange("action");
    }
  };

  return (
    <div className="relative inline-block text-left" ref={containerRef}>
      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel ?? t("选择要点类别", "Select entry category")}
        className={`agent-btn-press group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold transition-all cursor-pointer shadow-2xs select-none ${
          isOpen
            ? "border-emerald-500 ring-2 ring-emerald-500/20 bg-emerald-50/60 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
            : "border-slate-200 dark:border-slate-700 bg-white dark:bg-[#27282f] text-slate-800 dark:text-slate-100 hover:border-emerald-400 dark:hover:border-emerald-500/50 hover:bg-slate-50 dark:hover:bg-[#2e3038]"
        }`}
      >
        <span className="text-sm shrink-0 leading-none">{currentOption.icon}</span>
        <span className="truncate max-w-[130px] font-medium tracking-tight">
          {currentOption.label}
        </span>
        <ChevronDown
          size={12}
          className={`text-slate-400 dark:text-slate-400 group-hover:text-emerald-500 transition-transform duration-200 ${
            isOpen ? "rotate-180 text-emerald-600" : ""
          }`}
        />
      </button>

      {/* Custom Elevated Dropdown Popover */}
      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 mt-1.5 w-64 max-h-80 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#27282f] shadow-xl z-50 p-1.5 space-y-2 text-xs agent-custom-scrollbar animate-in fade-in zoom-in-95 duration-100"
        >
          {/* Section 1: Standard Kinds */}
          <div>
            <div className="px-2 py-1 text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-wider">
              {t("标准要点类型", "Standard Categories")}
            </div>
            <div className="space-y-0.5">
              {STANDARD_KINDS.map((opt) => {
                const isSelected = value === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(opt.id)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer text-left ${
                      isSelected
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold border border-emerald-500/30"
                        : "hover:bg-slate-100 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span>{opt.icon}</span>
                      <span>{opt.label}</span>
                    </span>
                    {isSelected && <Check size={13} className="text-emerald-600 dark:text-emerald-400" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Section 2: Popular STAR Presets */}
          <div className="border-t border-slate-100 dark:border-slate-800 pt-1.5">
            <div className="px-2 py-1 text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
              <Sparkles size={11} className="text-amber-500" />
              <span>{t("STAR · 常用分类预设", "STAR & Common Presets")}</span>
            </div>
            <div className="space-y-0.5">
              {PRESET_CUSTOM_KINDS.map((opt) => {
                const isSelected = value === opt.id || value === opt.label;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(opt.label)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer text-left ${
                      isSelected
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold border border-emerald-500/30"
                        : "hover:bg-slate-100 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span>{opt.icon}</span>
                      <span>{opt.label}</span>
                    </span>
                    {isSelected && <Check size={13} className="text-emerald-600 dark:text-emerald-400" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Section 3: User Custom Categories */}
          {userCustomKinds.length > 0 && (
            <div className="border-t border-slate-100 dark:border-slate-800 pt-1.5">
              <div className="px-2 py-1 text-[10px] font-bold text-slate-400 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
                <Tag size={11} className="text-teal-500" />
                <span>{t("自定义专属分类", "Custom Categories")}</span>
              </div>
              <div className="space-y-0.5">
                {userCustomKinds.map((customKind) => {
                  const isSelected = value === customKind;
                  return (
                    <div
                      key={customKind}
                      onClick={() => handleSelect(customKind)}
                      role="option"
                      aria-selected={isSelected}
                      className={`group flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer text-left ${
                        isSelected
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold border border-emerald-500/30"
                          : "hover:bg-slate-100 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200"
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <span>🏷️</span>
                        <span className="truncate">{customKind}</span>
                      </span>
                      <div className="flex items-center gap-1">
                        {isSelected && <Check size={13} className="text-emerald-600 dark:text-emerald-400 mr-1" />}
                        <button
                          type="button"
                          onClick={(e) => handleDeleteCustomKind(customKind, e)}
                          title={t("删除此自定义分类", "Delete this category")}
                          className="opacity-0 group-hover:opacity-100 hover:text-rose-500 p-0.5 rounded transition"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 4: Add New Custom Category Input */}
          <div className="border-t border-slate-100 dark:border-slate-800 pt-2 pb-0.5 px-1">
            {isAddingCustom ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={newKindInput}
                    onChange={(e) => setNewKindInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddCustomKind();
                      } else if (e.key === "Escape") {
                        setIsAddingCustom(false);
                      }
                    }}
                    placeholder={t("输入自定义类别 (如: 技术突破)", "e.g. Breakthrough")}
                    className="flex-1 px-2.5 py-1 rounded-lg border border-emerald-400 dark:border-emerald-500 bg-slate-50 dark:bg-slate-800 text-xs text-slate-800 dark:text-slate-100 outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomKind}
                    disabled={!newKindInput.trim()}
                    className="agent-btn-press px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs disabled:opacity-40 transition cursor-pointer"
                  >
                    {t("确定", "Add")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsAddingCustom(false)}
                    className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsAddingCustom(true)}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 hover:border-emerald-500 hover:bg-emerald-50/50 dark:hover:bg-emerald-500/10 text-slate-600 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-300 text-xs font-semibold transition cursor-pointer"
              >
                <Plus size={13} />
                <span>{t("+ 自定义类别...", "+ Custom Category...")}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
