"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { RefreshIcon } from "@/components/ui/icons";

/**
 * Pull down at the top of the list to refetch.
 *
 * Realtime already pushes changes, so this is not how the inbox stays
 * current — it is how someone CONFIRMS it is current. On a phone, after
 * putting the app away and coming back, the instinct is to pull, and a list
 * that doesn't respond to it reads as stale whether or not it is.
 */

/** How far down before the release actually refreshes. */
const TRIGGER_PX = 72;
/** Past this the indicator stops following, so it can't be dragged to the floor. */
const MAX_PX = 110;

export default function PullToRefresh({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const scroller = useRef<HTMLElement>(null);
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const armed = pull >= TRIGGER_PX;

  return (
    <main
      ref={scroller}
      className={cn("relative", className)}
      onTouchStart={(event) => {
        // Only from a genuine top-of-list. Starting the gesture mid-scroll
        // would fight the scroll it is interrupting.
        if ((scroller.current?.scrollTop ?? 0) > 0) {
          startY.current = null;
          return;
        }
        startY.current = event.touches[0].clientY;
      }}
      onTouchMove={(event) => {
        if (startY.current === null || refreshing) return;
        const delta = event.touches[0].clientY - startY.current;
        if (delta <= 0) {
          // Scrolling up again: hand the gesture back rather than holding it.
          setPull(0);
          startY.current = null;
          return;
        }
        // Resistance, so the sheet of content feels attached to something.
        setPull(Math.min(MAX_PX, delta * 0.45));
      }}
      onTouchEnd={() => {
        startY.current = null;
        if (!armed || refreshing) {
          setPull(0);
          return;
        }
        setRefreshing(true);
        setPull(TRIGGER_PX / 2);
        router.refresh();
        // router.refresh() resolves when the server render lands, but there is
        // no callback for it. A short hold reads as "something happened"
        // rather than a flicker, and the realtime subscription keeps the data
        // honest regardless.
        window.setTimeout(() => {
          setRefreshing(false);
          setPull(0);
        }, 700);
      }}
      onTouchCancel={() => {
        startY.current = null;
        setPull(0);
      }}
    >
      {pull > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center"
          style={{ height: pull }}
          aria-hidden="true"
        >
          <span
            className={cn(
              "mt-2 flex h-8 w-8 items-center justify-center rounded-full bg-panel shadow-md",
              armed ? "text-brand-600" : "text-tertiary"
            )}
          >
            <RefreshIcon
              size={15}
              className={refreshing ? "animate-spin" : undefined}
            />
          </span>
        </div>
      )}

      <div
        style={{ transform: pull ? `translateY(${pull}px)` : undefined }}
        // h-full matters: the ticket screen is `flex h-full`, and height:100%
        // resolves against the nearest parent with a definite height. Without
        // it this wrapper is auto-height, the ticket layout collapses, and the
        // thread stops filling the screen.
        className={cn("h-full", !pull && "transition-transform duration-panel ease-out")}
      >
        {children}
      </div>
    </main>
  );
}
