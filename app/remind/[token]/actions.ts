"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { verifyReminderToken } from "@/lib/notifications/reminder-token";

/**
 * Schedules the reminder. Reached only by an explicit POST from the
 * confirmation page — never as a side effect of following the link, because
 * mail clients and security scanners fetch links on delivery.
 */
export async function confirmReminder(token: string) {
  const result = verifyReminderToken(token);
  if (!result.ok) return { error: "This reminder link is no longer valid." };

  const { a: agentId, t: ticketId, d: hours } = result.payload;
  const admin = createAdminClient();
  const scheduledFor = new Date(Date.now() + hours * 3_600_000);

  // Idempotent by construction: one pending reminder per (agent, ticket).
  // Clicking twice reschedules rather than stacking, and a replayed link
  // simply re-sets the same time.
  const { error: clearError } = await admin
    .from("notifications")
    .delete()
    .eq("agent_id", agentId)
    .eq("ticket_id", ticketId)
    .eq("kind", "reminder")
    .is("sent_at", null);
  if (clearError) return { error: clearError.message };

  const { error } = await admin.from("notifications").insert({
    agent_id: agentId,
    ticket_id: ticketId,
    kind: "reminder",
    scheduled_for: scheduledFor.toISOString(),
    sent_at: null,
  });
  if (error) return { error: error.message };

  return { ok: true, scheduledFor: scheduledFor.toISOString() };
}

export async function cancelReminder(token: string) {
  const result = verifyReminderToken(token);
  if (!result.ok) return { error: "This reminder link is no longer valid." };

  const admin = createAdminClient();
  const { error } = await admin
    .from("notifications")
    .delete()
    .eq("agent_id", result.payload.a)
    .eq("ticket_id", result.payload.t)
    .eq("kind", "reminder")
    .is("sent_at", null);
  if (error) return { error: error.message };
  return { ok: true };
}
