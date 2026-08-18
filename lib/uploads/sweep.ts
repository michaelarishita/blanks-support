import { createAdminClient } from "@/lib/supabase/admin";
import { INTAKE_PREFIX } from "./grant";

/**
 * Deletes intake uploads that were never claimed by a submission.
 *
 * Direct-to-storage uploads mean a customer can put bytes in the bucket and
 * then close the tab, and nothing downstream would ever know. Without this,
 * the abandoned half of every abandoned form stays forever — on a public
 * endpoint that is a slow storage leak with no upper bound.
 *
 * Only touches `intake/`, which is the only prefix a signed grant can name.
 * Attachments that made it onto a ticket live under `<ticketId>/…` and are
 * never visible to this sweep — the two namespaces are what makes it safe to
 * delete by age alone.
 */

/** Comfortably past the 1h grant TTL, so nothing in flight is ever hit. */
export const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Bounded so one run can't spend the whole invocation deleting. */
const MAX_PER_RUN = 500;

export interface SweepResult {
  scanned: number;
  deleted: number;
  error?: string;
}

export async function sweepOrphanedUploads(
  now = Date.now(),
  maxAgeMs = ORPHAN_MAX_AGE_MS
): Promise<SweepResult> {
  const admin = createAdminClient();

  // Trailing slash trimmed: Supabase's list() takes a folder, not a prefix.
  const folder = INTAKE_PREFIX.replace(/\/$/, "");
  const { data, error } = await admin.storage
    .from("attachments")
    .list(folder, { limit: MAX_PER_RUN, sortBy: { column: "created_at", order: "asc" } });

  if (error) return { scanned: 0, deleted: 0, error: error.message };

  const objects = data ?? [];
  const cutoff = now - maxAgeMs;

  const stale = objects
    .filter((object) => {
      const stamp = object.created_at ?? object.updated_at;
      if (!stamp) return false;
      const at = new Date(stamp).getTime();
      // A missing or unparseable timestamp is left alone. Deleting on "we
      // couldn't tell how old it is" is the wrong default for the one
      // operation here that cannot be undone.
      return Number.isFinite(at) && at < cutoff;
    })
    .map((object) => `${folder}/${object.name}`);

  if (!stale.length) return { scanned: objects.length, deleted: 0 };

  const { error: removeError } = await admin.storage
    .from("attachments")
    .remove(stale);
  if (removeError) {
    return { scanned: objects.length, deleted: 0, error: removeError.message };
  }

  return { scanned: objects.length, deleted: stale.length };
}
