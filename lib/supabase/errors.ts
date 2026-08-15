import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Turns a Postgres/PostgREST error into something an agent can act on.
 *
 * Same principle as the earlier error audit: never show a raw driver string
 * where a person has to decide what to do next. "duplicate key value violates
 * unique constraint oauth_tokens_one_support_inbox" tells the operator
 * nothing, and it told one operator to go and delete a row by hand.
 *
 * The underlying detail is preserved in the returned string's tail, so a
 * report still contains enough to debug from.
 */

const CONSTRAINT_MESSAGES: Record<string, string> = {
  oauth_tokens_one_support_inbox:
    "Another mailbox is already connected as the support inbox. Reconnecting should replace it — if you are seeing this, migration 0007_claim_support_inbox.sql has not been run.",
  oauth_tokens_support_uniq:
    "That mailbox is already connected as the support inbox.",
  oauth_tokens_provider_agent_id_account_ref_key:
    "That Google account is already connected for this agent.",
  messages_gmail_message_id_uniq:
    "That email has already been imported — it is in the ticket already.",
  tickets_gmail_thread_id_uniq:
    "Another ticket already owns that Gmail thread.",
};

/**
 * True when the error means a table, column or function is absent.
 *
 * PGRST202 (unknown function) matters because the schema banner can only
 * probe tables, columns and buckets — a migration that adds only a function,
 * like 0007, is invisible to it. This is what makes that case loud instead.
 */
export function isMissingSchemaError(error: PostgrestError | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "42883" ||
    error.code === "PGRST202" ||
    error.code === "PGRST205"
  );
}

export function humanizePostgresError(
  error: PostgrestError | null,
  fallback = "The database rejected that change."
): string {
  if (!error) return fallback;

  if (isMissingSchemaError(error)) {
    return `A database migration hasn't been run yet — ${error.message}. Check the banner at the top of the dashboard.`;
  }

  if (error.code === "23505") {
    // The constraint name appears in `message` and sometimes in `details`.
    const haystack = `${error.message} ${error.details ?? ""}`;
    for (const [constraint, text] of Object.entries(CONSTRAINT_MESSAGES)) {
      if (haystack.includes(constraint)) return text;
    }
    return `That record already exists (${error.message}).`;
  }

  if (error.code === "23503") {
    return `That refers to something which no longer exists (${error.message}).`;
  }
  if (error.code === "42501" || error.code === "PGRST301") {
    return `Permission denied by row-level security (${error.message}).`;
  }

  return `${fallback} (${error.message})`;
}
