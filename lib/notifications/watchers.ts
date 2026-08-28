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
  /** The broader toggle: mail about tickets at all. */
  notifications_enabled: boolean;
}

/** The two facts about the ticket that decide who needs to hear about it. */
export interface NewTicketFacts {
  priority: "low" | "normal" | "high" | "urgent";
  /** True once a rule or a human has given it an owner. */
  assigned: boolean;
}

/**
 * The narrowed default, replacing "every new ticket to every watcher".
 *
 * That broadcast produced roughly 200 emails in fourteen days, nearly all
 * unread, which is the same failure the system alert was rebuilt to escape:
 * mail that always arrives stops being read, and then the one that mattered
 * is not read either.
 *
 * What survives the cut is the mail that asks for an action nobody has taken:
 * a ticket that is urgent AND has no owner. A Normal ticket sitting in the
 * inbox is not news — it is the inbox. An assigned ticket already generated
 * an assignment email to the person who has to act.
 */
export function needsUnassignedAttention(facts: NewTicketFacts): boolean {
  return !facts.assigned && (facts.priority === "high" || facts.priority === "urgent");
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
  ticket,
}: {
  candidates: WatcherCandidate[];
  alreadyNotified: Set<string>;
  ticket: NewTicketFacts;
}): WatcherSelection {
  const selection: WatcherSelection = { recipients: [], excluded: [] };
  const unowned = needsUnassignedAttention(ticket);

  for (const candidate of candidates) {
    if (!candidate.is_active) {
      selection.excluded.push({ id: candidate.id, reason: "inactive" });
      continue;
    }

    /**
     * Two ways to be on this mail, and they are deliberately different
     * questions.
     *
     * `watch_new_tickets` is unchanged: "I want every new ticket", the escape
     * hatch for anyone who genuinely does. It is no longer the ONLY route,
     * which is what made it all-or-nothing — the choice was a firehose or
     * silence, and most people want neither.
     *
     * The other route needs no new toggle: an unassigned High or Urgent
     * ticket goes to everyone who already accepts ticket mail. Nobody owns
     * it, so there is no assignee email covering it, and its priority is the
     * evidence that waiting for someone to notice is not good enough.
     */
    if (!candidate.watch_new_tickets) {
      if (!unowned) {
        selection.excluded.push({
          id: candidate.id,
          reason: `${ticket.priority} priority${ticket.assigned ? " and assigned" : ""} — not watching everything`,
        });
        continue;
      }
      if (!candidate.notifications_enabled) {
        selection.excluded.push({ id: candidate.id, reason: "notifications off" });
        continue;
      }
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
