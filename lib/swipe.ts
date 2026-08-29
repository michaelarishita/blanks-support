/**
 * Swipe-to-act geometry.
 *
 * Pure so the thresholds can be reasoned about and tested without a
 * touchscreen — which matters, because getting them wrong is not a visual bug
 * but a destructive one: too eager and scrolling a list resolves tickets.
 */

/**
 * The left strip that belongs to the navigation drawer, and to nothing else.
 *
 * An edge-swipe to open the drawer travels RIGHT, and so does swipe-to-claim
 * on a list row. Two handlers reading the same gesture is how you get a row
 * sliding open behind a drawer, or a claim fired by someone reaching for the
 * menu — and claiming a ticket by accident is a real cost, not a cosmetic one.
 *
 * So the contract is exclusive and lives in one place: a touch that STARTS
 * within this many pixels of the left edge is the drawer's, and rows must
 * ignore it. Everything to the right of it is the row's, and the drawer must
 * ignore that. Neither side gets to decide by threshold or by timing.
 *
 * 24px is roughly a thumb's width and matches the iOS back-swipe zone, which
 * is the gesture people already expect to find there.
 */
export const EDGE_ZONE_PX = 24;

/** Does this touch belong to the drawer rather than to the row under it? */
export function isEdgeSwipe(startX: number): boolean {
  return startX <= EDGE_ZONE_PX;
}

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
