"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
export type ButtonSize = "sm" | "md";

// Blue is the brand accent and is reserved for the single primary action in
// a view (see globals.css). Two blue buttons on one screen means one of them
// should be `secondary`.
//
// White on brand-500 measures 5.06:1, so the label darkens the FILL on hover
// rather than lightening it — hover:bg-brand-400 would drop white text below
// AA. The contrast test asserts this.
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-500 text-white shadow-sm hover:bg-brand-600 active:bg-brand-700 disabled:bg-brand-200 disabled:text-brand-800",
  secondary:
    "bg-panel text-primary border border-subtle shadow-sm hover:bg-gray-50 hover:border-strong active:bg-gray-100",
  ghost: "text-secondary hover:bg-gray-100 hover:text-primary active:bg-gray-200",
  danger: "bg-danger-text text-white shadow-sm hover:opacity-90 active:opacity-100",
  success: "bg-success-text text-white shadow-sm hover:opacity-90 active:opacity-100",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-caption gap-1.5 rounded-sm",
  md: "h-9 px-3.5 text-label gap-2 rounded-md",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner and disables the button. */
  loading?: boolean;
  /** Square button sized for a single icon. */
  iconOnly?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    iconOnly = false,
    disabled,
    className,
    children,
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex select-none items-center justify-center font-medium",
        "transition-colors duration-micro ease-out",
        "disabled:cursor-not-allowed disabled:opacity-60",
        SIZES[size],
        iconOnly && (size === "sm" ? "w-7 px-0" : "w-9 px-0"),
        VARIANTS[variant],
        className
      )}
      {...props}
    >
      {loading && (
        <svg
          className="h-3.5 w-3.5 animate-spin"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path
            d="M14 8a6 6 0 0 0-6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
      {children}
    </button>
  );
});

export default Button;
