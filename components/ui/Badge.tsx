import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-gray-100 text-secondary border-gray-200",
  brand: "bg-brand-50 text-brand-800 border-brand-200",
  success: "bg-success-bg text-success-text border-success-border",
  warning: "bg-warning-bg text-warning-text border-warning-border",
  danger: "bg-danger-bg text-danger-text border-danger-border",
  info: "bg-info-bg text-info-text border-info-border",
};

export default function Badge({
  tone = "neutral",
  dot = false,
  className,
  children,
  ...props
}: {
  tone?: BadgeTone;
  /** Leading status dot, coloured by tone. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5",
        "text-caption font-medium",
        TONES[tone],
        className
      )}
      {...props}
    >
      {dot && (
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-current opacity-80" />
      )}
      {children}
    </span>
  );
}
