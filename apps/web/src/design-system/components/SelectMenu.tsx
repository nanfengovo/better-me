/** @jsxRuntime automatic */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectMenuOption {
  value: string;
  label: string;
}

export interface SelectMenuGroup {
  label: string;
  options: readonly SelectMenuOption[];
}

export function SelectMenu({
  id,
  value,
  options,
  groups,
  onChange,
  ariaLabel,
  appearance = "control",
  align = "left",
  fullWidth = false,
  disabled = false,
  className,
  triggerClassName,
}: {
  id?: string;
  value: string;
  options?: readonly SelectMenuOption[];
  groups?: readonly SelectMenuGroup[];
  onChange: (value: string) => void;
  ariaLabel: string;
  appearance?: "title" | "control" | "ghost";
  align?: "left" | "right";
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const flatOptions = useMemo(
    () => (groups ? groups.flatMap((group) => group.options) : (options ?? [])),
    [groups, options],
  );
  const current = flatOptions.find((opt) => opt.value === value) ?? flatOptions[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  function focusOption(edge: "first" | "last" | "selected") {
    requestAnimationFrame(() => {
      const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
      if (!items.length) return;
      if (edge === "last") items[items.length - 1]?.focus();
      else if (edge === "selected") (items.find((el) => el.getAttribute("aria-selected") === "true") ?? items[0])?.focus();
      else items[0]?.focus();
    });
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (idx + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  function renderOption(option: SelectMenuOption) {
    const selected = option.value === value;
    return (
      <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={selected}
        className="bm-select-option"
        onClick={() => {
          onChange(option.value);
          setOpen(false);
          triggerRef.current?.focus();
        }}
      >
        <span className="truncate">{option.label}</span>
        {selected && <Check size={14} aria-hidden="true" />}
      </button>
    );
  }

  return (
    <div ref={rootRef} data-full-width={fullWidth ? "true" : undefined} className={className ? `bm-select-wrap ${className}` : "bm-select-wrap"}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        role="combobox"
        className={triggerClassName ? `bm-select-trigger ${triggerClassName}` : "bm-select-trigger"}
        data-appearance={appearance}
        data-value={value}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) focusOption("selected");
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            focusOption(event.key === "ArrowUp" ? "last" : "first");
          }
        }}
      >
        <span className="bm-select-label">{current?.label ?? ""}</span>
        <ChevronDown size={appearance === "title" ? 15 : 13} className="bm-select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          className="bm-select-popover"
          data-align={align}
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={handleListKeyDown}
        >
          {groups
            ? groups.map((group) => (
                <div key={group.label} role="group" aria-label={group.label} className="bm-select-group">
                  <div className="bm-select-group-label">{group.label}</div>
                  {group.options.map(renderOption)}
                </div>
              ))
            : flatOptions.map(renderOption)}
        </div>
      )}
    </div>
  );
}
