/** @jsxRuntime automatic */
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties } from "react";
import type { ButtonSize } from "./Button";

export interface HoldButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  onConfirm: () => void;
  holdMs?: number;
  size?: ButtonSize;
  iconOnly?: boolean;
  holdingLabel?: string;
}

/**
 * Press-and-hold confirmation button for destructive actions.
 * Fills with a smooth progress bar over `holdMs`; releasing early safely cancels.
 */
export function HoldButton({
  onConfirm,
  holdMs = 750,
  size = "xs",
  iconOnly = false,
  holdingLabel,
  className,
  disabled,
  children,
  ...props
}: HoldButtonProps) {
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<number | null>(null);
  const confirmedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (disabled || timerRef.current !== null) return;
    confirmedRef.current = false;
    setHolding(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      confirmedRef.current = true;
      setHolding(false);
      onConfirm();
    }, holdMs);
  }, [disabled, holdMs, onConfirm]);

  useEffect(() => cancel, [cancel]);

  return (
    <button
      type="button"
      disabled={disabled}
      data-variant="destructive"
      data-size={size}
      data-icon-only={iconOnly ? "true" : undefined}
      data-holding={holding ? "true" : undefined}
      className={className ? `bm-btn bm-hold-btn ${className}` : "bm-btn bm-hold-btn"}
      style={{ "--bm-hold-ms": `${holdMs}ms` } as CSSProperties}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        start();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") cancel();
      }}
      onBlur={cancel}
      {...props}
    >
      <span className="bm-hold-fill" aria-hidden="true" />
      <span className="bm-hold-content">{holding && holdingLabel ? holdingLabel : children}</span>
    </button>
  );
}
