import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildRawEmail,
  buildReplySubject,
  generateMessageId,
} from "@/lib/email/mime";
import { sendGmailMessage } from "./gmail";
import {
  getAccessToken,
  getConnectionForAgent,
  getSupportInboxConnection,
} from "./tokens";

// Delivery of a stored outbound message as real email.
// Shared by the reply action and the "send queued replies" backfill, so both
// paths behave identically. Server-only.

export type DeliveryResult =
  | { ok: true; skipped?: string }
  | { ok: false; error: string };

/**
 * Where customer replies should land. The agent sends from their own address,
 * but replying to that would drop the conversation into one person's personal
 * mailbox — which the inbound watch doesn't read. Reply-To routes it back to
 * the shared inbox instead.
 */
async function resolveReplyTo(): Promise<string | null> {
  if (process.env.SUPPORT_EMAIL) return process.env.SUPPORT_EMAIL;
  const support = await getSupportInboxConnection();
  return support?.account_ref ?? null;
}

/** True when the ticket can be answered by email at all. */
export function canEmail(channel: string, customerEmail: string | null | undefined) {
  return Boolean(customerEmail) && (channel === "email" || channel === "web_form");
}

/** Finds the Gmail connection to send this message through. */
export async function resolveSender(agentId: string | null) {
  if (agentId) {
    const own = await getConnectionForAgent(agentId);
    if (own) return own;
  }
  // Falls back to the shared mailbox so a reply from an agent who hasn't
  // connected their own Gmail still reaches the customer.
  return await getSupportInboxConnection();
}

export async function deliverMessage(messageId: string): Promise<DeliveryResult> {
  const admin = createAdminClient();

  const { data: message, error: loadError } = await admin
    .from("messages")
    .select(
      "id, ticket_id, direction, type, agent_id, body_text, delivery_status, agent:agents(id, name, email)"
    )
    .eq("id", messageId)
    .single();
  if (loadError || !message) return { ok: false, error: "Message not found" };

  if (message.direction !== "outbound" || message.type !== "public") {
    return { ok: true, skipped: "not a public reply" };
  }
  if (message.delivery_status === "sent") {
    return { ok: true, skipped: "already sent" };
  }

  const { data: ticket } = await admin
    .from("tickets")
    .select("id, number, subject, channel, gmail_thread_id, customer:customers(email, name)")
    .eq("id", message.ticket_id)
    .single();
  if (!ticket) return { ok: false, error: "Ticket not found" };

  // Supabase types embedded relations as arrays; these are to-one joins.
  const customer = (Array.isArray(ticket.customer)
    ? ticket.customer[0]
    : ticket.customer) as { email: string | null; name: string | null } | null;
  const agent = (Array.isArray(message.agent) ? message.agent[0] : message.agent) as
    | { id: string; name: string; email: string }
    | null;

  if (!canEmail(ticket.channel, customer?.email)) {
    return { ok: true, skipped: "ticket has no email address" };
  }

  const connection = await resolveSender(message.agent_id);
  if (!connection) {
    return {
      ok: false,
      error:
        "No Gmail connected. Connect your Gmail in Settings, or ask an admin to connect the support mailbox.",
    };
  }

  // Build the References chain from every message on the ticket that has a
  // known Message-ID, oldest first — that's what mail clients thread on.
  const { data: priorMessages } = await admin
    .from("messages")
    .select("rfc822_message_id, direction, created_at")
    .eq("ticket_id", ticket.id)
    .not("rfc822_message_id", "is", null)
    .order("created_at", { ascending: true });

  const chain = (priorMessages ?? [])
    .map((m) => m.rfc822_message_id as string)
    .filter(Boolean);

  // Keep the header bounded on long threads: RFC 5322 allows trimming the
  // middle as long as the first and most recent references survive.
  const references =
    chain.length > 20 ? [chain[0], ...chain.slice(-19)] : chain;

  const lastInbound = [...(priorMessages ?? [])]
    .reverse()
    .find((m) => m.direction === "inbound");
  const inReplyTo =
    (lastInbound?.rfc822_message_id as string | undefined) ??
    chain[chain.length - 1] ??
    null;

  const fromEmail = connection.account_ref;
  const rfcMessageId = generateMessageId(fromEmail);

  const raw = buildRawEmail({
    fromEmail,
    fromName: agent?.name ?? "Blanks Support",
    to: customer!.email!,
    replyTo: await resolveReplyTo(),
    subject: buildReplySubject(ticket.subject, ticket.number),
    bodyText: message.body_text,
    messageId: rfcMessageId,
    inReplyTo,
    references,
  });

  try {
    const accessToken = await getAccessToken(connection.id);
    const sent = await sendGmailMessage(accessToken, {
      raw,
      threadId: ticket.gmail_thread_id,
    });

    await admin
      .from("messages")
      .update({
        delivery_status: "sent",
        gmail_message_id: sent.id,
        rfc822_message_id: rfcMessageId,
      })
      .eq("id", message.id);

    // Remember the Gmail thread so later replies land in the same conversation.
    if (!ticket.gmail_thread_id && sent.threadId) {
      await admin
        .from("tickets")
        .update({ gmail_thread_id: sent.threadId })
        .eq("id", ticket.id);
    }

    return { ok: true };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const error =
      raw === "GMAIL_RECONNECT_REQUIRED"
        ? "Gmail access expired. Reconnect your Gmail in Settings."
        : raw;

    await admin
      .from("messages")
      .update({ delivery_status: "failed" })
      .eq("id", message.id);

    // messages has no column for the failure reason, so the detail lives in
    // the audit trail where the whole team can see it.
    await admin.from("ticket_events").insert({
      ticket_id: ticket.id,
      agent_id: message.agent_id,
      event_type: "reply_send_failed",
      detail: { message_id: message.id, error },
    });

    return { ok: false, error };
  }
}

/** Retries every reply left in queued/failed state. Used by the Settings backfill. */
export async function deliverPendingMessages(): Promise<{
  attempted: number;
  sent: number;
  failures: { ticketNumber: number | null; error: string }[];
}> {
  const admin = createAdminClient();
  const { data: pending } = await admin
    .from("messages")
    .select("id, ticket:tickets(number)")
    .eq("direction", "outbound")
    .eq("type", "public")
    .in("delivery_status", ["queued", "failed"])
    .order("created_at", { ascending: true });

  const failures: { ticketNumber: number | null; error: string }[] = [];
  let sent = 0;

  for (const row of pending ?? []) {
    const result = await deliverMessage(row.id);
    if (result.ok && !result.skipped) sent++;
    if (!result.ok) {
      const ticket = Array.isArray(row.ticket) ? row.ticket[0] : row.ticket;
      failures.push({
        ticketNumber: (ticket as { number: number } | null)?.number ?? null,
        error: result.error,
      });
    }
  }

  return { attempted: pending?.length ?? 0, sent, failures };
}
