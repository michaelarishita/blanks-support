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

/** A folder name is a ticket id. Anything else is not ours to reason about. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FolderSweepPlan {
  remove: string[];
  keep: string[];
  /** Names we refused to classify, with the reason. */
  ignored: { folder: string; reason: string }[];
}

/**
 * Decides which per-ticket folders are unreachable.
 *
 * PURE, because this is the one operation in the app that destroys customer
 * data and cannot be undone. The decision is worth being able to test
 * exhaustively without a bucket.
 *
 * The signal is deliberately NOT age. It is whether the ticket still exists:
 * intake creates the ticket row BEFORE uploading anything under it, so a
 * folder with no ticket can never be an upload in flight. An age heuristic
 * would have a window where a live attachment looks abandoned; this has none.
 *
 * `intake/` is excluded — it has its own time-based rule, because those
 * uploads legitimately exist before any ticket does.
 */
export function planFolderSweep({
  folders,
  existingTicketIds,
}: {
  folders: string[];
  existingTicketIds: Set<string>;
}): FolderSweepPlan {
  const plan: FolderSweepPlan = { remove: [], keep: [], ignored: [] };

  for (const folder of folders) {
    if (folder === INTAKE_PREFIX.replace(/\/$/, "")) {
      plan.ignored.push({ folder, reason: "intake, swept by age instead" });
      continue;
    }
    if (!UUID.test(folder)) {
      // Something put a folder here that we did not. Left alone: deleting
      // things we cannot explain is how a sweep becomes an incident.
      plan.ignored.push({ folder, reason: "not a ticket id" });
      continue;
    }
    if (existingTicketIds.has(folder)) {
      plan.keep.push(folder);
      continue;
    }
    plan.remove.push(folder);
  }

  return plan;
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

/** Bounded so one run cannot spend the whole invocation deleting. */
const MAX_FOLDERS_PER_RUN = 200;

/**
 * Removes per-ticket folders whose ticket no longer exists.
 *
 * Postgres deletes do not reach the storage bucket, so every deleted ticket
 * leaves its attachments behind — unreachable, un-listed anywhere in the app,
 * and still customer photographs. That is a retention problem before it is a
 * billing one, and it happens however the ticket went: through the app, or
 * through a hand-written DELETE in the SQL editor. Which is why this keys on
 * the absence of the ticket rather than on anything our code did.
 */
export async function sweepDeletedTicketFolders(): Promise<SweepResult> {
  const admin = createAdminClient();

  const { data, error } = await admin.storage
    .from("attachments")
    .list("", { limit: MAX_FOLDERS_PER_RUN });
  if (error) return { scanned: 0, deleted: 0, error: error.message };

  // Folders come back with a null id; files have one.
  const folders = (data ?? []).filter((entry) => entry.id === null).map((e) => e.name);
  if (!folders.length) return { scanned: 0, deleted: 0 };

  const candidates = folders.filter((f) => f !== "intake");
  if (!candidates.length) return { scanned: folders.length, deleted: 0 };

  const { data: tickets, error: ticketError } = await admin
    .from("tickets")
    .select("id")
    .in("id", candidates);

  // FAIL SAFE. A failed lookup makes every folder look orphaned, and acting
  // on that would delete every attachment in the product. Nothing is removed
  // unless we positively know which tickets exist.
  if (ticketError) {
    return { scanned: folders.length, deleted: 0, error: ticketError.message };
  }

  const plan = planFolderSweep({
    folders: candidates,
    existingTicketIds: new Set((tickets ?? []).map((t) => t.id as string)),
  });

  let deleted = 0;
  for (const folder of plan.remove) {
    // Two levels: <ticketId>/<messageId>/<file>. Listed rather than assumed,
    // because remove() takes exact paths.
    const paths: string[] = [];
    const { data: messageFolders } = await admin.storage
      .from("attachments")
      .list(folder, { limit: 100 });

    for (const messageFolder of messageFolders ?? []) {
      const { data: files } = await admin.storage
        .from("attachments")
        .list(`${folder}/${messageFolder.name}`, { limit: 100 });
      for (const file of files ?? []) {
        paths.push(`${folder}/${messageFolder.name}/${file.name}`);
      }
    }

    if (!paths.length) continue;
    const { error: removeError } = await admin.storage
      .from("attachments")
      .remove(paths);
    if (removeError) {
      console.error(`[uploads] could not remove ${folder}:`, removeError);
      continue;
    }
    deleted += paths.length;
  }

  return { scanned: folders.length, deleted };
}
