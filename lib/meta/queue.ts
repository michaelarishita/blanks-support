import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeWebhook } from "./events";
import { processMetaEvents, emptyMetaResult, type MetaSyncResult } from "./inbound";

/**
 * The durable landing pad between Meta's five-second deadline and our work.
 *
 * Meta retries immediately on a non-200, alerts after fifteen minutes, and
 * UNSUBSCRIBES the app after an hour of failures. An unsubscribed app is a
 * silent inbound outage — the mailbox equivalent of Gmail cancelling our watch
 * without telling anyone — so the endpoint's only job is to get the bytes onto
 * disk and answer.
 *
 * Everything expensive lives here and runs after the response: profile
 * fetches, media downloads, ticket creation, rules. None of it can cost us the
 * subscription any more, however slow the Graph API is being.
 */

/** How many events one drain will take. Bounded so a backlog can't run long. */
const MAX_PER_DRAIN = 50;

/**
 * A row that failed this many times is left alone.
 *
 * Same reasoning as the inbound quarantine: retrying forever is how one
 * unprocessable event consumes every drain. Unlike inbound mail there is no
 * cursor to block, so this is a cost control rather than an outage guard — but
 * a row stuck at the limit is still worth seeing, and the heartbeat counts it.
 */
export const MAX_ATTEMPTS = 5;

export interface RecordedEvent {
  id: string | null;
  /** Set when the row could not be written — the one failure worth a non-200. */
  error: string | null;
}

/**
 * Writes the raw event and nothing else.
 *
 * Deliberately takes the raw STRING rather than a parsed object: the body may
 * not be JSON at all, and an unparseable signed body is still evidence worth
 * keeping. It is stored as a jsonb string in that case rather than discarded.
 */
export async function recordWebhookEvent(input: {
  raw: string;
  signatureOk: boolean;
}): Promise<RecordedEvent> {
  const admin = createAdminClient();

  let payload: unknown;
  try {
    payload = JSON.parse(input.raw);
  } catch {
    // Kept as a JSON string, so the column is always valid jsonb and the body
    // is still there to look at.
    payload = { unparseable: input.raw.slice(0, 8000) };
  }

  const summary = summarize(payload);

  const { data, error } = await admin
    .from("meta_webhook_events")
    .insert({
      object: summary.object,
      entry_id: summary.entryId,
      mid: summary.mid,
      payload,
      signature_ok: input.signatureOk,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[meta] could not record the webhook event:", error.message);
    return { id: null, error: error.message };
  }
  return { id: data.id as string, error: null };
}

/** Cheap fields pulled off the payload for tracing, without normalising it. */
function summarize(payload: unknown): {
  object: string | null;
  entryId: string | null;
  mid: string | null;
} {
  const body = payload as {
    object?: unknown;
    entry?: { id?: unknown; messaging?: { message?: { mid?: unknown } }[] }[];
  } | null;
  const entry = Array.isArray(body?.entry) ? body.entry[0] : undefined;
  const messaging = Array.isArray(entry?.messaging) ? entry.messaging[0] : undefined;
  return {
    object: typeof body?.object === "string" ? body.object : null,
    entryId: typeof entry?.id === "string" ? entry.id : null,
    mid: typeof messaging?.message?.mid === "string" ? messaging.message.mid : null,
  };
}

export interface DrainResult extends MetaSyncResult {
  /** Rows taken off the queue this run. */
  drained: number;
  /** Rows that failed and will be retried. */
  failed: number;
  /** Set when the queue itself could not be read — never "nothing to do". */
  queueError?: string;
}

/**
 * Processes whatever is waiting.
 *
 * Called from `after()` on the webhook — so the common case is one row,
 * processed a few milliseconds after the response — and from the heartbeat,
 * which is what makes it self-healing: a drain that never ran because the
 * function was killed mid-flight is picked up within the hour rather than
 * being lost.
 */
export async function drainWebhookEvents(
  options: { max?: number } = {}
): Promise<DrainResult> {
  const admin = createAdminClient();
  const max = options.max ?? MAX_PER_DRAIN;
  const result: DrainResult = { ...emptyMetaResult(), drained: 0, failed: 0 };

  const { data: pending, error } = await admin
    .from("meta_webhook_events")
    .select("id, payload, attempts")
    .is("processed_at", null)
    .eq("signature_ok", true)
    .lt("attempts", MAX_ATTEMPTS)
    // Oldest first: Meta's own ordering, and the order a conversation happened
    // in. Processing newest-first would put a reply above the message it
    // answers.
    .order("received_at", { ascending: true })
    .limit(max);

  // A failed read is reported, never rendered as an empty queue — "nothing
  // waiting" and "we could not look" need opposite responses.
  if (error) return { ...result, queueError: error.message };

  for (const row of pending ?? []) {
    const id = row.id as string;
    try {
      const events = normalizeWebhook(row.payload);
      const outcome = await processMetaEvents(events);

      result.received += outcome.received;
      result.created += outcome.created;
      result.appended += outcome.appended;
      for (const [reason, count] of Object.entries(outcome.skipped)) {
        result.skipped[reason] = (result.skipped[reason] ?? 0) + count;
      }

      await admin
        .from("meta_webhook_events")
        .update({ processed_at: new Date().toISOString(), error: null })
        .eq("id", id);
      result.drained++;
    } catch (e) {
      // Left unprocessed so the next drain retries it. The attempt counter is
      // what stops that being forever.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[meta] event ${id} failed to process:`, message);
      await admin
        .from("meta_webhook_events")
        .update({ error: message, attempts: (row.attempts as number) + 1 })
        .eq("id", id);
      result.failed++;
    }
  }

  return result;
}
