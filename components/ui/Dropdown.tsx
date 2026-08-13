"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

// Click-outside + Escape + focus return. Rendered inline (not portalled) —
// every current use sits inside a scroll container that the menu should
// travel with.
export function Dropdown({
  trigger,
  children,
  align = "start",
  side = "bottom",
  className,
  menuClassName,
}: {
  /** Receives the open state so the trigger can show its own affordance. */
  trigger: (open: boolean) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="block w-full text-left"
      >
        {trigger(open)}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-40 min-w-[180px] animate-slide-up overflow-hidden",
            "rounded-md bg-panel p-1 shadow-md ring-1 ring-black/5",
            side === "bottom" ? "top-full mt-1" : "bottom-full mb-1",
            align === "start" ? "left-0" : "right-0",
            menuClassName
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

const ITEM_CLASSES =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-label " +
  "transition-colors duration-micro ease-out " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Renders an anchor when `href` is set and a button otherwise — a nav item
 * must stay a real link so middle-click and open-in-new-tab work, and a
 * button nested inside an anchor would be invalid markup.
 */
export function DropdownItem({
  icon,
  danger = false,
  href,
  className,
  children,
  ...props
}: {
  icon?: ReactNode;
  danger?: boolean;
  href?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const tone = danger
    ? "text-danger-text hover:bg-danger-bg"
    : "text-primary hover:bg-gray-100";
  const body = (
    <>
      {icon && <span className="flex-none text-tertiary">{icon}</span>}
      {children}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        role="menuitem"
        className={cn(ITEM_CLASSES, tone, className)}
        onClick={props.onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}
      >
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      className={cn(ITEM_CLASSES, tone, className)}
      {...props}
    >
      {body}
    </button>
  );
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-gray-200" role="separator" />;
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
      {children}
    </div>
  );
}
