"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { disconnectAgent } from "@/lib/google/tokens";
import { deliverPendingMessages } from "@/lib/google/outbound";

export async function disconnectGmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  try {
    // An agent can only ever disconnect their own mailbox — the id comes from
    // the verified session, never from the client.
    await disconnectAgent(user.id);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not disconnect" };
  }

  revalidatePath("/settings");
  return { ok: true };
}

export interface FlushResult {
  error?: string;
  attempted: number;
  sent: number;
  failures: { ticketNumber: number | null; error: string }[];
}

const emptyFlush = (error: string): FlushResult => ({
  error,
  attempted: 0,
  sent: 0,
  failures: [],
});

/**
 * Retries every public reply still sitting in queued or failed state — the
 * Phase 1 backlog, plus anything a later outage left behind.
 */
export async function sendQueuedReplies(): Promise<FlushResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return emptyFlush("Not authenticated");

  // This sends mail on behalf of other agents, so keep it to admins.
  const { data: me } = await supabase
    .from("agents")
    .select("role, is_active")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin" || !me.is_active) {
    return emptyFlush("Only admins can send the queued backlog");
  }

  let result;
  try {
    result = await deliverPendingMessages();
  } catch (e) {
    return emptyFlush(
      e instanceof Error ? e.message : "Could not send queued replies"
    );
  }

  revalidatePath("/settings");
  revalidatePath("/inbox");
  return result;
}
