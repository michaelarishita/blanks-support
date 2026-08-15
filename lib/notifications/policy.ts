import type { TicketPriority } from "@/lib/types";

/**
 * When a notification may be sent, and how loudly.
 *
 * The confirmed rule: EVERY assignment notifies. Priority changes the
 * treatment, never whether it sends.
 *
 *   Urgent   send now, and ignore quiet hours
 *   High     send now, respect quiet hours
 *   Normal   send now, respect quiet hours
 *   Low      send now, respect quiet hours
 *
 * Pure and clock-injectable, so the boundaries can be tested without waiting
 * for 9pm in Phoenix.
 */

/** Nobody needs a 3am ticket nag; it only teaches people to ignore the mail. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 7;
export const QUIET_ZONE = "America/Phoenix";

/** Only Urgent is loud enough to justify waking someone. */
export function bypassesQuietHours(priority: TicketPriority): boolean {
  return priority === "urgent";
}

/** The local hour in the quiet-hours zone, without pulling in a date library. */
export function localHour(at: Date, timeZone = QUIET_ZONE): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(at);
  // "24" appears at midnight in some ICU versions.
  return Number(hour) % 24;
}

export function isQuietHour(at: Date, timeZone = QUIET_ZONE): boolean {
  const hour = localHour(at, timeZone);
  // The window wraps midnight, so it's an OR rather than a range.
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * The next moment a notification may go out: now, or the start of the next
 * window. Phoenix does not observe DST, which is part of why it's the anchor.
 */
export function nextSendableTime(at: Date, timeZone = QUIET_ZONE): Date {
  if (!isQuietHour(at, timeZone)) return at;

  // Step forward an hour at a time until the window opens. Crude, but it needs
  // no timezone arithmetic of its own and can't drift across a DST boundary in
  // zones that do observe it.
  const candidate = new Date(at.getTime());
  for (let i = 0; i < 24; i++) {
    candidate.setUTCMinutes(0, 0, 0);
    candidate.setUTCHours(candidate.getUTCHours() + 1);
    if (!isQuietHour(candidate, timeZone)) return candidate;
  }
  return at;
}

export interface SendDecision {
  /** Send now. */
  sendNow: boolean;
  /** When it should go instead, if deferred. */
  scheduledFor: Date | null;
  reason: "immediate" | "urgent-bypass" | "deferred-quiet-hours";
}

export function decideSendTime(
  priority: TicketPriority,
  at: Date,
  timeZone = QUIET_ZONE
): SendDecision {
  if (bypassesQuietHours(priority)) {
    return { sendNow: true, scheduledFor: null, reason: "urgent-bypass" };
  }
  if (!isQuietHour(at, timeZone)) {
    return { sendNow: true, scheduledFor: null, reason: "immediate" };
  }
  return {
    sendNow: false,
    scheduledFor: nextSendableTime(at, timeZone),
    reason: "deferred-quiet-hours",
  };
}

/**
 * Priority in the subject, so it is unmistakable in a list of identical
 * subject lines.
 *
 * Normal carries no prefix: prefixing everything would make the prefix
 * meaningless, which is the same reason the inbox list only chips Urgent and
 * High.
 */
export function notificationSubject(
  base: string,
  priority: TicketPriority
): string {
  if (priority === "normal") return base;
  return `[${priority.toUpperCase()}] ${base}`;
}
