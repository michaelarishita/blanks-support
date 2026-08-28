import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
