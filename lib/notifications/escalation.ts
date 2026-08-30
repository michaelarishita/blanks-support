import type { TicketPriority, TicketStatus } from "@/lib/types";
import { suppressesEscalation } from "@/lib/ticket-status";

/**
 * When to chase an assigned ticket, and when to stop.
 *
 * Measured from the LAST CUSTOMER MESSAGE, not from assignment: the clock a
 * customer experiences is how long they've been waiting, and reassigning a
 * ticket internally shouldn't reset it.
 */

export const ESCALATE_AFTER_HOURS: Record<TicketPriority, number> = {
  urgent: 8,
  high: 24,
  normal: 48,
  low: 72,
};

/**
 * After this many, stop shouting at the agent and tell an admin instead. An
 * escalation nobody acts on is just noise, and the fourth one is evidence
 * that the agent isn't the person who can fix it.
 */
export const MAX_ESCALATIONS = 3;

/**
 * How many times we have chased THIS round of the conversation.
 *
 * The count must not carry across a customer reply. Each repeat needs its own
 * interval (`threshold * nextCount`), so a ticket chased three times, resolved,
 * and then reopened by the customer would need four thresholds — 192h for a
 * Normal ticket — before anyone was chased again, and would go straight to an
 * admin when they were. The customer asked a new question; the ladder starts
 * from the bottom.
 *
 * This became load-bearing when a public reply started resolving the ticket:
 * reopen went from an occasional event to the normal end of every exchange.
 */
export function escalationsSinceCustomerMessage(
  rows: { kind: string; sent_at?: string | null }[],
  lastCustomerMessageAt: string | Date | null
): number {
  const since = toMillis(lastCustomerMessageAt);
  return rows.filter((row) => {
    if (row.kind !== "escalation") return false;
    // Never sent — it cannot have chased anybody, so it is not a rung.
    if (!row.sent_at) return false;
    if (since === null) return true;
    return Date.parse(row.sent_at) > since;
  }).length;
}

export interface EscalationInput {
  priority: TicketPriority;
  status: TicketStatus;
  /** When the customer last wrote. Null for a ticket they never messaged. */
  lastCustomerMessageAt: string | Date | null;
  /** Escalations already sent to this agent for this ticket. */
  escalationCount: number;
  /** A reminder the agent set that hasn't fired yet. */
  pendingReminderAt: string | Date | null;
  now: number;
}

export type EscalationDecision =
  | { escalate: false; reason: string }
  | { escalate: true; overdueHours: number; nextCount: number; toAdmin: boolean };

const toMillis = (value: string | Date | null): number | null => {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
};

export function decideEscalation(input: EscalationInput): EscalationDecision {
  // Finished, or the ball is in the customer's court. `pending` is exactly
  // why it survives as a status despite leaving the UI.
  if (suppressesEscalation(input.status)) {
    return { escalate: false, reason: `status is ${input.status}` };
  }

  // The agent has already said "not yet, remind me at X". Chasing before then
  // ignores an answer they gave us.
  const reminderAt = toMillis(input.pendingReminderAt);
  if (reminderAt !== null && reminderAt > input.now) {
    return { escalate: false, reason: "a reminder is still pending" };
  }

  const lastCustomer = toMillis(input.lastCustomerMessageAt);
  if (lastCustomer === null) {
    // Nothing from the customer means no waiting clock to measure.
    return { escalate: false, reason: "no customer message to measure from" };
  }

  const overdueHours = (input.now - lastCustomer) / 3_600_000;
  const threshold = ESCALATE_AFTER_HOURS[input.priority] ?? ESCALATE_AFTER_HOURS.normal;
  if (overdueHours < threshold) {
    return { escalate: false, reason: `only ${Math.floor(overdueHours)}h of ${threshold}h` };
  }

  // Each repeat needs its own interval, or one overdue ticket would escalate
  // on every cron tick.
  const nextCount = input.escalationCount + 1;
  const requiredHours = threshold * nextCount;
  if (overdueHours < requiredHours) {
    return {
      escalate: false,
      reason: `escalation ${nextCount} is due at ${requiredHours}h`,
    };
  }

  return {
    escalate: true,
    overdueHours: Math.floor(overdueHours),
    nextCount,
    toAdmin: nextCount > MAX_ESCALATIONS,
  };
}

/**
 * `[URGENT · 8h UNANSWERED] Ticket #1042 — Order never arrived`
 *
 * A NEW subject every time, deliberately: escalations break out of the
 * assignment thread precisely because the agent is ignoring that thread, and
 * a reused subject would let Gmail file it straight back into the
 * conversation it needs to escape.
 */
export function escalationSubject(
  priority: TicketPriority,
  overdueHours: number,
  ticketNumber: number,
  ticketSubject: string
): string {
  const subject = ticketSubject.replace(/\s*\[BLK-\d+\]\s*/gi, " ").trim();
  return `[${priority.toUpperCase()} · ${overdueHours}h UNANSWERED] Ticket #${ticketNumber} — ${subject}`;
}

/** Firmer each time, and honest about what happens next. */
export function escalationLead(count: number, agentName: string): string {
  if (count === 1) {
    return `${agentName}, this ticket is past its response window and still unanswered.`;
  }
  if (count === 2) {
    return `${agentName}, this is the second reminder — the customer is still waiting.`;
  }
  if (count === 3) {
    return `${agentName}, third and final reminder. If this stays unanswered the next notice goes to an admin.`;
  }
  return `This ticket has been escalated ${count - 1} times without a reply and is now being raised with an admin.`;
}
