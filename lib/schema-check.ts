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
const MIGRATIONS: {
  file: string;
  title: string;
  probe: (buckets: Set<string> | null) => Promise<string | null>;
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
];

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
      const missing = await migration.probe(buckets);
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
