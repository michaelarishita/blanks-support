import { createAdminClient } from "@/lib/supabase/admin";

// One per-agent cadence for ALL notification kinds (Prompt 34).
//
//   immediate — every event emails as it happens (the pre-0028 behaviour)
//   daily     — folded into ONE digest at the agent's chosen hour; nothing else
//               emails EXCEPT an urgent ticket assigned directly to the agent
//   off       — no notification email at all
//
// One setting rather than one-per-kind on purpose: the whole complaint is too
// many knobs and too much mail. `notification_frequency` is authoritative; the
// legacy `notifications_enabled` boolean is only consulted as a fallback for
// the window where the code has deployed but 0028 has not yet been applied by
// hand — the column is simply absent then, and a hard failure there would stop
// every assignment email for everyone.

export type NotificationMode = "immediate" | "daily" | "off";

export interface NotificationPrefRow {
  notifications_enabled?: boolean | null;
  notification_frequency?: NotificationMode | null;
}

/**
 * Pure mapping. `notification_frequency` wins when present; otherwise fall back
 * to the legacy boolean (false -> off, else immediate). Pure so the mapping is
 * testable without a database.
 */
export function notificationMode(row: NotificationPrefRow): NotificationMode {
  if (row.notification_frequency) return row.notification_frequency;
  return row.notifications_enabled === false ? "off" : "immediate";
}

/**
 * Whether a per-event email should go out NOW for this agent, given their mode
 * and the event.
 *
 * The urgent carve-out lives here so every caller agrees on it: an urgent
 * ticket assigned directly to a person stays immediate even on `daily`, because
 * the digest would mean up to a day's delay on the one thing that can't wait.
 * `off` always means off — the escalation ladder (which ends at an admin) still
 * catches an ignored urgent ticket, so nothing falls on the floor.
 */
export function shouldEmailNow(
  mode: NotificationMode,
  event: {
    kind: "assignment" | "reassignment" | "reminder" | "escalation" | "new_ticket";
    priority?: "low" | "normal" | "high" | "urgent";
    /** True when this is a direct, personal assignment to the recipient. */
    directAssignment?: boolean;
  }
): boolean {
  if (mode === "off") return false;
  if (mode === "immediate") return true;

  // mode === "daily": everything folds into the digest, with one exception.
  if (
    event.kind === "assignment" &&
    event.directAssignment &&
    event.priority === "urgent"
  ) {
    return true;
  }
  // A reminder is something the agent explicitly asked for at a set time;
  // folding it into tomorrow's digest defeats the request. It still fires on
  // `daily` (but never on `off`).
  if (event.kind === "reminder") return true;
  return false;
}

/**
 * Reads one agent's mode, tolerant of 0028 not yet being applied.
 *
 * Tries the new column; if the column does not exist yet (PostgREST 42703 /
 * PGRST204), falls back to a select of the legacy boolean alone. So a deploy
 * that lands before the hand-run migration degrades to today's behaviour
 * rather than erroring on every send.
 */
export async function loadNotificationMode(agentId: string): Promise<NotificationMode> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agents")
    .select("notification_frequency, notifications_enabled")
    .eq("id", agentId)
    .maybeSingle();

  if (!error) return notificationMode((data ?? {}) as NotificationPrefRow);

  // Column not there yet — fall back to the legacy boolean.
  const { data: legacy } = await admin
    .from("agents")
    .select("notifications_enabled")
    .eq("id", agentId)
    .maybeSingle();
  return notificationMode((legacy ?? {}) as NotificationPrefRow);
}
