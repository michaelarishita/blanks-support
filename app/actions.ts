"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import type { TicketStatus } from "@/lib/types";

async function requireAgent() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  return { supabase, userId: user.id };
}

async function logEvent(
  supabase: ReturnType<typeof createClient>,
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

export async function sendReply(ticketId: string, body: string, isNote: boolean) {
  const { supabase, userId } = await requireAgent();
  const text = body.trim();
  if (!text) return { error: "Empty message" };

  const { error } = await supabase.from("messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    type: isNote ? "internal_note" : "public",
    agent_id: userId,
    body_text: text,
    // Phase 1: replies are stored + shown in-thread. Phase 2 wires Gmail
    // sending and flips this to queued → sent.
    delivery_status: isNote ? "stored" : "queued",
  });
  if (error) return { error: error.message };

  if (!isNote) {
    // A public reply usually means we're waiting on the customer.
    await supabase
      .from("tickets")
      .update({ status: "pending" })
      .eq("id", ticketId)
      .in("status", ["new", "open"]);
  } else {
    await logEvent(supabase, ticketId, userId, "note_added");
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/inbox");
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
  const { error } = await supabase
    .from("tickets")
    .update({ assignee_id: assigneeId })
    .eq("id", ticketId);
  if (error) return { error: error.message };

  await logEvent(supabase, ticketId, userId, "assigned", {
    assignee_id: assigneeId,
  });
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/inbox");
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
