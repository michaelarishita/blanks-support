import { type NextRequest, NextResponse } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { backfillMetaInbox } from "@/lib/meta/backfill";

/**
 * One-time import of the Messenger conversations already in the Page inbox,
 * from before the app was subscribed to the webhook.
 *
 *   GET ?token=...           → DRY RUN: what would come in, nothing written
 *   GET ?token=...&apply=1   → import the missing messages (idempotent)
 *
 * Authorised by CRON_SECRET like the other admin jobs, not a session: it is run
 * with curl, and a cookie check would only bounce it to a login page.
 * Idempotent — dedupe on meta_message_id means a re-run is a no-op.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const apply = request.nextUrl.searchParams.get("apply") === "1";
  const report = await backfillMetaInbox({ dryRun: !apply });

  return NextResponse.json({ mode: apply ? "apply" : "dry-run", ...report });
}
