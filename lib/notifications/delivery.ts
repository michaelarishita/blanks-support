import { buildRawEmail, generateMessageId } from "@/lib/email/mime";
import { sendGmailMessage } from "@/lib/google/gmail";
import { getAccessToken, getSupportInboxConnection } from "@/lib/google/tokens";
import { createAdminClient } from "@/lib/supabase/admin";
import { localHour, QUIET_ZONE } from "./policy";

/**
 * THE delivery chokepoint. Every email this system sends to a HUMAN team member
 * passes through here, whatever feature raised it — assignments, reminders,
 * escalations, the escalation hand-off, new-ticket notices, system alerts,
 * reconciliation, quarantine, digests. Customer replies do NOT: those go to
 * lib/google/outbound.ts and are a different thing entirely.
 *
 * WHY THIS EXISTS. Three separate senders have flooded this inbox, and each
 * per-sender fix held until the next sender found the same gap. A cap only
 * survives the next feature if it lives where every feature already has to be:
 * the one function that actually hands an email to Gmail.
 *
 * THE RULES (Prompt 38):
 *   - No human receives more than their `daily_email_cap` emails per day.
 *   - Anything over the cap is DEFERRED, not dropped: the full content is kept
 *     in email_ledger and rolled into a daily overflow digest. Nothing is lost.
 *   - EVERY kind counts. There is no allowlist. A new sender is capped by
 *     default simply by calling this function, which it must, because it is the
 *     only way to reach Gmail for a team address.
 *   - The ONLY way past the cap is `bypassCap`, which is explicit, named and
 *     logged (outcome 'bypassed', with its reason). The overflow digest is the
 *     one sanctioned user of it — it is the mechanism that makes the cap
 *     lossless, so it must be able to deliver even when the cap is spent.
 *
 * FAILS OPEN. If the cap column or the ledger can't be read (e.g. the migration
 * hasn't been applied yet), this SENDS rather than blocks: a missing cap is the
 * old behaviour; a chokepoint that swallowed every alert because a table was
 * absent would be a worse outage than the flood.
 */

/**
 * Used only when the real per-agent cap is unavailable (unknown recipient, or a
 * failed read). A flood backstop, never a day-to-day limit, and it only applies
 * on the fail-open path.
 */
const FALLBACK_CAP = 50;

/** The hour (team timezone) the overflow digest is sent, if anything is waiting. */
const OVERFLOW_DIGEST_HOUR = 8;

/** Loop protection: these go from the watched mailbox to internal addresses. */
const LOOP_GUARD_HEADERS = {
  "X-Blanks-Notification": "1",
  "Auto-Submitted": "auto-generated",
};

/** Calendar date in the team timezone — "today" means the team's today. */
function localDateKey(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: QUIET_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export type TeamEmailOutcome = "sent" | "deferred" | "bypassed" | "error";

export interface TeamEmailInput {
  /** What this email IS — recorded, and shown in the digest. Required. */
  kind: string;
  /** The team member's address. */
  recipientEmail: string;
  /** Resolved from recipientEmail when omitted. */
  agentId?: string | null;
  ticketId?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  fromName?: string;
  replyTo?: string;
  /** Omit to let an unthreaded fresh id be generated (alerts rely on this). */
  messageId?: string;
  inReplyTo?: string | null;
  references?: string[];
  threadId?: string | null;
  extraHeaders?: Record<string, string>;
  /** The explicit, named, logged escape hatch. Never a default. */
  bypassCap?: { reason: string };
}

type Connection = NonNullable<Awaited<ReturnType<typeof getSupportInboxConnection>>>;

async function deliver(
  connection: Connection,
  input: TeamEmailInput
): Promise<{ ok: boolean; error?: string }> {
  try {
    const accessToken = await getAccessToken(connection.id);
    const raw = buildRawEmail({
      fromEmail: connection.account_ref,
      fromName: input.fromName ?? "Blanks Support",
      to: input.recipientEmail,
      replyTo: input.replyTo,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      messageId: input.messageId ?? generateMessageId(connection.account_ref),
      inReplyTo: input.inReplyTo ?? null,
      references: input.references,
      extraHeaders: input.extraHeaders,
    });
    await sendGmailMessage(accessToken, {
      raw,
      threadId: input.threadId ?? undefined,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type Admin = ReturnType<typeof createAdminClient>;

async function recordLedger(
  admin: Admin,
  input: TeamEmailInput,
  outcome: TeamEmailOutcome,
  day: string,
  detail?: string | null
): Promise<void> {
  try {
    const { error } = await admin.from("email_ledger").insert({
      agent_id: input.agentId ?? null,
      recipient_email: input.recipientEmail,
      kind: input.kind,
      ticket_id: input.ticketId ?? null,
      subject: input.subject,
      // Kept so the digest can reproduce a deferred email, and so no capped
      // email is ever an absence. Bounded against a runaway body.
      body_text: input.bodyText ? input.bodyText.slice(0, 20000) : null,
      outcome,
      bypass_reason: input.bypassCap?.reason ?? null,
      detail: detail ?? null,
      day,
    });
    // Before 0029 is applied the table is absent; that is the fail-open path,
    // not an error worth shouting about on every send.
    if (error && error.code !== "42P01") {
      console.error("[delivery] ledger write failed:", error.message);
    }
  } catch (e) {
    console.error("[delivery] ledger write threw:", e);
  }
}

/**
 * Send one email to a team member, subject to their daily cap. See the module
 * header for the rules. Returns the outcome; the caller decides what a
 * 'deferred' means for its own bookkeeping (usually: the notification still
 * "happened", it was just batched).
 */
export async function sendTeamEmail(
  input: TeamEmailInput
): Promise<{ outcome: TeamEmailOutcome; error?: string }> {
  const admin = createAdminClient();
  const day = localDateKey(new Date());

  // Resolve the agent and their cap. Any failure here fails OPEN.
  let agentId = input.agentId ?? null;
  let cap = FALLBACK_CAP;
  let capKnown = false;
  try {
    const { data: agent } = await admin
      .from("agents")
      .select("id, daily_email_cap")
      .eq("email", input.recipientEmail)
      .maybeSingle();
    if (agent) {
      agentId = agentId ?? (agent.id as string);
      if (typeof agent.daily_email_cap === "number") {
        cap = agent.daily_email_cap as number;
        capKnown = true;
      }
    }
  } catch {
    /* fail open */
  }
  const resolved: TeamEmailInput = { ...input, agentId };

  const connection = await getSupportInboxConnection();
  if (!connection) return { outcome: "error", error: "no support mailbox connected" };

  const bypass = Boolean(input.bypassCap);

  // Is the recipient already at their cap for today? Only when we actually know
  // the cap and this is not an explicit bypass. A failed count fails OPEN.
  let overCap = false;
  if (capKnown && !bypass) {
    try {
      const { count, error } = await admin
        .from("email_ledger")
        .select("id", { count: "exact", head: true })
        .eq("recipient_email", input.recipientEmail)
        .eq("day", day)
        .eq("outcome", "sent");
      if (!error) overCap = (count ?? 0) >= cap;
    } catch {
      /* fail open */
    }
  }

  if (overCap) {
    await recordLedger(admin, resolved, "deferred", day);
    return { outcome: "deferred" };
  }

  const sent = await deliver(connection, resolved);
  if (!sent.ok) {
    await recordLedger(admin, resolved, "error", day, sent.error);
    return { outcome: "error", error: sent.error };
  }
  await recordLedger(admin, resolved, bypass ? "bypassed" : "sent", day);
  return { outcome: bypass ? "bypassed" : "sent" };
}

interface DeferredRow {
  id: string;
  agent_id: string | null;
  recipient_email: string;
  kind: string;
  subject: string | null;
  ticket_id: string | null;
  created_at: string;
}

export function buildOverflowDigest(items: DeferredRow[]): {
  subject: string;
  bodyText: string;
  bodyHtml: string;
} {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const byKind = new Map<string, DeferredRow[]>();
  for (const it of items) {
    const list = byKind.get(it.kind) ?? [];
    list.push(it);
    byKind.set(it.kind, list);
  }

  const lines: string[] = [
    `${items.length} notification${items.length === 1 ? "" : "s"} were held back by your daily email cap and are summarised here.`,
    "",
  ];
  for (const [kind, list] of byKind) {
    lines.push(`${kind.replace(/_/g, " ")} (${list.length}):`);
    for (const it of list) {
      const link = it.ticket_id ? `  ${site}/tickets/${it.ticket_id}` : "";
      lines.push(`  • ${it.subject ?? "(no subject)"}${link}`);
    }
    lines.push("");
  }
  lines.push("Raised your cap? Settings → your profile. Nothing here was dropped.");

  const bodyText = lines.join("\n");
  const bodyHtml = `<pre style="font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:pre-wrap;margin:0">${bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</pre>`;

  return {
    subject: `Daily summary — ${items.length} notification${items.length === 1 ? "" : "s"} held back`,
    bodyText,
    bodyHtml,
  };
}

/**
 * Roll every deferred, not-yet-digested email into one summary per recipient.
 *
 * Rides the ten-minute notifications cron like the unassigned digest. Sent at
 * most once per recipient per day, at/after the digest hour, and ONLY when
 * there is something waiting — a daily "nothing held back" would be its own
 * flood. The send is the one sanctioned cap bypass: it is explicit ('overflow
 * digest …'), named (kind 'overflow_digest') and logged (outcome 'bypassed').
 */
export async function sendOverflowDigests(
  now = new Date()
): Promise<{ sent: number; skipped: string[] }> {
  const result = { sent: 0, skipped: [] as string[] };
  if (localHour(now, QUIET_ZONE) < OVERFLOW_DIGEST_HOUR) {
    return { ...result, skipped: ["before digest hour"] };
  }

  const admin = createAdminClient();
  const day = localDateKey(now);

  let rows: DeferredRow[];
  try {
    const { data, error } = await admin
      .from("email_ledger")
      .select("id, agent_id, recipient_email, kind, subject, ticket_id, created_at")
      .eq("outcome", "deferred")
      .is("digested_at", null)
      .order("created_at", { ascending: true })
      .limit(2000);
    // A failed read is not "nothing deferred": say so, don't silently skip.
    if (error) return { ...result, skipped: [`read failed: ${error.message}`] };
    rows = (data ?? []) as DeferredRow[];
  } catch (e) {
    return { ...result, skipped: [`read threw: ${e instanceof Error ? e.message : e}`] };
  }
  if (!rows.length) return { ...result, skipped: ["nothing deferred"] };

  const byRecipient = new Map<string, DeferredRow[]>();
  for (const row of rows) {
    const list = byRecipient.get(row.recipient_email) ?? [];
    list.push(row);
    byRecipient.set(row.recipient_email, list);
  }

  for (const [recipient, items] of byRecipient) {
    // One roundup per recipient per day, and NEVER on a day they already got a
    // cadence daily digest — that digest folds the overflow in itself, so a
    // standalone one here would be the second email cap=1 is meant to prevent.
    try {
      const { count } = await admin
        .from("email_ledger")
        .select("id", { count: "exact", head: true })
        .eq("recipient_email", recipient)
        .eq("day", day)
        .in("kind", ["overflow_digest", "daily_digest"]);
      if ((count ?? 0) > 0) {
        result.skipped.push(`${recipient}: already got a digest today`);
        continue;
      }
    } catch {
      /* fall through and try to send; a duplicate digest beats a missing one */
    }

    const digest = buildOverflowDigest(items);
    const res = await sendTeamEmail({
      kind: "overflow_digest",
      recipientEmail: recipient,
      agentId: items[0].agent_id ?? null,
      subject: digest.subject,
      bodyText: digest.bodyText,
      bodyHtml: digest.bodyHtml,
      replyTo: recipient,
      extraHeaders: { ...LOOP_GUARD_HEADERS },
      bypassCap: { reason: `overflow digest rolling up ${items.length} capped email(s)` },
    });

    if (res.outcome === "bypassed" || res.outcome === "sent") {
      // Mark what we rolled up so tomorrow's digest doesn't repeat it.
      await admin
        .from("email_ledger")
        .update({ digested_at: new Date().toISOString() })
        .in(
          "id",
          items.map((i) => i.id)
        );
      result.sent++;
    } else {
      result.skipped.push(`${recipient}: ${res.outcome}${res.error ? ` ${res.error}` : ""}`);
    }
  }

  return result;
}
