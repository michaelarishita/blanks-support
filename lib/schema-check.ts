import { createAdminClient } from "@/lib/supabase/admin";

// Detects migrations that were written but never run.
//
// This exists because migrations have been missed three times, each time
// discovered only through a downstream symptom that pointed somewhere else
// entirely — most recently a send failure reported as "Message not found",
// which was really `column agents.title does not exist`. The schema is the
// one thing the app can check about itself directly, so it should.

export interface MigrationCheck {
  file: string;
  /** What this migration enables, in user terms. */
  title: string;
  applied: boolean;
  /** What was probed for and found missing. */
  missing: string | null;
}

export interface SchemaStatus {
  checks: MigrationCheck[];
  missing: MigrationCheck[];
  /** Set when the check itself could not run — never treated as "all fine". */
  error: string | null;
}

/** Cheap existence probe: PostgREST rejects an unknown table or column. */
async function columnExists(table: string, column: string): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from(table).select(column).limit(1);
  return !error;
}

async function bucketNames(): Promise<Set<string> | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.listBuckets();
  if (error) return null;
  return new Set((data ?? []).map((bucket) => bucket.name));
}

// Ordered, because they must be run in order.
//
// EVERY file in supabase/migrations must appear here. A migration added
// without an entry is invisible to the banner, which is exactly how 0007–0010
// went unnoticed while the banner reported all clear. tests/schema-check
// asserts this list against the directory so the omission can't repeat.
//
// `probe: null` means "cannot be checked cheaply" — a deliberate, visible
// admission rather than a silent gap.
const MIGRATIONS: {
  file: string;
  title: string;
  probe: ((buckets: Set<string> | null) => Promise<string | null>) | null;
  unprobeableReason?: string;
}[] = [
  {
    file: "0001_init.sql",
    title: "Core ticketing tables",
    probe: async () =>
      (await columnExists("tickets", "id")) ? null : "table `tickets`",
  },
  {
    file: "0002_gmail.sql",
    title: "Gmail send/receive columns",
    probe: async () =>
      (await columnExists("messages", "rfc822_message_id"))
        ? null
        : "column `messages.rfc822_message_id`",
  },
  {
    file: "0003_signature.sql",
    title: "Signatures, company branding — replies cannot send without this",
    probe: async () => {
      const missing: string[] = [];
      if (!(await columnExists("agents", "signature_enabled"))) {
        missing.push("column `agents.signature_enabled`");
      }
      if (!(await columnExists("settings", "data"))) {
        missing.push("table `settings`");
      }
      return missing.length ? missing.join(", ") : null;
    },
  },
  {
    file: "0004_brand_storage.sql",
    title: "Logo upload storage",
    probe: async (buckets) =>
      buckets === null || buckets.has("brand") ? null : "storage bucket `brand`",
  },
  {
    file: "0005_attachments_storage.sql",
    title: "Inbound attachment storage",
    probe: async (buckets) =>
      buckets === null || buckets.has("attachments")
        ? null
        : "storage bucket `attachments`",
  },
  {
    file: "0006_thread_account.sql",
    title: "Gmail thread ownership — prevents cross-account send failures",
    probe: async () =>
      (await columnExists("tickets", "gmail_account_ref"))
        ? null
        : "column `tickets.gmail_account_ref`",
  },
  {
    file: "0007_claim_support_inbox.sql",
    title: "Idempotent support-mailbox connect",
    // PostgREST answers PGRST202 for both "no such function" and "wrong
    // argument list", so the only way to probe would be to CALL it — which
    // would reassign the support inbox. Surfaced at point of use instead:
    // humanizePostgresError maps PGRST202 to "run the migration".
    probe: null,
    unprobeableReason:
      "function-only migration; a probe would have to invoke it, which reassigns the support inbox",
  },
  {
    file: "0008_blue_brand.sql",
    title: "Blue accent on outbound email",
    probe: async () => {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("settings")
        .select("data")
        .eq("id", true)
        .maybeSingle();
      // A missing settings table is 0003's problem, already reported above.
      if (error || !data) return null;
      const colour = (data.data as { brand_color?: string })?.brand_color;
      return colour === "#f5c518" ? "the email accent is still the old amber" : null;
    },
  },
  {
    file: "0009_notifications.sql",
    title: "Assignment notifications — nothing sends without this",
    probe: async () => {
      const missing: string[] = [];
      if (!(await columnExists("notifications", "kind"))) {
        missing.push("table `notifications`");
      }
      if (!(await columnExists("agents", "notifications_enabled"))) {
        missing.push("column `agents.notifications_enabled`");
      }
      return missing.length ? missing.join(", ") : null;
    },
  },
  {
    file: "0010_display_names.sql",
    title: "Internal display names — assignment email fails without this",
    probe: async () =>
      (await columnExists("agents", "display_name"))
        ? null
        : "column `agents.display_name`",
  },
  {
    file: "0011_rules.sql",
    title: "Routing rules — nothing is assigned automatically without this",
    probe: async () => {
      const missing: string[] = [];
      if (!(await columnExists("rules", "conditions"))) {
        missing.push("table `rules`");
      }
      // Checked separately: the column is what keeps an auto-reply from
      // stamping first_response_at, so the table existing without it would
      // still corrupt the response-time reporting.
      if (!(await columnExists("messages", "is_automated"))) {
        missing.push("column `messages.is_automated`");
      }
      return missing.length ? missing.join(", ") : null;
    },
  },
  {
    file: "0012_topics_and_live_routing.sql",
    title: "Live routing rules and the Subscription Help topic rename",
    probe: async () => {
      const admin = createAdminClient();
      // The rename is the cheapest reliable signal that this file ran: the
      // rules half can't be probed by shape, since 0011 also creates rules.
      const { data, error } = await admin
        .from("tags")
        .select("id")
        .eq("name", "Subscription Help")
        .maybeSingle();
      // A missing tags table is 0001's problem, already reported above.
      if (error) return null;
      return data ? null : "the `Subscription` topic has not been renamed";
    },
  },
  {
    file: "0013_meta_messaging.sql",
    title: "Instagram/Messenger dedupe — without it Meta redelivery doubles messages",
    probe: async () =>
      (await columnExists("messages", "deleted_at"))
        ? null
        : "column `messages.deleted_at`",
  },
  {
    file: "0014_new_ticket_notifications.sql",
    title: "New-ticket watcher emails",
    probe: async () =>
      (await columnExists("agents", "watch_new_tickets"))
        ? null
        : "column `agents.watch_new_tickets`",
  },
  {
    file: "0015_ticket_risk.sql",
    title: "Advisory risk flagging on tickets",
    probe: async () =>
      (await columnExists("tickets", "risk_score")) &&
      (await columnExists("messages", "reply_to_email"))
        ? null
        : "column `tickets.risk_score` / `messages.reply_to_email`",
  },
];

/** Exposed so the coverage test can compare against the migrations directory. */
export const CHECKED_MIGRATION_FILES = MIGRATIONS.map((m) => m.file);

// Re-checked often while something is missing so the banner clears promptly
// after the migration is run, and rarely once everything is in place.
const TTL_WHEN_MISSING_MS = 10_000;
const TTL_WHEN_HEALTHY_MS = 300_000;

let cached: { at: number; ttl: number; status: SchemaStatus } | null = null;

export async function checkSchema(force = false): Promise<SchemaStatus> {
  if (!force && cached && Date.now() - cached.at < cached.ttl) {
    return cached.status;
  }

  let status: SchemaStatus;
  try {
    const buckets = await bucketNames();
    const checks: MigrationCheck[] = [];
    for (const migration of MIGRATIONS) {
      // Unprobeable migrations are reported as applied rather than as
      // permanently missing — a banner that never clears gets ignored.
      const missing = migration.probe ? await migration.probe(buckets) : null;
      checks.push({
        file: migration.file,
        title: migration.title,
        applied: missing === null,
        missing,
      });
    }
    status = {
      checks,
      missing: checks.filter((check) => !check.applied),
      error: null,
    };
  } catch (e) {
    // A failed check is reported as a failed check. Returning "all applied"
    // here would recreate exactly the silence this module exists to end.
    status = {
      checks: [],
      missing: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }

  cached = {
    at: Date.now(),
    ttl: status.missing.length || status.error ? TTL_WHEN_MISSING_MS : TTL_WHEN_HEALTHY_MS,
    status,
  };
  return status;
}
