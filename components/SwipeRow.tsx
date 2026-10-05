"use client";

import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  COMMIT_PX,
  intentFor,
  isEdgeSwipe,
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
/**
 * A long, stationary hold — the mobile gesture for junk and multi-select.
 *
 * Junking by accident is worse than an accidental resolve or claim, so junk is
 * deliberately NOT a swipe direction: a third direction would crowd the two
 * that exist and lower the bar for firing them. A hold is the opposite of a
 * flick — it cannot happen while scrolling, and it takes a held half-second —
 * so it biases hard against the misfire. It opens a menu rather than acting
 * directly, which is a second deliberate tap on top of the hold.
 */
const LONG_PRESS_MS = 500;
/** Any finger travel past this cancels the hold — it was a swipe or a scroll. */
const LONG_PRESS_SLOP_PX = 10;

export default function SwipeRow({
  children,
  onResolve,
  onClaim,
  onLongPress,
  canResolve,
  canClaim,
  label,
}: {
  children: ReactNode;
  onResolve: () => void;
  onClaim: () => void;
  /** A held press (for the junk / select menu). Omitted → no hold is armed. */
  onLongPress?: () => void;
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
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set the instant a hold fires, read by onClickCapture to swallow the tap the
  // browser synthesises on release so the row does not also navigate.
  const heldFired = useRef(false);

  const intent: SwipeIntent = intentFor(offset);
  const allowed =
    intent === "resolve" ? canResolve : intent === "claim" ? canClaim : true;

  function clearHold() {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function reset() {
    clearHold();
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
        onClickCapture={(event) => {
          // Swallow the click the browser fires after a hold, so the row's
          // navigation overlay doesn't open the ticket the menu is about.
          if (heldFired.current) {
            event.preventDefault();
            event.stopPropagation();
            heldFired.current = false;
          }
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          // The left edge belongs to the navigation drawer. Without this the
          // same rightward gesture both opens the drawer and claims the ticket
          // underneath it — and an accidental claim is a real cost, not a
          // cosmetic one. The zone is shared with the drawer so the two cannot
          // disagree about where the boundary is.
          if (isEdgeSwipe(touch.clientX)) {
            start.current = null;
            return;
          }
          start.current = { x: touch.clientX, y: touch.clientY };
          engaged.current = false;
          heldFired.current = false;
          // Arm the hold. It is cancelled by any real movement below, so only a
          // stationary press survives to fire.
          if (onLongPress) {
            clearHold();
            holdTimer.current = setTimeout(() => {
              heldFired.current = true;
              holdTimer.current = null;
              onLongPress();
            }, LONG_PRESS_MS);
          }
        }}
        onTouchMove={(event) => {
          if (!start.current) return;
          const touch = event.touches[0];
          const dx = touch.clientX - start.current.x;
          const dy = touch.clientY - start.current.y;

          // Any travel means this is a swipe or a scroll, not a hold.
          if (Math.abs(dx) > LONG_PRESS_SLOP_PX || Math.abs(dy) > LONG_PRESS_SLOP_PX) {
            clearHold();
          }

          if (!engaged.current) {
            // Undecided until the gesture proves itself horizontal, so a
            // slightly diagonal scroll doesn't drag every row sideways.
            if (!isHorizontal(dx, dy)) return;
            engaged.current = true;
          }
          setOffset(travelFor(dx));
        }}
        onTouchEnd={() => {
          clearHold();
          // A hold already did its thing; don't also treat the release as a tap
          // or a swipe.
          if (heldFired.current) {
            reset();
            return;
          }
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
