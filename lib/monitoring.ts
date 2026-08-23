import { createAdminClient } from "@/lib/supabase/admin";
import { getSettingsBlob, patchSettingsBlob } from "@/lib/settings";
import { getSupportInboxConnection } from "@/lib/google/tokens";

// Inbound-email health.
//
// This exists because a lapsed Gmail watch stops inbound mail with NO error:
// the mailbox keeps receiving, nothing throws, tickets just quietly stop
// appearing. Silence is indistinguishable from a quiet support day, so the
// only way to catch it is to assert that something should have happened by
// now and complain when it hasn't.

export const HEALTH_KEY = "inbound_health";

/** No inbound email at all for this long is suspicious. */
export const SILENCE_ALERT_HOURS = 24;
/** Renew well before expiry — warn while there's still time to act. */
export const WATCH_EXPIRY_WARN_HOURS = 48;
/** The history cursor should move as mail arrives. */
export const CURSOR_STALE_HOURS = 24;
/** Don't re-send the same alert more often than this. */
export const ALERT_COOLDOWN_HOURS = 6;

export interface InboundHealth {
  status: "healthy" | "degraded" | "unknown";
  reasons: string[];
  /**
   * What the last sync threw away, when it threw anything away.
   *
   * "No inbound email for 31h" and "31h of inbound email, all discarded by a
   * guard" produce the same silence in the tickets table and need completely
   * different fixes. Naming the drop counts in the alert is the difference
   * between a day of diagnosis and a glance.
   */
  recentlyDropped?: string | null;
  checkedAt: string | null;
  lastInboundAt: string | null;
  watchExpiresAt: string | null;
  lastHistoryId: string | null;
  /** When lastHistoryId was last observed to change. */
  historyChangedAt: string | null;
  lastAlertAt: string | null;
}

const EMPTY_HEALTH: InboundHealth = {
  status: "unknown",
  reasons: [],
  checkedAt: null,
  lastInboundAt: null,
  watchExpiresAt: null,
  lastHistoryId: null,
  historyChangedAt: null,
  lastAlertAt: null,
};

export async function readInboundHealth(): Promise<InboundHealth> {
  // Read-only and rendered in the dashboard chrome, so a failure here must
  // not blank the whole app. The cause isn't swallowed: SchemaBanner reports
  // a missing settings table directly, and the cron surfaces it too.
  let blob: Record<string, unknown>;
  try {
    blob = await getSettingsBlob();
  } catch (e) {
    console.error("[monitoring] could not read health state:", e);
    return { ...EMPTY_HEALTH };
  }
  const stored = (blob[HEALTH_KEY] ?? {}) as Partial<InboundHealth>;
  return { ...EMPTY_HEALTH, ...stored };
}

async function writeInboundHealth(health: InboundHealth): Promise<void> {
  await patchSettingsBlob({ [HEALTH_KEY]: health });
}

const hoursSince = (iso: string | null | undefined, now: number): number | null =>
  iso ? (now - new Date(iso).getTime()) / 3_600_000 : null;

const hoursUntil = (iso: string | null | undefined, now: number): number | null =>
  iso ? (new Date(iso).getTime() - now) / 3_600_000 : null;

export interface HealthInputs {
  now: number;
  /** Most recent inbound email message, if any. */
  lastInboundAt: string | null;
  /** Whether the support mailbox is connected at all. */
  connected: boolean;
  watchExpiresAt: string | null;
  lastHistoryId: string | null;
  previousHistoryId: string | null;
  previousHistoryChangedAt: string | null;
  /** Whether any email ticket has ever existed — suppresses noise pre-launch. */
  everReceived: boolean;
}

/**
 * Pure evaluation, separated from I/O so the thresholds can be tested without
 * a database or a clock.
 */
export function evaluateInboundHealth(input: HealthInputs): {
  status: InboundHealth["status"];
  reasons: string[];
  historyChangedAt: string | null;
} {
  const reasons: string[] = [];

  const historyMoved =
    input.lastHistoryId !== null && input.lastHistoryId !== input.previousHistoryId;
  const historyChangedAt = historyMoved
    ? new Date(input.now).toISOString()
    : input.previousHistoryChangedAt;

  if (!input.connected) {
    return {
      status: "degraded",
      reasons: ["The support mailbox is not connected — inbound email is off."],
      historyChangedAt,
    };
  }

  // Before the first email ever arrives there's no baseline to judge silence
  // against, so don't cry wolf during setup.
  if (!input.everReceived) {
    return { status: "unknown", reasons: [], historyChangedAt };
  }

  const silentHours = hoursSince(input.lastInboundAt, input.now);
  if (silentHours === null || silentHours > SILENCE_ALERT_HOURS) {
    reasons.push(
      silentHours === null
        ? "No inbound email has ever been recorded."
        : `No inbound email for ${Math.floor(silentHours)}h (threshold ${SILENCE_ALERT_HOURS}h).`
    );
  }

  const expiryHours = hoursUntil(input.watchExpiresAt, input.now);
  if (expiryHours !== null && expiryHours < WATCH_EXPIRY_WARN_HOURS) {
    reasons.push(
      expiryHours <= 0
        ? "The Gmail watch has EXPIRED — push notifications have stopped."
        : `The Gmail watch expires in ${Math.floor(expiryHours)}h.`
    );
  } else if (input.watchExpiresAt === null) {
    reasons.push("No Gmail watch is registered — nothing is pushing new mail.");
  }

  const cursorAgeHours = hoursSince(historyChangedAt, input.now);
  if (cursorAgeHours !== null && cursorAgeHours > CURSOR_STALE_HOURS) {
    reasons.push(
      `The sync cursor hasn't moved in ${Math.floor(cursorAgeHours)}h (threshold ${CURSOR_STALE_HOURS}h).`
    );
  }

  return {
    status: reasons.length ? "degraded" : "healthy",
    reasons,
    historyChangedAt,
  };
}

/** True when an alert should be sent now, rather than suppressed as a repeat. */
export function shouldSendAlert(
  status: InboundHealth["status"],
  previousStatus: InboundHealth["status"],
  lastAlertAt: string | null,
  now: number
): boolean {
  if (status !== "degraded") return false;
  // A fresh transition into degraded always alerts, even inside the cooldown.
  if (previousStatus !== "degraded") return true;

  const since = hoursSince(lastAlertAt, now);
  return since === null || since >= ALERT_COOLDOWN_HOURS;
}

/** Runs the check against live state and persists the result. */
export async function checkInboundHealth(): Promise<{
  health: InboundHealth;
  previousStatus: InboundHealth["status"];
}> {
  const admin = createAdminClient();
  const now = Date.now();

  const previous = await readInboundHealth();
  const connection = await getSupportInboxConnection();

  const { data: lastInbound } = await admin
    .from("messages")
    .select("created_at, ticket:tickets!inner(channel)")
    .eq("direction", "inbound")
    .eq("tickets.channel", "email")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: emailTicketCount } = await admin
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .eq("channel", "email");

  const evaluated = evaluateInboundHealth({
    now,
    lastInboundAt: (lastInbound?.created_at as string | undefined) ?? null,
    connected: Boolean(connection),
    watchExpiresAt: connection?.watch_expires_at ?? null,
    lastHistoryId: connection?.last_history_id ?? null,
    previousHistoryId: previous.lastHistoryId,
    previousHistoryChangedAt: previous.historyChangedAt,
    everReceived: (emailTicketCount ?? 0) > 0,
  });

  /**
   * What the last sync discarded.
   *
   * Read from the settings blob the sync writes, so the heartbeat can say
   * "mail arrived and every message was dropped" instead of "no mail
   * arrived". Those are indistinguishable in the tickets table and need
   * opposite fixes — the first is a bug in our guards, the second is a quiet
   * Tuesday.
   */
  let recentlyDropped: string | null = null;
  try {
    const blob = await getSettingsBlob();
    const skipped = (blob.inbound_last_sync_skipped ?? {}) as Record<string, number>;
    const failures = (blob.inbound_last_sync_failures ?? []) as string[];
    const dropped = Object.entries(skipped)
      // Duplicates are the redelivery dedupe working, not a loss.
      .filter(([reason]) => reason !== "duplicate")
      .map(([reason, count]) => `${count} × ${reason}`);
    if (failures.length) dropped.unshift(`${failures.length} failed to store`);
    if (dropped.length) recentlyDropped = dropped.join("; ");
  } catch {
    // Monitoring must never be the thing that breaks.
  }

  if (recentlyDropped && evaluated.reasons.length) {
    evaluated.reasons.push(
      `The last sync discarded mail rather than finding none: ${recentlyDropped}.`
    );
  }

  const health: InboundHealth = {
    status: evaluated.status,
    reasons: evaluated.reasons,
    recentlyDropped,
    checkedAt: new Date(now).toISOString(),
    lastInboundAt: (lastInbound?.created_at as string | undefined) ?? null,
    watchExpiresAt: connection?.watch_expires_at ?? null,
    lastHistoryId: connection?.last_history_id ?? null,
    historyChangedAt: evaluated.historyChangedAt,
    lastAlertAt: previous.lastAlertAt,
  };

  await writeInboundHealth(health);
  return { health, previousStatus: previous.status };
}

export async function recordAlertSent(at = new Date()): Promise<void> {
  const health = await readInboundHealth();
  await writeInboundHealth({ ...health, lastAlertAt: at.toISOString() });
}
