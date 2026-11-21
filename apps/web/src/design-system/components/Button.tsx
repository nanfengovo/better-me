/** @jsxRuntime automatic */
import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "tinted" | "secondary" | "ghost" | "status" | "destructive";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", iconOnly = false, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? "true" : undefined}
      className={className ? `bm-btn ${className}` : "bm-btn"}
      {...props}
    />
  );
});
