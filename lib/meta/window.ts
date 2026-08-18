/**
 * Meta's reply window.
 *
 * The rule that will bite, stated plainly: you may reply freely for 24 hours
 * after the customer's last message. Between 24 hours and 7 days a reply must
 * carry the HUMAN_AGENT tag. Past 7 days there is no way to message them at
 * all until they write again.
 *
 * Pure and clock-injectable, because every interesting case is a boundary and
 * none of them are reachable by waiting.
 */

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ReplyWindowState =
  /** Free-form reply allowed. */
  | "open"
  /** Allowed, but the send must carry the HUMAN_AGENT tag. */
  | "human_agent"
  /** Meta will refuse. Nothing we can send changes that. */
  | "expired"
  /** No inbound message, so no window was ever opened. */
  | "never_opened";

export interface ReplyWindow {
  state: ReplyWindowState;
  /** Until the free-form window shuts. Negative once it has. */
  msUntilTagRequired: number;
  /** Until nothing can be sent at all. Negative once past. */
  msUntilClosed: number;
  lastInboundAt: string | null;
  /** True when a send is possible at all — what the composer gates on. */
  canSend: boolean;
  /** True when the send must carry the tag. */
  requiresTag: boolean;
}

export function replyWindow(
  lastInboundAt: string | null | undefined,
  now = Date.now()
): ReplyWindow {
  if (!lastInboundAt) {
    // Meta does not let a business open a conversation. Without an inbound
    // message there is no window, and this is not a "wait and retry" state.
    return {
      state: "never_opened",
      msUntilTagRequired: 0,
      msUntilClosed: 0,
      lastInboundAt: null,
      canSend: false,
      requiresTag: false,
    };
  }

  const at = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(at)) {
    // An unparseable timestamp must not read as "plenty of time".
    return {
      state: "never_opened",
      msUntilTagRequired: 0,
      msUntilClosed: 0,
      lastInboundAt,
      canSend: false,
      requiresTag: false,
    };
  }

  const msUntilTagRequired = at + STANDARD_WINDOW_MS - now;
  const msUntilClosed = at + HUMAN_AGENT_WINDOW_MS - now;

  const state: ReplyWindowState =
    msUntilTagRequired > 0 ? "open" : msUntilClosed > 0 ? "human_agent" : "expired";

  return {
    state,
    msUntilTagRequired,
    msUntilClosed,
    lastInboundAt,
    canSend: state === "open" || state === "human_agent",
    requiresTag: state === "human_agent",
  };
}

/**
 * What the Send API needs for this state.
 *
 * MESSAGE_TAG + HUMAN_AGENT is what buys the extra six days, and it is only
 * legitimate for a human answering a question — which is exactly what this
 * app does. Applying it to anything automated would be a policy violation, so
 * it is derived from the window rather than being a flag anyone can set.
 */
export function sendParamsFor(
  state: ReplyWindowState
): { messaging_type: string; tag?: string } | null {
  if (state === "open") return { messaging_type: "RESPONSE" };
  if (state === "human_agent") {
    return { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" };
  }
  return null;
}

/** "18h left", "45m left", "2d left" — short enough to sit in a status line. */
export function describeRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

/**
 * The sentence an agent sees. Deliberately says what to DO in the cases where
 * there is something to do, and says plainly that there isn't when there is
 * not — the same discipline as "connect your Gmail in Settings".
 */
export function describeWindow(window: ReplyWindow): string {
  switch (window.state) {
    case "open":
      return `${describeRemaining(window.msUntilTagRequired)} to reply freely`;
    case "human_agent":
      return `Outside the 24-hour window — ${describeRemaining(
        window.msUntilClosed
      )} to reply as a human agent`;
    case "expired":
      return "Meta's 7-day reply window has closed. You can't message this customer until they write again.";
    case "never_opened":
      return "No message from this customer yet, so Meta won't allow a reply.";
  }
}

/** Below this, the countdown starts warning rather than merely informing. */
export const URGENT_REMAINING_MS = 4 * 60 * 60 * 1000;
