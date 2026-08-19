/**
 * Who hears about a new ticket.
 *
 * Pure, because the interesting rule is a negative one — the person who was
 * just assigned the ticket must NOT also get the "new ticket" notice — and a
 * rule about mail NOT being sent is invisible in testing unless it is stated
 * somewhere it can be asserted.
 */

export interface WatcherCandidate {
  id: string;
  email: string;
  name: string;
  display_name: string | null;
  is_active: boolean;
  /** The Settings toggle: "Email me about every new ticket". */
  watch_new_tickets: boolean;
}

export interface WatcherSelection {
  recipients: WatcherCandidate[];
  /** Who was left out and why — surfaced in the send result, not guessed at. */
  excluded: { id: string; reason: string }[];
}

/**
 * @param alreadyNotified agents who already have a notification for THIS
 *   ticket — in practice whoever a routing rule just assigned it to, who is
 *   receiving the assignment email at the same moment.
 */
export function selectNewTicketRecipients({
  candidates,
  alreadyNotified,
}: {
  candidates: WatcherCandidate[];
  alreadyNotified: Set<string>;
}): WatcherSelection {
  const selection: WatcherSelection = { recipients: [], excluded: [] };

  for (const candidate of candidates) {
    if (!candidate.is_active) {
      selection.excluded.push({ id: candidate.id, reason: "inactive" });
      continue;
    }
    if (!candidate.watch_new_tickets) {
      selection.excluded.push({ id: candidate.id, reason: "not watching" });
      continue;
    }
    /**
     * THE DEDUPE. A rule that assigns at creation sends the assignee an
     * assignment email; sending them a new-ticket email in the same minute
     * about the same ticket is how people learn to ignore both. Other
     * watchers still get theirs — they are hearing something the assignee
     * already knows.
     *
     * Keyed on "has a notification for this ticket" rather than "is the
     * assignee", so it holds whatever order things happen in, and covers a
     * manual assignment made seconds before the notice would go out.
     */
    if (alreadyNotified.has(candidate.id)) {
      selection.excluded.push({
        id: candidate.id,
        reason: "already emailed about this ticket",
      });
      continue;
    }
    selection.recipients.push(candidate);
  }

  return selection;
}

/** "New ticket #1042 — Order questions — Jane Doe" */
export function newTicketSubject({
  number,
  topic,
  customerName,
}: {
  number: number;
  topic: string | null;
  customerName: string;
}): string {
  // Topic is optional on email and social tickets, and a subject with an
  // empty segment reads as a bug rather than as a missing field.
  const parts = [`New ticket #${number}`, topic, customerName].filter(
    (part): part is string => Boolean(part && String(part).trim())
  );
  return parts.join(" — ");
}
