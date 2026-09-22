"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { syncAndClassify, type SyncResult } from "@/lib/personal-triage/store";
import { fetchInboxMessageBody } from "@/lib/personal-triage/gmail";
import { correctTriage } from "@/lib/personal-triage/corrections";
import type { Classification } from "@/lib/personal-triage/classifier";

// Server actions for the PRIVATE personal-triage view (Phase A).
//
// Every action re-authorises the caller AND requires admin — this is "me only"
// while it is an experiment. The data is owner-scoped by RLS regardless, but
// the actions must not run for anyone else. All owner ids come from the
// authenticated session, never from the client.

async function requireAdmin(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const { data: me } = await supabase
    .from("agents")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") throw new Error("Not authorised");
  return user.id;
}

/** Pulls recent inbox mail, classifies whatever is new, stores metadata only. */
export async function syncTriage(): Promise<SyncResult> {
  const ownerId = await requireAdmin();
  const result = await syncAndClassify(ownerId);
  revalidatePath("/triage");
  return result;
}

/** Fetches ONE message's body on demand. Never stored. */
export async function loadBody(
  gmailMessageId: string
): Promise<{ bodyText?: string; error?: string }> {
  const ownerId = await requireAdmin();
  try {
    const body = await fetchInboxMessageBody(ownerId, gmailMessageId);
    return { bodyText: body.bodyText };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not load the message." };
  }
}

/** Records a "the classifier was wrong" correction and flips the stored bucket. */
export async function correct(
  gmailMessageId: string,
  label: Classification
): Promise<{ correctionId?: string; error?: string }> {
  const ownerId = await requireAdmin();
  const res = await correctTriage(ownerId, gmailMessageId, label);
  revalidatePath("/triage");
  return res;
}
