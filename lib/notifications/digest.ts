import { createAdminClient } from "@/lib/supabase/admin";
import { buildRawEmail, generateMessageId } from "@/lib/email/mime";
import { getSupportInboxConnection, getAccessToken } from "@/lib/google/tokens";
import { sendGmailMessage } from "@/lib/google/gmail";
import { getCompanySettings } from "@/lib/settings";
import { localHour, QUIET_ZONE } from "./policy";
import { localDateKey } from "./unassigned-send";
import { NOTIFICATION_HEADERS } from "./send";
import { ESCALATE_AFTER_HOURS } from "./escalation";
import { STATUSES_AWAITING_AGENT } from "@/lib/ticket-status";
import type { TicketPriority } from "@/lib/types";

/**
 * The per-agent DAILY DIGEST (Prompt 34).
 *
 * One email, once a day, at the agent's chosen hour, for agents on the `daily`
 * cadence. Grouped by what needs the reader to ACT, not a flat list of "ticket
 * #N was assigned":
 *
 *   1. Assigned to you and past their chase window (overdue) — worst first.
 *   2. Assigned to you and still unanswered (awaiting) — oldest first.
 *   3. New unassigned tickets — a count, with the oldest few named.
 *
 * If there is nothing to report, it SENDS NOTHING. A daily "all clear" becomes
 * noise within a week, and then the real one is ignored too — the same lesson
 * as the unassigned digest and the system-alert rebuild.
 *
 * Bounded so one bad morning cannot become an unbounded query.
 */
const MAX_TICKETS = 500;

export interface DigestTicketInput {
  number: number;
  subject: string;
  priority: TicketPriority;
  /** When the customer last wrote; null falls back to createdAt. */
  lastCustomerMessageAt: string | null;
  createdAt: string;
}

export interface DigestLine {
  number: number;
  subject: string;
  priority: TicketPriority;
  waitHours: number;
}

export interface DigestModel {
  /** Assigned to you, past the chase window. Worst (longest) first. */
  overdue: DigestLine[];
  /** Assigned to you, unanswered, not yet overdue. Oldest first. */
  awaiting: DigestLine[];
  unassignedCount: number;
  /** The oldest few unassigned, named. */
  unassignedOldest: DigestLine[];
  hasContent: boolean;
}

function waitHours(t: DigestTicketInput, nowMs: number): number {
  const at = t.lastCustomerMessageAt ?? t.createdAt;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((nowMs - ms) / 3_600_000));
}

function toLine(t: DigestTicketInput, nowMs: number): DigestLine {
  return {
    number: t.number,
    subject: t.subject || "(no subject)",
    priority: t.priority,
    waitHours: waitHours(t, nowMs),
  };
}

/**
 * Pure. The "send nothing if empty" decision is a property of this function, so
 * it is tested directly rather than inferred from a send that did not happen.
 */
export function buildDigestModel(
  assigned: DigestTicketInput[],
  unassigned: DigestTicketInput[],
  nowMs: number
): DigestModel {
  const overdue: DigestLine[] = [];
  const awaiting: DigestLine[] = [];

  for (const t of assigned) {
    const line = toLine(t, nowMs);
    const threshold = ESCALATE_AFTER_HOURS[t.priority] ?? ESCALATE_AFTER_HOURS.normal;
    if (line.waitHours >= threshold) overdue.push(line);
    else awaiting.push(line);
  }

  // Longest wait first in every list — that is "oldest first" and, for overdue,
  // "worst first" at the same time.
  const byOldest = (a: DigestLine, b: DigestLine) => b.waitHours - a.waitHours;
  overdue.sort(byOldest);
  awaiting.sort(byOldest);

  const unassignedLines = unassigned.map((t) => toLine(t, nowMs)).sort(byOldest);

  return {
    overdue,
    awaiting,
    unassignedCount: unassignedLines.length,
    unassignedOldest: unassignedLines.slice(0, 3),
    hasContent: overdue.length + awaiting.length + unassignedLines.length > 0,
  };
}

/** Whether this tick should run the digest for an agent — pure, date-keyed. */
export function digestDue({
  now,
  digestHour,
  lastRunDate,
  timeZone = QUIET_ZONE,
}: {
  now: Date;
  digestHour: number;
  lastRunDate: string | null;
  timeZone?: string;
}): boolean {
  if (localHour(now, timeZone) < digestHour) return false;
  return lastRunDate !== localDateKey(now, timeZone);
}

const PRIORITY_TAG: Record<TicketPriority, string> = {
  urgent: "[URGENT] ",
  high: "[HIGH] ",
  normal: "",
  low: "",
};

function line(l: DigestLine): string {
  const waited = l.waitHours >= 1 ? `${l.waitHours}h waiting` : "just now";
  return `  #${l.number} ${PRIORITY_TAG[l.priority]}${l.subject} — ${waited}`;
}

export function digestSubject(model: DigestModel): string {
  const need = model.overdue.length + model.awaiting.length;
  const parts: string[] = [];
  if (need) parts.push(`${need} awaiting you`);
  if (model.unassignedCount) parts.push(`${model.unassignedCount} unassigned`);
  return `Your support digest — ${parts.join(", ")}`;
}

export function digestText(model: DigestModel, site: string): string {
  const out: string[] = ["Here is your once-a-day summary of what needs you.", ""];

  if (model.overdue.length) {
    out.push(`OVERDUE — past their response window (${model.overdue.length}):`);
    out.push(...model.overdue.map(line));
    out.push("");
  }
  if (model.awaiting.length) {
    out.push(`AWAITING YOUR REPLY, oldest first (${model.awaiting.length}):`);
    out.push(...model.awaiting.map(line));
    out.push("");
  }
  if (model.unassignedCount) {
    out.push(`NEW UNASSIGNED — ${model.unassignedCount} in the queue. Oldest:`);
    out.push(...model.unassignedOldest.map(line));
    out.push("");
  }

  out.push(`Open the dashboard: ${site}/inbox`);
  return out.join("\n");
}

export interface DailyDigestResult {
  considered: number;
  sent: number;
  empty: number;
  skipped: string[];
  error?: string;
}

/** newest inbound message per ticket, one query for the whole set. */
async function lastCustomerByTicket(
  admin: ReturnType<typeof createAdminClient>,
  ticketIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ticketIds.length) return map;
  const { data, error } = await admin
    .from("messages")
    .select("ticket_id, created_at")
    .in("ticket_id", ticketIds)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false });
  if (error) {
    // Fall back to createdAt per ticket — overstates the wait, never understates.
    console.error("[digest] could not read customer messages:", error.message);
    return map;
  }
  for (const m of data ?? []) {
    const id = m.ticket_id as string;
    if (!map.has(id)) map.set(id, m.created_at as string);
  }
  return map;
}

/**
 * Runs the daily digest for every `daily` agent whose hour has arrived and who
 * has not had one today. Resilient to 0028 not being applied: if the cadence
 * column is absent the query errors, and we skip digests entirely rather than
 * throwing (the pre-migration deploy window).
 */
export async function runDailyDigests(
  options: { now?: Date; force?: boolean } = {}
): Promise<DailyDigestResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const result: DailyDigestResult = { considered: 0, sent: 0, empty: 0, skipped: [] };

  const admin = createAdminClient();

  const { data: agents, error: agentError } = await admin
    .from("agents")
    .select("id, email, name, display_name, is_active, notification_frequency, digest_hour, digest_last_run_date")
    .eq("notification_frequency", "daily")
    .eq("is_active", true);
  if (agentError) {
    // Almost always "column does not exist" before 0028 is applied. Skip, don't
    // throw — this cron also drains reminders and escalations.
    return { ...result, error: agentError.message };
  }
  if (!agents?.length) return result;

  // Shared inputs, read once.
  const connection = await getSupportInboxConnection();
  if (!connection) return { ...result, error: "no support mailbox connected" };
  const company = await getCompanySettings();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  // The unassigned set is the same for everyone.
  const { data: unassignedRows, error: unassignedError } = await admin
    .from("tickets")
    .select("id, number, subject, priority, created_at")
    .is("assignee_id", null)
    .in("status", STATUSES_AWAITING_AGENT)
    .limit(MAX_TICKETS);
  if (unassignedError) return { ...result, error: unassignedError.message };
  const unassignedLast = await lastCustomerByTicket(
    admin,
    (unassignedRows ?? []).map((r) => r.id as string)
  );
  const unassigned: DigestTicketInput[] = (unassignedRows ?? []).map((r) => ({
    number: r.number as number,
    subject: (r.subject as string) ?? "",
    priority: r.priority as TicketPriority,
    createdAt: r.created_at as string,
    lastCustomerMessageAt: unassignedLast.get(r.id as string) ?? null,
  }));

  for (const agent of agents) {
    const digestHour = (agent.digest_hour as number | null) ?? 8;
    const lastRun = (agent.digest_last_run_date as string | null) ?? null;
    if (!options.force && !digestDue({ now, digestHour, lastRunDate: lastRun })) {
      continue;
    }
    result.considered++;

    const { data: assignedRows, error: assignedError } = await admin
      .from("tickets")
      .select("id, number, subject, priority, created_at")
      .eq("assignee_id", agent.id)
      .in("status", STATUSES_AWAITING_AGENT)
      .limit(MAX_TICKETS);
    if (assignedError) {
      result.skipped.push(`${agent.email}: ${assignedError.message}`);
      continue;
    }
    const assignedLast = await lastCustomerByTicket(
      admin,
      (assignedRows ?? []).map((r) => r.id as string)
    );
    const assigned: DigestTicketInput[] = (assignedRows ?? []).map((r) => ({
      number: r.number as number,
      subject: (r.subject as string) ?? "",
      priority: r.priority as TicketPriority,
      createdAt: r.created_at as string,
      lastCustomerMessageAt: assignedLast.get(r.id as string) ?? null,
    }));

    const model = buildDigestModel(assigned, unassigned, nowMs);

    // Nothing to report: send NOTHING, but stamp the date so this counts as
    // today's (single) consideration and we don't re-run all day.
    if (!model.hasContent) {
      await stampRun(admin, agent.id as string, now);
      result.empty++;
      continue;
    }

    const raw = buildRawEmail({
      fromEmail: connection.account_ref,
      fromName: `${company.company_name} Support`,
      to: agent.email as string,
      // Never hello@: replying to a digest must not open a ticket.
      replyTo: agent.email as string,
      subject: digestSubject(model),
      bodyText: digestText(model, site),
      bodyHtml: `<pre style="font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:pre-wrap;margin:0">${escapeHtml(digestText(model, site))}</pre>`,
      messageId: generateMessageId(connection.account_ref),
      // Never threaded, and never the [⚠️ BLANKS SYSTEM] prefix: this is an
      // FYI, not an alarm.
      extraHeaders: { ...NOTIFICATION_HEADERS },
    });

    try {
      const accessToken = await getAccessToken(connection.id);
      await sendGmailMessage(accessToken, { raw });
      // Stamp only AFTER a successful send, so a failed morning retries on the
      // next tick rather than being counted as done.
      await stampRun(admin, agent.id as string, now);
      result.sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[digest] send failed for ${agent.email}:`, message);
      result.skipped.push(`${agent.email}: ${message}`);
    }
  }

  return result;
}

async function stampRun(
  admin: ReturnType<typeof createAdminClient>,
  agentId: string,
  now: Date
): Promise<void> {
  await admin
    .from("agents")
    .update({ digest_last_run_date: localDateKey(now) })
    .eq("id", agentId);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
