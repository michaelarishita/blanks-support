import { createAdminClient } from "@/lib/supabase/admin";
import {
  assessVendorOutreach,
  VENDOR_JUNK_THRESHOLD,
} from "@/lib/vendor/outreach";
import {
  applyCorrectionOverride,
  domainOf,
  overrideTargetsFor,
} from "@/lib/senders/overrides";
import type { JunkReason } from "@/lib/types";

/**
 * Corrections — the two-way loop, and the record that is the asset.
 *
 * "Not spam" on a junked ticket sends it to the inbox, unassigned. "Mark as
 * spam" on a normal ticket sends it to Junk. BOTH write a spam_corrections row
 * that captures the message, the classifier's verdict AND score at the time,
 * who corrected it and when — the labelled eval set — and BOTH set an immediate
 * per-sender override so the very next message from them is filed the same way
 * without waiting for anyone to change a threshold.
 *
 * All writes go through the service-role client: the caller (a server action)
 * has already authorised the agent, and spam_corrections / sender overrides are
 * admin-written by design.
 */

type Admin = ReturnType<typeof createAdminClient>;

interface Snapshot {
  messageId: string | null;
  subject: string;
  bodyText: string;
  fromEmail: string | null;
  fromDomain: string | null;
  channel: string | null;
  score: number;
  likely: boolean;
  reasons: { code: string; label: string; weight: number }[];
}

/** The message + the classifier's verdict on it, at this moment. */
async function snapshotTicket(
  admin: Admin,
  ticketId: string
): Promise<Snapshot | null> {
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, channel, customer:customers(email)")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return null;

  const customer = (
    Array.isArray(ticket.customer) ? ticket.customer[0] : ticket.customer
  ) as { email: string | null } | null;
  const email = customer?.email ?? null;

  const { data: firstMessage } = await admin
    .from("messages")
    .select("id, body_text, bulk_marker")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const subject = (ticket.subject as string) ?? "";
  const bodyText = (firstMessage?.body_text as string | undefined) ?? "";
  const vendor = assessVendorOutreach({
    subject,
    bodyText,
    fromEmail: email,
    bulkMarker: (firstMessage?.bulk_marker as string | undefined) ?? null,
    shopifyCustomerFound: null,
    priorTicketCount: 0,
  });

  return {
    messageId: (firstMessage?.id as string | undefined) ?? null,
    subject,
    bodyText,
    fromEmail: email,
    fromDomain: domainOf(email),
    channel: (ticket.channel as string | null) ?? null,
    score: vendor.score,
    likely: vendor.likely,
    reasons: vendor.reasons,
  };
}

async function recordCorrection(
  admin: Admin,
  ticketId: string,
  agentId: string,
  label: "spam" | "not_spam",
  snapshot: Snapshot
): Promise<string | null> {
  const { data, error } = await admin
    .from("spam_corrections")
    .insert({
      ticket_id: ticketId,
      message_id: snapshot.messageId,
      subject: snapshot.subject,
      body_text: snapshot.bodyText,
      from_email: snapshot.fromEmail,
      from_domain: snapshot.fromDomain,
      channel: snapshot.channel,
      label,
      classifier_score: snapshot.score,
      classifier_likely: snapshot.likely,
      classifier_reasons: snapshot.reasons,
      corrected_by: agentId,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[corrections] could not record correction:", error.message);
    return null;
  }
  return data.id as string;
}

/** "Mark as spam" — a normal ticket to Junk, with the opposite label recorded. */
export async function markTicketAsSpam(
  ticketId: string,
  agentId: string
): Promise<{ error?: string; correctionId?: string }> {
  const admin = createAdminClient();
  const snapshot = await snapshotTicket(admin, ticketId);
  if (!snapshot) return { error: "Ticket not found." };

  const junkReason: JunkReason = {
    source: "manual",
    classifierScore: snapshot.score,
    classifierThreshold: VENDOR_JUNK_THRESHOLD,
    classifierReasons: snapshot.reasons,
  };

  const { error } = await admin
    .from("tickets")
    .update({
      status: "junk",
      junked_at: new Date().toISOString(),
      junk_reason: junkReason,
      // Junk is out of everyone's queue; an assignee on it is meaningless.
      assignee_id: null,
    })
    .eq("id", ticketId);
  if (error) return { error: error.message };

  const correctionId = await recordCorrection(admin, ticketId, agentId, "spam", snapshot);
  await applyCorrectionOverride(admin, {
    email: snapshot.fromEmail,
    label: "spam",
    ticketId,
    agentId,
  });
  await admin.from("ticket_events").insert({
    ticket_id: ticketId,
    agent_id: agentId,
    event_type: "marked_spam",
    detail: { classifier_score: snapshot.score, from: snapshot.fromEmail },
  });
  return { correctionId: correctionId ?? undefined };
}

/** "Not spam" — a junked ticket to the inbox, unassigned, with a not_spam label. */
export async function markTicketNotSpam(
  ticketId: string,
  agentId: string
): Promise<{ error?: string; correctionId?: string }> {
  const admin = createAdminClient();
  const snapshot = await snapshotTicket(admin, ticketId);
  if (!snapshot) return { error: "Ticket not found." };

  const { error } = await admin
    .from("tickets")
    .update({
      // Back to the inbox as unclaimed work — the safe destination for a
      // customer who should never have been junked.
      status: "open",
      assignee_id: null,
      junked_at: null,
      junk_reason: null,
    })
    .eq("id", ticketId);
  if (error) return { error: error.message };

  const correctionId = await recordCorrection(
    admin,
    ticketId,
    agentId,
    "not_spam",
    snapshot
  );
  await applyCorrectionOverride(admin, {
    email: snapshot.fromEmail,
    label: "not_spam",
    ticketId,
    agentId,
  });
  await admin.from("ticket_events").insert({
    ticket_id: ticketId,
    agent_id: agentId,
    event_type: "marked_not_spam",
    detail: { classifier_score: snapshot.score, from: snapshot.fromEmail },
  });
  return { correctionId: correctionId ?? undefined };
}

/**
 * Undo a correction: reverse the ticket, drop the override it created, and mark
 * the correction undone so it leaves the eval corpus.
 *
 * Reversing the OVERRIDE matters as much as the ticket — an "undo" that left the
 * sender still marked spam would keep junking their future mail, which is not
 * what undo means.
 */
export async function undoCorrection(
  correctionId: string,
  agentId: string
): Promise<{ error?: string; ticketId?: string }> {
  const admin = createAdminClient();
  const { data: correction, error } = await admin
    .from("spam_corrections")
    .select("id, ticket_id, from_email, label, undone_at")
    .eq("id", correctionId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!correction) return { error: "Correction not found." };
  if (correction.undone_at) return { error: "Already undone." };

  const ticketId = correction.ticket_id as string | null;
  const label = correction.label as "spam" | "not_spam";

  // Reverse the ticket. "Mark as spam" junked it → un-junk; "Not spam"
  // un-junked it → re-junk. The ticket may have moved on since (a reply, a
  // manual change); the update is unconditional here because undo is an
  // explicit instruction to put it back.
  if (ticketId) {
    if (label === "spam") {
      await admin
        .from("tickets")
        .update({ status: "open", junked_at: null, junk_reason: null })
        .eq("id", ticketId);
    } else {
      await admin
        .from("tickets")
        .update({
          status: "junk",
          junked_at: new Date().toISOString(),
          junk_reason: { source: "manual", classifierThreshold: VENDOR_JUNK_THRESHOLD },
          assignee_id: null,
        })
        .eq("id", ticketId);
    }
  }

  // Drop the override this correction set, so the sender reverts to default
  // handling. Scoped to the same label so a later, opposite correction on the
  // same sender is not clobbered.
  const targets = overrideTargetsFor(correction.from_email as string | null);
  const values = [targets.address, targets.domain].filter(Boolean) as string[];
  if (values.length) {
    await admin
      .from("sender_spam_overrides")
      .delete()
      .in("value", values)
      .eq("label", label);
  }

  await admin
    .from("spam_corrections")
    .update({ undone_at: new Date().toISOString(), undone_by: agentId })
    .eq("id", correctionId);

  if (ticketId) {
    await admin.from("ticket_events").insert({
      ticket_id: ticketId,
      agent_id: agentId,
      event_type: "correction_undone",
      detail: { label },
    });
  }
  return { ticketId: ticketId ?? undefined };
}
