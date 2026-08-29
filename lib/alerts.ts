import { buildRawEmail, generateMessageId } from "@/lib/email/mime";
import { sendGmailMessage } from "@/lib/google/gmail";
import { getAccessToken, getSupportInboxConnection } from "@/lib/google/tokens";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapeHtml } from "@/lib/html";

/**
 * OPERATIONAL ALERTS — the alarm, as distinct from the hundred FYIs.
 *
 * The heartbeat was never broken. It fired four times, delivered correctly,
 * and was buried: ~200 notification emails from hello@ in fourteen days,
 * nearly all unread. An alarm that arrives from the same address, in the same
 * shape, with the same subject grammar as routine mail is not an alarm — it
 * is one more unread line.
 *
 * Four things separate the two, and all four matter independently:
 *
 *   1. A subject prefix that shares nothing with "New ticket #NNNN".
 *   2. A template that looks like an alarm rather than an FYI.
 *   3. Headers that make threading impossible, so it can never be swallowed
 *      into an existing conversation and marked read with it.
 *   4. A persistent row, so the dashboard can keep saying so after the email
 *      has scrolled away. That is the part email fundamentally cannot do.
 */

/**
 * Deliberately unlike every other subject this system sends. Notifications
 * are "New ticket #1042 — …", "Assigned to you: …", "Reminder: …". Nothing
 * else begins with a bracket-and-siren, so a filter or a glance can separate
 * them without reading further.
 */
export const SYSTEM_ALERT_PREFIX = "[⚠️ BLANKS SYSTEM]";

/** Past this many unacknowledged occurrences, a warning becomes critical. */
export const ESCALATE_AFTER_OCCURRENCES = 3;

export type AlertSeverity = "warning" | "critical";

export interface SystemAlert {
  id: string;
  kind: string;
  severity: AlertSeverity;
  title: string;
  reasons: string[];
  detail: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  last_notified_at: string | null;
  acknowledged_at: string | null;
}

export function alertRecipient(): string {
  return process.env.ALERT_EMAIL ?? "michael@blankssportsnutrition.com";
}

/** Ordinal for the subject line, so a repeat never arrives looking identical. */
function occurrenceLabel(count: number): string {
  if (count <= 1) return "";
  const suffix =
    count % 100 >= 11 && count % 100 <= 13
      ? "th"
      : count % 10 === 1
        ? "st"
        : count % 10 === 2
          ? "nd"
          : count % 10 === 3
            ? "rd"
            : "th";
  return ` (${count}${suffix} alert)`;
}

/**
 * The subject line for an occurrence.
 *
 * Exported and pure because the whole point is that repeats DIFFER: Gmail
 * threads on subject as well as References, so an identical subject would
 * collapse six alerts into one conversation whose unread state is cleared by
 * reading the first.
 */
export function alertSubject(
  title: string,
  occurrence: number,
  severity: AlertSeverity
): string {
  const critical = severity === "critical" ? " STILL BROKEN —" : "";
  return `${SYSTEM_ALERT_PREFIX}${critical} ${title}${occurrenceLabel(occurrence)}`;
}

/** Severity after N unacknowledged occurrences of the same condition. */
export function escalatedSeverity(
  base: AlertSeverity,
  occurrence: number
): AlertSeverity {
  // A condition nobody has acknowledged after several hours is a worse
  // problem than the same condition was on its first hour, and saying the
  // same words again at the same volume is how alerts get filtered away.
  return base === "critical" || occurrence >= ESCALATE_AFTER_OCCURRENCES
    ? "critical"
    : "warning";
}

function alertHtml(
  subject: string,
  reasons: string[],
  detail: string,
  alert: { occurrence_count: number; first_seen_at: string; severity: AlertSeverity }
): string {
  const bar = alert.severity === "critical" ? "#b42318" : "#b54708";
  const repeat =
    alert.occurrence_count > 1
      ? `<p style="margin:0 0 16px;padding:10px 12px;background:#fef3f2;border-radius:6px;color:#912018;font-size:13px">
           This is occurrence <strong>${alert.occurrence_count}</strong>, first seen
           ${escapeHtml(new Date(alert.first_seen_at).toUTCString())}. It has not been acknowledged.
         </p>`
      : "";

  // Inline styles and a table-free layout: this has to render in a client we
  // do not control, on a day when something is already broken.
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e7e5e4">
    <div style="background:${bar};padding:14px 20px;color:#ffffff;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase">
      ⚠️ Blanks Support — system alert
    </div>
    <div style="padding:20px">
      <h1 style="margin:0 0 12px;font-size:17px;line-height:1.35;color:#1c1917">${escapeHtml(subject)}</h1>
      ${repeat}
      ${
        reasons.length
          ? `<ul style="margin:0 0 16px;padding-left:20px;color:#292524;font-size:14px;line-height:1.6">${reasons
              .map((r) => `<li>${escapeHtml(r)}</li>`)
              .join("")}</ul>`
          : ""
      }
      <pre style="margin:0;padding:12px;background:#fafaf9;border:1px solid #e7e5e4;border-radius:6px;color:#44403c;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word">${escapeHtml(detail)}</pre>
      <p style="margin:16px 0 0;font-size:12px;color:#78716c">
        This is an automated system alert, not a ticket notification. It also
        appears as a banner in the dashboard and stays there until somebody
        acknowledges it.
      </p>
    </div>
  </div>
</body></html>`;
}

async function deliverAlertEmail(
  subject: string,
  reasons: string[],
  detail: string,
  alert: { occurrence_count: number; first_seen_at: string; severity: AlertSeverity }
): Promise<{ sent: boolean; error?: string }> {
  const connection = await getSupportInboxConnection();
  if (!connection) return { sent: false, error: "No support mailbox connected" };

  try {
    const accessToken = await getAccessToken(connection.id);
    const bodyText = [
      subject,
      "",
      ...reasons.map((r) => `  • ${r}`),
      reasons.length ? "" : null,
      detail,
    ]
      .filter((line) => line !== null)
      .join("\n");

    const raw = buildRawEmail({
      fromEmail: connection.account_ref,
      fromName: "Blanks Support SYSTEM ALERT",
      to: alertRecipient(),
      subject,
      bodyText,
      bodyHtml: alertHtml(subject, reasons, detail, alert),
      // Fresh id, and NO In-Reply-To or References, ever.
      //
      // Threading is the failure mode this whole module exists to avoid: an
      // alert threaded onto a notification inherits that conversation's read
      // state, so opening an unrelated FYI silently marks the alarm read.
      messageId: generateMessageId(connection.account_ref),
      extraHeaders: {
        // Lets the owner filter alerts into their own label, and lets our own
        // inbound guard recognise them without parsing the subject.
        "X-Blanks-Alert": "system",
        "X-Blanks-Notification": "system-alert",
        "Auto-Submitted": "auto-generated",
        Importance: "high",
        "X-Priority": "1",
      },
    });

    await sendGmailMessage(accessToken, { raw });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A generic outgoing webhook, from ALERT_WEBHOOK_URL.
 *
 * The cheapest possible second channel that isn't email: a plain JSON POST
 * with a `text` field, which is the shape Slack, Discord (with /slack),
 * ntfy and Pushover all already accept. No SDK, no vendor account in the
 * build, nothing to keep working when the vendor changes their client
 * library. If the env var is unset this does nothing and says so.
 *
 * Best-effort by construction: a webhook that throws must never be the reason
 * an alert email doesn't go out.
 */
export async function postAlertWebhook(
  text: string
): Promise<{ posted: boolean; error?: string }> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return { posted: false };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { posted: false, error: `webhook responded ${res.status}` };
    return { posted: true };
  } catch (e) {
    return { posted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface RaiseResult {
  alert: SystemAlert | null;
  emailed: boolean;
  webhooked: boolean;
  error?: string;
}

/**
 * Record a condition, escalate it if it is a repeat, and notify.
 *
 * `kind` identifies the CONDITION, not the occurrence, and a partial unique
 * index keeps at most one unacknowledged row per kind. So a problem that
 * persists for six hours produces one row with occurrence_count 6, not six
 * rows — the banner stays a banner instead of becoming its own flood.
 */
export async function raiseSystemAlert(input: {
  kind: string;
  title: string;
  reasons?: string[];
  detail?: string;
  severity?: AlertSeverity;
  /** Skip the email but still record the row (used when inside a cooldown). */
  notify?: boolean;
}): Promise<RaiseResult> {
  const admin = createAdminClient();
  const reasons = input.reasons ?? [];
  const detail = input.detail ?? "";
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await admin
    .from("system_alerts")
    .select("*")
    .eq("kind", input.kind)
    .is("acknowledged_at", null)
    .maybeSingle();
  if (readError) return { alert: null, emailed: false, webhooked: false, error: readError.message };

  const occurrence = (existing?.occurrence_count ?? 0) + 1;
  const severity = escalatedSeverity(input.severity ?? "warning", occurrence);

  const row = existing
    ? await admin
        .from("system_alerts")
        .update({
          severity,
          title: input.title,
          reasons,
          detail,
          last_seen_at: now,
          occurrence_count: occurrence,
        })
        .eq("id", existing.id)
        .select("*")
        .single()
    : await admin
        .from("system_alerts")
        .insert({
          kind: input.kind,
          severity,
          title: input.title,
          reasons,
          detail,
          first_seen_at: now,
          last_seen_at: now,
          occurrence_count: 1,
        })
        .select("*")
        .single();

  if (row.error) {
    return { alert: null, emailed: false, webhooked: false, error: row.error.message };
  }
  const alert = row.data as SystemAlert;

  if (input.notify === false) {
    return { alert, emailed: false, webhooked: false };
  }

  const subject = alertSubject(input.title, occurrence, severity);
  const [mail, hook] = await Promise.all([
    deliverAlertEmail(subject, reasons, detail, alert),
    postAlertWebhook([subject, ...reasons.map((r) => `• ${r}`)].join("\n")),
  ]);

  if (mail.sent) {
    await admin
      .from("system_alerts")
      .update({ last_notified_at: new Date().toISOString() })
      .eq("id", alert.id);
  }

  return {
    alert,
    emailed: mail.sent,
    webhooked: hook.posted,
    error: mail.error ?? hook.error,
  };
}

/** Open alerts, worst and newest first. Read by the dashboard banner. */
/**
 * What an AGENT should be told about an alert, if anything.
 *
 * System alerts are written for whoever can fix them, and that is always an
 * admin: Pub/Sub subscriptions, migrations, cursors. An agent shown a red
 * block about a Pub/Sub subscription learns two things — that something is
 * broken, and that banners in this app are not addressed to them. The second
 * is the expensive one, because it is what makes the next banner ignorable.
 *
 * So an agent gets a sentence about the only thing that changes THEIR work —
 * customer mail may be late — and nothing about the mechanism. Anything with
 * no consequence they could notice returns null and is not shown at all.
 *
 * Pure, and keyed on alert KIND, so a new alert kind is silent for agents
 * until somebody decides what it means for them. That default is deliberate:
 * the failure mode being fixed is agents seeing alarms meant for someone else.
 */
export function agentFacingNotice(kinds: string[]): string | null {
  const delayed = new Set([
    // Inbound is down, so mail is arriving late or not at all.
    "inbound_email_down",
    // Specific messages were given up on, so a customer may not appear.
    "inbound_quarantine",
    // Mail exists in the mailbox that we have no record of deciding about.
    "inbound_reconciliation",
  ]);
  // NOT here, on purpose: "inbound_reconciliation_failed" is a gap in our
  // MONITORING, not in the mail. Nothing an agent does changes, and telling
  // them their email may be delayed when it may well be fine is the false
  // alarm in the other direction.
  return kinds.some((k) => delayed.has(k))
    ? "Some incoming email may be delayed."
    : null;
}

/**
 * Who an agent should be told has been notified.
 *
 * Read rather than hardcoded, for the same reason the notification seed lists
 * are data: the team changes, and a banner naming somebody who left is worse
 * than one naming nobody. Falls back to the generic phrasing whenever the
 * lookup is unhelpful — a name is a nicety here, not the message.
 */
export async function alertResponderNames(): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agents")
    .select("name, display_name")
    .eq("role", "admin")
    .eq("is_active", true);
  if (error || !data?.length) return "An admin has been notified";

  const names = data
    .map((a) => ((a.display_name as string) || (a.name as string) || "").split(" ")[0])
    .filter(Boolean);
  if (!names.length) return "An admin has been notified";
  if (names.length === 1) return `${names[0]} has been notified`;
  if (names.length === 2) return `${names[0]} and ${names[1]} have been notified`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} have been notified`;
}

export async function readOpenAlerts(): Promise<{
  alerts: SystemAlert[];
  error: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("system_alerts")
    .select("*")
    .is("acknowledged_at", null)
    .order("severity", { ascending: true })
    .order("last_seen_at", { ascending: false })
    .limit(10);
  // A failed read is reported, never rendered as "no alerts" — that is the
  // house rule, and this is the surface where breaking it would hide the
  // thing most worth seeing.
  if (error) return { alerts: [], error: error.message };
  return { alerts: (data ?? []) as SystemAlert[], error: null };
}

/**
 * Kept for the escalation path, which is a message to a person rather than a
 * condition to be tracked and acknowledged. It is still unthreadable and
 * still carries the system prefix.
 */
export async function sendOperationalAlert(
  title: string,
  body: string
): Promise<{ sent: boolean; error?: string }> {
  return deliverAlertEmail(
    `${SYSTEM_ALERT_PREFIX} ${title}`,
    [],
    body,
    { occurrence_count: 1, first_seen_at: new Date().toISOString(), severity: "warning" }
  );
}
