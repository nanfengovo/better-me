/** @jsxRuntime automatic */
import type { ReactNode } from "react";

export interface PageHeaderProps {
  /** Optional leading icon or badge next to the title. */
  icon?: ReactNode;
  /** Optional quiet uppercase/mono eyebrow above the title. */
  eyebrow?: ReactNode;
  /** Primary heading text. Rendered as `<h1>` by default or `<h2>`/`<h3>` via `headingLevel`. */
  title: ReactNode;
  /** Concise single-sentence subtitle explaining the workspace purpose. */
  description?: ReactNode;
  /** Inline metadata or status pills placed beside/below the title. */
  meta?: ReactNode;
  /** Right-aligned primary and secondary actions. */
  actions?: ReactNode;
  /** Compact density for nested panes and sub-surfaces. */
  compact?: boolean;
  /** Semantic heading level (defaults to 1). */
  headingLevel?: 1 | 2 | 3;
  className?: string;
}

/**
 * Calm Craft PageHeader — unified top bar across BetterMe workspaces.
 * Keeps title, quiet context, and right-aligned actions aligned on a single calm rhythm.
 */
export function PageHeader({
  icon,
  eyebrow,
  title,
  description,
  meta,
  actions,
  compact = false,
  headingLevel = 1,
  className,
}: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : headingLevel === 2 ? "h2" : "h3";
  return (
    <header
      className={className ? `bm-page-header ${className}` : "bm-page-header"}
      data-compact={compact ? "true" : undefined}
    >
      <div className="bm-page-header-main">
        {icon && <div className="bm-page-header-icon" aria-hidden="true">{icon}</div>}
        <div className="bm-page-header-copy">
          {eyebrow && <div className="bm-page-header-eyebrow">{eyebrow}</div>}
          <div className="bm-page-header-title-row">
            <Heading className="bm-page-header-title">{title}</Heading>
            {meta && <div className="bm-page-header-meta">{meta}</div>}
          </div>
          {description && <p className="bm-page-header-desc">{description}</p>}
        </div>
      </div>
      {actions && <div className="bm-page-header-actions">{actions}</div>}
    </header>
  );
}
