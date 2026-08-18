"use client";

import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  COMMIT_PX,
  intentFor,
  isHorizontal,
  travelFor,
  type SwipeIntent,
} from "@/lib/swipe";
import { CheckIcon, UserIcon } from "@/components/ui/icons";

/**
 * A list row you can swipe to act on.
 *
 * The whole triage loop — resolve this, claim that — without opening
 * anything, which on a phone is the difference between working the inbox and
 * merely reading it.
 *
 * Touch only, and deliberately so: on a desktop the same actions are one
 * click away in the ticket, and a mouse "swipe" is a drag nobody would guess
 * at. Nothing here is the ONLY way to reach an action.
 */
export default function SwipeRow({
  children,
  onResolve,
  onClaim,
  canResolve,
  canClaim,
  label,
}: {
  children: ReactNode;
  onResolve: () => void;
  onClaim: () => void;
  /** Already resolved? Then the left swipe is inert rather than confusing. */
  canResolve: boolean;
  /** Already owned by this agent? Then so is the right one. */
  canClaim: boolean;
  label: string;
}) {
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const engaged = useRef(false);

  const intent: SwipeIntent = intentFor(offset);
  const allowed =
    intent === "resolve" ? canResolve : intent === "claim" ? canClaim : true;

  function reset() {
    setSettling(true);
    setOffset(0);
    start.current = null;
    engaged.current = false;
    window.setTimeout(() => setSettling(false), 200);
  }

  return (
    <div className="relative overflow-hidden">
      {/* The action behind the row. Rendered only once the gesture is
          engaged, so a stationary list has no stray colour in it. */}
      {offset !== 0 && (
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-0 flex items-center px-5 text-white",
            offset < 0
              ? "justify-end bg-success-text"
              : "justify-start bg-brand-500",
            !allowed && "opacity-40"
          )}
        >
          <span className="flex items-center gap-1.5 text-label font-semibold">
            {offset < 0 ? (
              <>
                <CheckIcon size={16} />
                {canResolve ? "Resolve" : "Already resolved"}
              </>
            ) : (
              <>
                <UserIcon size={16} />
                {canClaim ? "Claim" : "Already yours"}
              </>
            )}
          </span>
        </div>
      )}

      <div
        // pan-y: the browser keeps vertical scrolling, we take horizontal.
        // Without it the browser claims both and the swipe never fires.
        className={cn(
          "touch-pan-y-only relative bg-panel",
          settling && "transition-transform duration-panel ease-out"
        )}
        style={{ transform: `translateX(${offset}px)` }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          start.current = { x: touch.clientX, y: touch.clientY };
          engaged.current = false;
        }}
        onTouchMove={(event) => {
          if (!start.current) return;
          const touch = event.touches[0];
          const dx = touch.clientX - start.current.x;
          const dy = touch.clientY - start.current.y;

          if (!engaged.current) {
            // Undecided until the gesture proves itself horizontal, so a
            // slightly diagonal scroll doesn't drag every row sideways.
            if (!isHorizontal(dx, dy)) return;
            engaged.current = true;
          }
          setOffset(travelFor(dx));
        }}
        onTouchEnd={() => {
          if (!engaged.current) {
            reset();
            return;
          }
          const decided = intentFor(offset);
          if (decided === "resolve" && canResolve) onResolve();
          if (decided === "claim" && canClaim) onClaim();
          reset();
        }}
        onTouchCancel={reset}
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}

/** Exposed for the test, so the copy and the threshold can't drift apart. */
export const SWIPE_COMMIT_PX = COMMIT_PX;
