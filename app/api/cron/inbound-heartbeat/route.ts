import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import {
  alertRecipient,
  sendOperationalAlert,
} from "@/lib/alerts";
import {
  checkInboundHealth,
  recordAlertSent,
  shouldSendAlert,
} from "@/lib/monitoring";

// Hourly. The most important cron here: a lapsed Gmail watch stops inbound
// mail silently, so this asserts that mail should have arrived by now and
// complains when it hasn't.
//
// The alert has two channels on purpose — an email to the owner, and a
// persistent banner in the dashboard. Monitoring nobody sees isn't monitoring.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const { health, previousStatus } = await checkInboundHealth();

  let alertSent = false;
  let alertError: string | undefined;

  if (shouldSendAlert(health.status, previousStatus, health.lastAlertAt, Date.now())) {
    const body = [
      "Inbound email on Blanks Support looks broken.",
      "",
      ...health.reasons.map((reason) => `  • ${reason}`),
      "",
      `Last inbound email: ${health.lastInboundAt ?? "never"}`,
      ...(health.recentlyDropped
        ? [
            "",
            "MAIL IS ARRIVING AND BEING DISCARDED — that is different from a quiet",
            "mailbox, and it is the more likely cause:",
            `  ${health.recentlyDropped}`,
          ]
        : []),
      `Gmail watch expires: ${health.watchExpiresAt ?? "not registered"}`,
      `Sync cursor last moved: ${health.historyChangedAt ?? "never"}`,
      "",
      "What to check, in order:",
      "  1. Settings → Support mailbox — is it still connected?",
      "  2. Google Cloud → Pub/Sub → the subscription's delivery errors.",
      "  3. Run the renew-watch cron by hand, then 'Check mail now'.",
      "",
      "This alert repeats at most every 6 hours while the problem persists.",
    ].join("\n");

    const result = await sendOperationalAlert(
      "[Blanks Support] Inbound email may be down",
      body
    );
    alertSent = result.sent;
    alertError = result.error;
    if (result.sent) await recordAlertSent();
  }

  return Response.json({
    status: health.status,
    reasons: health.reasons,
    alertSent,
    alertRecipient: alertSent ? alertRecipient() : undefined,
    alertError,
  });
}
