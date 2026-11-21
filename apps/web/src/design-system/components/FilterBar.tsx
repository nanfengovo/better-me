/** @jsxRuntime automatic */
import type { ReactNode } from "react";
import { Search, X } from "lucide-react";

export interface FilterBarSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel?: string;
  clearLabel?: string;
}

export interface FilterBarProps {
  /** Optional inline search field with instant clear button. */
  search?: FilterBarSearch;
  /** Inline filter selects, segmented controls, or tag chips. */
  controls?: ReactNode;
  /** Quiet count or summary text. */
  meta?: ReactNode;
  /** Right-aligned reset / export / secondary actions. */
  actions?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

/**
 * Calm Craft FilterBar — unified search, filter selects, and utility actions strip.
 */
export function FilterBar({
  search,
  controls,
  meta,
  actions,
  ariaLabel,
  className,
}: FilterBarProps) {
  return (
    <div
      className={className ? `bm-filter-bar ${className}` : "bm-filter-bar"}
      role={ariaLabel ? "search" : undefined}
      aria-label={ariaLabel}
    >
      {search && (
        <label className="bm-filter-search">
          <Search size={14} className="bm-filter-search-icon" aria-hidden="true" />
          <input
            type="text"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder}
            aria-label={search.ariaLabel ?? search.placeholder}
          />
          {search.value.length > 0 && (
            <button
              type="button"
              className="bm-filter-search-clear"
              aria-label={search.clearLabel ?? "清除搜索"}
              onClick={() => search.onChange("")}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </label>
      )}
      {controls && <div className="bm-filter-controls">{controls}</div>}
      {meta && <div className="bm-filter-meta">{meta}</div>}
      {actions && <div className="bm-filter-actions">{actions}</div>}
    </div>
  );
}
