import type { TicketPriority, TicketStatus } from "@/lib/types";
import { ESCALATE_AFTER_HOURS } from "./escalation";
import { STATUSES_AWAITING_AGENT } from "@/lib/ticket-status";

/**
 * The daily "nobody has picked these up" digest.
 *
 * Pure, because the interesting rules are all about NOT sending — no tickets,
 * no mail; nothing overdue, no overdue section — and a rule about mail that
 * does not go out is invisible in testing unless it is stated somewhere it can
 * be asserted.
 */

export interface UnassignedTicket {
  id: string;
  number: number;
  subject: string;
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: string;
  /** When the customer last wrote, which is the clock they experience. */
  lastCustomerMessageAt: string | null;
}

export interface DigestTicket extends UnassignedTicket {
  ageHours: number;
  /** Hours past this priority's threshold, or null if within it. */
  overdueBy: number | null;
}

export interface Digest {
  total: number;
  /** The three that have been waiting longest. */
  oldest: DigestTicket[];
  /** Everything past its threshold, however old. */
  overdue: DigestTicket[];
}

/** How many of the oldest to name. Enough to act on, short enough to read. */
export const OLDEST_SHOWN = 3;

/**
 * Builds the digest.
 *
 * Age is measured from the LAST CUSTOMER MESSAGE where there is one, matching
 * escalation: the number that matters is how long the person has been waiting,
 * not how long the row has existed. A ticket reopened by a customer reply is
 * freshly urgent, not three days stale.
 */
export function buildUnassignedDigest(
  tickets: UnassignedTicket[],
  now: number
): Digest {
  const scored = tickets
    .filter((t) => STATUSES_AWAITING_AGENT.includes(t.status))
    .map<DigestTicket>((t) => {
      const since = Date.parse(t.lastCustomerMessageAt ?? t.createdAt);
      const ageHours = Math.max(0, Math.floor((now - since) / 3_600_000));
      const threshold = ESCALATE_AFTER_HOURS[t.priority] ?? ESCALATE_AFTER_HOURS.normal;
      return {
        ...t,
        ageHours,
        overdueBy: ageHours >= threshold ? ageHours - threshold : null,
      };
    })
    .sort((a, b) => b.ageHours - a.ageHours);

  return {
    total: scored.length,
    oldest: scored.slice(0, OLDEST_SHOWN),
    // Sorted by how far past, not by age: a 9-hour Urgent needs attention
    // before a 50-hour Low, and the raw ages say the opposite.
    overdue: scored
      .filter((t) => t.overdueBy !== null)
      .sort((a, b) => (b.overdueBy ?? 0) - (a.overdueBy ?? 0)),
  };
}

/** "3 unassigned tickets — oldest 52h" */
export function digestSubject(digest: Digest): string {
  const noun = digest.total === 1 ? "ticket" : "tickets";
  const oldest = digest.oldest[0];
  const tail = oldest ? ` — oldest ${oldest.ageHours}h` : "";
  return `${digest.total} unassigned ${noun}${tail}`;
}

function line(t: DigestTicket): string {
  const overdue =
    t.overdueBy === null
      ? ""
      : ` · ${t.overdueBy}h past the ${t.priority} threshold`;
  return `#${t.number} — ${t.subject || "(no subject)"} · ${t.priority} · waiting ${t.ageHours}h${overdue}`;
}

export function digestText(digest: Digest, siteUrl: string): string {
  const parts = [
    `${digest.total} open ticket${digest.total === 1 ? " has" : "s have"} nobody assigned.`,
    "",
    "Longest waiting:",
    ...digest.oldest.map((t) => `  ${line(t)}`),
  ];

  if (digest.overdue.length) {
    parts.push(
      "",
      `Past the response threshold (${digest.overdue.length}):`,
      ...digest.overdue.slice(0, 10).map((t) => `  ${line(t)}`)
    );
    if (digest.overdue.length > 10) {
      parts.push(`  …and ${digest.overdue.length - 10} more`);
    }
  }

  parts.push("", `Unassigned queue: ${siteUrl}/inbox?view=unassigned`);
  return parts.join("\n");
}
