import { createAdminClient } from "@/lib/supabase/admin";
import { buildRawEmail, generateMessageId } from "@/lib/email/mime";
import { getSupportInboxConnection, getAccessToken } from "@/lib/google/tokens";
import { sendGmailMessage } from "@/lib/google/gmail";
import { getCompanySettings, getSettingsBlob, patchSettingsBlob } from "@/lib/settings";
import { localHour, QUIET_ZONE } from "./policy";
import { NOTIFICATION_HEADERS } from "./send";
import {
  buildUnassignedDigest,
  digestSubject,
  digestText,
  type UnassignedTicket,
} from "./unassigned";
import { STATUSES_AWAITING_AGENT } from "@/lib/ticket-status";

/**
 * One email a day, to whoever asked for it, only when there is something to
 * say.
 *
 * The hole 0018 opened: an ordinary Normal ticket that no rule claims now
 * arrives in total silence. Eleven landed in one day and nobody was told.
 * Per-ticket mail was the wrong shape for that — it is what made the old
 * broadcast unreadable — so this is once a day and never when the queue is
 * empty.
 */

/** Local hour the digest is due. Morning, not 4am. */
export const DIGEST_HOUR = 8;

/** Bounded so one bad morning cannot turn into an unbounded query. */
const MAX_TICKETS = 500;

export interface DigestResult {
  sent: number;
  skipped: string[];
  total: number;
  error?: string;
}

/** Calendar date in the quiet-hours zone, so "today" means the team's today. */
export function localDateKey(at: Date, timeZone = QUIET_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Whether this tick should send.
 *
 * Pure, and keyed on the LOCAL DATE rather than on a cron firing, so a missed
 * run catches up on the next tick instead of skipping the day — which is how a
 * digest quietly stops arriving without anything reporting a failure.
 */
export function digestIsDue({
  now,
  lastSentDate,
  timeZone = QUIET_ZONE,
}: {
  now: Date;
  /** Local date key of the last digest, or null if never. */
  lastSentDate: string | null;
  timeZone?: string;
}): boolean {
  if (localHour(now, timeZone) < DIGEST_HOUR) return false;
  return lastSentDate !== localDateKey(now, timeZone);
}

export async function sendUnassignedDigest(
  options: { now?: Date; force?: boolean } = {}
): Promise<DigestResult> {
  const now = options.now ?? new Date();
  const result: DigestResult = { sent: 0, skipped: [], total: 0 };

  const blob = await getSettingsBlob();
  const lastSentDate =
    (blob.unassigned_digest_last_date as string | undefined) ?? null;
  if (!options.force && !digestIsDue({ now, lastSentDate })) {
    return { ...result, skipped: ["not due"] };
  }

  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("tickets")
    .select("id, number, subject, priority, status, created_at")
    .is("assignee_id", null)
    .in("status", STATUSES_AWAITING_AGENT)
    .limit(MAX_TICKETS);
  // A failed read is NOT an empty queue. Reporting "nothing unassigned" here
  // would be the most reassuring possible way to fail.
  if (error) return { ...result, error: error.message };

  // There is no `last_customer_message_at` column — the escalation cron
  // derives it the same way. One query for the whole set rather than one per
  // ticket, then the newest inbound row per ticket.
  const ids = (rows ?? []).map((r) => r.id as string);
  const lastCustomerAt = new Map<string, string>();
  if (ids.length) {
    const { data: inbound, error: inboundError } = await admin
      .from("messages")
      .select("ticket_id, created_at")
      .in("ticket_id", ids)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false });
    // Falling back to created_at is honest here: it is the ticket's own age,
    // which is never NEWER than the customer's last message, so the digest can
    // overstate the wait but never understate it.
    if (inboundError) {
      console.error("[digest] could not read customer messages:", inboundError.message);
    }
    for (const m of inbound ?? []) {
      const ticketId = m.ticket_id as string;
      if (!lastCustomerAt.has(ticketId)) {
        lastCustomerAt.set(ticketId, m.created_at as string);
      }
    }
  }

  const tickets: UnassignedTicket[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    number: r.number as number,
    subject: (r.subject as string) ?? "",
    priority: r.priority,
    status: r.status,
    createdAt: r.created_at as string,
    lastCustomerMessageAt: lastCustomerAt.get(r.id as string) ?? null,
  }));

  const digest = buildUnassignedDigest(tickets, now.getTime());
  result.total = digest.total;

  // Nothing to say. The date is still stamped so an empty Monday does not make
  // Tuesday's digest look overdue.
  if (!digest.total) {
    await patchSettingsBlob({ unassigned_digest_last_date: localDateKey(now) });
    return { ...result, skipped: ["queue is empty"] };
  }

  const { data: watchers, error: agentError } = await admin
    .from("agents")
    .select("id, email, display_name, name, is_active, watch_unassigned_digest")
    .eq("watch_unassigned_digest", true)
    .eq("is_active", true);
  if (agentError) return { ...result, error: agentError.message };
  if (!watchers?.length) return { ...result, skipped: ["nobody is subscribed"] };

  const connection = await getSupportInboxConnection();
  if (!connection) return { ...result, error: "no support mailbox connected" };

  const company = await getCompanySettings();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const subject = digestSubject(digest);
  const bodyText = digestText(digest, site);

  for (const watcher of watchers) {
    const raw = buildRawEmail({
      fromEmail: connection.account_ref,
      fromName: `${company.company_name} Support`,
      to: watcher.email as string,
      // Never hello@: replying to a digest must not open a ticket.
      replyTo: watcher.email as string,
      subject,
      bodyText,
      bodyHtml: `<pre style="font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:pre-wrap;margin:0">${escapeHtml(bodyText)}</pre>`,
      messageId: generateMessageId(connection.account_ref),
      // Never threaded, and never carrying the [⚠️ BLANKS SYSTEM] prefix: this
      // is an FYI, not an alarm, and the prefix only keeps working as a filter
      // while nothing routine uses it.
      extraHeaders: { ...NOTIFICATION_HEADERS },
    });

    try {
      const accessToken = await getAccessToken(connection.id);
      await sendGmailMessage(accessToken, { raw });
      result.sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[digest] send failed for ${watcher.email}:`, message);
      result.skipped.push(`${watcher.email}: ${message}`);
    }
  }

  // Stamped only when somebody actually received it, so a morning of failed
  // sends is retried on the next tick rather than counted as done.
  if (result.sent > 0) {
    await patchSettingsBlob({ unassigned_digest_last_date: localDateKey(now) });
  }

  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
