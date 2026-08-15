import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKED_MIGRATION_FILES } from "@/lib/schema-check";

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
