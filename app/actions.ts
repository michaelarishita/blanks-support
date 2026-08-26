"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { ActionResult, TicketStatus } from "@/lib/types";
import { canEmail, deliverMessage, resolveSender } from "@/lib/google/outbound";
import { htmlToPlainText, sanitizeRichText } from "@/lib/html";
import { syncSupportMailboxThrottled } from "@/lib/google/inbound";
import { sendAssignmentNotification } from "@/lib/notifications/send";
import { STATUSES_AWAITING_AGENT } from "@/lib/ticket-status";
import {
  currentReplyWindow,
  deliverMetaMessage,
  isMetaChannel,
} from "@/lib/meta/outbound";
import { describeWindow } from "@/lib/meta/window";
import { humanizePostgresError } from "@/lib/supabase/errors";

async function requireAgent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  return { supabase, userId: user.id };
}

async function logEvent(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ticketId: string,
  agentId: string,
  eventType: string,
  detail: Record<string, unknown> = {}
) {
  await supabase.from("ticket_events").insert({
    ticket_id: ticketId,
    agent_id: agentId,
    event_type: eventType,
    detail,
  });
}

export async function sendReply(
  ticketId: string,
  /** HTML from the composer — never trusted, sanitized here before storage. */
  bodyHtml: string,
  isNote: boolean
) {
  const { supabase, userId } = await requireAgent();

  const html = sanitizeRichText(bodyHtml);
  // The plain-text rendering is the canonical body: it's what the thread
  // falls back to, what search will index, and the text/plain email part.
  const text = htmlToPlainText(html);
  if (!text.trim()) return { error: "Empty message" };

  // Decide up front whether this reply goes out as email, and bail before
  // storing anything if it can't — otherwise a missing Gmail connection would
  // swallow the agent's draft into a thread as an undeliverable message.
  let willEmail = false;
  let willSendSocial = false;
  let unassigned = false;
  if (!isNote) {
    const { data: ticket } = await supabase
      .from("tickets")
      .select("channel, assignee_id, customer:customers(email)")
      .eq("id", ticketId)
      .single();
    unassigned = !ticket?.assignee_id;
    const customer = Array.isArray(ticket?.customer)
      ? ticket.customer[0]
      : ticket?.customer;
    willEmail = canEmail(ticket?.channel ?? "", customer?.email);
    if (willEmail && !(await resolveSender(userId))) {
      return {
        error:
          "Connect your Gmail in Settings before replying to email tickets.",
      };
    }

    willSendSocial = isMetaChannel(ticket?.channel ?? "");
    if (willSendSocial) {
      // Blocked BEFORE storing, exactly like the missing-Gmail case. Meta
      // will refuse a send outside its window, and a reply that sits in the
      // thread looking sent while the customer never received it is the worst
      // available outcome — worse than not being able to write it.
      const window = await currentReplyWindow(ticketId);
      if (!window.canSend) return { error: describeWindow(window) };
    }
  }

  const { data: inserted, error } = await supabase
    .from("messages")
    .insert({
      ticket_id: ticketId,
      direction: "outbound",
      type: isNote ? "internal_note" : "public",
      agent_id: userId,
      body_text: text,
      body_html: html,
      delivery_status:
        isNote || (!willEmail && !willSendSocial) ? "stored" : "queued",
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  // Send inline: an agent needs to know immediately whether their reply
  // actually left the building.
  let deliveryError: string | null = null;
  if (inserted && (willEmail || willSendSocial)) {
    // One or the other, never both: a ticket has one channel.
    const result = willSendSocial
      ? await deliverMetaMessage(inserted.id)
      : await deliverMessage(inserted.id);
    if (!result.ok) deliveryError = result.error;
  }

  // Answering an unowned ticket claims it. Deliberately does NOT reassign a
  // ticket that already has an owner — replying to someone else's ticket
  // shouldn't silently take it off them.
  let claimed = false;
  if (!isNote && unassigned) {
    const { error: claimError } = await supabase
      .from("tickets")
      .update({ assignee_id: userId })
      .eq("id", ticketId)
      .is("assignee_id", null);

    if (!claimError) {
      claimed = true;
      await logEvent(supabase, ticketId, userId, "auto_assigned", {
        reason: "replied to an unassigned ticket",
      });
      // No assignment notification here: they just replied to it, so mailing
      // them about it would be noise.
    }
  }

  if (!isNote) {
    // A public reply moves the ticket to "waiting on customer". This is the
    // only place `pending` is set by hand, and 6E's escalation suppression
    // depends on it — the status list comes from lib/ticket-status so the
    // rule and its tests share one source.
    await supabase
      .from("tickets")
      .update({ status: "pending" })
      .eq("id", ticketId)
      .in("status", STATUSES_AWAITING_AGENT);
  } else {
    await logEvent(supabase, ticketId, userId, "note_added");
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/inbox");
  // The reply is saved and visible either way, so this is a warning rather
  // than an error — the draft must be cleared to avoid a duplicate send, but
  // the agent still needs to know the customer hasn't received it.
  if (deliveryError) {
    return {
      ok: true,
      claimed,
      warning: `Saved, but the email didn't send: ${deliveryError}`,
    };
  }
  return { ok: true, claimed };
}

/** Re-attempts delivery of a reply that failed to send. */
export async function retryDelivery(messageId: string) {
  const { supabase } = await requireAgent();

  // Read through the agent's own client so RLS decides visibility before we
  // hand the id to the service-role delivery path.
  const { data: message } = await supabase
    .from("messages")
    .select("id, ticket_id")
    .eq("id", messageId)
    .single();
  if (!message) return { error: "Message not found" };

  const result = await deliverMessage(messageId);
  revalidatePath(`/tickets/${message.ticket_id}`);
  revalidatePath("/inbox");

  if (!result.ok) return { error: result.error };
  return { ok: true };
}

export async function setStatus(ticketId: string, status: TicketStatus) {
  const { supabase, userId } = await requireAgent();
  const { error } = await supabase
    .from("tickets")
    .update({ status })
    .eq("id", ticketId);
  if (error) return { error: error.message };

  await logEvent(supabase, ticketId, userId, "status_changed", { status });
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

export async function assignTicket(ticketId: string, assigneeId: string | null) {
  const { supabase, userId } = await requireAgent();

  // Read the current owner first: the notification must fire on a CHANGE, not
  // on every save. Re-assigning a ticket to whoever already holds it is a
  // no-op, and mailing them about it would train people to ignore these.
  const { data: before } = await supabase
    .from("tickets")
    .select("assignee_id")
    .eq("id", ticketId)
    .maybeSingle();
  const previousAssignee = before?.assignee_id ?? null;

  const { error } = await supabase
    .from("tickets")
    .update({ assignee_id: assigneeId })
    .eq("id", ticketId);
  if (error) return { error: error.message };

  await logEvent(supabase, ticketId, userId, "assigned", {
    assignee_id: assigneeId,
  });

  // Self-assignment still notifies: the spec is explicit that assigning
  // yourself a ticket should still produce the record.
  let notificationWarning: string | undefined;
  if (assigneeId && assigneeId !== previousAssignee) {
    const result = await sendAssignmentNotification(ticketId, assigneeId);
    // The assignment itself succeeded, so this is a warning rather than an
    // error — but it is SURFACED. Logging it to the server console was how a
    // schema failure hid for days: the UI said "Assigned to Melissa" while no
    // mail had been sent and nothing on screen said so.
    if (result.error) {
      notificationWarning = `Assigned, but the notification email failed: ${result.error}`;
      console.error("[assign] notification failed:", result.error);
    } else if (result.skipped) {
      notificationWarning = `Assigned. No email sent — ${result.skipped}.`;
    }
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/inbox");
  return notificationWarning ? { ok: true, warning: notificationWarning } : { ok: true };
}

/**
 * Marks a risk flag as reviewed.
 *
 * The score and reasons are KEPT — only the dismissal is recorded. Clearing
 * them would make "someone looked at this and judged it fine" indistinguish-
 * able from "this was never flagged", and the first of those is exactly the
 * evidence needed to tune the signals later.
 */
export async function dismissRiskFlag(ticketId: string): Promise<ActionResult> {
  const { supabase, userId } = await requireAgent();

  const { error } = await supabase
    .from("tickets")
    .update({
      risk_dismissed_at: new Date().toISOString(),
      risk_dismissed_by: userId,
    })
    .eq("id", ticketId);
  if (error) return { error: error.message };

  await logEvent(supabase, ticketId, userId, "risk_dismissed");

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

/**
 * "I'm on it" — recorded, not merely hidden.
 *
 * Acknowledging stores who and when, so an alert that everyone ignored stays
 * distinguishable from one somebody handled. It is not a mute either: the
 * partial unique index only covers UNacknowledged rows, so if the condition
 * recurs the next heartbeat raises a fresh alert with its own count.
 */
export async function acknowledgeSystemAlert(alertId: string): Promise<ActionResult> {
  const { supabase, userId } = await requireAgent();

  const { error } = await supabase
    .from("system_alerts")
    .update({
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: userId,
    })
    .eq("id", alertId)
    .is("acknowledged_at", null);
  if (error) {
    return { error: humanizePostgresError(error, "Could not acknowledge that alert.") };
  }

  revalidatePath("/inbox", "layout");
  return { ok: true };
}

export async function toggleTag(ticketId: string, tagId: string, on: boolean) {
  const { supabase, userId } = await requireAgent();
  if (on) {
    await supabase.from("ticket_tags").insert({ ticket_id: ticketId, tag_id: tagId });
    await logEvent(supabase, ticketId, userId, "tagged", { tag_id: tagId });
  } else {
    await supabase
      .from("ticket_tags")
      .delete()
      .eq("ticket_id", ticketId)
      .eq("tag_id", tagId);
    await logEvent(supabase, ticketId, userId, "untagged", { tag_id: tagId });
  }
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/inbox");
  return { ok: true };
}

export async function setPriority(ticketId: string, priority: string) {
  const { supabase, userId } = await requireAgent();
  const { error } = await supabase
    .from("tickets")
    .update({ priority })
    .eq("id", ticketId);
  if (error) return { error: error.message };
  await logEvent(supabase, ticketId, userId, "priority_changed", { priority });
  revalidatePath(`/tickets/${ticketId}`);
  return { ok: true };
}


/**
 * Background inbox refresh, called when the dashboard mounts and on a light
 * interval while a session is open. Throttled server-side, so several agents
 * with the dashboard open do not multiply into several syncs a minute.
 */
export async function autoSyncInbox() {
  await requireAgent();

  const result = await syncSupportMailboxThrottled();
  const imported = result.created + result.appended;
  if (imported > 0) {
    revalidatePath("/inbox");
  }
  return {
    imported,
    throttled: Boolean(result.throttled),
    error: result.error,
  };
}
