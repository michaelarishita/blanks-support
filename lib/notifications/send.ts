import { createAdminClient } from "@/lib/supabase/admin";
import { buildRawEmail, generateMessageId } from "@/lib/email/mime";
import { sendGmailMessage } from "@/lib/google/gmail";
import { getAccessToken, getSupportInboxConnection } from "@/lib/google/tokens";
import { getCompanySettings } from "@/lib/settings";
import { agentDisplayName, customerDisplayName } from "@/lib/display";
import type { TicketChannel, TicketPriority } from "@/lib/types";
import {
  ASSIGNMENT_SUBJECT,
  renderAssignmentHtml,
  renderAssignmentText,
  type AssignmentContext,
  type QueueBreakdown,
} from "./assignment";
import { summarizeMessage } from "./summary";
import { decideSendTime, notificationSubject } from "./policy";
import { escalationLead, escalationSubject } from "./escalation";
import {
  REMINDER_DELAYS,
  describeDelay,
  signReminderToken,
} from "./reminder-token";
import { alertRecipient, sendOperationalAlert } from "@/lib/alerts";
import {
  newTicketSubject,
  selectNewTicketRecipients,
  type WatcherCandidate,
} from "./watchers";

// Sends notifications from the shared mailbox to an agent.
//
// LOOP PROTECTION. These are emails from hello@ — the mailbox we watch — to
// internal addresses. Three independent guards, because one failing silently
// turns every assignment into a ticket, and a notification about THAT ticket
// would cascade:
//
//  1. X-Blanks-Notification and Auto-Submitted: auto-generated are stamped on
//     every send. The inbound parser treats either as machine-generated and
//     always drops it, with no trusted-forwarder exception.
//  2. The sender is hello@, which is in our own-addresses set.
//  3. Reply-To is the AGENT's own address, never hello@ — so hitting reply on
//     a notification starts a normal internal email, not a new ticket.

export const NOTIFICATION_HEADERS = {
  "X-Blanks-Notification": "1",
  "Auto-Submitted": "auto-generated",
} as const;

export type NotificationKind =
  | "assignment"
  | "reminder"
  | "escalation"
  | "new_ticket";

export interface NotificationResult {
  sent: boolean;
  skipped?: string;
  error?: string;
}

const OPEN_STATUSES = ["new", "open", "pending"];

/** Mirrors MAX_ESCALATIONS; imported separately to avoid a cycle. */
const MAX_ESCALATION_COUNT = 3;

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    "https://support.blankssportsnutrition.com"
  );
}

/** Counts of this agent's unresolved tickets, and their oldest. */
async function gatherQueue(agentId: string): Promise<AssignmentContext["queue"]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("tickets")
    .select("number, priority, created_at")
    .eq("assignee_id", agentId)
    .in("status", OPEN_STATUSES)
    .order("created_at", { ascending: true });

  const rows = data ?? [];
  const byPriority: QueueBreakdown = { urgent: 0, high: 0, normal: 0, low: 0 };
  for (const row of rows) {
    const key = row.priority as keyof QueueBreakdown;
    if (key in byPriority) byPriority[key] += 1;
  }

  return {
    total: rows.length,
    byPriority,
    oldest: rows[0]
      ? { number: rows[0].number as number, createdAt: rows[0].created_at as string }
      : null,
  };
}

/**
 * The root of this (agent, ticket) conversation, if it has one.
 *
 * Both halves matter: reminders reply into the root Message-ID, and reuse its
 * SUBJECT byte-for-byte. The subject now carries priority, so a ticket
 * escalated from Normal to Urgent mid-thread would otherwise split into two
 * Gmail conversations.
 */
async function threadRoot(
  agentId: string,
  ticketId: string
): Promise<{ messageId: string; subject: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("notifications")
    .select("thread_message_id, subject")
    .eq("agent_id", agentId)
    .eq("ticket_id", ticketId)
    .not("thread_message_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data?.thread_message_id) return null;
  return {
    messageId: data.thread_message_id as string,
    subject: (data.subject as string | null) ?? null,
  };
}

function reminderLinks(agentId: string, ticketId: string) {
  const base = siteUrl();
  return REMINDER_DELAYS.map((hours) => ({
    hours,
    label: describeDelay(hours),
    href: `${base}/remind/${signReminderToken(agentId, ticketId, hours)}`,
  }));
}

export async function sendAssignmentNotification(
  ticketId: string,
  agentId: string
): Promise<NotificationResult> {
  const admin = createAdminClient();

  const { data: agent, error: agentError } = await admin
    .from("agents")
    .select("id, name, display_name, email, is_active, notifications_enabled")
    .eq("id", agentId)
    .maybeSingle();
  if (agentError) return { sent: false, error: agentError.message };
  if (!agent) return { sent: false, skipped: "agent not found" };
  if (!agent.is_active) return { sent: false, skipped: "agent inactive" };
  if (agent.notifications_enabled === false) {
    return { sent: false, skipped: "notifications disabled" };
  }

  const { data: ticket, error: ticketError } = await admin
    .from("tickets")
    .select(
      "id, number, subject, priority, channel, topic, assignee_id, created_at, customer:customers(name, email), ticket_tags(tag:tags(name))"
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketError) return { sent: false, error: ticketError.message };
  if (!ticket) return { sent: false, skipped: "ticket not found" };

  const connection = await getSupportInboxConnection();
  if (!connection) {
    return { sent: false, skipped: "no support mailbox connected" };
  }

  // Latest inbound message, for the preview.
  const { data: latest } = await admin
    .from("messages")
    .select("body_text, body_html")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const customer = Array.isArray(ticket.customer) ? ticket.customer[0] : ticket.customer;
  const tags = ((ticket.ticket_tags ?? []) as { tag: { name: string } | { name: string }[] }[])
    .map((tt) => (Array.isArray(tt.tag) ? tt.tag[0]?.name : tt.tag?.name))
    .filter((name): name is string => Boolean(name));

  const company = await getCompanySettings();
  const context: AssignmentContext = {
    // Internal email to a teammate, so this is the dashboard label — not the
    // signature name customers see.
    agentName: agentDisplayName(agent),
    variant: "assignment",
    reminderLinks: reminderLinks(agentId, ticketId),
    ticket: {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      priority: ticket.priority as TicketPriority,
      channel: ticket.channel as TicketChannel,
      topic: ticket.topic,
      tags,
      customerName: customerDisplayName(customer),
      createdAt: ticket.created_at,
    },
    summary: summarizeMessage({
      bodyText: latest?.body_text,
      bodyHtml: latest?.body_html,
    }),
    queue: await gatherQueue(agentId),
    siteUrl: siteUrl(),
  };

  const priority = ticket.priority as TicketPriority;

  // EVERY assignment notifies. Priority changes the treatment, never whether
  // it sends: Urgent ignores quiet hours, everything else defers to the next
  // window rather than being dropped.
  const decision = decideSendTime(priority, new Date());
  if (!decision.sendNow && decision.scheduledFor) {
    const { error } = await admin.from("notifications").insert({
      agent_id: agentId,
      ticket_id: ticketId,
      kind: "assignment",
      scheduled_for: decision.scheduledFor.toISOString(),
      sent_at: null,
    });
    if (error) return { sent: false, error: error.message };
    return {
      sent: false,
      skipped: `queued for ${decision.scheduledFor.toISOString()} (quiet hours)`,
    };
  }

  const messageId = generateMessageId(connection.account_ref);
  const root = await threadRoot(agentId, ticketId);
  // Follow-ups reuse the root's subject exactly; the first send composes it.
  const subject =
    root?.subject ?? notificationSubject(ASSIGNMENT_SUBJECT, priority);

  const raw = buildRawEmail({
    fromEmail: connection.account_ref,
    fromName: `${company.company_name} Support`,
    to: agent.email,
    // Never hello@: replying to a notification must not open a ticket.
    replyTo: agent.email,
    // Byte-identical across the thread — Gmail needs a stable subject as well
    // as the header chain to group reliably.
    subject,
    bodyText: renderAssignmentText(context),
    bodyHtml: renderAssignmentHtml(context),
    messageId,
    inReplyTo: root?.messageId ?? null,
    references: root ? [root.messageId] : undefined,
    extraHeaders: { ...NOTIFICATION_HEADERS },
  });

  try {
    const accessToken = await getAccessToken(connection.id);
    await sendGmailMessage(accessToken, { raw });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[notifications] assignment send failed for ${agentId}:`, message);
    return { sent: false, error: message };
  }

  const { error: insertError } = await admin.from("notifications").insert({
    agent_id: agentId,
    ticket_id: ticketId,
    kind: "assignment",
    // The first notification for this pair becomes the thread root.
    thread_message_id: root?.messageId ?? messageId,
    subject,
    sent_at: new Date().toISOString(),
  });
  if (insertError) {
    // The mail is already gone; losing the record would break threading for
    // later reminders, so it's worth surfacing rather than swallowing.
    console.error("[notifications] could not record the send:", insertError);
  }

  return { sent: true };
}


export interface NewTicketResult {
  sent: number;
  deferred: number;
  skipped: { agentId: string; reason: string }[];
  error?: string;
}

/**
 * Tells the watchers a ticket has arrived.
 *
 * Runs AFTER the routing rules, so that whoever a rule just assigned it to is
 * already recorded in `notifications` and can be excluded — two emails about
 * one ticket in the same minute is how people learn to ignore both.
 *
 * Threads per (watcher, ticket) through the same root as every other
 * notification, so a later assignment or escalation about this ticket replies
 * into the notice rather than starting a second conversation about it.
 */
export async function sendNewTicketNotification(
  ticketId: string
): Promise<NewTicketResult> {
  const admin = createAdminClient();
  const result: NewTicketResult = { sent: 0, deferred: 0, skipped: [] };

  const { data: ticket, error: ticketError } = await admin
    .from("tickets")
    .select(
      "id, number, subject, priority, channel, topic, assignee_id, created_at, customer:customers(name, email), ticket_tags(tag:tags(name))"
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketError) return { ...result, error: ticketError.message };
  if (!ticket) return { ...result, error: "ticket not found" };

  const { data: candidates, error: agentError } = await admin
    .from("agents")
    .select(
      "id, email, name, display_name, is_active, watch_new_tickets, notifications_enabled"
    );
  if (agentError) {
    // A missing column here means 0014 has not been run. Reported rather than
    // swallowed: silently mailing nobody is the failure mode this whole
    // feature exists to avoid.
    return { ...result, error: agentError.message };
  }

  // Whoever already has mail about this ticket — in practice the assignee a
  // rule just picked, receiving the assignment email at this same moment.
  const { data: existing } = await admin
    .from("notifications")
    .select("agent_id")
    .eq("ticket_id", ticketId);
  const alreadyNotified = new Set(
    (existing ?? []).map((row) => row.agent_id as string)
  );

  const selection = selectNewTicketRecipients({
    candidates: (candidates ?? []) as WatcherCandidate[],
    alreadyNotified,
    ticket: {
      priority: ticket.priority as TicketPriority,
      // Read here rather than passed in, because the rules have already run
      // by this point: a ticket a routing rule just claimed is assigned, and
      // its owner is getting the assignment email instead.
      assigned: Boolean(ticket.assignee_id),
    },
  });
  result.skipped = selection.excluded.map((e) => ({
    agentId: e.id,
    reason: e.reason,
  }));

  if (!selection.recipients.length) return result;

  const connection = await getSupportInboxConnection();
  if (!connection) return { ...result, error: "no support mailbox connected" };

  const { data: latest } = await admin
    .from("messages")
    .select("body_text, body_html")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const customer = Array.isArray(ticket.customer) ? ticket.customer[0] : ticket.customer;
  const tags = ((ticket.ticket_tags ?? []) as { tag: { name: string } | { name: string }[] }[])
    .map((tt) => (Array.isArray(tt.tag) ? tt.tag[0]?.name : tt.tag?.name))
    .filter((name): name is string => Boolean(name));

  const priority = ticket.priority as TicketPriority;
  const customerName = customerDisplayName(customer);
  const company = await getCompanySettings();
  const summary = summarizeMessage({
    bodyText: latest?.body_text,
    bodyHtml: latest?.body_html,
  });

  const baseSubject = newTicketSubject({
    number: ticket.number,
    topic: ticket.topic,
    customerName,
  });

  for (const watcher of selection.recipients) {
    // Same policy as escalations: everything defers out of quiet hours except
    // Urgent, which is the only priority loud enough to justify a 3am phone.
    const decision = decideSendTime(priority, new Date());
    if (!decision.sendNow && decision.scheduledFor) {
      await admin.from("notifications").insert({
        agent_id: watcher.id,
        ticket_id: ticketId,
        kind: "new_ticket",
        scheduled_for: decision.scheduledFor.toISOString(),
        sent_at: null,
      });
      result.deferred++;
      continue;
    }

    const messageId = generateMessageId(connection.account_ref);
    const root = await threadRoot(watcher.id, ticketId);
    const subject = root?.subject ?? notificationSubject(baseSubject, priority);

    const context: AssignmentContext = {
      agentName: agentDisplayName(watcher),
      variant: "new_ticket",
      // No queue: this mail is about somebody else's ticket, and appending
      // "here is your workload" turns a short notice into an unrelated nag.
      queue: null,
      ticket: {
        id: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        priority,
        channel: ticket.channel as TicketChannel,
        topic: ticket.topic,
        tags,
        customerName,
        createdAt: ticket.created_at,
      },
      summary,
      siteUrl: siteUrl(),
    };

    const raw = buildRawEmail({
      fromEmail: connection.account_ref,
      fromName: `${company.company_name} Support`,
      to: watcher.email,
      // Never hello@: replying to a notification must not open a ticket.
      replyTo: watcher.email,
      subject,
      bodyText: renderAssignmentText(context),
      bodyHtml: renderAssignmentHtml(context),
      messageId,
      inReplyTo: root?.messageId ?? null,
      references: root ? [root.messageId] : undefined,
      // The loop guard. These go from hello@ — the mailbox we watch — to
      // internal addresses, so without these headers every new ticket would
      // create three more.
      extraHeaders: { ...NOTIFICATION_HEADERS },
    });

    try {
      const accessToken = await getAccessToken(connection.id);
      await sendGmailMessage(accessToken, { raw });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[notifications] new-ticket send failed for ${watcher.id}:`, message);
      result.skipped.push({ agentId: watcher.id, reason: message });
      continue;
    }

    await admin.from("notifications").insert({
      agent_id: watcher.id,
      ticket_id: ticketId,
      kind: "new_ticket",
      thread_message_id: root?.messageId ?? messageId,
      subject,
      sent_at: new Date().toISOString(),
    });
    result.sent++;
  }

  return result;
}

/**
 * A reminder the agent asked for. THREADS into the assignment conversation:
 * they requested it, so the context belongs together and a fresh mail would
 * just be clutter.
 */
export async function sendReminderNotification(
  ticketId: string,
  agentId: string
): Promise<NotificationResult> {
  return sendFollowUp(ticketId, agentId, "reminder");
}

/**
 * An escalation. Deliberately does NOT thread: the whole premise is that the
 * agent is ignoring the assignment thread, so replying into it would bury the
 * chase under a collapsed Gmail conversation. New Message-ID, no In-Reply-To,
 * and a subject that dates itself so it lands unread at the top.
 */
export async function sendEscalationNotification(
  ticketId: string,
  agentId: string,
  overdueHours: number,
  count: number
): Promise<NotificationResult> {
  return sendFollowUp(ticketId, agentId, "escalation", { overdueHours, count });
}

async function sendFollowUp(
  ticketId: string,
  agentId: string,
  kind: "reminder" | "escalation",
  escalation?: { overdueHours: number; count: number }
): Promise<NotificationResult> {
  const admin = createAdminClient();

  const { data: agent, error: agentError } = await admin
    .from("agents")
    .select("id, name, display_name, email, is_active, notifications_enabled")
    .eq("id", agentId)
    .maybeSingle();
  if (agentError) return { sent: false, error: agentError.message };
  if (!agent?.is_active) return { sent: false, skipped: "agent inactive" };
  if (agent.notifications_enabled === false) {
    return { sent: false, skipped: "notifications disabled" };
  }

  const { data: ticket, error: ticketError } = await admin
    .from("tickets")
    .select(
      "id, number, subject, priority, channel, topic, assignee_id, created_at, customer:customers(name, email), ticket_tags(tag:tags(name))"
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketError) return { sent: false, error: ticketError.message };
  if (!ticket) return { sent: false, skipped: "ticket not found" };

  const connection = await getSupportInboxConnection();
  if (!connection) return { sent: false, skipped: "no support mailbox connected" };

  const priority = ticket.priority as TicketPriority;
  const agentName = agentDisplayName(agent);

  // Past the cap, stop chasing the agent and tell an admin instead.
  if (escalation && escalation.count > MAX_ESCALATION_COUNT) {
    const result = await sendOperationalAlert(
      `[ESCALATED] Ticket #${ticket.number} unanswered by ${agentName}`,
      [
        `Ticket #${ticket.number} — ${ticket.subject}`,
        `Assigned to: ${agentName} (${agent.email})`,
        `Priority: ${priority}`,
        `Unanswered for: ${escalation.overdueHours}h`,
        "",
        `${MAX_ESCALATION_COUNT} escalations have been sent with no reply, so this is`,
        "going to you instead of continuing to chase them.",
        "",
        `${siteUrl()}/tickets/${ticket.id}`,
      ].join("\n")
    );
    if (!result.sent) return { sent: false, error: result.error };

    await admin.from("notifications").insert({
      agent_id: agentId,
      ticket_id: ticketId,
      kind: "escalation",
      escalation_count: escalation.count,
      sent_at: new Date().toISOString(),
    });
    return { sent: true, skipped: `handed to ${alertRecipient()}` };
  }

  const { data: latest } = await admin
    .from("messages")
    .select("body_text, body_html")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const customer = Array.isArray(ticket.customer) ? ticket.customer[0] : ticket.customer;
  const tags = ((ticket.ticket_tags ?? []) as { tag: { name: string } | { name: string }[] }[])
    .map((tt) => (Array.isArray(tt.tag) ? tt.tag[0]?.name : tt.tag?.name))
    .filter((name): name is string => Boolean(name));

  const context: AssignmentContext = {
    agentName,
    variant: kind,
    lead: escalation ? escalationLead(escalation.count, agentName) : undefined,
    reminderLinks: kind === "reminder" ? reminderLinks(agentId, ticketId) : undefined,
    ticket: {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      priority,
      channel: ticket.channel as TicketChannel,
      topic: ticket.topic,
      tags,
      customerName: customerDisplayName(customer),
      createdAt: ticket.created_at,
    },
    summary: summarizeMessage({ bodyText: latest?.body_text, bodyHtml: latest?.body_html }),
    queue: await gatherQueue(agentId),
    siteUrl: siteUrl(),
  };

  const messageId = generateMessageId(connection.account_ref);
  const root = kind === "reminder" ? await threadRoot(agentId, ticketId) : null;

  const subject = escalation
    ? escalationSubject(priority, escalation.overdueHours, ticket.number, ticket.subject)
    : (root?.subject ?? notificationSubject(ASSIGNMENT_SUBJECT, priority));

  const raw = buildRawEmail({
    fromEmail: connection.account_ref,
    fromName: `${(await getCompanySettings()).company_name} Support`,
    to: agent.email,
    replyTo: agent.email,
    subject,
    bodyText: renderAssignmentText(context),
    bodyHtml: renderAssignmentHtml(context),
    messageId,
    // Escalations pass neither, so Gmail cannot file them back into the
    // thread they exist to escape.
    inReplyTo: root?.messageId ?? null,
    references: root ? [root.messageId] : undefined,
    extraHeaders: { ...NOTIFICATION_HEADERS },
  });

  try {
    const accessToken = await getAccessToken(connection.id);
    await sendGmailMessage(accessToken, { raw });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[notifications] ${kind} send failed for ${agentId}:`, message);
    return { sent: false, error: message };
  }

  await admin.from("notifications").insert({
    agent_id: agentId,
    ticket_id: ticketId,
    kind,
    thread_message_id: root?.messageId ?? (kind === "reminder" ? messageId : null),
    subject: root?.subject ?? subject,
    escalation_count: escalation?.count ?? 0,
    sent_at: new Date().toISOString(),
  });

  return { sent: true };
}
