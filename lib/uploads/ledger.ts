import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The record of every upload we invited, and what became of it.
 *
 * Written because a customer's photo went missing and the honest answer to
 * "was an upload URL even issued?" was that nobody could tell — not that the
 * number was bad, that it did not exist. The temp object is deleted on claim
 * and swept after 24h, and the only trace of a failed browser PUT was a
 * console.error in the customer's own browser.
 *
 * Every function here is best-effort and never throws. Bookkeeping must not
 * be able to fail a customer's submission — an unrecorded upload is a gap in
 * a report; a 500 is a person who could not reach us.
 */

export type GrantOutcome = "stored" | "rejected" | "missing" | "expired";

/** One row per signed URL handed out. */
export async function recordGrantIssued(input: {
  storagePath: string;
  originalName: string;
  declaredBytes: number;
  ip: string;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("upload_grants").insert({
      storage_path: input.storagePath,
      original_name: input.originalName.slice(0, 200),
      declared_bytes: input.declaredBytes,
      issued_ip: input.ip,
    });
    if (error) console.error("[uploads] could not record grant:", error.message);
  } catch (e) {
    console.error("[uploads] could not record grant:", e);
  }
}

/**
 * What became of one grant.
 *
 * Conditional on `resolved_at is null`, so a redelivery or a replayed grant
 * cannot rewrite a verdict already reached — the first answer is the true one
 * and a later "missing" must not overwrite an earlier "stored".
 */
export async function resolveGrant(
  storagePath: string,
  outcome: GrantOutcome,
  detail?: string | null
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("upload_grants")
      .update({
        resolved_at: new Date().toISOString(),
        outcome,
        detail: detail ? detail.slice(0, 500) : null,
      })
      .eq("storage_path", storagePath)
      .is("resolved_at", null);
    if (error) console.error("[uploads] could not resolve grant:", error.message);
  } catch (e) {
    console.error("[uploads] could not resolve grant:", e);
  }
}

/** Links the ledger row to the attachment it became. */
export async function linkGrantToAttachment(
  storagePath: string,
  attachmentId: string
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin
      .from("upload_grants")
      .update({ attachment_id: attachmentId })
      .eq("storage_path", storagePath);
  } catch (e) {
    console.error("[uploads] could not link grant:", e);
  }
}
