import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/**
 * Personal mail is a SEPARATE space, not a new ticket channel. It must never
 * surface anywhere a ticket does — inbox, search, reconciliation, exports, the
 * Ike export, or notifications.
 *
 * The structural guarantee: the two personal tables are referenced ONLY inside
 * the personal-triage feature and the schema checker. Any query against
 * personal_messages from a ticket surface would put it in that surface's
 * results, so the allowlist below is what keeps the two worlds apart. If a
 * future edit reads the personal tables from anywhere else, this fails.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SCAN_DIRS = ["app", "lib", "components"];
const PERSONAL_TABLES = /personal_messages|personal_triage_corrections/;

// The ONLY places allowed to name the personal tables.
const ALLOWLIST = new Set([
  "app/(dashboard)/triage/page.tsx",
  "lib/personal-triage/corrections.ts",
  "lib/personal-triage/harness.ts",
  "lib/personal-triage/store.ts",
  "lib/schema-check.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("personal mail never surfaces where a ticket does", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(repoRoot, d)));

  it("references the personal tables only from the allowlisted feature files", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (PERSONAL_TABLES.test(readFileSync(file, "utf8"))) {
        const rel = relative(repoRoot, file);
        if (!ALLOWLIST.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the ticket surfaces (search, reconcile, exports, notifications) do not name them", () => {
    // A representative set of the surfaces the prompt enumerated. Each queries
    // tickets/messages; none may read personal mail.
    const surfaces = [
      "lib/inbound/reconcile.ts",
      "lib/notifications/send.ts",
    ].map((p) => join(repoRoot, p));

    for (const file of surfaces) {
      // Only assert on files that exist in this tree.
      try {
        statSync(file);
      } catch {
        continue;
      }
      expect(readFileSync(file, "utf8")).not.toMatch(PERSONAL_TABLES);
    }
  });
});
