/** @jsxRuntime automatic */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { ButtonSize, ButtonVariant } from "./Button";

export type SplitButtonMenuEntry =
  | { kind: "divider"; id: string }
  | {
      kind?: "item";
      id: string;
      label: string;
      description?: string;
      badge?: string;
      icon?: ReactNode;
      disabled?: boolean;
      busy?: boolean;
      onSelect: () => void;
    };

export function SplitButton({
  variant = "primary",
  size = "sm",
  primaryLabel,
  primaryAriaLabel,
  primaryTitle,
  primaryIcon,
  primaryDisabled,
  primaryBusy,
  onPrimaryClick,
  menuLabel,
  menuHeading,
  items,
  align = "right",
  className,
}: {
  variant?: Extract<ButtonVariant, "primary" | "tinted" | "secondary">;
  size?: Extract<ButtonSize, "sm" | "md">;
  primaryLabel: string;
  primaryAriaLabel?: string;
  primaryTitle?: string;
  primaryIcon?: ReactNode;
  primaryDisabled?: boolean;
  primaryBusy?: boolean;
  onPrimaryClick: () => void;
  menuLabel: string;
  menuHeading?: string;
  items: readonly SplitButtonMenuEntry[];
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingEdgeRef = useRef<"first" | "last" | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    if (pendingEdgeRef.current) {
      const enabled = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      const idx = pendingEdgeRef.current === "last" ? enabled.length - 1 : 0;
      enabled[idx]?.focus();
      pendingEdgeRef.current = null;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      if (rootRef.current?.contains(event.target as Node)) {
        event.stopPropagation();
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={className ? `bm-split-wrap ${className}` : "bm-split-wrap"}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <div className="bm-split" data-variant={variant} data-size={size}>
        <button
          type="button"
          className="bm-split-primary"
          disabled={primaryDisabled}
          aria-busy={primaryBusy || undefined}
          title={primaryTitle}
          aria-description={primaryTitle}
          aria-label={primaryAriaLabel ?? primaryLabel}
          onClick={onPrimaryClick}
        >
          {primaryIcon}
          <span>{primaryLabel}</span>
        </button>
        <button
          ref={toggleRef}
          type="button"
          className="bm-split-toggle"
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const edge = event.key === "ArrowUp" ? "last" : "first";
              if (open) {
                const enabled = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
                enabled[edge === "last" ? enabled.length - 1 : 0]?.focus();
              } else {
                pendingEdgeRef.current = edge;
                setOpen(true);
              }
            }
          }}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="bm-split-menu"
          data-align={align}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const enabled = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
            if (!enabled.length) return;
            const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? enabled.length - 1
                  : (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
            enabled[next]?.focus();
          }}
        >
          {menuHeading && <div className="bm-split-menu-heading">{menuHeading}</div>}
          {items.map((entry) =>
            entry.kind === "divider" ? (
              <div key={entry.id} className="bm-split-menu-divider" role="separator" />
            ) : (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                className="bm-split-menu-item"
                disabled={entry.disabled}
                aria-busy={entry.busy || undefined}
                onClick={() => {
                  setOpen(false);
                  toggleRef.current?.focus();
                  entry.onSelect();
                }}
              >
                {entry.icon && <span className="bm-split-menu-icon">{entry.icon}</span>}
                <span className="bm-split-menu-copy">
                  <strong>{entry.label}</strong>
                  {entry.description && <small>{entry.description}</small>}
                </span>
                {entry.badge && <span className="bm-split-menu-badge">{entry.badge}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
