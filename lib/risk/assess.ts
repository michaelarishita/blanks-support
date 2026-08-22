import { createAdminClient } from "@/lib/supabase/admin";
import { lookupByEmail } from "@/lib/shopify/orders";
import { REPEAT_WINDOW_MS, assessRisk, type RiskFacts } from "./signals";

/**
 * Gathers the facts and records the assessment.
 *
 * ADVISORY. Nothing here changes a ticket's status, assignee, priority or
 * anything else — it writes three columns nobody reads to make a decision.
 * The score and the reasons are stored together so precision can be checked
 * later against outcomes rather than argued about.
 *
 * Server-only. Never throws: a ticket that exists is worth more than a badge
 * on it, and this runs on the same path that receives customer mail.
 */

export async function assessTicketRisk(ticketId: string): Promise<void> {
  try {
    await run(ticketId);
  } catch (e) {
    console.error(`[risk] assessment failed for ${ticketId}:`, e);
  }
}

async function run(ticketId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, customer_id, created_at, customer:customers(email)")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return;

  const customer = (Array.isArray(ticket.customer) ? ticket.customer[0] : ticket.customer) as
    | { email: string | null }
    | null;
  const email = customer?.email ?? null;

  const { data: firstMessage } = await admin
    .from("messages")
    .select("id, body_text, reply_to_email")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const { count: attachmentCount } = firstMessage
    ? await admin
        .from("attachments")
        .select("id", { count: "exact", head: true })
        .eq("message_id", firstMessage.id)
    : { count: 0 };

  // Prior and recent tickets from the same customer, excluding this one.
  let priorTicketCount = 0;
  let recentTicketCount = 0;
  if (ticket.customer_id) {
    const { count: prior } = await admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", ticket.customer_id)
      .neq("id", ticketId)
      .lt("created_at", ticket.created_at);
    priorTicketCount = prior ?? 0;

    const since = new Date(
      new Date(ticket.created_at).getTime() - REPEAT_WINDOW_MS
    ).toISOString();
    const { count: recent } = await admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", ticket.customer_id)
      .neq("id", ticketId)
      .gte("created_at", since);
    recentTicketCount = recent ?? 0;
  }

  /**
   * null, not false, when the lookup cannot run.
   *
   * Shopify being unconfigured or having a bad afternoon must not read as
   * "no such customer" — that would flag every ticket in the inbox with the
   * most alarming signals we have.
   */
  let shopifyCustomerFound: boolean | null = null;
  if (email) {
    try {
      const context = await lookupByEmail(email);
      shopifyCustomerFound = context ? true : false;
    } catch (e) {
      console.warn(`[risk] Shopify lookup unavailable for ${ticketId}:`, e);
      shopifyCustomerFound = null;
    }
  }

  const facts: RiskFacts = {
    subject: ticket.subject ?? "",
    bodyText: (firstMessage?.body_text as string | undefined) ?? "",
    fromEmail: email,
    replyToEmail: (firstMessage?.reply_to_email as string | undefined) ?? null,
    hasAttachments: (attachmentCount ?? 0) > 0,
    shopifyCustomerFound,
    priorTicketCount,
    recentTicketCount,
  };

  const assessment = assessRisk(facts);

  await admin
    .from("tickets")
    .update({
      risk_score: assessment.score,
      risk_reasons: assessment.reasons,
      risk_assessed_at: new Date().toISOString(),
    })
    .eq("id", ticketId);

  if (assessment.flagged) {
    // Recorded in the audit trail as well as on the ticket, so the history
    // shows WHEN it was flagged and on what — a score edited later would
    // otherwise be indistinguishable from the original judgement.
    await admin.from("ticket_events").insert({
      ticket_id: ticketId,
      event_type: "risk_flagged",
      detail: { score: assessment.score, reasons: assessment.reasons },
    });
  }
}
