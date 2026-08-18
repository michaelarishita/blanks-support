import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { backfillAttachments } from "@/lib/google/backfill";

/**
 * One-off recovery for attachments dropped before the inline-classification
 * fix. Guarded by CRON_SECRET rather than a session, so it can be run with
 * curl and cannot be reached by anything that merely has a login.
 *
 *   GET ?token=$CRON_SECRET                 → dry run, counts only
 *   GET ?token=...&tickets=1018,1025        → dry run, those tickets
 *   GET ?token=...&tickets=1018&apply=1     → download and attach
 *
 * DRY BY DEFAULT. `apply=1` is required to write anything, because the
 * failure mode of getting this wrong is duplicate attachments on real
 * customer tickets.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const params = request.nextUrl.searchParams;
  const apply = params.get("apply") === "1";

  const raw = params.get("tickets");
  const ticketNumbers = raw
    ? raw
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    : undefined;

  const result = await backfillAttachments({ ticketNumbers, dryRun: !apply });

  return Response.json({
    ...result,
    // Spelled out, so a dry run can never be mistaken for a completed one in
    // a terminal scrollback.
    mode: apply ? "APPLIED — files downloaded and attached" : "DRY RUN — nothing downloaded, nothing written",
    totalMegabytes: Math.round((result.totalBytes / (1024 * 1024)) * 100) / 100,
  });
}
