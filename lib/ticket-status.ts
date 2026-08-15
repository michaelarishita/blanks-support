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
 *   pending   automatic  · an agent replied, we're waiting on the customer
 *   resolved  MANUAL     · done
 *   closed    automatic  · resolved and untouched for 7 days (auto-close cron)
 *
 * `pending` matters beyond display: escalation suppression keys off it, so a
 * ticket waiting on a customer isn't chased. Removing it from the UI must not
 * remove it from the lifecycle.
 */

/** The only statuses an agent sets directly. */
export const MANUAL_STATUSES = ["open", "resolved"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

/** Statuses where the ball is in our court, so an agent reply moves it on. */
export const STATUSES_AWAITING_AGENT: TicketStatus[] = ["new", "open"];

/** Statuses a customer message pulls back into the queue. */
export const STATUSES_REOPENED_BY_CUSTOMER: TicketStatus[] = ["pending", "resolved"];

/** Statuses that count as finished. */
export const CLOSED_STATUSES: TicketStatus[] = ["resolved", "closed"];

/**
 * What an agent's public reply does to the status.
 * Returns null when nothing should change.
 */
export function nextStatusAfterAgentReply(
  current: TicketStatus
): TicketStatus | null {
  return STATUSES_AWAITING_AGENT.includes(current) ? "pending" : null;
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

/** True while we're waiting on the customer — shown passively, never a button. */
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
