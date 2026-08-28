import { createAdminClient } from "@/lib/supabase/admin";
import { raiseSystemAlert } from "@/lib/alerts";

/**
 * The escape valve for a message that can never be taken in.
 *
 * Holding the cursor for a failed message stays the DEFAULT, and it is right:
 * advancing past a message we could not write turns a transient error into
 * permanent loss. But a message that fails every time holds every message
 * behind it forever, and inbound is down until a person notices — which last
 * time took 31 hours.
 *
 * Nothing here deletes anything. The mail is still in Gmail. This is a record
 * that we stopped trying, with the reason and the count, so a person can look
 * and put it back.
 */

/** Three separate syncs, not three retries in a loop. */
export const QUARANTINE_AFTER_ATTEMPTS = 3;

export type FailurePhase = "fetch" | "store";

/** What this run PROVED about the system, as opposed to about one message. */
export interface BatchEvidence {
  /** Messages read from Gmail successfully in this run. */
  fetched: number;
  /** Messages written to the database in this run. */
  stored: number;
}

export interface QuarantineVerdict {
  quarantine: boolean;
  /** Always set — a decision not to quarantine is worth reading too. */
  reason: string;
}

/**
 * THE GUARD THAT MAKES THIS SAFE, and the reason it is a pure function with
 * its own tests.
 *
 * A plain attempt counter cannot tell a poison message from an outage. A
 * missing column, an RLS change, an expired key, Postgres being down — these
 * fail EVERY message, so a counter alone would quarantine the entire mailbox
 * three runs later, one batch at a time. That is an automatic data-loss
 * machine that runs fastest exactly when something is most broken.
 *
 * So quarantine requires positive evidence that the system works and this
 * message is the exception: something else in the same run got through the
 * same phase. Fetch and store are checked separately because they fail for
 * unrelated reasons — a Gmail outage says nothing about whether Postgres
 * accepts writes, and vice versa.
 *
 * When there is no such evidence, nothing is quarantined and the cursor stays
 * held. Blocked and loud is the safe failure here; skipped and quiet is not.
 */
export function shouldQuarantine({
  attempts,
  phase,
  evidence,
}: {
  attempts: number;
  phase: FailurePhase;
  evidence: BatchEvidence;
}): QuarantineVerdict {
  if (attempts < QUARANTINE_AFTER_ATTEMPTS) {
    return {
      quarantine: false,
      reason: `attempt ${attempts} of ${QUARANTINE_AFTER_ATTEMPTS}`,
    };
  }

  const succeeded = phase === "fetch" ? evidence.fetched : evidence.stored;
  if (succeeded === 0) {
    return {
      quarantine: false,
      reason:
        phase === "fetch"
          ? "nothing was fetched in this run — that is an outage, not a bad message"
          : "nothing was stored in this run — that is an outage, not a bad message",
    };
  }

  return {
    quarantine: true,
    reason: `failed ${attempts} times while ${succeeded} other message(s) succeeded in the same run`,
  };
}

// ---------------------------------------------------------------- the DB side

export interface QuarantineRow {
  gmail_message_id: string;
  attempts: number;
  last_error: string;
  last_phase: FailurePhase;
  quarantined_at: string | null;
  released_at: string | null;
}

/**
 * Ids currently quarantined, so the sync steps over them.
 *
 * Returns null when the lookup FAILED, which callers must not read as "none
 * are quarantined" — that would put every poisoned message straight back in
 * front of the cursor and re-block the channel on the one run where the
 * database was already unhappy.
 */
export async function loadQuarantinedIds(ids: string[]): Promise<Set<string> | null> {
  if (!ids.length) return new Set();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("quarantined_messages")
    .select("gmail_message_id")
    .in("gmail_message_id", ids)
    .not("quarantined_at", "is", null)
    .is("released_at", null);
  if (error) {
    console.error("[quarantine] could not read the quarantine list:", error.message);
    return null;
  }
  return new Set((data ?? []).map((row) => row.gmail_message_id as string));
}

/** Records one failed attempt and returns the running total for that message. */
export async function recordAttempt(
  gmailMessageId: string,
  phase: FailurePhase,
  error: string
): Promise<number | null> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await admin
    .from("quarantined_messages")
    .select("id, attempts")
    .eq("gmail_message_id", gmailMessageId)
    .maybeSingle();
  if (readError) {
    console.error("[quarantine] could not read attempts:", readError.message);
    return null;
  }

  if (!existing) {
    const { error: insertError } = await admin.from("quarantined_messages").insert({
      gmail_message_id: gmailMessageId,
      attempts: 1,
      first_failed_at: now,
      last_failed_at: now,
      last_error: error,
      last_phase: phase,
    });
    if (insertError) {
      console.error("[quarantine] could not record an attempt:", insertError.message);
      return null;
    }
    return 1;
  }

  const attempts = (existing.attempts as number) + 1;
  const { error: updateError } = await admin
    .from("quarantined_messages")
    .update({
      attempts,
      last_failed_at: now,
      last_error: error,
      last_phase: phase,
      // A message that starts failing again after a release is a fresh case,
      // not a continuation — clearing this puts it back under the threshold
      // instead of quarantining it on the first failure after release.
      released_at: null,
      released_by: null,
    })
    .eq("id", existing.id);
  if (updateError) {
    console.error("[quarantine] could not update attempts:", updateError.message);
    return null;
  }
  return attempts;
}

/** Marks a message quarantined. It stops holding the cursor from here. */
export async function quarantineMessage(
  gmailMessageId: string,
  reason: string
): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("quarantined_messages")
    .update({ quarantined_at: new Date().toISOString() })
    .eq("gmail_message_id", gmailMessageId)
    .is("quarantined_at", null);
  if (error) {
    console.error("[quarantine] could not quarantine:", error.message);
    return false;
  }
  console.error(`[quarantine] ${gmailMessageId} quarantined — ${reason}`);
  return true;
}

/**
 * The alarm. An alert ROW, not an email, for the same reason every other
 * system alert is: it persists until a person acknowledges it, and a
 * quarantined message is by definition one nobody has looked at yet.
 */
export async function alertOnQuarantine(
  quarantined: { id: string; error: string }[]
): Promise<void> {
  if (!quarantined.length) return;
  try {
    await raiseSystemAlert({
      kind: "inbound_quarantine",
      title: `${quarantined.length} inbound message(s) could not be taken in`,
      severity: "warning",
      reasons: quarantined.map((q) => `${q.id}: ${q.error}`),
      detail:
        "These were tried three times and skipped so the rest of the mail could move. " +
        "They are still in Gmail. Settings → Inbound has the list and a button to put them back.",
    });
  } catch (e) {
    // Never the thing that breaks the sync.
    console.error("[quarantine] could not raise the alert:", e);
  }
}

/** Puts a message back in the queue. The next sync will try it again. */
export async function releaseQuarantined(
  gmailMessageId: string,
  agentId: string | null
): Promise<{ error?: string }> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("quarantined_messages")
    .update({
      released_at: new Date().toISOString(),
      released_by: agentId,
      // Back to zero: a release is a judgement that the cause is fixed, so it
      // deserves the full three attempts again rather than being re-caught on
      // the first stumble.
      attempts: 0,
      quarantined_at: null,
    })
    .eq("gmail_message_id", gmailMessageId);
  return error ? { error: error.message } : {};
}

/** What Settings shows. */
export async function readQuarantined(): Promise<{
  rows: QuarantineRow[];
  error: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("quarantined_messages")
    .select("gmail_message_id, attempts, last_error, last_phase, quarantined_at, released_at")
    .not("quarantined_at", "is", null)
    .is("released_at", null)
    .order("quarantined_at", { ascending: false });
  // A failed read is reported, never rendered as an empty quarantine list —
  // "nothing is stuck" and "we could not check" need opposite responses.
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as QuarantineRow[], error: null };
}
