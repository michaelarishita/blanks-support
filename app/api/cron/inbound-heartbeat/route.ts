import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { alertRecipient, raiseSystemAlert } from "@/lib/alerts";
import {
  checkInboundHealth,
  recordAlertSent,
  shouldSendAlert,
} from "@/lib/monitoring";
import { readMetaHealth } from "@/lib/meta/health";
import { compareDeploy, readHeadOfMain, readRunningBuild } from "@/lib/deploy-health";
import { getSettingsBlob, patchSettingsBlob } from "@/lib/settings";
import { drainWebhookEvents } from "@/lib/meta/queue";

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

  /**
   * Messenger, checked before email — and separately from it.
   *
   * A Meta outage and a Gmail outage are unrelated conditions with unrelated
   * fixes, so they get their own alert kind rather than being folded into
   * "inbound email may be down". Merging them would mean acknowledging one
   * silences the other.
   *
   * The drain runs here too, and that is what makes the queue self-healing:
   * an event whose `after()` never completed — the function was killed, the
   * deploy rolled — is picked up within the hour instead of sitting forever.
   */
  const meta = await checkMetaChannel();

  /**
   * And the thing that ships the app, which had no heartbeat at all.
   *
   * Seven production builds failed over four days and nobody was told; the
   * only reason it surfaced was somebody going to look. Every other
   * subsystem here reports when it stops working.
   */
  const deploy = await checkDeploy();

  const { health, previousStatus } = await checkInboundHealth();

  if (health.status !== "degraded") {
      return Response.json({
      status: health.status,
      reasons: health.reasons,
      alertSent: false,
      meta,
      deploy,
    });
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
    meta,
    deploy,
    alertRecipient: raised.emailed ? alertRecipient() : undefined,
    alertError: raised.error,
  });
}

/**
 * The Messenger half of the heartbeat.
 *
 * Its own alert kind, because a missing Page subscription and a lapsed Gmail
 * watch need different people to do different things — and because
 * acknowledging one must not silence the other.
 *
 * Never throws. A broken Meta check must not stop the email heartbeat, which
 * is the older and more load-bearing of the two.
 */
async function checkMetaChannel() {
  try {
    // Self-healing: anything whose after() never finished is picked up here.
    const drained = await drainWebhookEvents();
    const health = await readMetaHealth();

    if (!health.reasons.length) {
      return {
        ok: true,
        subscription: health.subscription.state,
        token: health.token.state,
        drained: drained.drained,
        unprocessed: health.events.unprocessed,
      };
    }

    const raised = await raiseSystemAlert({
      kind: "meta_messenger_down",
      title: "Facebook Messenger may be disconnected",
      reasons: health.reasons,
      detail: [
        `Subscription: ${health.subscription.state} — ${health.subscription.detail}`,
        `Page token:   ${health.token.state} — ${health.token.detail}`,
        `Last event:   ${health.events.lastReceivedAt ?? "never"}`,
        `Unprocessed:  ${health.events.unprocessed}`,
        "",
        "Meta unsubscribes an app after an hour of failed deliveries and does",
        "not tell anybody. If the subscription is gone, the Page keeps",
        "receiving messages and we simply never hear about them.",
        "",
        "What to check, in order:",
        "  1. developers.facebook.com → the app → Webhooks → is the Page still",
        "     subscribed, with `messages` and `message_echoes`?",
        "  2. Settings → Messenger in the dashboard shows the same thing.",
        "  3. If signature failures are climbing, compare META_APP_SECRET",
        "     against the app's secret before assuming an attack.",
      ].join("\n"),
      severity: "warning",
    });

    return {
      ok: false,
      reasons: health.reasons,
      subscription: health.subscription.state,
      token: health.token.state,
      drained: drained.drained,
      alertSent: raised.emailed,
    };
  } catch (e) {
    console.error("[cron] Meta health check failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Is production serving what we last shipped?
 *
 * Its own alert kind, like Messenger's: a failed deploy and a lapsed Gmail
 * watch need different people to do different things, and acknowledging one
 * must not silence the other.
 *
 * The divergence CLOCK is persisted rather than recomputed, because "they
 * differ" is not the alarm — "they have differed for six hours" is. A deploy
 * takes minutes, and a push thirty seconds ago is not a failure.
 */
async function checkDeploy() {
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL;
    const repo = process.env.GITHUB_REPO ?? "michaelarishita/blanks-support";
    if (!site) return { state: "unknown", detail: "NEXT_PUBLIC_SITE_URL is not set" };

    const [running, head] = await Promise.all([
      readRunningBuild(site),
      readHeadOfMain(repo),
    ]);

    const blob = await getSettingsBlob();
    const previous = (blob.deploy_divergence as
      | { running?: string; head?: string; since?: number }
      | undefined) ?? {};

    // The clock restarts whenever the PAIR changes, so a new push does not
    // inherit the previous divergence's age and alarm instantly.
    const samePair = previous.running === running && previous.head === head;
    const divergedSince = samePair ? (previous.since ?? Date.now()) : Date.now();

    const health = compareDeploy({ running, head, divergedSince, now: Date.now() });

    await patchSettingsBlob({
      deploy_divergence:
        health.state === "current" && health.behindHours === 0
          ? null
          : { running, head, since: divergedSince },
      deploy_last_checked: new Date().toISOString(),
    });

    if (health.state !== "behind") return health;

    await raiseSystemAlert({
      kind: "deploy_behind",
      title: "Production is running old code",
      severity: "warning",
      reasons: [health.detail],
      detail: [
        `Serving : ${health.running}`,
        `main    : ${health.head}`,
        `Behind  : ${health.behindHours}h`,
        "",
        "A pushed commit is not a deployed commit. Builds fail silently —",
        "Vercel emails about it, and an emailed alert dies in the noise,",
        "which is why this is a row.",
        "",
        "What to check, in order:",
        "  1. vercel.com → blanks-support → Deployments. A red one at the top",
        "     is the answer; open it and read the build log.",
        "  2. A failure in ~4-6s that compiles and then dies on /login is a",
        "     missing NEXT_PUBLIC_SUPABASE_* at BUILD time.",
        "  3. Reproduce locally the way the cloud does it:",
        "     rm -rf node_modules && npm ci && npm run build",
        "     `npm install` succeeds where `npm ci` fails — it proves nothing.",
      ].join("\n"),
    });

    return health;
  } catch (e) {
    // Never the thing that stops the email heartbeat.
    console.error("[cron] deploy check failed:", e);
    return { state: "unknown", detail: e instanceof Error ? e.message : String(e) };
  }
}
