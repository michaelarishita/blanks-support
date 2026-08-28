import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { sendUnassignedDigest } from "@/lib/notifications/unassigned-send";
import { createAdminClient } from "@/lib/supabase/admin";
import { decideEscalation } from "@/lib/notifications/escalation";
import { decideSendTime } from "@/lib/notifications/policy";
import {
  sendAssignmentNotification,
  sendEscalationNotification,
  sendReminderNotification,
} from "@/lib/notifications/send";
import type { TicketPriority, TicketStatus } from "@/lib/types";

/**
 * Every 10 minutes: drain due notifications, then evaluate escalations.
 *
 * Idempotent. Rows are claimed by stamping sent_at BEFORE the send, so a
 * double-run — or an overlapping run — can't send the same reminder twice.
 * A send that then fails is logged and left claimed rather than retried
 * forever; the escalation ladder still covers a genuinely unanswered ticket.
 */
export const dynamic = "force-dynamic";

const MAX_PER_RUN = 50;

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const admin = createAdminClient();
  const now = new Date();
  const result = {
    remindersSent: 0,
    deferredAssignmentsSent: 0,
    escalationsSent: 0,
    escalationsToAdmin: 0,
    deferredAgain: 0,
    failures: [] as string[],
    unassignedDigest: null as Awaited<ReturnType<typeof sendUnassignedDigest>> | null,
  };

  // The daily unassigned digest rides this ten-minute job rather than taking a
  // cron entry of its own. Two reasons, and neither is laziness: a new cron is
  // one more thing that can be silently absent, and the send is gated on the
  // LOCAL DATE rather than on a firing — so a missed tick catches up on the
  // next one instead of skipping the day, which is how a digest stops arriving
  // with nothing reporting a failure.
  try {
    result.unassignedDigest = await sendUnassignedDigest({ now });
    if (result.unassignedDigest.error) {
      console.error("[cron] unassigned digest failed:", result.unassignedDigest.error);
    }
  } catch (e) {
    // Never the thing that stops reminders and escalations going out.
    console.error("[cron] unassigned digest threw:", e);
  }

  // ---- 1. Anything due: reminders the agent set, and assignments that were
  //         deferred out of quiet hours.
  const { data: due } = await admin
    .from("notifications")
    .select("id, agent_id, ticket_id, kind, scheduled_for")
    .is("sent_at", null)
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", now.toISOString())
    .limit(MAX_PER_RUN);

  for (const row of due ?? []) {
    const { data: ticket } = await admin
      .from("tickets")
      .select("status, priority, assignee_id")
      .eq("id", row.ticket_id)
      .maybeSingle();

    // The ticket may have been resolved, or handed on, since it was queued.
    if (!ticket || ticket.assignee_id !== row.agent_id) {
      await admin.from("notifications").delete().eq("id", row.id);
      continue;
    }
    if (["resolved", "closed"].includes(ticket.status as string)) {
      await admin.from("notifications").delete().eq("id", row.id);
      continue;
    }

    // Still inside quiet hours (a 3am reminder request lands here) — push it
    // to the next window rather than sending.
    const decision = decideSendTime(ticket.priority as TicketPriority, now);
    if (!decision.sendNow && decision.scheduledFor) {
      await admin
        .from("notifications")
        .update({ scheduled_for: decision.scheduledFor.toISOString() })
        .eq("id", row.id);
      result.deferredAgain++;
      continue;
    }

    // Claim before sending: two overlapping runs must not both send.
    const { data: claimed } = await admin
      .from("notifications")
      .update({ sent_at: now.toISOString() })
      .eq("id", row.id)
      .is("sent_at", null)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    const sent =
      row.kind === "reminder"
        ? await sendReminderNotification(row.ticket_id, row.agent_id)
        : await sendAssignmentNotification(row.ticket_id, row.agent_id);

    if (sent.error) result.failures.push(`${row.kind} ${row.id}: ${sent.error}`);
    else if (row.kind === "reminder") result.remindersSent++;
    else result.deferredAssignmentsSent++;
  }

  // ---- 2. Escalations for assigned, unanswered tickets.
  const { data: candidates } = await admin
    .from("tickets")
    .select("id, priority, status, assignee_id")
    .not("assignee_id", "is", null)
    .not("status", "in", "(resolved,closed,pending)")
    .limit(MAX_PER_RUN);

  for (const ticket of candidates ?? []) {
    const agentId = ticket.assignee_id as string;

    const { data: lastCustomer } = await admin
      .from("messages")
      .select("created_at")
      .eq("ticket_id", ticket.id)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: history } = await admin
      .from("notifications")
      .select("kind, scheduled_for, sent_at, escalation_count")
      .eq("ticket_id", ticket.id)
      .eq("agent_id", agentId);

    const rows = history ?? [];
    const escalationCount = rows.filter((r) => r.kind === "escalation").length;
    const pendingReminder = rows.find(
      (r) => r.kind === "reminder" && !r.sent_at && r.scheduled_for
    );

    const decision = decideEscalation({
      priority: ticket.priority as TicketPriority,
      status: ticket.status as TicketStatus,
      lastCustomerMessageAt: (lastCustomer?.created_at as string) ?? null,
      escalationCount,
      pendingReminderAt: (pendingReminder?.scheduled_for as string) ?? null,
      now: now.getTime(),
    });
    if (!decision.escalate) continue;

    // Quiet hours apply to escalations too — except Urgent.
    const timing = decideSendTime(ticket.priority as TicketPriority, now);
    if (!timing.sendNow) continue;

    const sent = await sendEscalationNotification(
      ticket.id,
      agentId,
      decision.overdueHours,
      decision.nextCount
    );
    if (sent.error) result.failures.push(`escalation ${ticket.id}: ${sent.error}`);
    else if (decision.toAdmin) result.escalationsToAdmin++;
    else result.escalationsSent++;
  }

  return Response.json({ ok: true, ...result });
}
