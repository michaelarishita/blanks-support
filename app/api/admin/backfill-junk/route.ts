import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { backfillFromMailbox } from "@/lib/google/inbound";

/**
 * One-off recovery: file recent guard-drops into Junk so there is something to
 * review — and correct from — on day one.
 *
 *   GET ?token=$CRON_SECRET                 → dry run, the last 30 days
 *   GET ?token=...&days=90                  → dry run, a wider window
 *   GET ?token=...&apply=1                  → file the "junk"-disposition
 *                                             candidates into Junk
 *
 * DRY BY DEFAULT. The dry run answers point 5 directly: it reports, per
 * disposition, exactly which mail the guards decided about — how much is a
 * recoverable Junk ticket ("junk") versus provably-not-a-customer and left
 * discarded ("drop"). `apply=1` then files the recoverable ones.
 *
 * Guarded by CRON_SECRET, not a session: curl-runnable and unreachable by a
 * mere login.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const params = request.nextUrl.searchParams;
  const apply = params.get("apply") === "1";
  const days = Math.min(365, Math.max(1, Number(params.get("days")) || 30));
  const max = Math.min(500, Math.max(1, Number(params.get("max")) || 200));

  // Same query as reconciliation: our own sent mail and drafts are not customer
  // mail and never should have been dropped, so they are not what we recover.
  const query = `newer_than:${days}d -in:sent -in:draft -in:chats`;

  // Always survey first (dry), so the response can report what WOULD be filed
  // even when applying.
  const survey = await backfillFromMailbox({ query, max, apply: false });

  const fresh = survey.candidates.filter((c) => !c.alreadyStored);
  const byDisposition = {
    junk: fresh.filter((c) => c.disposition === "junk"),
    drop: fresh.filter((c) => c.disposition === "drop"),
    inbox: fresh.filter((c) => c.disposition === "inbox"),
  };

  const junkIds = byDisposition.junk.map((c) => c.id);

  let applied: { filed: number; error: string | null } | null = null;
  if (apply && junkIds.length) {
    const run = await backfillFromMailbox({ query, max, apply: true, ids: junkIds });
    applied = { filed: run.ingested, error: run.result.error ?? null };
  }

  return Response.json({
    mode: apply
      ? "APPLIED — junk-disposition mail filed into Junk"
      : "DRY RUN — nothing written",
    windowDays: days,
    examined: survey.candidates.length,
    alreadyStored: survey.candidates.filter((c) => c.alreadyStored).length,
    recoverableToJunk: byDisposition.junk.length,
    stillDropped: byDisposition.drop.length,
    wouldGoToInbox: byDisposition.inbox.length,
    hitCap: survey.candidates.length >= max,
    applied,
    // The specifics, so "16 dropped by a guard" stops being a mystery.
    junk: byDisposition.junk.map(describe),
    dropped: byDisposition.drop.map(describe),
    error: survey.result.error ?? null,
  });
}

function describe(c: {
  id: string;
  fromEmail: string | null;
  subject: string;
  droppedBy: string | null;
}) {
  return {
    from: c.fromEmail ?? "unknown",
    subject: c.subject || "(no subject)",
    guard: c.droppedBy,
  };
}
