/** @jsxRuntime automatic */
import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** Subtle leading icon inside a soft tinted container. */
  icon?: ReactNode;
  /** Clear, calm headline describing the current state. */
  title: ReactNode;
  /** Restrained 1–2 line guidance explaining what to do next. */
  description?: ReactNode;
  /** Primary and optional secondary action buttons. */
  actions?: ReactNode;
  /** Compact variant for side panels, cards, or embedded sections. */
  compact?: boolean;
  /** Left-aligned editorial mode (inspired by Dossier ScreenMessage) vs centered card. */
  align?: "center" | "start";
  className?: string;
}

/**
 * Calm Craft EmptyState — restrained empty or onboarding state without marketing noise.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  compact = false,
  align = "center",
  className,
}: EmptyStateProps) {
  return (
    <section
      className={className ? `bm-empty-state ${className}` : "bm-empty-state"}
      data-compact={compact ? "true" : undefined}
      data-align={align}
    >
      {icon && <div className="bm-empty-icon" aria-hidden="true">{icon}</div>}
      <h2 className="bm-empty-title">{title}</h2>
      {description && <p className="bm-empty-desc">{description}</p>}
      {actions && <div className="bm-empty-actions">{actions}</div>}
    </section>
  );
}
