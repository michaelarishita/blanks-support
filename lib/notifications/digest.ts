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
 * The SCHEDULED digest sends NOTHING when there is nothing to report — a daily
 * "all clear" becomes noise within a week, and then the real one is ignored
 * too. The ON-DEMAND test send (sendDigestNow) is the one exception: it always
 * delivers, so you can confirm the plumbing and see the format even on a quiet
 * day.
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

/** 'sent' — an email went out; 'empty' — ran, nothing to report; 'failed'. */
export type DigestOutcome = "sent" | "empty" | "failed";

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

/**
 * Whether this tick should run the digest for an agent — pure, date-keyed.
 * `lastRunAt` is the timestamp of the last completed run; the once-per-day
 * dedup compares its LOCAL DATE against today's.
 */
export function digestDue({
  now,
  digestHour,
  lastRunAt,
  timeZone = QUIET_ZONE,
}: {
  now: Date;
  digestHour: number;
  lastRunAt: string | null;
  timeZone?: string;
}): boolean {
  if (localHour(now, timeZone) < digestHour) return false;
  const lastDate = lastRunAt ? localDateKey(new Date(lastRunAt), timeZone) : null;
  return lastDate !== localDateKey(now, timeZone);
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
  if (!model.hasContent) return "Your support digest — all clear";
  const need = model.overdue.length + model.awaiting.length;
  const parts: string[] = [];
  if (need) parts.push(`${need} awaiting you`);
  if (model.unassignedCount) parts.push(`${model.unassignedCount} unassigned`);
  return `Your support digest — ${parts.join(", ")}`;
}

export function digestText(model: DigestModel, site: string): string {
  if (!model.hasContent) {
    return [
      "Nothing needs your attention right now — you're all clear.",
      "",
      "(On a normal day the scheduled digest sends nothing when there's nothing",
      "to report. You're seeing this because you asked for one on demand.)",
      "",
      `Open the dashboard: ${site}/inbox`,
    ].join("\n");
  }

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

interface TicketRow {
  id: string;
  number: number;
  subject: string | null;
  priority: TicketPriority;
  created_at: string;
}

async function toInputs(
  admin: ReturnType<typeof createAdminClient>,
  rows: TicketRow[]
): Promise<DigestTicketInput[]> {
  const last = await lastCustomerByTicket(admin, rows.map((r) => r.id));
  return rows.map((r) => ({
    number: r.number,
    subject: r.subject ?? "",
    priority: r.priority,
    createdAt: r.created_at,
    lastCustomerMessageAt: last.get(r.id) ?? null,
  }));
}

/** The unassigned queue — the same for every agent, so read once. */
async function gatherUnassigned(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ tickets: DigestTicketInput[]; error?: string }> {
  const { data, error } = await admin
    .from("tickets")
    .select("id, number, subject, priority, created_at")
    .is("assignee_id", null)
    .in("status", STATUSES_AWAITING_AGENT)
    .limit(MAX_TICKETS);
  if (error) return { tickets: [], error: error.message };
  return { tickets: await toInputs(admin, (data ?? []) as TicketRow[]) };
}

interface DigestAgent {
  id: string;
  email: string;
}

/**
 * Builds and (unless empty and not forced) sends one agent's digest. Returns
 * the outcome; the CALLER decides whether to stamp it — the scheduled path
 * stamps on a completed run, the on-demand test does not touch the schedule.
 */
async function sendDigestForAgent(
  admin: ReturnType<typeof createAdminClient>,
  agent: DigestAgent,
  unassigned: DigestTicketInput[],
  now: Date,
  connection: Awaited<ReturnType<typeof getSupportInboxConnection>>,
  companyName: string,
  site: string,
  opts: { sendWhenEmpty: boolean }
): Promise<{ outcome: DigestOutcome; error?: string }> {
  if (!connection) return { outcome: "failed", error: "no support mailbox connected" };

  const { data: assignedRows, error } = await admin
    .from("tickets")
    .select("id, number, subject, priority, created_at")
    .eq("assignee_id", agent.id)
    .in("status", STATUSES_AWAITING_AGENT)
    .limit(MAX_TICKETS);
  if (error) return { outcome: "failed", error: error.message };

  const assigned = await toInputs(admin, (assignedRows ?? []) as TicketRow[]);
  const model = buildDigestModel(assigned, unassigned, now.getTime());

  // Scheduled path on a quiet day: send nothing.
  if (!model.hasContent && !opts.sendWhenEmpty) return { outcome: "empty" };

  const raw = buildRawEmail({
    fromEmail: connection.account_ref,
    fromName: `${companyName} Support`,
    to: agent.email,
    // Never hello@: replying to a digest must not open a ticket.
    replyTo: agent.email,
    subject: digestSubject(model),
    bodyText: digestText(model, site),
    bodyHtml: `<pre style="font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:pre-wrap;margin:0">${escapeHtml(digestText(model, site))}</pre>`,
    messageId: generateMessageId(connection.account_ref),
    // Never threaded, and never the [⚠️ BLANKS SYSTEM] prefix: an FYI, not an alarm.
    extraHeaders: { ...NOTIFICATION_HEADERS },
  });

  try {
    const accessToken = await getAccessToken(connection.id);
    await sendGmailMessage(accessToken, { raw });
    return { outcome: model.hasContent ? "sent" : "empty" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[digest] send failed for ${agent.email}:`, message);
    return { outcome: "failed", error: message };
  }
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
  const result: DailyDigestResult = { considered: 0, sent: 0, empty: 0, skipped: [] };

  const admin = createAdminClient();

  const { data: agents, error: agentError } = await admin
    .from("agents")
    .select("id, email, is_active, notification_frequency, digest_hour, digest_last_run_at")
    .eq("notification_frequency", "daily")
    .eq("is_active", true);
  if (agentError) {
    // Almost always "column does not exist" before 0028 is applied. Skip, don't
    // throw — this cron also drains reminders and escalations.
    return { ...result, error: agentError.message };
  }
  if (!agents?.length) return result;

  const connection = await getSupportInboxConnection();
  if (!connection) return { ...result, error: "no support mailbox connected" };
  const company = await getCompanySettings();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const unassigned = await gatherUnassigned(admin);
  if (unassigned.error) return { ...result, error: unassigned.error };

  for (const agent of agents) {
    const digestHour = (agent.digest_hour as number | null) ?? 8;
    const lastRunAt = (agent.digest_last_run_at as string | null) ?? null;
    if (!options.force && !digestDue({ now, digestHour, lastRunAt })) continue;
    result.considered++;

    const res = await sendDigestForAgent(
      admin,
      { id: agent.id as string, email: agent.email as string },
      unassigned.tickets,
      now,
      connection,
      company.company_name,
      site,
      { sendWhenEmpty: false }
    );

    if (res.outcome === "failed") {
      // Don't stamp — retry on the next tick.
      result.skipped.push(`${agent.email}: ${res.error}`);
      continue;
    }
    // Stamp only a COMPLETED run (sent or empty), so a quiet day is recorded as
    // "ran, nothing to report" and a failure retries.
    await stampRun(admin, agent.id as string, now, res.outcome);
    if (res.outcome === "sent") result.sent++;
    else result.empty++;
  }

  return result;
}

/**
 * Sends ONE agent their digest right now, on demand, regardless of hour or
 * whether it already ran today — and ALWAYS delivers (even on a quiet day) so
 * the plumbing and the format can be confirmed. Does NOT touch the scheduled
 * last-run tracking: this is a preview, not the daily run.
 */
export async function sendDigestNow(
  agentId: string,
  options: { now?: Date } = {}
): Promise<{ outcome: DigestOutcome; error?: string }> {
  const now = options.now ?? new Date();
  const admin = createAdminClient();

  const { data: agent, error } = await admin
    .from("agents")
    .select("id, email, is_active")
    .eq("id", agentId)
    .maybeSingle();
  if (error) return { outcome: "failed", error: error.message };
  if (!agent) return { outcome: "failed", error: "agent not found" };

  const connection = await getSupportInboxConnection();
  if (!connection) return { outcome: "failed", error: "no support mailbox connected" };
  const company = await getCompanySettings();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const unassigned = await gatherUnassigned(admin);
  if (unassigned.error) return { outcome: "failed", error: unassigned.error };

  return sendDigestForAgent(
    admin,
    { id: agent.id as string, email: agent.email as string },
    unassigned.tickets,
    now,
    connection,
    company.company_name,
    site,
    { sendWhenEmpty: true }
  );
}

async function stampRun(
  admin: ReturnType<typeof createAdminClient>,
  agentId: string,
  now: Date,
  outcome: "sent" | "empty"
): Promise<void> {
  await admin
    .from("agents")
    .update({ digest_last_run_at: now.toISOString(), digest_last_outcome: outcome })
    .eq("id", agentId);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
