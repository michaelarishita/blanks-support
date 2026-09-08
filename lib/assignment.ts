/**
 * What a public reply does to a ticket's assignment.
 *
 * Pure and tiny, so the rule is stated once and tested without a database. The
 * server action in app/actions.ts reads this to decide between three outcomes,
 * and the tests assert the boundaries it must never cross — chiefly that a
 * reply on someone ELSE's ticket reassigns it, while a reply on your OWN or an
 * unassigned one does not go through the reassignment path.
 */

export type ReplyAssignment =
  /** Unowned ticket: answering it claims it (no notification — you know). */
  | "claim"
  /** Already yours: nothing changes. */
  | "keep"
  /** Someone else's: it becomes yours, and they are told it left their queue. */
  | "reassign";

/**
 * Decides the assignment outcome of a PUBLIC reply.
 *
 * Internal notes never reach this — a note is the team talking to itself and
 * must not move ownership. That guard lives at the call site; this function
 * assumes it is only asked about public replies.
 */
export function replyAssignment(
  currentAssigneeId: string | null | undefined,
  replierId: string
): ReplyAssignment {
  if (!currentAssigneeId) return "claim";
  if (currentAssigneeId === replierId) return "keep";
  return "reassign";
}
