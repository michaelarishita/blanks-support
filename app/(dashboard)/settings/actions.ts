"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { disconnectAgent } from "@/lib/google/tokens";

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
