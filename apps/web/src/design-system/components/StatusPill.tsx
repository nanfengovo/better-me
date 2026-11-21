/** @jsxRuntime automatic */
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type StatusPillTone = "warn" | "accent" | "danger" | "neutral";

export interface StatusPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: StatusPillTone;
  dot?: boolean;
  trailing?: ReactNode;
}

export function StatusPill({
  tone = "warn",
  dot = true,
  trailing,
  className,
  type = "button",
  children,
  ...props
}: StatusPillProps) {
  return (
    <button
      type={type}
      data-tone={tone}
      className={className ? `bm-status-pill ${className}` : "bm-status-pill"}
      {...props}
    >
      {dot && <span className="bm-status-pill-dot" aria-hidden="true" />}
      <span>{children}</span>
      {trailing}
    </button>
  );
}
