import { createAdminClient } from "@/lib/supabase/admin";

// Detects migrations that were written but never run.
//
// This exists because migrations have been missed three times, each time
// discovered only through a downstream symptom that pointed somewhere else
// entirely — most recently a send failure reported as "Message not found",
// which was really `column agents.title does not exist`. The schema is the
// one thing the app can check about itself directly, so it should.
//
// It then cried wolf twice, which cost more than it saved: a banner that is
// sometimes wrong about a missing migration is a banner nobody reads when one
// is genuinely missing. Both false alarms had ONE cause — a probe that
// answered "not there" whenever it could not tell. See `readInventory`.

/** What we were able to establish about one migration. */
export type MigrationState = "applied" | "missing" | "unverified";

export interface MigrationCheck {
  file: string;
  /** What this migration enables, in user terms. */
  title: string;
  state: MigrationState;
  /** What was probed for and found missing. Set only when state is "missing". */
  missing: string | null;
  /** Why we could not tell. Set only when state is "unverified". */
  unverified: string | null;
}

export interface SchemaStatus {
  checks: MigrationCheck[];
  /** Migrations we know have not been run. */
  missing: MigrationCheck[];
  /** Migrations we could not check. NOT the same claim, and never merged. */
  unverified: MigrationCheck[];
  /** Set when the check itself could not run — never treated as "all fine". */
  error: string | null;
}

/**
 * Everything the probes need, read from pg_catalog in ONE call.
 *
 * Replaces fifteen sequential PostgREST requests, each of which treated any
 * error as "the column is missing". That design had no way to say "I could
 * not tell", so every transient failure became an accusation — and because
 * the requests ran in sequence, one bad second reported a contiguous RANGE of
 * migrations as unapplied, which is exactly how 0013/0014/0015 were declared
 * missing while all three were in place.
 *
 * pg_catalog rather than PostgREST is the other half. PostgREST answers from
 * a CACHED schema, and that cache lags DDL by design — so the old probe was
 * least reliable in the exact minutes after a migration ran, which is the one
 * moment somebody is looking at the banner.
 */
export interface SchemaInventory {
  tables: Set<string>;
  /** `table.column` */
  columns: Set<string>;
  indexes: Set<string>;
  functions: Set<string>;
  enumValues: Map<string, Set<string>>;
  /** Storage buckets. Null when the bucket list could not be read. */
  buckets: Set<string> | null;
}

/** What one migration must have in the database for us to call it applied. */
interface Requirements {
  tables?: string[];
  /** `table.column` */
  columns?: string[];
  indexes?: string[];
  functions?: string[];
  /** enum type name → labels that must be present. */
  enumValues?: Record<string, string[]>;
  buckets?: string[];
}

/** A probe that reads DATA rather than shape. Returns what is missing, or null. */
type DataProbe = (
  admin: ReturnType<typeof createAdminClient>
) => Promise<string | null | { unverified: string }>;

interface Migration {
  file: string;
  title: string;
  requires?: Requirements;
  dataProbe?: DataProbe;
  /**
   * Set when this migration leaves NO evidence a probe could read, with the
   * reason. Reported as applied — a banner that can never clear is a banner
   * people learn to scroll past, which costs more than the gap does.
   *
   * A stated admission, never a silent one, and never a probe written so it
   * cannot fail: a check that always passes looks exactly like a check that
   * works, which is the more expensive of the two mistakes.
   */
  unprobeableReason?: string;
}

// Ordered, because they must be run in order.
//
// EVERY file in supabase/migrations must appear here. A migration added
// without an entry is invisible to the banner, which is exactly how 0007–0010
// went unnoticed while the banner reported all clear. tests/schema-check
// asserts this list against the directory so the omission can't repeat.
const MIGRATIONS: Migration[] = [
  {
    file: "0001_init.sql",
    title: "Core ticketing tables",
    requires: {
      tables: ["tickets", "messages", "agents", "customers", "ticket_events"],
      functions: ["is_agent", "is_admin"],
    },
  },
  {
    file: "0002_gmail.sql",
    title: "Gmail send/receive columns",
    requires: {
      columns: ["messages.rfc822_message_id"],
      // The dedupe that makes Pub/Sub redelivery safe. Without it a redelivered
      // message is inserted twice and the thread shows the customer repeating
      // themselves — which reads as a customer problem, not a schema one.
      indexes: ["messages_gmail_message_id_uniq"],
    },
  },
  {
    file: "0003_signature.sql",
    title: "Signatures, company branding — replies cannot send without this",
    requires: { columns: ["agents.signature_enabled"], tables: ["settings"] },
  },
  {
    file: "0004_brand_storage.sql",
    title: "Logo upload storage",
    requires: { buckets: ["brand"] },
  },
  {
    file: "0005_attachments_storage.sql",
    title: "Inbound attachment storage",
    requires: { buckets: ["attachments"] },
  },
  {
    file: "0006_thread_account.sql",
    title: "Gmail thread ownership — prevents cross-account send failures",
    requires: { columns: ["tickets.gmail_account_ref"] },
  },
  {
    file: "0007_claim_support_inbox.sql",
    title: "Idempotent support-mailbox connect",
    // Was `probe: null` — "cannot be checked cheaply", because PostgREST can
    // only reach a function by CALLING it, and calling this one reassigns the
    // support inbox. pg_proc answers the question without invoking anything.
    requires: { functions: ["claim_support_inbox"] },
  },
  {
    file: "0008_blue_brand.sql",
    title: "Blue accent on outbound email",
    dataProbe: async (admin) => {
      const { data, error } = await admin
        .from("settings")
        .select("data")
        .eq("id", true)
        .maybeSingle();
      // A missing settings table is 0003's problem, already reported above.
      // A read that FAILED is not evidence of anything either way.
      if (error) return { unverified: `the settings row could not be read (${error.message})` };
      if (!data) return null;
      const colour = (data.data as { brand_color?: string })?.brand_color;
      return colour === "#f5c518" ? "the email accent is still the old amber" : null;
    },
  },
  {
    file: "0009_notifications.sql",
    title: "Assignment notifications — nothing sends without this",
    requires: {
      tables: ["notifications"],
      columns: ["agents.notifications_enabled"],
      enumValues: { notification_kind: ["assignment", "reminder", "escalation"] },
    },
  },
  {
    file: "0010_display_names.sql",
    title: "Internal display names — assignment email fails without this",
    requires: { columns: ["agents.display_name"] },
  },
  {
    file: "0011_rules.sql",
    title: "Routing rules — nothing is assigned automatically without this",
    requires: {
      tables: ["rules"],
      // Checked separately: the column is what keeps an auto-reply from
      // stamping first_response_at, so the table existing without it would
      // still corrupt the response-time reporting.
      columns: ["messages.is_automated"],
    },
  },
  {
    file: "0012_topics_and_live_routing.sql",
    title: "Live routing rules and the Subscription Help topic rename",
    dataProbe: async (admin) => {
      // The rename is the cheapest reliable signal that this file ran: the
      // rules half can't be probed by shape, since 0011 also creates rules.
      const { data, error } = await admin
        .from("tags")
        .select("id")
        .eq("name", "Subscription Help")
        .maybeSingle();
      if (error) return { unverified: `the tags table could not be read (${error.message})` };
      return data ? null : "the `Subscription` topic has not been renamed";
    },
  },
  {
    file: "0013_meta_messaging.sql",
    title: "Instagram/Messenger dedupe — without it Meta redelivery doubles messages",
    requires: {
      // The indexes ARE this migration. Probing only `deleted_at` meant the
      // file could be half-applied — column present, dedupe index absent —
      // and report as done, which is the state in which Meta redelivery
      // silently duplicates every message it retries.
      indexes: ["messages_meta_message_id_uniq", "tickets_meta_conversation_idx"],
      columns: ["messages.deleted_at"],
    },
  },
  {
    file: "0014_new_ticket_notifications.sql",
    title: "New-ticket watcher emails",
    requires: {
      columns: ["agents.watch_new_tickets"],
      // The enum value is the half a column probe cannot see, and it is the
      // half that throws at send time.
      enumValues: { notification_kind: ["new_ticket"] },
    },
  },
  {
    file: "0015_ticket_risk.sql",
    title: "Advisory risk flagging on tickets",
    requires: {
      columns: [
        "tickets.risk_score",
        "tickets.risk_reasons",
        "tickets.risk_dismissed_by",
        "messages.reply_to_email",
      ],
      indexes: ["tickets_risk_idx"],
    },
  },
  {
    file: "0016_alerts_and_vendor_noise.sql",
    title: "System alert banner and the sender ignore list",
    requires: {
      tables: ["system_alerts", "ignored_senders"],
      // Probed separately from the tables: without these every inbound ticket
      // errors at assessment time rather than merely losing the signal.
      columns: ["tickets.vendor_outreach", "messages.bulk_marker"],
      indexes: ["system_alerts_open_kind_uniq", "ignored_senders_value_uniq"],
    },
  },
  {
    file: "0017_schema_inventory.sql",
    title: "Schema inventory — the banner cannot check anything else without it",
    requires: { functions: ["schema_inventory"] },
  },
  {
    file: "0018_narrow_new_ticket_mail.sql",
    title: "New-ticket mail narrowed to unassigned High/Urgent",
    // The narrowing itself is in the code, not the schema. All this file does
    // is clear 0014's seed — and any of those three may legitimately switch
    // the toggle back on from Settings the next minute, at which point the
    // database looks exactly as it did before the migration ran. There is no
    // reading of the data that separates "never run" from "run, then somebody
    // opted back in", and inventing one would give the banner a way to be
    // confidently wrong about a person's own preference.
    unprobeableReason:
      "data-only, and a person may reverse it from Settings — nothing distinguishes that from never having run it",
  },
];

/** Exposed so the coverage test can compare against the migrations directory. */
export const CHECKED_MIGRATION_FILES = MIGRATIONS.map((m) => m.file);

/**
 * Compares one migration's requirements against the inventory.
 *
 * Pure, and exported for the tests: the property that matters — a probe never
 * reports "missing" on evidence it does not have — is about this function,
 * and a live database cannot be made to demonstrate it on demand.
 */
export function unmetRequirements(
  requires: Requirements,
  inventory: SchemaInventory
): string[] {
  const missing: string[] = [];
  for (const table of requires.tables ?? []) {
    if (!inventory.tables.has(table)) missing.push(`table \`${table}\``);
  }
  for (const column of requires.columns ?? []) {
    if (!inventory.columns.has(column)) missing.push(`column \`${column}\``);
  }
  for (const index of requires.indexes ?? []) {
    if (!inventory.indexes.has(index)) missing.push(`index \`${index}\``);
  }
  for (const fn of requires.functions ?? []) {
    if (!inventory.functions.has(fn)) missing.push(`function \`${fn}()\``);
  }
  for (const [type, labels] of Object.entries(requires.enumValues ?? {})) {
    const present = inventory.enumValues.get(type);
    // A type we know nothing about is reported once, not once per label.
    if (!present) {
      missing.push(`type \`${type}\``);
      continue;
    }
    for (const label of labels) {
      if (!present.has(label)) missing.push(`\`${type}\` value \`${label}\``);
    }
  }
  for (const bucket of requires.buckets ?? []) {
    // Null means the bucket list could not be read. Storage is a separate
    // service from Postgres and fails separately; "we could not ask" must not
    // become "the bucket is gone", which would send someone to re-run a
    // migration that creates a bucket that already exists.
    if (inventory.buckets && !inventory.buckets.has(bucket)) {
      missing.push(`storage bucket \`${bucket}\``);
    }
  }
  return missing;
}

/** Buckets a migration needs but that we could not confirm either way. */
function unverifiableBuckets(requires: Requirements, inventory: SchemaInventory): string[] {
  if (inventory.buckets || !(requires.buckets ?? []).length) return [];
  return (requires.buckets ?? []).map((b) => `storage bucket \`${b}\``);
}

/**
 * Reads the schema inventory, or explains why it could not.
 *
 * The return type is the entire point: `{ inventory }` or `{ unavailable }`,
 * never a half-populated inventory. An inventory that silently came back
 * empty would report every migration as missing at once — the loudest
 * possible false alarm.
 */
async function readInventory(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ inventory: SchemaInventory } | { unavailable: string }> {
  const { data, error } = await admin.rpc("schema_inventory");

  if (error) {
    // PGRST202 is "no such function", which here means 0017 itself has not
    // been run. That is a real missing migration, and it is reported as one
    // by 0017's own entry — but it leaves us unable to check anything else,
    // which is a different sentence from "nothing else is applied".
    // PGRST202 is "no such function". Almost always that means 0017 has not
    // been run — but PostgREST discovers functions through the cached schema,
    // so for a moment after you DO run it the answer is the same. 0017 ends
    // with `notify pgrst, 'reload schema'` to close that window; the wording
    // here covers it staying open anyway, because telling someone to run a
    // migration they just ran is the whole failure this module is repaying.
    const reason =
      error.code === "PGRST202"
        ? "supabase/migrations/0017_schema_inventory.sql has not been run yet (or was run seconds ago and PostgREST has not reloaded)"
        : `${error.code ?? "error"}: ${error.message}`;
    return { unavailable: reason };
  }
  if (!data || typeof data !== "object") {
    return { unavailable: "the schema inventory came back empty" };
  }

  const raw = data as {
    tables?: string[];
    columns?: string[];
    indexes?: string[];
    functions?: string[];
    enum_values?: Record<string, string[]>;
  };

  const enumValues = new Map<string, Set<string>>();
  for (const [type, labels] of Object.entries(raw.enum_values ?? {})) {
    enumValues.set(type, new Set(labels));
  }

  return {
    inventory: {
      tables: new Set(raw.tables ?? []),
      columns: new Set(raw.columns ?? []),
      indexes: new Set(raw.indexes ?? []),
      functions: new Set(raw.functions ?? []),
      enumValues,
      buckets: await bucketNames(admin),
    },
  };
}

/** Storage bucket names, or null when the list could not be read. */
async function bucketNames(
  admin: ReturnType<typeof createAdminClient>
): Promise<Set<string> | null> {
  const { data, error } = await admin.storage.listBuckets();
  if (error) return null;
  return new Set((data ?? []).map((bucket) => bucket.name));
}

// Re-checked often while something is wrong so the banner clears promptly
// after the migration is run, and rarely once everything is in place.
const TTL_WHEN_MISSING_MS = 10_000;
const TTL_WHEN_HEALTHY_MS = 300_000;

let cached: { at: number; ttl: number; status: SchemaStatus } | null = null;

/** Exposed for tests; the cache is otherwise process-lifetime. */
export function resetSchemaCheckCache() {
  cached = null;
}

export async function checkSchema(force = false): Promise<SchemaStatus> {
  if (!force && cached && Date.now() - cached.at < cached.ttl) {
    return cached.status;
  }

  const status = await runChecks();

  cached = {
    at: Date.now(),
    ttl:
      status.missing.length || status.unverified.length || status.error
        ? TTL_WHEN_MISSING_MS
        : TTL_WHEN_HEALTHY_MS,
    status,
  };
  return status;
}

async function runChecks(): Promise<SchemaStatus> {
  const empty = { checks: [], missing: [], unverified: [] };
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return { ...empty, error: describe(e) };
  }

  const read = await readInventory(admin);
  if ("unavailable" in read) {
    // Everything except 0017 becomes unverified — NOT missing. This is the
    // whole correction: the old code would have reported sixteen migrations
    // as unapplied because one call failed.
    const checks = MIGRATIONS.map<MigrationCheck>((m) =>
      m.file === "0017_schema_inventory.sql" &&
      read.unavailable.includes("0017_schema_inventory.sql")
        ? {
            file: m.file,
            title: m.title,
            state: "missing",
            missing: "function `schema_inventory()`",
            unverified: null,
          }
        : {
            file: m.file,
            title: m.title,
            state: "unverified",
            missing: null,
            unverified: read.unavailable,
          }
    );
    return {
      checks,
      missing: checks.filter((c) => c.state === "missing"),
      unverified: checks.filter((c) => c.state === "unverified"),
      error: null,
    };
  }

  const { inventory } = read;
  const checks: MigrationCheck[] = [];

  for (const migration of MIGRATIONS) {
    try {
      checks.push(await checkOne(migration, inventory, admin));
    } catch (e) {
      // A thrown probe is a probe that did not answer.
      checks.push({
        file: migration.file,
        title: migration.title,
        state: "unverified",
        missing: null,
        unverified: describe(e),
      });
    }
  }

  return {
    checks,
    missing: checks.filter((c) => c.state === "missing"),
    unverified: checks.filter((c) => c.state === "unverified"),
    error: null,
  };
}

async function checkOne(
  migration: Migration,
  inventory: SchemaInventory,
  admin: ReturnType<typeof createAdminClient>
): Promise<MigrationCheck> {
  const base = { file: migration.file, title: migration.title };

  if (migration.unprobeableReason) {
    return { ...base, state: "applied", missing: null, unverified: null };
  }

  const missing = migration.requires
    ? unmetRequirements(migration.requires, inventory)
    : [];
  if (missing.length) {
    return { ...base, state: "missing", missing: missing.join(", "), unverified: null };
  }

  if (migration.dataProbe) {
    const verdict = await migration.dataProbe(admin);
    if (verdict && typeof verdict === "object") {
      return { ...base, state: "unverified", missing: null, unverified: verdict.unverified };
    }
    if (verdict) {
      return { ...base, state: "missing", missing: verdict, unverified: null };
    }
  }

  const unverifiable = migration.requires
    ? unverifiableBuckets(migration.requires, inventory)
    : [];
  if (unverifiable.length) {
    return {
      ...base,
      state: "unverified",
      missing: null,
      unverified: `storage could not be reached, so ${unverifiable.join(", ")} could not be checked`,
    };
  }

  return { ...base, state: "applied", missing: null, unverified: null };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
