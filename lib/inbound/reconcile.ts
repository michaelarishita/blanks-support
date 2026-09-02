import { createAdminClient } from "@/lib/supabase/admin";
import { backfillFromMailbox } from "@/lib/google/inbound";
import { loadQuarantinedIds } from "@/lib/inbound/quarantine";
import { raiseSystemAlert } from "@/lib/alerts";
import { patchSettingsBlob } from "@/lib/settings";

/**
 * Compares the mailbox to our record, and trusts neither mechanism.
 *
 * Every other alarm here watches a MECHANISM — the sync ran, the cursor moved,
 * the watch is alive — and every outage so far found a new mechanism to break:
 * a guard that discarded group mail, a 404 that held the cursor, a reconnect
 * that skipped it forward. Each one was invisible to the alarms that existed,
 * because each alarm was built from the last failure.
 *
 * This watches the OUTCOME. It asks one question — "is there mail in the
 * mailbox we have neither stored nor deliberately dropped?" — and that
 * question stays right regardless of which part breaks next.
 *
 * The verdicts are RE-DERIVED from the live guards rather than read from the
 * skip counters the sync wrote. A recorded skip log is itself a mechanism, and
 * a reconciliation that trusts one is checking our record against our record.
 */

/** Mail that arrived, was not stored, and no rule explains. */
export interface Discrepancy {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  receivedAt: string | null;
}

export interface ReconcileReport {
  windowDays: number;
  checkedAt: string;
  /** Ids the mailbox listed in the window. */
  examined: number;
  accounted: {
    /** We have a message row for it. */
    stored: number;
    /** A guard dropped it, and the same guard drops it again now. */
    guardDropped: number;
    /** We gave up on it, on purpose, and said so. */
    quarantined: number;
    /** Gmail no longer has it. */
    goneFromMailbox: number;
    /** Too recent to expect: the sync has not had its chance yet. */
    tooRecent: number;
  };
  discrepancies: Discrepancy[];
  /** More mail in the window than one run examines. Never silent. */
  hitCap: boolean;
  /**
   * Set when the check could not complete. A reconciliation that failed has
   * NOT found zero discrepancies, and must never be recorded as a clean run.
   */
  error: string | null;
}

const DEFAULT_WINDOW_DAYS = 7;
/** Gmail's page maximum. Above this the window is reported as capped. */
const DEFAULT_MAX = 500;

/**
 * How long a message may be un-ticketed before it counts against us.
 *
 * The sync is not instant, and reconciliation must not race it: a message that
 * landed thirty seconds ago is not evidence of anything. An hour is far longer
 * than any sync path takes and far shorter than the daily cadence, so nothing
 * real hides inside it.
 */
const GRACE_MS = 60 * 60 * 1000;

export async function reconcileMailbox(
  options: { days?: number; max?: number; now?: number } = {}
): Promise<ReconcileReport> {
  const windowDays = options.days ?? DEFAULT_WINDOW_DAYS;
  const max = options.max ?? DEFAULT_MAX;
  const now = options.now ?? Date.now();
  const empty = {
    windowDays,
    checkedAt: new Date(now).toISOString(),
    examined: 0,
    accounted: {
      stored: 0,
      guardDropped: 0,
      quarantined: 0,
      goneFromMailbox: 0,
      tooRecent: 0,
    },
    discrepancies: [],
    hitCap: false,
  };

  let report;
  try {
    // Deliberately excludes our own outbound and drafts: neither is expected
    // to become a ticket, and drafts are where the poison ids come from.
    // Spam and trash are excluded too — Gmail filed those, not us, and
    // treating Gmail's spam calls as our misses would make this alarm noise.
    report = await backfillFromMailbox({
      query: `newer_than:${windowDays}d -in:sent -in:draft -in:chats`,
      max,
      apply: false,
    });
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
  if (report.result.error) return { ...empty, error: report.result.error };

  const candidates = report.candidates;
  const stored = candidates.filter((c) => c.alreadyStored).length;
  const guardDropped = candidates.filter((c) => !c.alreadyStored && c.droppedBy).length;
  const goneFromMailbox = report.result.skipped["no longer in the mailbox"] ?? 0;

  const unexplained = candidates.filter((c) => !c.alreadyStored && !c.droppedBy);

  // Too recent to have been missed. Checked before the quarantine lookup so a
  // quiet minute of new mail cannot look like a database problem.
  const tooRecent = unexplained.filter(
    (c) => c.receivedAt !== null && now - Date.parse(c.receivedAt) < GRACE_MS
  );
  const settled = unexplained.filter((c) => !tooRecent.includes(c));

  const quarantinedIds = await loadQuarantinedIds(settled.map((c) => c.id));
  if (quarantinedIds === null) {
    // We cannot tell "deliberately abandoned" from "unaccounted for", and the
    // difference is the entire output of this job. Reporting the mail as
    // missing on a failed lookup would be an alarm about our own outage.
    return {
      ...empty,
      examined: candidates.length,
      error: "The quarantine list could not be read, so nothing could be reconciled against it.",
    };
  }

  const discrepancies: Discrepancy[] = settled
    .filter((c) => !quarantinedIds.has(c.id))
    .map((c) => ({
      id: c.id,
      fromEmail: c.fromEmail,
      fromName: c.fromName,
      subject: c.subject,
      receivedAt: c.receivedAt,
    }));

  return {
    windowDays,
    checkedAt: new Date(now).toISOString(),
    examined: candidates.length,
    accounted: {
      stored,
      guardDropped,
      quarantined: settled.length - discrepancies.length,
      goneFromMailbox,
      tooRecent: tooRecent.length,
    },
    discrepancies,
    hitCap: candidates.length >= max,
    error: null,
  };
}

/** How many discrepancies get named in the alert before it becomes a wall. */
/**
 * Uploads we invited that never became anything.
 *
 * The third reconciliation, and the one that answers the question nobody
 * could answer when a customer's photo went missing: we minted a URL, and
 * then what? A grant with no resolution is somebody who tried to send us
 * something and did not — reported as a count with reasons, the same way the
 * mailbox reconciliation reports its guard-drops.
 *
 * Grants younger than the grace are ignored: a submission genuinely in flight
 * has an unresolved row for as long as the customer is still typing, and
 * flagging those would make this fire on healthy traffic.
 */
const GRANT_GRACE_MS = 2 * 60 * 60 * 1000;

export interface UploadLedgerReport {
  issued: number;
  stored: number;
  /** Invited, never claimed. The browser PUT failed, or they gave up. */
  neverClaimed: number;
  /** Claimed, but the object was not there. */
  missingObject: number;
  /** Claimed and refused — sniffing, size, EXIF, or a storage failure. */
  rejected: number;
  reasons: string[];
  error: string | null;
}

export async function reconcileUploads(
  now = Date.now()
): Promise<UploadLedgerReport> {
  const empty: UploadLedgerReport = {
    issued: 0, stored: 0, neverClaimed: 0, missingObject: 0, rejected: 0,
    reasons: [], error: null,
  };
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("upload_grants")
    .select("storage_path, original_name, issued_at, resolved_at, outcome, detail")
    .gte("issued_at", new Date(now - 7 * 86_400_000).toISOString());
  // A failed read is reported, never rendered as "nothing outstanding".
  if (error) return { ...empty, error: error.message };

  const rows = data ?? [];
  const report = { ...empty, issued: rows.length };
  const reasons = new Map<string, number>();

  for (const row of rows) {
    const settled = Boolean(row.resolved_at);
    if (!settled) {
      // Still in flight: not yet evidence of anything.
      if (now - Date.parse(row.issued_at as string) < GRANT_GRACE_MS) continue;
      report.neverClaimed++;
      reasons.set("never claimed (the upload never reached us)",
        (reasons.get("never claimed (the upload never reached us)") ?? 0) + 1);
      continue;
    }
    if (row.outcome === "stored") { report.stored++; continue; }
    if (row.outcome === "missing") {
      report.missingObject++;
      reasons.set("claimed but the object was absent",
        (reasons.get("claimed but the object was absent") ?? 0) + 1);
      continue;
    }
    if (row.outcome === "rejected") {
      report.rejected++;
      const why = `rejected: ${String(row.detail ?? "no reason recorded").slice(0, 60)}`;
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
    }
  }

  report.reasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} × ${reason}`);
  return report;
}

const NAMED_IN_ALERT = 10;

/**
 * Records the run and raises the alarm if anything is unaccounted for.
 *
 * A CLEAN run is recorded too. That is what makes silence mean "checked and
 * healthy" instead of "possibly dead" — the timestamp in Settings is the
 * evidence, and monitoring treats a stale one as its own degraded reason.
 *
 * A clean run deliberately does NOT email. A daily "all clear" is precisely
 * the hundred-FYIs problem the alert system was rebuilt to escape; the record
 * is the report, and only a discrepancy is worth interrupting somebody for.
 */
export async function runReconciliation(
  options: { days?: number; max?: number; now?: number } = {}
): Promise<ReconcileReport> {
  const report = await reconcileMailbox(options);

  // The upload ledger, on the same daily cadence. Wrapped: a failure here
  // must not stop the mailbox reconciliation it rides on.
  let uploads: UploadLedgerReport | null = null;
  try {
    uploads = await reconcileUploads(options.now ?? Date.now());
    if (uploads.error) console.error("[reconcile] upload ledger:", uploads.error);
    else if (uploads.neverClaimed || uploads.missingObject) {
      console.warn(
        `[reconcile] uploads: ${uploads.issued} issued, ${uploads.stored} stored, ` +
          `${uploads.neverClaimed} never claimed, ${uploads.missingObject} missing — ` +
          uploads.reasons.join("; ")
      );
    }
  } catch (e) {
    console.error("[reconcile] upload ledger threw:", e);
  }

  await patchSettingsBlob({
    inbound_last_upload_ledger: uploads,
    inbound_last_reconcile: {
      // A failed run records the failure and does NOT stamp the clean-run
      // time — otherwise a broken reconciliation reads as a healthy mailbox,
      // which is the exact inversion this job exists to prevent.
      at: report.error ? null : report.checkedAt,
      attemptedAt: report.checkedAt,
      windowDays: report.windowDays,
      examined: report.examined,
      accounted: report.accounted,
      discrepancies: report.discrepancies.length,
      hitCap: report.hitCap,
      error: report.error,
    },
  });

  if (report.error) {
    await raiseSystemAlert({
      kind: "inbound_reconciliation_failed",
      title: "The mailbox reconciliation could not run",
      severity: "warning",
      reasons: [report.error],
      detail:
        "This is the check that would notice mail going missing for a reason nothing else watches. While it cannot run, that gap is unwatched.",
    });
    return report;
  }

  if (!report.discrepancies.length) return report;

  const named = report.discrepancies.slice(0, NAMED_IN_ALERT);
  const reasons = named.map(
    (d) =>
      `${d.id} — ${d.fromEmail ?? "unknown sender"} — ${d.subject || "(no subject)"}`
  );
  if (report.discrepancies.length > named.length) {
    reasons.push(`…and ${report.discrepancies.length - named.length} more`);
  }

  await raiseSystemAlert({
    kind: "inbound_reconciliation",
    title: `${report.discrepancies.length} message(s) in the mailbox are unaccounted for`,
    severity: "warning",
    reasons,
    detail:
      `Checked the last ${report.windowDays} days: ${report.examined} messages, ` +
      `${report.accounted.stored} stored, ${report.accounted.guardDropped} dropped by a guard, ` +
      `${report.accounted.quarantined} quarantined. The messages above are none of those — ` +
      "they arrived and we have no record of deciding anything about them.",
  });

  return report;
}
