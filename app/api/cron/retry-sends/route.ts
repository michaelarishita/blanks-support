import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { deliverMessage } from "@/lib/google/outbound";

// Hourly. Retries replies that failed to send, so delivery doesn't depend on
// an admin noticing the flush button in Settings.
//
// Backoff is derived from the failure events already written by
// deliverMessage rather than a new column: wait 2^attempts minutes, capped at
// 12 hours, and give up after 6 attempts. A permanently-broken message
// (deleted customer, revoked mailbox) therefore stops consuming quota instead
// of retrying forever.

export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 6;
const MAX_BACKOFF_MINUTES = 720;
const MAX_AGE_DAYS = 3;
const MAX_PER_RUN = 25;

function backoffMinutes(attempts: number): number {
  return Math.min(2 ** attempts, MAX_BACKOFF_MINUTES);
}

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const admin = createAdminClient();
  const oldest = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();

  const { data: failed } = await admin
    .from("messages")
    .select("id, ticket_id, created_at")
    .eq("direction", "outbound")
    .eq("type", "public")
    .in("delivery_status", ["queued", "failed"])
    .gte("created_at", oldest)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);

  const results = { attempted: 0, sent: 0, skipped: 0, exhausted: 0, failures: [] as string[] };

  for (const message of failed ?? []) {
    const { data: events } = await admin
      .from("ticket_events")
      .select("created_at")
      .eq("ticket_id", message.ticket_id)
      .eq("event_type", "reply_send_failed")
      .contains("detail", { message_id: message.id })
      .order("created_at", { ascending: false });

    const attempts = events?.length ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      results.exhausted++;
      continue;
    }

    const lastAttempt = events?.[0]?.created_at;
    if (lastAttempt) {
      const waitedMinutes = (Date.now() - new Date(lastAttempt).getTime()) / 60_000;
      if (waitedMinutes < backoffMinutes(attempts)) {
        results.skipped++;
        continue;
      }
    }

    results.attempted++;
    const result = await deliverMessage(message.id);
    if (result.ok && !result.skipped) results.sent++;
    else if (!result.ok) results.failures.push(result.error);
  }

  return Response.json({ ok: true, ...results });
}
