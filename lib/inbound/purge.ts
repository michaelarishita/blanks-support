import { createAdminClient } from "@/lib/supabase/admin";
import { JUNK_RETENTION_DAYS } from "@/lib/inbound/junk";

/**
 * Purges junk older than the retention window.
 *
 * Junk is filed, not deleted — but it does not live forever, or the folder
 * becomes the landfill this feature exists to replace. After the window the
 * ticket is DELETED (its messages, events and tags cascade); the storage
 * folder is left orphaned and collected by the daily deleted-ticket sweep that
 * runs in the same cron, so no new sweep is needed.
 *
 * What SURVIVES the purge on purpose: the spam_corrections rows. Their
 * ticket_id FK is `on delete set null`, and they snapshot the message text —
 * so the eval corpus outlives the tickets it was built from, which is the whole
 * reason the snapshot exists.
 *
 * The count is returned so the cron can report it: a purge nobody can see is
 * indistinguishable from one that silently stopped running.
 */

const MAX_PER_RUN = 500;

export interface JunkPurgeReport {
  purged: number;
  numbers: number[];
  hitCap: boolean;
  error: string | null;
}

export async function purgeExpiredJunk(
  now = Date.now()
): Promise<JunkPurgeReport> {
  const admin = createAdminClient();
  const cutoff = new Date(now - JUNK_RETENTION_DAYS * 86_400_000).toISOString();

  // junked_at is always stamped by the code that files junk; last_message_at is
  // the fallback for any legacy row that somehow carries none, so such a row is
  // still eligible rather than immortal.
  const { data: expired, error } = await admin
    .from("tickets")
    .select("id, number")
    .eq("status", "junk")
    .or(`junked_at.lt.${cutoff},and(junked_at.is.null,last_message_at.lt.${cutoff})`)
    .limit(MAX_PER_RUN);
  if (error) return { purged: 0, numbers: [], hitCap: false, error: error.message };
  if (!expired?.length) return { purged: 0, numbers: [], hitCap: false, error: null };

  const ids = expired.map((t) => t.id);
  const { error: deleteError } = await admin.from("tickets").delete().in("id", ids);
  if (deleteError) {
    return { purged: 0, numbers: [], hitCap: false, error: deleteError.message };
  }

  return {
    purged: ids.length,
    numbers: expired.map((t) => t.number),
    hitCap: ids.length === MAX_PER_RUN,
    error: null,
  };
}
