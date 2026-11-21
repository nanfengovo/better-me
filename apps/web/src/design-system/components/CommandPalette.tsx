/** @jsxRuntime automatic */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";

export interface CommandItem {
  id: string;
  group: string;
  label: string;
  keywords?: string;
  description?: string;
  icon?: ReactNode;
  shortcutTokens?: readonly string[];
  disabled?: boolean;
  onSelect: () => void;
}

export function CommandPalette({
  open,
  onClose,
  items,
  placeholder,
  emptyLabel,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly CommandItem[];
  placeholder: string;
  emptyLabel: string;
  ariaLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const hay = `${item.label} ${item.group} ${item.description ?? ""} ${item.keywords ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const item of filtered) {
      const bucket = map.get(item.group) ?? [];
      bucket.push(item);
      map.set(item.group, bucket);
    }
    return [...map.entries()];
  }, [filtered]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const flatEnabled = filtered.filter((item) => !item.disabled);
  const safeIndex = flatEnabled.length > 0 ? Math.min(activeIndex, flatEnabled.length - 1) : -1;
  const activeItem = safeIndex >= 0 ? flatEnabled[safeIndex] : undefined;

  function run(item: CommandItem) {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  }

  return (
    <div
      className="bm-cmd-backdrop no-print"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bm-cmd-dialog" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div className="bm-cmd-search">
          <Search size={15} className="bm-cmd-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-controls={listId}
            aria-activedescendant={activeItem ? `${listId}-${activeItem.id}` : undefined}
            onKeyDown={(event) => {
              if (!flatEnabled.length) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((prev) => (prev + 1) % flatEnabled.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((prev) => (prev - 1 + flatEnabled.length) % flatEnabled.length);
              } else if (event.key === "Enter" && activeItem) {
                event.preventDefault();
                run(activeItem);
              }
            }}
          />
          <kbd className="bm-kbd">Esc</kbd>
        </div>

        <div ref={listRef} id={listId} className="bm-cmd-list" role="listbox" aria-label={ariaLabel}>
          {grouped.length === 0 ? (
            <div className="bm-cmd-empty">{emptyLabel}</div>
          ) : (
            grouped.map(([group, groupItems]) => (
              <div key={group} className="bm-cmd-group" role="group" aria-label={group}>
                <div className="bm-cmd-group-label">{group}</div>
                {groupItems.map((item) => {
                  const isActive = activeItem?.id === item.id;
                  const enabledIdx = flatEnabled.indexOf(item);
                  return (
                    <button
                      key={item.id}
                      id={`${listId}-${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      disabled={item.disabled}
                      className="bm-cmd-item"
                      data-active={isActive ? "true" : undefined}
                      onMouseEnter={() => { if (enabledIdx >= 0) setActiveIndex(enabledIdx); }}
                      onClick={() => run(item)}
                    >
                      {item.icon && <span className="bm-cmd-item-icon" aria-hidden="true">{item.icon}</span>}
                      <span className="bm-cmd-item-copy">
                        <strong>{item.label}</strong>
                        {item.description && <small>{item.description}</small>}
                      </span>
                      {item.shortcutTokens && item.shortcutTokens.length > 0 && (
                        <span className="bm-cmd-keys" aria-hidden="true">
                          {item.shortcutTokens.map((tok, idx) => (
                            <kbd key={`${tok}-${idx}`} className="bm-kbd">{tok}</kbd>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
