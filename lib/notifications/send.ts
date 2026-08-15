import { createAdminClient } from "@/lib/supabase/admin";
import { buildRawEmail, generateMessageId } from "@/lib/email/mime";
import { sendGmailMessage } from "@/lib/google/gmail";
import { getAccessToken, getSupportInboxConnection } from "@/lib/google/tokens";
import { getCompanySettings } from "@/lib/settings";
import { customerDisplayName } from "@/lib/display";
import type { TicketChannel, TicketPriority } from "@/lib/types";
import {
  ASSIGNMENT_SUBJECT,
  renderAssignmentHtml,
  renderAssignmentText,
  type AssignmentContext,
  type QueueBreakdown,
} from "./assignment";
import { summarizeMessage } from "./summary";

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

export type NotificationKind = "assignment" | "reminder" | "escalation";

export interface NotificationResult {
  sent: boolean;
  skipped?: string;
  error?: string;
}

const OPEN_STATUSES = ["new", "open", "pending"];

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
 * The Message-ID that opened this (agent, ticket) conversation, if any.
 * Reminders and escalations reply into it so Gmail groups them.
 */
async function threadRoot(
  agentId: string,
  ticketId: string
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("notifications")
    .select("thread_message_id")
    .eq("agent_id", agentId)
    .eq("ticket_id", ticketId)
    .not("thread_message_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.thread_message_id as string | undefined) ?? null;
}

export async function sendAssignmentNotification(
  ticketId: string,
  agentId: string
): Promise<NotificationResult> {
  const admin = createAdminClient();

  const { data: agent, error: agentError } = await admin
    .from("agents")
    .select("id, name, email, is_active, notifications_enabled")
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
      "id, number, subject, priority, channel, topic, created_at, customer:customers(name, email), ticket_tags(tag:tags(name))"
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
    agentName: agent.name,
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

  const messageId = generateMessageId(connection.account_ref);
  const root = await threadRoot(agentId, ticketId);

  const raw = buildRawEmail({
    fromEmail: connection.account_ref,
    fromName: `${company.company_name} Support`,
    to: agent.email,
    // Never hello@: replying to a notification must not open a ticket.
    replyTo: agent.email,
    // Byte-identical across the thread — Gmail needs a stable subject as well
    // as the header chain to group reliably.
    subject: ASSIGNMENT_SUBJECT,
    bodyText: renderAssignmentText(context),
    bodyHtml: renderAssignmentHtml(context),
    messageId,
    inReplyTo: root,
    references: root ? [root] : undefined,
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
    thread_message_id: root ?? messageId,
    sent_at: new Date().toISOString(),
  });
  if (insertError) {
    // The mail is already gone; losing the record would break threading for
    // later reminders, so it's worth surfacing rather than swallowing.
    console.error("[notifications] could not record the send:", insertError);
  }

  return { sent: true };
}
