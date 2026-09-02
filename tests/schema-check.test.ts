import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECKED_MIGRATION_FILES,
  unmetRequirements,
  type SchemaInventory,
} from "@/lib/schema-check";

/**
 * The guard for the failure that actually happened: migrations 0007–0010 were
 * written, committed, and never added to the schema checker — so the banner
 * reported "all clear" while four migrations were unapplied, and the
 * assignment email failed silently for days.
 *
 * A checker that silently stops covering new migrations is worse than no
 * checker, because it is trusted.
 */
describe("schema check covers every migration", () => {
  const dir = fileURLToPath(new URL("../supabase/migrations", import.meta.url));
  const onDisk = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("finds migrations on disk", () => {
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it("has an entry for every migration file", () => {
    const missing = onDisk.filter((f) => !CHECKED_MIGRATION_FILES.includes(f));
    expect(missing).toEqual([]);
  });

  it("has no entry for a migration that doesn't exist", () => {
    const stale = CHECKED_MIGRATION_FILES.filter((f) => !onDisk.includes(f));
    expect(stale).toEqual([]);
  });

  it("keeps the checker in migration order", () => {
    expect(CHECKED_MIGRATION_FILES).toEqual([...CHECKED_MIGRATION_FILES].sort());
  });
});


/**
 * The second failure, and the more expensive one: the banner reported
 * 0013/0014/0015 as unrun when all three were applied. Twice now that has sent
 * someone to the SQL editor to re-run migrations that were already there.
 *
 * A checker that is sometimes wrong about a missing migration is worse than no
 * checker for the same reason a checker with gaps is: it is trusted. So the
 * property under test is not "it finds missing things" — it is "it never
 * claims something is missing on evidence it does not have".
 */
function inventory(overrides: Partial<SchemaInventory> = {}): SchemaInventory {
  return {
    tables: new Set(["tickets", "messages"]),
    columns: new Set(["tickets.id", "messages.deleted_at"]),
    indexes: new Set(["messages_meta_message_id_uniq"]),
    functions: new Set(["claim_support_inbox"]),
    enumValues: new Map([["notification_kind", new Set(["assignment", "new_ticket"])]]),
    buckets: new Set(["brand", "attachments"]),
    ...overrides,
  };
}

describe("what a probe will and will not claim", () => {
  it("reports something genuinely absent", () => {
    expect(unmetRequirements({ columns: ["tickets.risk_score"] }, inventory())).toEqual([
      "column `tickets.risk_score`",
    ]);
  });

  it("says nothing about what is present", () => {
    expect(
      unmetRequirements(
        { tables: ["tickets"], columns: ["messages.deleted_at"] },
        inventory()
      )
    ).toEqual([]);
  });

  it("checks indexes, which is the only evidence a migration of indexes leaves", () => {
    // 0013's dedupe index is the migration. It was previously unprobeable, so
    // the file was reported as permanently unverifiable — and an index that is
    // missing there means Meta redelivery silently doubles every message.
    expect(
      unmetRequirements({ indexes: ["tickets_meta_conversation_idx"] }, inventory())
    ).toEqual(["index `tickets_meta_conversation_idx`"]);
    expect(
      unmetRequirements({ indexes: ["messages_meta_message_id_uniq"] }, inventory())
    ).toEqual([]);
  });

  it("checks enum values, which no column probe can see", () => {
    expect(
      unmetRequirements(
        { enumValues: { notification_kind: ["new_ticket"] } },
        inventory()
      )
    ).toEqual([]);
    expect(
      unmetRequirements(
        { enumValues: { notification_kind: ["escalation"] } },
        inventory()
      )
    ).toEqual(["`notification_kind` value `escalation`"]);
  });

  it("reports an unknown enum type once, not once per label", () => {
    expect(
      unmetRequirements({ enumValues: { rule_trigger: ["a", "b", "c"] } }, inventory())
    ).toEqual(["type `rule_trigger`"]);
  });

  it("will not call a bucket missing when storage could not be reached", () => {
    // Storage is a separate service from Postgres and fails separately. The
    // old probe read a failed listBuckets() as "the bucket is gone", which
    // sends someone to re-run a migration creating a bucket that exists.
    expect(unmetRequirements({ buckets: ["brand"] }, inventory({ buckets: null }))).toEqual([]);
    expect(
      unmetRequirements({ buckets: ["nope"] }, inventory())
    ).toEqual(["storage bucket `nope`"]);
  });
});

describe("an inventory that could not be read", () => {
  it("cannot be confused with an empty database", async () => {
    // The failure mode the old design had no way to avoid: one failed request
    // and every migration reads as unapplied. An empty inventory is a CLAIM
    // about the schema, and a failed read has not made one — so the code path
    // that handles a failed read must not build an inventory at all.
    const src = readFileSync(
      fileURLToPath(new URL("../lib/schema-check.ts", import.meta.url)),
      "utf8"
    );
    // The failure branch returns `unavailable`, never a SchemaInventory.
    expect(src).toContain('return { unavailable:');
    expect(src).toContain('state: "unverified"');
    // And the sets are only ever built from data that arrived.
    const failureBranch = src.slice(
      src.indexOf("async function readInventory"),
      src.indexOf("/** Storage bucket names")
    );
    expect(failureBranch).toContain("if (error) {");
    expect(failureBranch.indexOf("return { unavailable:")).toBeLessThan(
      failureBranch.indexOf("tables: new Set(")
    );
  });
});

/**
 * The bootstrap check was the one place this module could still cry wolf, and
 * it would do it in exactly the situation it exists to handle: the moments
 * after somebody ran the migration.
 *
 * PostgREST answers PGRST202 both for "no such function" and for "my schema
 * cache has not caught up yet" — same code, same message. Verified against the
 * live project, along with the fact that information_schema is NOT reachable
 * through PostgREST (PGRST106), so there is no second oracle to break the tie.
 * Time is the only discriminator available.
 */
describe("PGRST202 is two different facts", () => {
  const rpc = (result: { data?: unknown; error?: { code: string; message: string } }) =>
    vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });

  const INVENTORY = {
    tables: [], columns: [], indexes: [], functions: [], enum_values: {},
  };

  async function withClient(client: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => client }));
    return import("@/lib/schema-check");
  }

  const storage = { listBuckets: async () => ({ data: [], error: null }) };

  afterEach(() => {
    vi.doUnmock("@/lib/supabase/admin");
    vi.useRealTimers();
  });

  it("reports 'could not check', not 'missing', the first time", async () => {
    // A migration somebody ran ten seconds ago must never be reported unrun.
    const mod = await withClient({
      rpc: rpc({ error: { code: "PGRST202", message: "Could not find the function" } }),
      storage,
    });
    mod.resetSchemaCheckCache();
    const status = await mod.checkSchema(true);

    expect(status.missing).toEqual([]);
    expect(status.unverified.length).toBe(status.checks.length);
    expect(status.unverified[0].unverified).toContain("isn't answering yet");
  });

  it("calls it missing once it outlasts the grace", async () => {
    // A function that genuinely does not exist does not start working, so the
    // banner still has to say so — a check that can never turn red is not a
    // check.
    vi.useFakeTimers();
    const mod = await withClient({
      rpc: rpc({ error: { code: "PGRST202", message: "Could not find the function" } }),
      storage,
    });
    mod.resetSchemaCheckCache();

    await mod.checkSchema(true);
    vi.advanceTimersByTime(61_000);
    const status = await mod.checkSchema(true);

    expect(status.missing.map((m) => m.file)).toEqual(["0017_schema_inventory.sql"]);
    // And still never accuses the other twenty of being unrun.
    expect(status.unverified.every((c) => c.file !== "0017_schema_inventory.sql")).toBe(true);
  });

  it("forgets the clock as soon as the function answers", async () => {
    // The lag resolved. A later, unrelated PGRST202 must start its own grace
    // rather than inheriting a stale one and turning red immediately.
    vi.useFakeTimers();
    const flaky = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "x" } })
      .mockResolvedValue({ data: INVENTORY, error: null });
    const mod = await withClient({ rpc: flaky, storage });
    mod.resetSchemaCheckCache();

    await mod.checkSchema(true);
    const recovered = await mod.checkSchema(true);
    // The inventory answered, so nothing is "could not check" any more. (It
    // is an EMPTY inventory, so everything is legitimately missing — that is
    // the right reading of a database with no tables in it.)
    expect(
      recovered.unverified.filter((c) => c.unverified?.includes("isn't answering"))
    ).toEqual([]);

    // Long after, it fails again — and gets a fresh grace, not an instant red.
    vi.advanceTimersByTime(10 * 60_000);
    flaky.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "x" } });
    const later = await mod.checkSchema(true);
    expect(later.missing).toEqual([]);
  });

  it("never starts the clock for an unrelated failure", async () => {
    // A network error or a bad key says nothing about which migrations exist,
    // and must not age into an accusation.
    vi.useFakeTimers();
    const mod = await withClient({
      rpc: rpc({ error: { code: "PGRST301", message: "JWT expired" } }),
      storage,
    });
    mod.resetSchemaCheckCache();

    await mod.checkSchema(true);
    vi.advanceTimersByTime(10 * 60_000);
    const status = await mod.checkSchema(true);

    expect(status.missing).toEqual([]);
    expect(status.unverified[0].unverified).toContain("JWT expired");
  });
});
