"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

// Shows on hover *and* keyboard focus, and is wired up with aria-describedby
// so it isn't a mouse-only affordance.
export default function Tooltip({
  content,
  side = "top",
  children,
  className,
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "right";
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  const position = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  }[side];

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-50 animate-fade-in whitespace-nowrap",
            "rounded-sm bg-gray-900 px-2 py-1 text-caption font-medium text-white shadow-md",
            position
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
