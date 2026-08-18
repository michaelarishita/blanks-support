import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sweepOrphanedUploads } from "@/lib/uploads/sweep";

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

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - AUTO_CLOSE_DAYS * 86_400_000).toISOString();

  const { data: stale, error } = await admin
    .from("tickets")
    .select("id, number")
    .eq("status", "resolved")
    .lt("last_message_at", cutoff)
    .limit(MAX_PER_RUN);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!stale?.length) {
    return Response.json({ ok: true, closed: 0, uploads });
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
    closed: ids.length,
    numbers: stale.map((ticket) => ticket.number),
    // Surfaced so a persistent backlog above the cap is visible rather than
    // looking like the job simply finished.
    hitCap: ids.length === MAX_PER_RUN,
  });
}
