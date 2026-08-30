import type { TicketStatus } from "@/lib/types";

/**
 * The ticket status model.
 *
 * All five statuses remain in the model. Only two are set BY HAND — the rest
 * are consequences, and exposing them as buttons invited agents to fight the
 * automation:
 *
 *   new       automatic  · created, nobody has replied yet
 *   open      MANUAL     · being worked
 *   pending   LEGACY     · nothing writes this any more — see below
 *   resolved  automatic + MANUAL · a public reply, or an agent saying so
 *   closed    automatic  · resolved and untouched for 7 days (auto-close cron)
 *
 * A PUBLIC REPLY NOW RESOLVES. Most replies are terminal answers, and the old
 * behaviour parked every one of them in `pending` — a state nobody revisits,
 * so the queue filled with tickets that were finished in every sense except
 * the one the software recorded.
 *
 * The other half was already true: the `on_message_insert` trigger reopens a
 * resolved ticket the moment the customer writes back. That is what makes
 * resolving-on-reply safe rather than optimistic — being wrong costs nothing,
 * because the customer's own reply corrects it.
 *
 * `pending` is now WRITTEN BY NOTHING. It is kept in the enum because live
 * rows still hold it, and every reader still handles it: the reopen trigger
 * pulls it back to open, escalation still suppresses it, and a reply still
 * resolves it — so the remaining rows drain through the normal flow rather
 * than needing a migration.
 */

/** The only statuses an agent sets directly. */
export const MANUAL_STATUSES = ["open", "resolved"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

/** Statuses where the ball is in our court — the unassigned queue's meaning. */
export const STATUSES_AWAITING_AGENT: TicketStatus[] = ["new", "open"];

/**
 * Statuses a public reply moves to resolved.
 *
 * Includes `pending` so the rows left behind by the old behaviour drain
 * through the ordinary flow instead of sitting in a state nothing writes any
 * more. Deliberately EXCLUDES `closed`: replying to a closed ticket should not
 * quietly un-close it, and `resolved` is already the destination.
 */
export const STATUSES_A_REPLY_RESOLVES: TicketStatus[] = ["new", "open", "pending"];

/** Statuses a customer message pulls back into the queue. */
export const STATUSES_REOPENED_BY_CUSTOMER: TicketStatus[] = ["pending", "resolved"];

/** Statuses that count as finished. */
export const CLOSED_STATUSES: TicketStatus[] = ["resolved", "closed"];

/**
 * What an agent's public reply does to the status.
 * Returns null when nothing should change.
 *
 * An INTERNAL NOTE is not a reply and never reaches here — a note is the team
 * talking to itself, and resolving a ticket because somebody wrote a note
 * would resolve it without answering anybody.
 */
export function nextStatusAfterAgentReply(
  current: TicketStatus
): TicketStatus | null {
  return STATUSES_A_REPLY_RESOLVES.includes(current) ? "resolved" : null;
}

/**
 * What an inbound customer message does to the status.
 *
 * This mirrors the `on_message_insert` trigger in 0001_init.sql, which is
 * where it actually happens — the database owns it so an import path that
 * bypasses the app can't skip it. Kept here so the rule is testable and so a
 * change to one side is visible against the other.
 */
export function nextStatusAfterCustomerMessage(
  current: TicketStatus
): TicketStatus | null {
  return STATUSES_REOPENED_BY_CUSTOMER.includes(current) ? "open" : null;
}

/**
 * True while we're waiting on the customer — shown passively, never a button.
 *
 * Only ever true for LEGACY rows now. Nothing writes `pending`, so this
 * describes a state that can only shrink. Kept rather than deleted because
 * the rows exist and the badge is still accurate for them; when the count
 * reaches zero this and the badge can go together.
 */
export function isWaitingOnCustomer(status: TicketStatus): boolean {
  return status === "pending";
}

/** Which of the two manual buttons should read as active. */
export function activeManualStatus(status: TicketStatus): ManualStatus {
  return CLOSED_STATUSES.includes(status) ? "resolved" : "open";
}

/** Escalation must not chase a ticket that is finished or awaiting a reply. */
export function suppressesEscalation(status: TicketStatus): boolean {
  return CLOSED_STATUSES.includes(status) || isWaitingOnCustomer(status);
}
