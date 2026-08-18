/**
 * Swipe-to-act geometry.
 *
 * Pure so the thresholds can be reasoned about and tested without a
 * touchscreen — which matters, because getting them wrong is not a visual bug
 * but a destructive one: too eager and scrolling a list resolves tickets.
 */

/** How far before the gesture is treated as horizontal rather than a scroll. */
export const ENGAGE_PX = 12;

/** How far a completed swipe must travel to fire. */
export const COMMIT_PX = 88;

/** Past this the row stops following the finger, so it can't be flung away. */
export const MAX_TRAVEL_PX = 132;

export type SwipeIntent = "none" | "resolve" | "claim";

/**
 * Is this gesture horizontal enough to be a swipe?
 *
 * The vertical comparison is what stops a slightly-diagonal scroll from
 * dragging rows sideways. A list that wobbles while you scroll it feels
 * broken even when nothing fires.
 */
export function isHorizontal(dx: number, dy: number): boolean {
  return Math.abs(dx) > ENGAGE_PX && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/** Where the row should sit for a given finger delta. */
export function travelFor(dx: number): number {
  const capped = Math.max(-MAX_TRAVEL_PX, Math.min(MAX_TRAVEL_PX, dx));
  // Resistance past the commit point: the row keeps moving so the gesture
  // stays alive, but slows, which reads as "this is as far as it goes".
  if (Math.abs(capped) <= COMMIT_PX) return capped;
  const overshoot = Math.abs(capped) - COMMIT_PX;
  return Math.sign(capped) * (COMMIT_PX + overshoot * 0.35);
}

/**
 * What a release at this offset means.
 *
 * Left is Resolve and right is Claim, matching the spec. Neither is
 * irreversible — both post an undo toast — which is what makes a swipe an
 * acceptable trigger for them at all.
 */
export function intentFor(dx: number): SwipeIntent {
  if (dx <= -COMMIT_PX) return "resolve";
  if (dx >= COMMIT_PX) return "claim";
  return "none";
}
