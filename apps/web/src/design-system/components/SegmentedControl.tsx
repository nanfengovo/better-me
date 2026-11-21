/** @jsxRuntime automatic */
import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  className,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={className ? `bm-segmented ${className}` : "bm-segmented"}
      role="group"
      aria-label={ariaLabel}
      title={title}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="bm-segmented-item"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
