import { signPayload, verifyPayload } from "@/lib/crypto";

/**
 * Signed "remind me later" links.
 *
 * THE PREFETCH TRAP is why these exist in this shape. Gmail, Workspace and
 * Outlook Safe Links all fetch URLs in email on delivery, and a forwarded
 * thread does it again. A bare `GET /remind?...` that scheduled a reminder
 * would therefore fire with nobody having clicked anything — possibly the
 * instant the mail arrived. So the signed link only ever RENDERS a
 * confirmation page; the scheduling happens on an explicit POST from it.
 *
 * The signature is the authorisation: no session is required, because the
 * recipient of the email may well be reading it on a phone that isn't logged
 * in. That is also why the confirmation page shows the ticket NUMBER and
 * nothing else — a leaked link must not leak ticket contents.
 */

const PURPOSE = "reminder-link";

/** Links die after a day; a reminder set from a week-old email is noise. */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const REMINDER_DELAYS = [1, 4, 8, 24] as const;
export type ReminderDelayHours = (typeof REMINDER_DELAYS)[number];

export interface ReminderPayload {
  /** agent */
  a: string;
  /** ticket */
  t: string;
  /** delay in hours */
  d: number;
  /** expiry, epoch ms */
  x: number;
}

export function signReminderToken(
  agentId: string,
  ticketId: string,
  delayHours: number,
  now = Date.now()
): string {
  return signPayload(PURPOSE, {
    a: agentId,
    t: ticketId,
    d: delayHours,
    x: now + TOKEN_TTL_MS,
  } satisfies ReminderPayload);
}

export type TokenResult =
  | { ok: true; payload: ReminderPayload }
  | { ok: false; reason: "invalid" | "expired" | "malformed" };

export function verifyReminderToken(token: string, now = Date.now()): TokenResult {
  const payload = verifyPayload<ReminderPayload>(PURPOSE, token);
  if (!payload) return { ok: false, reason: "invalid" };

  if (
    typeof payload.a !== "string" ||
    typeof payload.t !== "string" ||
    typeof payload.d !== "number" ||
    typeof payload.x !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (!REMINDER_DELAYS.includes(payload.d as ReminderDelayHours)) {
    return { ok: false, reason: "malformed" };
  }
  if (now > payload.x) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

export function describeDelay(hours: number): string {
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
