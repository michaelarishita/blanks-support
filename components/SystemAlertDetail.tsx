"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { AlertTriangleIcon, ChevronDownIcon } from "@/components/ui/icons";

/**
 * The alert body, collapsed to one tappable line on a phone.
 *
 * Measured on an iPhone 13 in WebKit: the expanded banner was 235px of a
 * 664px viewport — 35% — and left the ticket thread 70px of visible
 * conversation. That is the whole of the "message visibility is cut off"
 * complaint; the diagnostic detail was pushing the conversation off screen.
 *
 * Desktop is unchanged: there the detail costs nothing anybody misses. The
 * collapse is a mobile-only concession to a viewport that does not have 235px
 * to spend on something already emailed to the person who has to act.
 */
export default function SystemAlertDetail({
  summary,
  children,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-0 flex-1 text-caption text-danger-text">
      {/* Always visible: the one line that says what is wrong. */}
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex-none">
          <AlertTriangleIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">{summary}</div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          // 44px target, and md:hidden because the detail is never collapsed
          // on a desktop — there is room, and hiding it there would only make
          // the alarm easier to overlook.
          className="-my-1.5 -mr-1.5 flex h-11 w-11 flex-none items-center justify-center rounded-md active:bg-danger-border/40 md:hidden"
        >
          <span className="sr-only">{open ? "Hide detail" : "Show detail"}</span>
          <ChevronDownIcon
            size={16}
            className={cn("transition-transform duration-micro", open && "rotate-180")}
          />
        </button>
      </div>

      {/* Detail: hidden on a phone until asked for, always shown from md up. */}
      <div className={cn("pl-6", open ? "block" : "hidden md:block")}>{children}</div>
    </div>
  );
}
