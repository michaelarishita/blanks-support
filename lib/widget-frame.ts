/**
 * The contract between the embedded widget and its host page.
 *
 * Pure and dependency-free: `public/widget.js` is plain script on the
 * storefront and cannot import this, so the message type is duplicated there.
 * Anything that can be shared and tested lives here instead of in the
 * component.
 */

/** The one message the widget sends to its parent. */
export const HEIGHT_MESSAGE_TYPE = "blanks-widget-height";

/** Query parameter widget.js uses to tell the iframe who framed it. */
export const PARENT_ORIGIN_PARAM = "parent";

export interface HeightMessage {
  type: typeof HEIGHT_MESSAGE_TYPE;
  height: number;
}

/**
 * Decides which origin a height message may be addressed to.
 *
 * The value arrives in the URL, so it is attacker-controllable: anyone can
 * open /widget?parent=https://evil.example. It is therefore MATCHED against
 * the allowlist rather than used, and a miss returns null rather than falling
 * back to the requested value or to "*". postMessage's targetOrigin is the
 * only thing stopping a hostile framer from receiving our messages, and "*"
 * would hand them over by definition.
 *
 * Returning null is not a failure: the caller broadcasts to every allowed
 * origin instead, which is how a hand-written embed (no widget.js, so no
 * parameter) still works.
 */
export function resolveParentOrigin(
  requested: string | string[] | undefined,
  allowed: string[]
): string | null {
  // Next gives an array when a parameter is repeated. Two answers to "who is
  // my parent" is not a question worth guessing at.
  if (typeof requested !== "string") return null;

  const normalized = requested.trim().replace(/\/$/, "");
  if (!normalized) return null;

  return allowed.some((origin) => origin.replace(/\/$/, "") === normalized)
    ? normalized
    : null;
}

/** Lower bound on the panel height, so a mid-transition measurement can't collapse it. */
export const MIN_PANEL_HEIGHT = 260;

/**
 * True when the measured height is worth sending.
 *
 * A zero or negative height means the element is display:none or not laid out
 * yet; forwarding that would collapse the panel on the storefront.
 */
export function isUsableHeight(height: unknown): height is number {
  return typeof height === "number" && Number.isFinite(height) && height > 0;
}
