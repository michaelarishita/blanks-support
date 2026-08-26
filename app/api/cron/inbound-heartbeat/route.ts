import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { alertRecipient, raiseSystemAlert } from "@/lib/alerts";
import {
  checkInboundHealth,
  recordAlertSent,
  shouldSendAlert,
} from "@/lib/monitoring";

// Hourly. The most important cron here: a lapsed Gmail watch stops inbound
// mail silently, so this asserts that mail should have arrived by now and
// complains when it hasn't.
//
// THREE channels now, because two were not enough. The email was delivered
// correctly all four times it fired and was buried under routine
// notifications; the banner it wrote could be scrolled past. So the alert is
// now a row that persists until acknowledged, an email that cannot be
// threaded or mistaken for an FYI, and an optional webhook to something that
// isn't a mailbox at all.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const { health, previousStatus } = await checkInboundHealth();

  if (health.status !== "degraded") {
    return Response.json({ status: health.status, reasons: health.reasons, alertSent: false });
  }

  const detail = [
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
  ].join("\n");

  // The ROW is written on every degraded check, so the banner's occurrence
  // count is honest even while the email is inside its cooldown. Only the
  // notification is rate-limited — recording the condition never is, because
  // an alert that under-counts itself cannot escalate.
  const notify = shouldSendAlert(
    health.status,
    previousStatus,
    health.lastAlertAt,
    Date.now()
  );

  const raised = await raiseSystemAlert({
    kind: "inbound_email_down",
    title: "Inbound email may be down",
    reasons: health.reasons,
    detail,
    severity: "warning",
    notify,
  });

  if (raised.emailed) await recordAlertSent();

  return Response.json({
    status: health.status,
    reasons: health.reasons,
    occurrence: raised.alert?.occurrence_count ?? null,
    severity: raised.alert?.severity ?? null,
    alertSent: raised.emailed,
    webhookSent: raised.webhooked,
    alertRecipient: raised.emailed ? alertRecipient() : undefined,
    alertError: raised.error,
  });
}
