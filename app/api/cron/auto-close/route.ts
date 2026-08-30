import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sweepDeletedTicketFolders,
  sweepOrphanedUploads,
} from "@/lib/uploads/sweep";
import { runReconciliation } from "@/lib/inbound/reconcile";

// Daily. Resolved tickets nobody has touched for a week become closed.
//
// Deliberately only touches `resolved` — never open, new or pending. A
// customer reply reopens a resolved ticket (the messages trigger does that),
// which also refreshes last_message_at, so an active conversation can't be
// closed out from under an agent.

export const dynamic = "force-dynamic";

const AUTO_CLOSE_DAYS = 7;
/** Bounded so one run can't rewrite the entire table. */
const MAX_PER_RUN = 200;

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  // Piggybacked on this job rather than given a route of its own, because a
  // new cron means a new entry configured by hand in the Vercel dashboard —
  // and an unconfigured cron is indistinguishable from a working one until
  // the bucket bill arrives. Both jobs are daily and neither is expensive.
  const uploads = await sweepOrphanedUploads();
  if (uploads.error) {
    console.error("[cron] orphan upload sweep failed:", uploads.error);
  }

  // The other half: attachments whose TICKET is gone. Postgres deletes do not
  // reach the bucket, so without this every deleted ticket leaves customer
  // photographs behind — unreachable from the app, and still stored.
  const ticketFiles = await sweepDeletedTicketFolders();
  if (ticketFiles.error) {
    console.error("[cron] deleted-ticket sweep failed:", ticketFiles.error);
  }

  // Also piggybacked, and for the same reason: daily, and a new cron entry is
  // one more thing that can be silently absent.
  //
  // This is the only check that watches the OUTCOME rather than a mechanism.
  // Every alarm we have watches something we already knew could break, and
  // each outage found a new mechanism instead. Records a clean run too, so its
  // silence means "checked" rather than "possibly dead" — monitoring treats a
  // stale timestamp as its own degraded reason.
  const reconcile = await runReconciliation();
  if (reconcile.error) {
    console.error("[cron] mailbox reconciliation failed:", reconcile.error);
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - AUTO_CLOSE_DAYS * 86_400_000).toISOString();

  // Seven days FROM THE RESOLVE, not from the last message.
  //
  // These diverge, and by days: a ticket resolved on the 28th whose last
  // message was the 23rd would have been closed on the 30th — two days of
  // grace instead of seven. That was always wrong and became load-bearing
  // when a public reply started resolving, because the reply's own timestamp
  // is what makes the two coincide in the common case and nothing else does.
  //
  // resolved_at is stamped by the on_ticket_update trigger on every entry
  // into resolved, so a reopened-and-resolved-again ticket gets a fresh
  // seven days. last_message_at remains the fallback for any row predating
  // the stamp — never absent in practice, but a null here would otherwise
  // exclude a ticket from auto-close forever.
  const { data: stale, error } = await admin
    .from("tickets")
    .select("id, number")
    .eq("status", "resolved")
    .or(
      `resolved_at.lt.${cutoff},and(resolved_at.is.null,last_message_at.lt.${cutoff})`
    )
    .limit(MAX_PER_RUN);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!stale?.length) {
    return Response.json({ ok: true, closed: 0, uploads, ticketFiles, reconcile });
  }

  const ids = stale.map((ticket) => ticket.id);
  const { error: updateError } = await admin
    .from("tickets")
    .update({ status: "closed" })
    .in("id", ids);

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 });
  }

  // agent_id null marks this as a system action rather than someone's doing.
  await admin.from("ticket_events").insert(
    ids.map((id) => ({
      ticket_id: id,
      agent_id: null,
      event_type: "status_changed",
      detail: { status: "closed", by: "auto-close", after_days: AUTO_CLOSE_DAYS },
    }))
  );

  return Response.json({
    ok: true,
    uploads,
    ticketFiles,
    reconcile,
    closed: ids.length,
    numbers: stale.map((ticket) => ticket.number),
    // Surfaced so a persistent backlog above the cap is visible rather than
    // looking like the job simply finished.
    hitCap: ids.length === MAX_PER_RUN,
  });
}
