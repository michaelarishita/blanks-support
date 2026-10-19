import { type NextRequest, NextResponse } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { backfillMetaInbox } from "@/lib/meta/backfill";

/**
 * One-time import of the Messenger OR Instagram conversations already in the
 * Page inbox, from before the app was subscribed to the webhook.
 *
 *   GET ?token=...                        → DRY RUN (Messenger), nothing written
 *   GET ?token=...&platform=instagram     → DRY RUN (Instagram DMs)
 *   GET ?token=...&platform=instagram&apply=1  → import the missing IG messages
 *
 * Authorised by CRON_SECRET like the other admin jobs, not a session: it is run
 * with curl, and a cookie check would only bounce it to a login page.
 * Idempotent — dedupe on meta_message_id means a re-run is a no-op.
 *
 * Note on access: with Standard Access the Graph conversations read only
 * returns threads from people who hold a role on the app, so a dry run will
 * show little or nothing until instagram_manage_messages reaches Advanced
 * Access. This endpoint is the thing to run the day approval lands.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const apply = request.nextUrl.searchParams.get("apply") === "1";
  const platformParam = request.nextUrl.searchParams.get("platform");
  const platform = platformParam === "instagram" ? "instagram" : "messenger";
  const report = await backfillMetaInbox({ dryRun: !apply, platform });

  return NextResponse.json({ mode: apply ? "apply" : "dry-run", ...report });
}
