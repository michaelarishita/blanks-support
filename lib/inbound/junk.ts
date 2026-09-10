import type { InboundDrop } from "@/lib/google/inbound";
import type { JunkReason } from "@/lib/types";
import type { VendorReason } from "@/lib/vendor/outreach";
import { VENDOR_JUNK_THRESHOLD } from "@/lib/vendor/outreach";
import type { OverrideMatch } from "@/lib/senders/overrides";

/**
 * Where a just-arrived message goes: dropped, to the inbox, or to Junk.
 *
 * Pure, so the decision can be argued about and tested without a mailbox. It
 * takes already-computed inputs (the guard verdict, the sender override, the
 * classifier score) rather than importing the machinery that produces them,
 * which keeps it free of the inbound-sync import cycle.
 */

/**
 * How long a junked ticket survives before it is purged.
 *
 * Shown on the Junk view so the purge is never a surprise, and used by the
 * daily cron that does the purging. Long enough that a wrongly-junked customer
 * has a realistic chance of being noticed; short enough that spam does not
 * accumulate forever.
 */
export const JUNK_RETENTION_DAYS = 30;

export type Disposition =
  | { kind: "drop"; reason: string }
  | { kind: "inbox" }
  | { kind: "junk"; junkReason: JunkReason };

export interface DispositionInput {
  drop: InboundDrop | null;
  override: OverrideMatch | null;
  /** The vendor-outreach classifier's text-only score for this message. */
  vendorScore: number;
  vendorReasons: VendorReason[];
}

/**
 * Guard rules that prove the message is NOT a customer with a question, and so
 * are still discarded rather than filed in Junk:
 *
 *   no-sender  — nothing to attribute a ticket to
 *   automated  — an auto-reply, a bounce, or one of our own notifications
 *   own-address — our own outbound
 *
 * Filing these in Junk would bury the genuinely reviewable drops (a customer
 * wrongly caught by the bulk-mail rule) under a pile of our own notification
 * mail. The prompt's concern is "if one of those was a customer, it is gone
 * silently" — and none of these three is ever a customer. They remain counted
 * skips, and reconciliation still accounts for them as deliberate.
 */
const HARD_DROP_RULES = new Set<InboundDrop["rule"]>([
  "no-sender",
  "automated",
  "own-address",
]);

/**
 * Guard rules where a real customer COULD be hiding, so they file to Junk
 * instead of dropping:
 *
 *   bulk-mail       — the exact rule that silently discarded support@ group
 *                     customers for as long as the group existed
 *   ignored-sender  — a hand-maintained list, and a hand-maintained list has
 *                     fat-fingers in it
 */
const JUNK_GUARD_RULES = new Set<InboundDrop["rule"]>([
  "ignored-sender",
  "bulk-mail",
]);

export function decideDisposition(input: DispositionInput): Disposition {
  const { drop, override } = input;

  // The classifier score travels on EVERY junk reason, so a junked ticket
  // always shows what the classifier thought — even when a guard did the
  // filing. That is the corroborating evidence an agent reviews.
  const classifier = {
    classifierScore: input.vendorScore,
    classifierThreshold: VENDOR_JUNK_THRESHOLD,
    classifierReasons: input.vendorReasons,
  };

  // Provably-non-customer drops win outright. An override cannot turn our own
  // outbound or an auto-reply into a customer, so it is not even consulted here.
  if (drop && HARD_DROP_RULES.has(drop.rule)) {
    return { kind: "drop", reason: `${drop.rule} (${drop.detail})` };
  }

  // An explicit human override is the strongest signal there is, in either
  // direction, and it beats the guards and the classifier.
  if (override?.label === "not_spam") {
    return { kind: "inbox" };
  }
  if (override?.label === "spam") {
    return {
      kind: "junk",
      junkReason: {
        source: "override",
        overrideScope: override.scope,
        overrideValue: override.value,
        ...classifier,
      },
    };
  }

  // A reviewable guard fired: file it, carrying which rule and why.
  if (drop && JUNK_GUARD_RULES.has(drop.rule)) {
    return {
      kind: "junk",
      junkReason: {
        source: "guard",
        rule: drop.rule,
        detail: drop.detail,
        ...classifier,
      },
    };
  }

  // Nothing dropped it and nobody overrode it: the classifier gets to file it
  // only when it is CONFIDENT (see VENDOR_JUNK_THRESHOLD's asymmetry note).
  // Below the bar it stays in the visible inbox — uncertainty goes to a human.
  if (input.vendorScore >= VENDOR_JUNK_THRESHOLD) {
    return { kind: "junk", junkReason: { source: "classifier", ...classifier } };
  }

  return { kind: "inbox" };
}

/** One line describing why a ticket is in Junk, for the ticket screen. */
export function describeJunkReason(reason: JunkReason | null | undefined): string {
  if (!reason) return "Filed in Junk.";
  if (reason.source === "manual") return "Marked as spam by an agent.";
  if (reason.source === "override") {
    return `Sender marked as spam (${reason.overrideScope} ${reason.overrideValue}).`;
  }
  if (reason.source === "guard") {
    const rule =
      reason.rule === "bulk-mail"
        ? "arrived with mailing-list headers"
        : reason.rule === "ignored-sender"
          ? "sender is on the ignore list"
          : (reason.rule ?? "a guard");
    return `Caught by a guard: ${rule}${reason.detail ? ` (${reason.detail})` : ""}.`;
  }
  return `Classifier scored this ${reason.classifierScore ?? "?"} (junk at ${reason.classifierThreshold ?? "?"}+).`;
}
